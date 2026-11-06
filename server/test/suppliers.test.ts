import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rules, type ProductInput } from "../../shared/types.js";
import { ValidationError } from "../src/errors.js";
import { normalizeSuppliers, parseHttpUrl } from "../src/suppliers.js";
import { createFixture, type Fixture } from "./helpers.js";

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

const detailsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).details ?? [];
  }
  throw new Error("ValidationError が発生しませんでした");
};

describe("購入元の入力チェック", () => {
  it("空行は捨て、前後の空白を除く", () => {
    expect(
      normalizeSuppliers([
        { name: " モノタロウ ", url: " https://www.monotaro.com/ " },
        { name: "", url: "" },
        { name: "近所の商店" },
      ]),
    ).toEqual([
      { name: "モノタロウ", url: "https://www.monotaro.com/" },
      { name: "近所の商店", url: "" },
    ]);
  });

  it("未指定（null / undefined）は空配列", () => {
    expect(normalizeSuppliers(undefined)).toEqual([]);
    expect(normalizeSuppliers(null)).toEqual([]);
  });

  it("スキーム省略の URL は https:// を補う", () => {
    expect(parseHttpUrl("www.amazon.co.jp/dp/123")).toBe("https://www.amazon.co.jp/dp/123");
    expect(parseHttpUrl("http://example.com")).toBe("http://example.com");
  });

  it.each(["javascript:alert(1)", "ftp://example.com/a", "file:///C:/a.txt", "https://", "abc", "https://exa mple.com", "data:text/html,x"])(
    "http/https 以外・不正な URL は拒否する: %s",
    (url) => {
      expect(parseHttpUrl(url)).toBeNull();
      expect(detailsOf(() => normalizeSuppliers([{ name: "A", url }]))[0]).toMatch(/1件目.*URL/);
    },
  );

  it("URL だけで名前が無い行はエラー（何件目か示す）", () => {
    expect(detailsOf(() => normalizeSuppliers([{ name: "A" }, { name: "", url: "https://example.com" }]))).toEqual([
      "購入元2件目：購入元の名前を入力してください。",
    ]);
  });

  it("件数・文字数の上限（境界値）", () => {
    const five = Array.from({ length: Rules.maxSuppliers }, (_, i) => ({ name: `店${i}` }));
    expect(normalizeSuppliers(five)).toHaveLength(Rules.maxSuppliers);
    expect(detailsOf(() => normalizeSuppliers([...five, { name: "6件目" }]))).toContain(`購入元は${Rules.maxSuppliers}件までです。`);

    expect(normalizeSuppliers([{ name: "あ".repeat(Rules.supplierNameMaxLength) }])).toHaveLength(1);
    expect(detailsOf(() => normalizeSuppliers([{ name: "あ".repeat(Rules.supplierNameMaxLength + 1) }]))[0]).toMatch(/名前は/);

    const base = "https://example.com/";
    const okUrl = base + "a".repeat(Rules.supplierUrlMaxLength - base.length);
    expect(normalizeSuppliers([{ name: "A", url: okUrl }])[0]!.url).toBe(okUrl);
    expect(detailsOf(() => normalizeSuppliers([{ name: "A", url: okUrl + "a" }]))[0]).toMatch(/URL は500文字以内/);
  });

  it("配列でない・要素がオブジェクトでない場合は拒否する", () => {
    expect(() => normalizeSuppliers("モノタロウ")).toThrow(ValidationError);
    expect(detailsOf(() => normalizeSuppliers(["モノタロウ"]))[0]).toMatch(/1件目の形式/);
  });

  it("名前の改行は1行にまとめる", () => {
    expect(normalizeSuppliers([{ name: "A\r\n商店" }])[0]!.name).toBe("A 商店");
  });
});

describe("購入元の保存", () => {
  const two = [
    { name: "モノタロウ", url: "https://www.monotaro.com/" },
    { name: "近所の商店", url: "" },
  ];

  it("登録時に順番どおり保存し、検索・ID 検索・警告一覧でも返す", () => {
    const p = f.service.registerProduct(input({ suppliers: two, initialStock: 1 }), keep, f.actor);
    expect(p.suppliers).toEqual(two);
    expect(f.service.getProduct(p.id).suppliers).toEqual(two);
    expect(f.service.searchProducts()[0]!.suppliers).toEqual(two);
    expect(f.service.findByCode("a001")!.suppliers).toEqual(two);
    expect(f.service.lowStockProducts()[0]!.suppliers).toEqual(two);
  });

  it("購入元なしの商品は空配列（他の商品の購入元が混ざらない）", () => {
    f.service.registerProduct(input({ suppliers: two }), keep, f.actor);
    const b = f.service.registerProduct(input({ code: "B001", name: "みかん" }), keep, f.actor);
    expect(b.suppliers).toEqual([]);
    expect(f.service.searchProducts().map((p) => p.suppliers.length)).toEqual([2, 0]);
  });

  it("更新で並べ替え・削除でき、監査ログに残る", () => {
    const p = f.service.registerProduct(input({ suppliers: two }), keep, f.actor);
    const after = f.service.updateProduct(p.id, input({ suppliers: [two[1]!] }), p.version, keep, f.actor);
    expect(after.suppliers).toEqual([two[1]]);
    expect(after.version).toBe(p.version + 1);
    expect(f.service.auditLogs(1)[0]!.detail).toBe("購入元: 近所の商店");

    const cleared = f.service.updateProduct(p.id, input({ suppliers: [] }), after.version, keep, f.actor);
    expect(cleared.suppliers).toEqual([]);
    expect(f.service.auditLogs(1)[0]!.detail).toBe("購入元: なし");
  });

  it("購入元を省略した更新では変更しない", () => {
    const p = f.service.registerProduct(input({ suppliers: two }), keep, f.actor);
    const after = f.service.updateProduct(p.id, input({ name: "青りんご" }), p.version, keep, f.actor);
    expect(after.suppliers).toEqual(two);
  });

  it("入力エラーは他の項目のエラーとまとめて返し、何も保存しない", () => {
    const details = detailsOf(() =>
      f.service.registerProduct(input({ name: "", suppliers: [{ name: "A", url: "javascript:x" }] }), keep, f.actor),
    );
    expect(details).toHaveLength(2);
    expect(f.service.searchProducts()).toHaveLength(0);
  });

  it("商品を削除すると購入元も消える", () => {
    const p = f.service.registerProduct(input({ suppliers: two }), keep, f.actor);
    f.service.deleteProduct(p.id, p.version, f.actor);
    const row = f.db.prepare("SELECT COUNT(*) AS n FROM product_suppliers").get() as { n: number };
    expect(Number(row.n)).toBe(0);
  });

  it("CSV 取り込みで商品を更新しても購入元は消えない", () => {
    const p = f.service.registerProduct(input({ suppliers: two }), keep, f.actor);
    f.service.importProducts("商品コード,商品名,カテゴリ,警告在庫\nA001,りんご改,果物,3\n", false, f.actor);
    const after = f.service.getProduct(p.id);
    expect(after.name).toBe("りんご改");
    expect(after.suppliers).toEqual(two);
  });
});
