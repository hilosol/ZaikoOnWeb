import { normalizeText } from "../../../shared/text";
import type { Product, Supplier } from "../../../shared/types";

/**
 * 保存がぶつかったとき（他の人が先に同じ商品を保存した）に、項目ごとに内容を合わせる。
 *
 * - base   … 自分が編集画面を開いたときの内容
 * - mine   … 自分が入力した内容
 * - theirs … 他の人が保存した、今の内容
 *
 * 項目ごとに：
 * - 相手だけが変えた → 相手の値を取り込む
 * - 自分だけが変えた → 自分の値のまま
 * - 両方が同じ値に変えた → そのまま
 * - 両方が違う値に変えた → 「ぶつかった項目」として、どちらにするか利用者が選ぶ
 */

/** 合わせる対象の項目（在庫数は入出庫でしか変えないので対象外） */
export interface EditableFields {
  code: string;
  name: string;
  category: string;
  location: string;
  note: string;
  summary: string;
  warningStock: string;
  offBook: boolean;
  suppliers: Supplier[];
  /** 画像：keep = 開いたときのまま（＝今の画像を使う）、それ以外 = 自分が変えた */
  image: "keep" | "changed";
  /** 画像のファイル名（base・theirs で比べる） */
  imageFile: string | null;
}

export type FieldKey = Exclude<keyof EditableFields, "imageFile">;

export const FieldLabels: Record<FieldKey, string> = {
  code: "商品ID",
  name: "商品名",
  category: "カテゴリ",
  location: "保管場所",
  note: "備考",
  summary: "概要",
  warningStock: "警告在庫",
  offBook: "簿外",
  suppliers: "購入元",
  image: "画像",
};

const FIELDS = Object.keys(FieldLabels) as FieldKey[];

export function fieldsOf(p: Product): EditableFields {
  return {
    code: p.code,
    name: p.name,
    category: p.category,
    location: p.location,
    note: p.note,
    summary: p.summary,
    warningStock: String(p.warningStock),
    offBook: p.offBook,
    suppliers: p.suppliers,
    image: "keep",
    imageFile: p.imageFile,
  };
}

/** 比べるときの表記ゆれ（前後の空白・全角半角・カンマ区切りの数字）は同じとみなす */
function same(key: FieldKey, a: EditableFields, b: EditableFields): boolean {
  switch (key) {
    case "suppliers":
      return JSON.stringify(a.suppliers.map((s) => [s.name.trim(), s.url.trim()])) === JSON.stringify(b.suppliers.map((s) => [s.name.trim(), s.url.trim()]));
    case "offBook":
      return a.offBook === b.offBook;
    case "image":
      return a.image === b.image && a.imageFile === b.imageFile;
    case "code":
    case "warningStock":
      return normalizeText(String(a[key])).replace(/,/g, "") === normalizeText(String(b[key])).replace(/,/g, "");
    default:
      return String(a[key]).trim() === String(b[key]).trim();
  }
}

export interface MergeResult {
  /** 合わせた内容（ぶつかった項目は自分の値のまま） */
  merged: EditableFields;
  /** 相手の値を取り込んだ項目 */
  taken: FieldKey[];
  /** 両方が違う値に変えた項目（利用者が選ぶ） */
  conflicts: FieldKey[];
}

export function mergeProduct(base: EditableFields, mine: EditableFields, theirs: EditableFields): MergeResult {
  const merged: EditableFields = { ...mine, imageFile: theirs.imageFile };
  const taken: FieldKey[] = [];
  const conflicts: FieldKey[] = [];
  for (const key of FIELDS) {
    // 画像：自分が変えていない（keep）なら、相手が変えたかどうかに関係なく今の画像を使う
    const mineChanged = key === "image" ? mine.image === "changed" : !same(key, base, mine);
    const theirsChanged = key === "image" ? base.imageFile !== theirs.imageFile : !same(key, base, theirs);
    if (!theirsChanged) continue;
    if (!mineChanged) {
      if (key !== "image") (merged as unknown as Record<string, unknown>)[key] = theirs[key];
      taken.push(key);
    } else if (key === "image" || !same(key, mine, theirs)) {
      conflicts.push(key);
    }
  }
  return { merged, taken, conflicts };
}

/** 画面に出す値（ぶつかった項目の「相手の値／自分の値」） */
export function displayValue(key: FieldKey, f: EditableFields, imageLabel?: string): string {
  switch (key) {
    case "offBook":
      return f.offBook ? "簿外" : "簿外ではない";
    case "suppliers":
      return f.suppliers.length === 0 ? "（なし）" : f.suppliers.map((s) => s.name).join("、");
    case "image":
      return imageLabel ?? (f.imageFile ? "画像あり" : "画像なし");
    default: {
      const v = String(f[key]).trim();
      return v === "" ? "（空欄）" : v;
    }
  }
}
