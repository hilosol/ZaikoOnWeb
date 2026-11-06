import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rules, type ProductInput } from "../../shared/types.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/errors.js";
import { createFixture, imageFiles, JPEG, PNG, uploadFiles, type Fixture } from "./helpers.js";

let f: Fixture;
beforeEach(() => {
  f = createFixture();
});
afterEach(() => f.cleanup());

const input = (over: Partial<ProductInput> = {}): ProductInput => ({
  code: "A001",
  name: "りんご",
  category: "果物",
  warningStock: 3,
  initialStock: 10,
  ...over,
});
const keep = { action: "keep" } as const;

describe("商品登録", () => {
  it("初期在庫ありなら初期登録の履歴を入力者・IP付きで残す", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    const [h] = f.service.allHistories();
    expect(h).toMatchObject({
      productId: p.id,
      productCode: "A001",
      type: "INIT",
      quantity: 10,
      stockAfter: 10,
      userName: "山田",
      clientIp: "192.168.1.10",
      createdAt: "2026-11-02 09:00:00",
    });
  });

  it("初期在庫0なら履歴を残さない", () => {
    f.service.registerProduct(input({ initialStock: 0 }), keep, f.actor);
    expect(f.service.allHistories()).toHaveLength(0);
  });

  it("前後の空白・全角英数を正規化する（商品名の全角は保つ）", () => {
    const p = f.service.registerProduct(input({ code: " Ａ００１ ", name: " りんご　" }), keep, f.actor);
    expect(p.code).toBe("A001");
    expect(p.name).toBe("りんご");
  });

  it("全角半角違いでも商品IDの重複は拒否する", () => {
    f.service.registerProduct(input(), keep, f.actor);
    expect(() => f.service.registerProduct(input({ code: "Ａ００１", name: "別" }), keep, f.actor)).toThrow(/既に登録/);
  });

  it("入力エラーはまとめて返す", () => {
    try {
      f.service.registerProduct({ code: "", name: " ", category: "", warningStock: -1 }, keep, f.actor);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).details).toHaveLength(3);
    }
  });

  it.each([
    ["小数", { warningStock: 1.5 }],
    ["文字列", { warningStock: "3" as unknown as number }],
    ["初期在庫が負", { initialStock: -1 }],
    ["初期在庫が上限超え", { initialStock: Rules.maxStock + 1 }],
    ["コードが長すぎる", { code: "C".repeat(Rules.codeMaxLength + 1) }],
    ["商品名が長すぎる", { name: "N".repeat(Rules.nameMaxLength + 1) }],
  ])("%s は拒否する", (_label, over) => {
    expect(() => f.service.registerProduct(input(over), keep, f.actor)).toThrow(ValidationError);
  });

  it("上限ちょうどは許可する", () => {
    const p = f.service.registerProduct(
      input({ code: "C".repeat(Rules.codeMaxLength), name: "N".repeat(Rules.nameMaxLength), initialStock: Rules.maxStock }),
      keep,
      f.actor,
    );
    expect(p.stock).toBe(Rules.maxStock);
  });

  it("登録されていない・無効な入力者では操作できない", () => {
    expect(() => f.service.registerProduct(input(), keep, { ...f.actor, userName: "知らない人" })).toThrow(/入力者/);
    const u = f.service.listUsers()[0]!;
    f.service.updateUser(u.id, { active: false }, f.actor);
    expect(() => f.service.registerProduct(input(), keep, f.actor)).toThrow(/入力者/);
  });

  it("画像付きで登録すると一時ファイルが画像フォルダに移る", () => {
    const uploadId = f.images.saveUpload(JPEG);
    const p = f.service.registerProduct(input(), { action: "replace", uploadId }, f.actor);
    expect(p.imageFile).toBe(uploadId);
    expect(imageFiles(f.dir)).toEqual([uploadId]);
    expect(uploadFiles(f.dir)).toEqual([]);
  });

  it("登録に失敗したら確定した画像を消す", () => {
    f.service.registerProduct(input(), keep, f.actor);
    const uploadId = f.images.saveUpload(JPEG);
    expect(() =>
      f.service.registerProduct(input({ name: "重複" }), { action: "replace", uploadId }, f.actor),
    ).toThrow(ValidationError);
    expect(imageFiles(f.dir)).toEqual([]);
  });

  it("存在しない uploadId は拒否し、商品も登録しない", () => {
    const fake = "00000000-0000-0000-0000-000000000000.jpg";
    expect(() => f.service.registerProduct(input(), { action: "replace", uploadId: fake }, f.actor)).toThrow(/見つかりません/);
    expect(f.service.searchProducts()).toHaveLength(0);
  });
});

describe("入出庫", () => {
  it("入庫・出庫で在庫と履歴（処理後在庫）が更新される", () => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    expect(f.service.changeStock(p.id, "IN", 5, f.actor).stock).toBe(15);
    expect(f.service.changeStock(p.id, "OUT", 3, { userName: "山田", clientIp: "192.168.1.20" }).stock).toBe(12);

    const last = f.service.recentHistories(1)[0]!;
    expect(last).toMatchObject({ type: "OUT", quantity: 3, stockAfter: 12, clientIp: "192.168.1.20" });
  });

  it("在庫ちょうどの出庫で0になる", () => {
    const p = f.service.registerProduct(input({ initialStock: 4 }), keep, f.actor);
    expect(f.service.changeStock(p.id, "OUT", 4, f.actor).stock).toBe(0);
  });

  it("在庫不足なら在庫も履歴も変えない", () => {
    const p = f.service.registerProduct(input({ initialStock: 2 }), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "OUT", 3, f.actor)).toThrow(/在庫が不足/);
    expect(f.service.getProduct(p.id).stock).toBe(2);
    expect(f.service.allHistories()).toHaveLength(1);
  });

  it("上限を超える入庫は拒否する", () => {
    const p = f.service.registerProduct(input({ initialStock: Rules.maxStock }), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "IN", 1, f.actor)).toThrow(/上限/);
  });

  it.each([0, -1, 1.5, Rules.maxQuantityPerOperation + 1, "1", null])("数量 %s は拒否する", (q) => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "IN", q, f.actor)).toThrow(/数量/);
  });

  it("区分が不正なら拒否する", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "INIT", 1, f.actor)).toThrow(/入庫・出庫・移管/);
  });

  it("存在しない商品は NotFound", () => {
    expect(() => f.service.changeStock(999, "IN", 1, f.actor)).toThrow(NotFoundError);
    expect(f.service.allHistories()).toHaveLength(0);
  });

  it("入力者が空なら名前なし・IP付きで記録できる（リストに無い人）", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.changeStock(p.id, "OUT", 1, { userName: "", clientIp: "192.168.0.151" });
    expect(f.service.recentHistories(1)[0]).toMatchObject({ userName: "", clientIp: "192.168.0.151" });
    f.service.changeStock(p.id, "TRANSFER", 1, { userName: "  ", clientIp: "192.168.0.151" }, { destination: "製造部" });
    expect(f.service.recentHistories(1)[0]).toMatchObject({ type: "TRANSFER", userName: "" });
  });

  it("登録されていない名前・無効な名前での入出庫は拒否する", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "IN", 1, { userName: "知らない人", clientIp: "x" })).toThrow(/入力者/);
  });

  it("商品の登録は名前が必須（IP だけでは不可）", () => {
    expect(() => f.service.registerProduct(input(), keep, { userName: "", clientIp: "x" })).toThrow(/入力者/);
  });

  it("入出庫では version を変えない（編集中の人の保存を妨げない）", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.changeStock(p.id, "IN", 1, f.actor);
    expect(f.service.getProduct(p.id).version).toBe(p.version);
  });
});

describe("入庫の理由", () => {
  it("決まった選択肢で記録し、未指定は null、入庫以外では無視する", () => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    for (const r of ["購入", "戻り", "その他"]) {
      f.service.changeStock(p.id, "IN", 1, f.actor, { reason: r });
      expect(f.service.recentHistories(1)[0]!.reason).toBe(r);
    }
    f.service.changeStock(p.id, "IN", 1, f.actor);
    expect(f.service.recentHistories(1)[0]!.reason).toBeNull();
    f.service.changeStock(p.id, "OUT", 1, f.actor, { reason: "購入" });
    expect(f.service.recentHistories(1)[0]!.reason).toBeNull();
  });

  it("選択肢に無い理由は在庫を変えずに拒否する", () => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "IN", 1, f.actor, { reason: "盗難" })).toThrow(/購入・戻り・その他/);
    expect(() => f.service.changeStock(p.id, "IN", 1, f.actor, { reason: 1 })).toThrow(/購入・戻り・その他/);
    expect(f.service.getProduct(p.id).stock).toBe(10);
  });
});

describe("在庫調整（棚卸し）", () => {
  it("在庫を指定の数に合わせ、差と理由を履歴に残す", () => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    expect(f.service.adjustStock(p.id, 7, 10, f.actor, " 棚卸し ").stock).toBe(7);
    expect(f.service.recentHistories(1)[0]).toMatchObject({ type: "ADJUST", quantity: 3, stockAfter: 7, comment: "棚卸し（-3）" });
    f.service.adjustStock(p.id, 12, 7, f.actor, "見落とし分");
    expect(f.service.recentHistories(1)[0]).toMatchObject({ quantity: 5, stockAfter: 12, comment: "見落とし分（+5）" });
    expect(f.service.adjustStock(p.id, 0, 12, f.actor, "全数破損").stock).toBe(0);
  });

  it("画面表示後に他の端末で在庫が変わっていたら上書きしない", () => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    f.service.changeStock(p.id, "OUT", 2, f.actor);
    expect(() => f.service.adjustStock(p.id, 9, 10, f.actor, "棚卸し")).toThrow(ConflictError);
    expect(f.service.getProduct(p.id).stock).toBe(8);
  });

  it.each([
    ["負の数", -1, "棚卸し", /0〜/],
    ["上限超え", Rules.maxStock + 1, "棚卸し", /0〜/],
    ["小数", 1.5, "棚卸し", /整数/],
    ["文字列", "5", "棚卸し", /整数/],
    ["理由なし", 5, "  ", /理由/],
    ["理由が長すぎる", 5, "x".repeat(Rules.commentMaxLength + 1), /文字以内/],
    ["同じ数", 10, "棚卸し", /同じ数/],
  ])("%s は拒否する", (_l, target, reason, msg) => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    expect(() => f.service.adjustStock(p.id, target, 10, f.actor, reason)).toThrow(msg);
    expect(f.service.getProduct(p.id).stock).toBe(10);
  });

  it("登録済みの名前が必要（IP だけでは不可）・存在しない商品は NotFound", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    expect(() => f.service.adjustStock(p.id, 1, 10, { userName: "", clientIp: "x" }, "棚卸し")).toThrow(/入力者/);
    expect(() => f.service.adjustStock(999, 1, undefined, f.actor, "棚卸し")).toThrow(NotFoundError);
  });
});

describe("移管", () => {
  it("在庫を減らし、移管先を履歴に残す", () => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    expect(f.service.changeStock(p.id, "TRANSFER", 4, f.actor, { destination: " 製造部 " }).stock).toBe(6);
    expect(f.service.recentHistories(1)[0]).toMatchObject({ type: "TRANSFER", quantity: 4, stockAfter: 6, destination: "製造部" });
  });

  it("移管先が空・長すぎる場合は拒否する", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "TRANSFER", 1, f.actor, { destination: "  " })).toThrow(/移管先/);
    expect(() => f.service.changeStock(p.id, "TRANSFER", 1, f.actor)).toThrow(/移管先/);
    expect(() => f.service.changeStock(p.id, "TRANSFER", 1, f.actor, { destination: "x".repeat(Rules.destinationMaxLength + 1) })).toThrow(/文字以内/);
    expect(f.service.getProduct(p.id).stock).toBe(10);
  });

  it("在庫を超える移管は拒否する", () => {
    const p = f.service.registerProduct(input({ initialStock: 2 }), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "TRANSFER", 3, f.actor, { destination: "製造部" })).toThrow(/移管数/);
  });

  it("入出庫では移管先を記録しない", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.changeStock(p.id, "IN", 1, f.actor, { destination: "無視される" });
    expect(f.service.recentHistories(1)[0]!.destination).toBeNull();
  });

  it("移管先の候補はよく使う順", () => {
    const p = f.service.registerProduct(input({ initialStock: 100 }), keep, f.actor);
    f.service.changeStock(p.id, "TRANSFER", 1, f.actor, { destination: "A部" });
    f.service.changeStock(p.id, "TRANSFER", 1, f.actor, { destination: "B部" });
    f.service.changeStock(p.id, "TRANSFER", 1, f.actor, { destination: "B部" });
    expect(f.service.recentDestinations()).toEqual(["B部", "A部"]);
  });
});

describe("コメント・備考", () => {
  it("入出庫・移管のコメントを記録する（任意・改行は1行に・空は null）", () => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    f.service.changeStock(p.id, "OUT", 1, f.actor, { comment: " 修理用\r\n至急 " });
    expect(f.service.recentHistories(1)[0]!.comment).toBe("修理用 至急");
    f.service.changeStock(p.id, "TRANSFER", 1, f.actor, { destination: "製造部", comment: "貸出" });
    expect(f.service.recentHistories(1)[0]).toMatchObject({ destination: "製造部", comment: "貸出" });
    f.service.changeStock(p.id, "IN", 1, f.actor, { comment: "  " });
    expect(f.service.recentHistories(1)[0]!.comment).toBeNull();
  });

  it("コメントが長すぎる場合は在庫を変えずに拒否する", () => {
    const p = f.service.registerProduct(input({ initialStock: 10 }), keep, f.actor);
    expect(() => f.service.changeStock(p.id, "OUT", 1, f.actor, { comment: "x".repeat(Rules.commentMaxLength + 1) })).toThrow(/コメント/);
    expect(f.service.getProduct(p.id).stock).toBe(10);
    f.service.changeStock(p.id, "OUT", 1, f.actor, { comment: "x".repeat(Rules.commentMaxLength) });
  });

  it("商品の備考は複数行を保持し、変更を操作ログに残す", () => {
    const p = f.service.registerProduct(input({ note: " 棚卸ドル払い\r\n円払い別 " }), keep, f.actor);
    expect(p.note).toBe("棚卸ドル払い\n円払い別");
    f.service.updateProduct(p.id, input({ note: "" }), p.version, keep, f.actor);
    expect(f.service.getProduct(p.id).note).toBe("");
    expect(f.service.auditLogs(1)[0]!.detail).toContain("備考を変更");
    expect(() => f.service.registerProduct(input({ code: "B", note: "x".repeat(Rules.noteMaxLength + 1) }), keep, f.actor)).toThrow(/備考/);
  });
});

describe("概要", () => {
  it("登録・更新でき、検索対象になり、変更を操作ログに残す", () => {
    const p = f.service.registerProduct(input({ summary: " 同軸ケーブルの\r\n先端に付けるコネクタ " }), keep, f.actor);
    expect(p.summary).toBe("同軸ケーブルの\n先端に付けるコネクタ");
    expect(f.service.searchProducts("せんたん")).toHaveLength(0); // 漢字はかなに変換しない
    expect(f.service.searchProducts("先端")).toHaveLength(1);
    expect(f.service.searchProducts("こねくた")).toHaveLength(1);
    f.service.updateProduct(p.id, input({ summary: "" }), p.version, keep, f.actor);
    expect(f.service.auditLogs(1)[0]!.detail).toContain("概要を変更");
    expect(() => f.service.registerProduct(input({ code: "B", summary: "x".repeat(Rules.summaryMaxLength + 1) }), keep, f.actor)).toThrow(/概要/);
  });
});

describe("保管場所", () => {
  it("登録・更新でき、改行は1行にまとめ、変更を操作ログに残す", () => {
    const p = f.service.registerProduct(input({ location: " 上段A-1,\r\n上段B-1 " }), keep, f.actor);
    expect(p.location).toBe("上段A-1, 上段B-1");
    const u = f.service.updateProduct(p.id, input({ location: "倉庫" }), p.version, keep, f.actor);
    expect(u.location).toBe("倉庫");
    expect(f.service.auditLogs(1)[0]!.detail).toContain("保管場所: 上段A-1, 上段B-1 → 倉庫");
  });

  it("長すぎる場合は拒否、未指定なら空", () => {
    expect(() => f.service.registerProduct(input({ location: "x".repeat(Rules.locationMaxLength + 1) }), keep, f.actor)).toThrow(/保管場所/);
    expect(f.service.registerProduct(input({ code: "B" }), keep, f.actor).location).toBe("");
  });
});

describe("商品更新", () => {
  it("在庫数は変えず、他の項目を更新して version を上げる", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    const u = f.service.updateProduct(p.id, input({ name: "青りんご", warningStock: 5, initialStock: 999 }), p.version, keep, f.actor);
    expect(u).toMatchObject({ name: "青りんご", warningStock: 5, stock: 10, version: p.version + 1 });
  });

  it("古い version での更新は Conflict（他の人が先に更新した）", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.updateProduct(p.id, input({ name: "1回目" }), p.version, keep, f.actor);
    expect(() => f.service.updateProduct(p.id, input({ name: "2回目" }), p.version, keep, f.actor)).toThrow(ConflictError);
    expect(f.service.getProduct(p.id).name).toBe("1回目");
  });

  it("version 未指定は拒否する", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    expect(() => f.service.updateProduct(p.id, input(), undefined, keep, f.actor)).toThrow(/バージョン/);
  });

  it("自分のコードはそのまま使え、他商品のコードは使えない", () => {
    const a = f.service.registerProduct(input({ code: "A" }), keep, f.actor);
    f.service.registerProduct(input({ code: "B" }), keep, f.actor);
    const a2 = f.service.updateProduct(a.id, input({ code: "A", name: "x" }), a.version, keep, f.actor);
    expect(() => f.service.updateProduct(a.id, input({ code: "B" }), a2.version, keep, f.actor)).toThrow(/既に登録/);
  });

  it("商品名を変えても過去の履歴の商品名は変わらない", () => {
    const p = f.service.registerProduct(input({ name: "りんご" }), keep, f.actor);
    f.service.updateProduct(p.id, input({ name: "青りんご" }), p.version, keep, f.actor);
    expect(f.service.allHistories()[0]!.productName).toBe("りんご");
  });

  it("画像を差し替えると保存後に古い画像を消す", () => {
    const first = f.images.saveUpload(JPEG);
    const p = f.service.registerProduct(input(), { action: "replace", uploadId: first }, f.actor);
    const second = f.images.saveUpload(PNG);
    f.service.updateProduct(p.id, input(), p.version, { action: "replace", uploadId: second }, f.actor);
    expect(imageFiles(f.dir)).toEqual([second]);
  });

  it("画像を外すと null になり、ファイルも消える", () => {
    const first = f.images.saveUpload(JPEG);
    const p = f.service.registerProduct(input(), { action: "replace", uploadId: first }, f.actor);
    const u = f.service.updateProduct(p.id, input(), p.version, { action: "remove" }, f.actor);
    expect(u.imageFile).toBeNull();
    expect(imageFiles(f.dir)).toEqual([]);
  });

  it("更新に失敗したら、新しい画像を消して古い画像は残す", () => {
    const first = f.images.saveUpload(JPEG);
    const p = f.service.registerProduct(input(), { action: "replace", uploadId: first }, f.actor);
    const second = f.images.saveUpload(PNG);
    expect(() =>
      f.service.updateProduct(p.id, input(), p.version + 1, { action: "replace", uploadId: second }, f.actor),
    ).toThrow(ConflictError);
    expect(imageFiles(f.dir)).toEqual([first]);
    expect(f.service.getProduct(p.id).imageFile).toBe(first);
  });

  it("変更内容を操作ログに残す", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.updateProduct(p.id, input({ name: "青りんご" }), p.version, keep, f.actor);
    const [log] = f.service.auditLogs(1);
    expect(log).toMatchObject({ action: "PRODUCT_UPDATE", target: "A001", userName: "山田", clientIp: "192.168.1.10" });
    expect(log!.detail).toContain("りんご → 青りんご");
  });
});

describe("商品削除", () => {
  it("履歴と操作ログは残し、画像は消す", () => {
    const uploadId = f.images.saveUpload(JPEG);
    const p = f.service.registerProduct(input(), { action: "replace", uploadId }, f.actor);
    f.service.deleteProduct(p.id, p.version, f.actor);

    expect(() => f.service.getProduct(p.id)).toThrow(NotFoundError);
    expect(f.service.allHistories()).toHaveLength(1);
    expect(f.service.auditLogs(1)[0]!.action).toBe("PRODUCT_DELETE");
    expect(imageFiles(f.dir)).toEqual([]);
  });

  it("二重削除は NotFound、古い version での削除は Conflict", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    const u = f.service.updateProduct(p.id, input({ name: "x" }), p.version, keep, f.actor);
    expect(() => f.service.deleteProduct(p.id, p.version, f.actor)).toThrow(ConflictError);
    f.service.deleteProduct(p.id, u.version, f.actor);
    expect(() => f.service.deleteProduct(p.id, u.version, f.actor)).toThrow(NotFoundError);
  });

  it("削除後に同じコードで再登録でき、ID は再利用されない", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.deleteProduct(p.id, p.version, f.actor);
    expect(f.service.registerProduct(input(), keep, f.actor).id).not.toBe(p.id);
  });
});

describe("参照", () => {
  it.each([
    ["a00", 1],
    ["Ａ００", 1],
    ["果物", 2],
    ["みかん", 1],
    ["A001", 1],
    ["A-001", 1], // ハイフンは無視
    ["A0-01", 1],
    ["  ", 2],
    ["該当なし", 0],
  ])("検索 '%s' → %i 件", (keyword, count) => {
    f.service.registerProduct(input({ code: "A001", name: "りんご" }), keep, f.actor);
    f.service.registerProduct(input({ code: "B001", name: "みかん" }), keep, f.actor);
    expect(f.service.searchProducts(keyword)).toHaveLength(count);
  });

  it("コードでの検索（スキャン結果）は全角でも一致し、無ければ null", () => {
    f.service.registerProduct(input({ code: "4901234567894" }), keep, f.actor);
    expect(f.service.findByCode("４９０１２３４５６７８９４")?.code).toBe("4901234567894");
    expect(f.service.findByCode("000")).toBeNull();
    f.service.registerProduct(input({ code: "AP-00001", name: "x" }), keep, f.actor);
    expect(f.service.findByCode("ap-00001")?.code).toBe("AP-00001");
    expect(f.service.findByCode("AP00001")?.code).toBe("AP-00001");
    expect(f.service.findByCode("ａｐ－００００１")?.code).toBe("AP-00001");
    expect(f.service.findByCode("AP‐00001")?.code).toBe("AP-00001"); // U+2010 ハイフン
    expect(f.service.findByCode("")).toBeNull();
  });

  it("在庫警告は在庫が警告在庫以下の商品を少ない順に返す", () => {
    f.service.registerProduct(input({ code: "A", name: "ちょうど", initialStock: 3, warningStock: 3 }), keep, f.actor);
    f.service.registerProduct(input({ code: "B", name: "下回る", initialStock: 1, warningStock: 3 }), keep, f.actor);
    f.service.registerProduct(input({ code: "C", name: "余裕", initialStock: 4, warningStock: 3 }), keep, f.actor);
    expect(f.service.lowStockProducts().map((p) => p.name)).toEqual(["下回る", "ちょうど"]);
  });

  it("ハイフンの違いだけのコードが複数ある場合は決めずに null", () => {
    f.service.registerProduct(input({ code: "AB-1" }), keep, f.actor);
    f.service.registerProduct(input({ code: "A-B1", name: "別" }), keep, f.actor);
    expect(f.service.findByCode("AB1")).toBeNull();
    expect(f.service.findByCode("A-B1")?.code).toBe("A-B1"); // 完全一致は優先
  });

  it.each([
    ["こねくた", 1],
    ["コネクタ", 1],
    ["ｺﾈｸﾀ", 1], // 半角カナ
    ["ぷろーぶ", 1], // 長音はそのまま一致
    ["けーぶる", 1],
    ["ケーブル用", 1],
    ["こねくたー", 0], // 長音の有無は別の文字として扱う
  ])("ひらがな・カタカナを区別しない: %s → %i 件", (keyword, count) => {
    f.service.registerProduct(input({ code: "C1", name: "SMAコネクタ ケーブル用", category: "" }), keep, f.actor);
    f.service.registerProduct(input({ code: "P1", name: "プローブ", category: "" }), keep, f.actor);
    expect(f.service.searchProducts(keyword)).toHaveLength(count);
  });

  it("商品名の型式もハイフン無視で検索できる", () => {
    f.service.registerProduct(input({ code: "AP-00001", name: "プローブチップ APT（72A-C4/035）" }), keep, f.actor);
    expect(f.service.searchProducts("72AC4")).toHaveLength(1);
    expect(f.service.searchProducts("ap00001")).toHaveLength(1);
  });

  it("最近の履歴は新しい順で件数を制限する", () => {
    const p = f.service.registerProduct(input({ initialStock: 0 }), keep, f.actor);
    for (let i = 1; i <= 5; i++) {
      f.clock.advance(1);
      f.service.changeStock(p.id, "IN", i, f.actor);
    }
    expect(f.service.recentHistories(2).map((h) => h.quantity)).toEqual([5, 4]);
    expect(f.service.recentHistories(0)).toEqual([]);
    expect(f.service.recentHistories(10, p.id)).toHaveLength(5);
  });
});

describe("入力者", () => {
  it("追加・名前変更・無効化ができ、無効な人は一覧に出ない", () => {
    const u = f.service.createUser(" 鈴木 ", f.actor);
    expect(u.name).toBe("鈴木");
    f.service.updateUser(u.id, { name: "鈴木一郎" }, f.actor);
    f.service.updateUser(u.id, { active: false }, f.actor);
    expect(f.service.listUsers().map((x) => x.name)).toEqual(["山田"]);
    expect(f.service.listUsers(true).map((x) => x.name)).toEqual(["山田", "鈴木一郎"]);
  });

  it("同じ名前・空の名前・長すぎる名前は拒否する", () => {
    expect(() => f.service.createUser("山田", f.actor)).toThrow(/既に登録/);
    expect(() => f.service.createUser("  ", f.actor)).toThrow(/名前を入力/);
    expect(() => f.service.createUser("x".repeat(Rules.userNameMaxLength + 1), f.actor)).toThrow(/文字以内/);
  });
});
