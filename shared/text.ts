/** 全角英数記号を半角にし、前後の空白を除く（商品コードや検索語の比較用）。 */
export function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim();
}

/** ハイフン類（全角は NFKC で半角になる。ほかにダッシュ・マイナス記号など）。長音「ー」は含めない */
const HYPHENS = /[-\u2010-\u2015\u2212]/g;

/** カタカナ（ァ〜ヶ）をひらがなにする。半角カナは normalizeText（NFKC）で全角になってから変換される。長音「ー」はそのまま */
function katakanaToHiragana(s: string): string {
  return s.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * 大文字小文字・全角半角・ハイフンの有無・ひらがなカタカナを区別しない比較キー
 * （サーバーと画面で同じ規則で検索するため共有）。
 * 例: "ap00001" と "AP-00001"、"72AC4" と "72A-C4/035"、"こねくた" と "コネクタ"（半角「ｺﾈｸﾀ」も）が一致する。
 */
export function searchKey(value: unknown): string {
  return katakanaToHiragana(normalizeText(value).toUpperCase().replace(HYPHENS, ""));
}

/** 前後の空白だけを除く（商品名など、全角を保ちたい項目用）。 */
export function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** 商品が検索語に一致するか（コード・商品名・カテゴリ・概要）。 */
export function matchesKeyword(
  item: { code: string; name: string; category: string; summary?: string },
  keyword: string,
): boolean {
  const key = searchKey(keyword);
  if (!key) return true;
  return (
    searchKey(item.code).includes(key) ||
    searchKey(item.name).includes(key) ||
    searchKey(item.category).includes(key) ||
    searchKey(item.summary ?? "").includes(key)
  );
}

/**
 * 読み取ったQR・バーコード（または入力）の内容から商品IDを取り出す。
 * QRにはスマホの標準カメラで開けるよう「http://共有PC:28003/m?id=AP-00001」のようなURLを入れているため、
 * URL なら id パラメータを取り出し、それ以外はそのまま（ID だけの QR・バーコード・手入力）返す。
 */
export function extractCode(raw: string): string {
  const text = (raw ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return text;
  try {
    const url = new URL(text);
    const id = url.searchParams.get("id");
    if (id) return id.trim();
  } catch {
    // URL として解釈できなければそのまま
  }
  return text;
}

/** 商品のスマホ用画面の URL（QR ラベルに入れる） */
export function productUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/m?id=${encodeURIComponent(code)}`;
}
