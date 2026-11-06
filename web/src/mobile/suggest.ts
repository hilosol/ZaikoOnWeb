import { searchKey } from "../../../shared/text";
import type { Product } from "../../../shared/types";

/** 数字の先頭の 0 を除く（"AP00028" → "AP28"）。「hp28」で HP-00028 を探せるようにする */
const dropLeadingZeros = (s: string) => s.replace(/(^|\D)0+(?=\d)/g, "$1");

/**
 * ID 入力欄の候補。検索と同じ規則（ハイフン・大文字小文字・全角半角・ひらがなカタカナを区別しない）に加え、
 * ID の数字の先頭の 0 も無視する（"ap1" → AP-00001）。
 * ID 一致 → ID 前方一致 → ID 部分一致 → 商品名・概要の部分一致 の順に並べる。同順位は ID の自然順（A2 < A10）。
 */
export function suggestProducts(products: readonly Product[], input: string, limit = 8): Product[] {
  const key = searchKey(input);
  if (!key) return [];
  const key0 = dropLeadingZeros(key);
  const ranked: { p: Product; rank: number }[] = [];
  for (const p of products) {
    const code = searchKey(p.code);
    const code0 = dropLeadingZeros(code);
    const rank =
      code === key || code0 === key0
        ? 0
        : code.startsWith(key) || code0.startsWith(key0)
          ? 1
          : code.includes(key) || code0.includes(key0)
            ? 2
            : searchKey(p.name).includes(key) || searchKey(p.summary).includes(key)
              ? 3
              : -1;
    if (rank >= 0) ranked.push({ p, rank });
  }
  const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  ranked.sort((a, b) => a.rank - b.rank || collator.compare(a.p.code, b.p.code));
  return ranked.slice(0, limit).map((r) => r.p);
}
