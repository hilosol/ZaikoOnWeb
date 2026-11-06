import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rules, type ProductInput } from "../../shared/types.js";
import { ValidationError } from "../src/errors.js";
import { mapColumns, parseCsv, productsToCsv, unescapeCsvText } from "../src/productCsv.js";
import { createFixture, type Fixture } from "./helpers.js";

describe("CSV の解析", () => {
  it("引用符・カンマ・改行・\"\"・BOM・空行に対応し、元の行番号を返す", () => {
    const rows = parseCsv('﻿a,b,c\r\n"x,y","1行目\n2行目","5"""\r\n\r\nlast,,\n');
    expect(rows).toEqual([
      { line: 1, cells: ["a", "b", "c"] },
      { line: 2, cells: ["x,y", "1行目\n2行目", '5"'] },
      { line: 5, cells: ["last", "", ""] },
    ]);
  });

  it("最終行に改行が無くても読める", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["1", "2"] },
    ]);
  });

  it("閉じていない引用符はエラー", () => {
    expect(() => parseCsv('a,b\n"x,1\n')).toThrow(/2行目.*引用符/);
  });

  it("数式対策の ' を外す（それ以外の ' は残す）", () => {
    expect(unescapeCsvText("'=1+1")).toBe("=1+1");
    expect(unescapeCsvText("'-5")).toBe("-5");
    expect(unescapeCsvText("'abc")).toBe("'abc");
  });

  it("見出しの表記ゆれを吸収し、知らない列は無視・同じ項目の重複は検出", () => {
    const m = mapColumns(["ＩＤ", "商品名", "カテゴリー", "場所", " 閾値 ", "型式", "在庫", "在庫数"]);
    expect(m.index).toMatchObject({ code: 0, name: 1, category: 2, location: 3, warningStock: 4, stock: 6 });
    expect(m.ignored).toEqual(["型式"]);
    expect(m.duplicated).toEqual(["在庫"]);
  });
});

describe("在庫CSVの出力・取り込み", () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
  });
  afterEach(() => f.cleanup());

  const keep = { action: "keep" } as const;
  const reg = (over: Partial<ProductInput> = {}) =>
    f.service.registerProduct(
      { code: "A001", name: "りんご", category: "果物", warningStock: 3, initialStock: 10, location: "上段A-1", ...over },
      keep,
      f.actor,
    );
  const imp = (csv: string, dryRun = false) => f.service.importProducts(csv, dryRun, f.actor);
  const HEADER = "商品ID,商品名,概要,カテゴリ,保管場所,在庫,警告在庫,備考";

  it("出力した CSV をそのまま取り込むと変更なし（往復できる）", () => {
    reg({ summary: "赤い,果物", note: "1行目\n2行目" });
    reg({ code: "-B", name: "=SUM(1)", initialStock: 0 });
    const csv = productsToCsv(f.service.searchProducts());
    expect(csv.startsWith("﻿" + HEADER)).toBe(true);
    const r = imp(csv);
    expect(r).toMatchObject({ dryRun: false, created: 0, updated: 0, unchanged: 2, errors: [] });
  });

  it("確認のみ（dryRun）では DB を変えない", () => {
    reg();
    const r = imp(`${HEADER}\nA001,りんご改,,果物,上段A-1,7,3,\nN1,新商品,,,,5,1,`, true);
    expect(r).toMatchObject({ dryRun: true, created: 1, updated: 1, stockAdjusted: 1 });
    expect(f.service.searchProducts()).toHaveLength(1);
    expect(f.service.getProduct(1).stock).toBe(10);
  });

  it("新規登録・上書き・在庫の棚卸調整を履歴付きで反映する", () => {
    const p = reg();
    const r = imp(`${HEADER}\nA001,りんご改,説明,果物,倉庫,7,2,メモ\nN1,新商品,,資材,,5,1,`);
    expect(r).toMatchObject({ dryRun: false, created: 1, updated: 1, stockAdjusted: 1, unchanged: 0 });

    const u = f.service.getProduct(p.id);
    expect(u).toMatchObject({ name: "りんご改", summary: "説明", location: "倉庫", stock: 7, warningStock: 2, note: "メモ", version: p.version + 1 });
    const n = f.service.findByCode("N1")!;
    expect(n).toMatchObject({ name: "新商品", category: "資材", stock: 5 });

    const [init, adjust] = f.service.recentHistories(2);
    expect(adjust).toMatchObject({ productId: p.id, type: "ADJUST", quantity: 3, stockAfter: 7, comment: "CSV取込 -3" });
    expect(init).toMatchObject({ productId: n.id, type: "INIT", quantity: 5, comment: "CSV取込" });
    expect(f.service.auditLogs(1)[0]).toMatchObject({ action: "PRODUCT_IMPORT", userName: "山田" });
  });

  it("CSV に無い列・空欄の在庫は変更しない。CSV に無い商品も変更しない", () => {
    reg();
    reg({ code: "B", name: "みかん" });
    const r = imp("商品ID,保管場所,在庫\nA001,倉庫,");
    expect(r.updated).toBe(1);
    expect(f.service.getProduct(1)).toMatchObject({ name: "りんご", location: "倉庫", stock: 10, category: "果物" });
    expect(f.service.findByCode("B")!.name).toBe("みかん");
  });

  it("1行でもエラーがあれば何も反映せず、行番号付きでエラーを返す", () => {
    reg();
    const r = imp(`${HEADER}\nA001,りんご改,,,,abc,3,\n,名前,,,,1,1,\nN1,,,,,1,1,\nN2,x,,,,-1,0,\nA001,重複,,,,1,1,`);
    expect(r.dryRun).toBe(true);
    expect(r.errors.map((e) => [e.line, e.messages[0]])).toEqual([
      [2, "在庫は整数で入力してください（「abc」）。"],
      [3, "商品IDが空です。"],
      [4, "商品名を入力してください。"],
      [5, `在庫は0〜${Rules.maxStock.toLocaleString("ja-JP")}の範囲で入力してください（「-1」）。`],
      [6, "2行目と商品IDが重複しています。"],
    ]);
    expect(f.service.getProduct(1).name).toBe("りんご");
  });

  it("全角数字・カンマ付きの数・全角コード・数式対策の ' を解釈する", () => {
    reg();
    imp(`商品ID,在庫,警告在庫,商品名\nＡ００１,"１,０００",５,'=りんご`);
    expect(f.service.getProduct(1)).toMatchObject({ stock: 1000, warningStock: 5, name: "=りんご" });
  });

  it("商品IDの列が無い・新規なのに商品名の列が無い・空・行数超過はエラー", () => {
    expect(() => imp("名前,在庫\nx,1")).toThrow(/商品ID/);
    expect(imp("商品ID,在庫\nNEW,1").errors[0]!.messages[0]).toMatch(/商品名/);
    expect(() => imp("")).toThrow(ValidationError);
    expect(() => imp("商品ID,商品名")).toThrow(/データ行/);
    const many = ["商品ID,商品名", ...Array.from({ length: Rules.maxImportRows + 1 }, (_, i) => `C${i},n`)].join("\n");
    expect(() => imp(many)).toThrow(/行まで/);
  });

  it("登録済みの名前が必要（IP だけでは取り込めない）", () => {
    expect(() => f.service.importProducts(`${HEADER}\nN,n,,,,1,1,`, false, { userName: "", clientIp: "x" })).toThrow(/入力者/);
  });

  it("最初の在庫表の形式（ID・カテゴリー・場所・閾値）も読める", () => {
    const r = imp("ID,カテゴリー,型式,商品名,場所,棚番号,在庫,閾値\nAP-00001,未分類,72A,プローブ,D-3,,91,90");
    expect(r.created).toBe(1);
    expect(r.ignoredColumns).toEqual(["型式", "棚番号"]);
    expect(f.service.findByCode("AP-00001")).toMatchObject({ location: "D-3", stock: 91, warningStock: 90 });
  });
});
