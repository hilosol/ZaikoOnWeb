import { describe, expect, it } from "vitest";
import type { Product } from "../../../shared/types";
import { suggestProducts } from "./suggest";

const p = (code: string, name = "", summary = ""): Product => ({
  id: 0, code, name, summary, category: "", location: "", note: "", stock: 0, warningStock: 0,
  imageFile: null, suppliers: [], offBook: false, version: 1, createdAt: "", updatedAt: "",
});

const products = [
  p("AP-00010", "プローブチップ APT"),
  p("AP-00001", "プローブチップ APT"),
  p("A10", "SMA ジョイント"),
  p("A2", "SMS コネクタ"),
  p("HP-00001", "コネクタ ケーブル用", "APT用の部品"),
  p("XAP1", "その他"),
];

const codes = (q: string, limit?: number) => suggestProducts(products, q, limit).map((x) => x.code);

describe("ID の候補", () => {
  it("一致 → 前方一致 → 部分一致 → 名前・概要 の順、同順位は自然順", () => {
    expect(codes("ap000")).toEqual(["AP-00001", "AP-00010"]);
    expect(codes("apt")).toEqual(["AP-00001", "AP-00010", "HP-00001"]); // 名前・概要
    expect(codes("A")).toEqual(["A2", "A10", "AP-00001", "AP-00010", "XAP1", "HP-00001"]); // HP-00001 は概要の一致なので最後
  });

  it("数字の先頭の 0 を省略して入力できる", () => {
    expect(codes("ap1")).toEqual(["AP-00001", "AP-00010", "XAP1"]); // 一致 → 前方一致 → 部分一致
    expect(codes("hp1")).toEqual(["HP-00001"]);
    expect(codes("a1")).toEqual(["A10"]); // A10 は 0 を省略しても A10
  });

  it("完全一致を最上位にする", () => {
    expect(codes("a2")[0]).toBe("A2");
    expect(codes("AP-00001")[0]).toBe("AP-00001");
  });

  it("ひらがな・全角でも候補を出す", () => {
    expect(codes("こねくた")).toEqual(["A2", "HP-00001"]);
    expect(codes("ＨＰ")).toEqual(["HP-00001"]);
  });

  it("空・該当なしは空、件数の上限", () => {
    expect(codes("  ")).toEqual([]);
    expect(codes("zzz")).toEqual([]);
    expect(codes("a", 2)).toHaveLength(2);
  });
});
