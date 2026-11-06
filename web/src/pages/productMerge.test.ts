import { describe, expect, it } from "vitest";
import type { Product } from "../../../shared/types";
import { displayValue, fieldsOf, mergeProduct, type EditableFields } from "./productMerge";

const product: Product = {
  id: 1,
  code: "A001",
  name: "りんご",
  category: "果物",
  location: "上段A-1",
  summary: "",
  note: "",
  stock: 10,
  warningStock: 3,
  imageFile: "a.jpg",
  suppliers: [{ name: "青果店", url: "" }],
  offBook: false,
  version: 1,
  createdAt: "",
  updatedAt: "",
};
const base = fieldsOf(product);
const edit = (change: Partial<EditableFields>): EditableFields => ({ ...base, ...change });

describe("保存がぶつかったときの合わせ方", () => {
  it("違う項目を変えたなら、相手の変更を取り込み、自分の変更も残す", () => {
    const r = mergeProduct(base, edit({ note: "自分の備考" }), edit({ location: "下段B-2" }));
    expect(r.conflicts).toEqual([]);
    expect(r.taken).toEqual(["location"]);
    expect(r.merged).toMatchObject({ note: "自分の備考", location: "下段B-2" });
  });

  it("同じ項目を違う値に変えたら、ぶつかった項目として返す（値は自分のまま）", () => {
    const r = mergeProduct(base, edit({ name: "青りんご" }), edit({ name: "赤りんご", category: "食品" }));
    expect(r.conflicts).toEqual(["name"]);
    expect(r.taken).toEqual(["category"]);
    expect(r.merged).toMatchObject({ name: "青りんご", category: "食品" });
  });

  it("同じ値に変えたならぶつからない（前後の空白・全角半角・カンマの違いは同じとみなす）", () => {
    expect(mergeProduct(base, edit({ name: "青りんご " }), edit({ name: "青りんご" })).conflicts).toEqual([]);
    expect(mergeProduct(base, edit({ code: "Ａ００２" }), edit({ code: "A002" })).conflicts).toEqual([]);
    expect(mergeProduct(base, edit({ warningStock: "1,000" }), edit({ warningStock: "1000" })).conflicts).toEqual([]);
  });

  it("相手が何も変えていなければ何もしない", () => {
    expect(mergeProduct(base, edit({ name: "x" }), base)).toEqual({ merged: { ...edit({ name: "x" }) }, taken: [], conflicts: [] });
  });

  it("簿外・購入元も項目ごとに合わせる", () => {
    const r = mergeProduct(base, edit({ offBook: true }), edit({ suppliers: [{ name: "新しい店", url: "https://example.com" }] }));
    expect(r.conflicts).toEqual([]);
    expect(r.merged.offBook).toBe(true);
    expect(r.merged.suppliers).toEqual([{ name: "新しい店", url: "https://example.com" }]);
    expect(mergeProduct(base, edit({ suppliers: [] }), edit({ suppliers: [{ name: "別", url: "" }] })).conflicts).toEqual(["suppliers"]);
  });

  it("画像：自分が変えていなければ相手の画像を使い、両方が変えたらぶつかる", () => {
    const theirs = edit({ imageFile: "b.jpg" });
    const r1 = mergeProduct(base, base, theirs);
    expect(r1).toMatchObject({ taken: ["image"], conflicts: [] });
    expect(r1.merged.imageFile).toBe("b.jpg");
    const r2 = mergeProduct(base, edit({ image: "changed" }), theirs);
    expect(r2.conflicts).toEqual(["image"]);
    expect(mergeProduct(base, edit({ image: "changed" }), base).conflicts).toEqual([]);
  });

  it("表示用の値", () => {
    expect(displayValue("note", edit({ note: "  " }))).toBe("（空欄）");
    expect(displayValue("offBook", edit({ offBook: true }))).toBe("簿外");
    expect(displayValue("suppliers", edit({ suppliers: [] }))).toBe("（なし）");
    expect(displayValue("image", edit({ imageFile: null }))).toBe("画像なし");
  });
});
