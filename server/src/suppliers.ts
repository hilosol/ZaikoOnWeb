import type { DatabaseSync } from "node:sqlite";
import { Rules, type Supplier } from "../../shared/types.js";
import { ValidationError } from "./errors.js";
import { trimText } from "./text.js";

/**
 * 購入元の入力を正規化・検証する。
 * - 名前・URL とも空の行は捨てる（画面の空欄行をそのまま送ってよい）
 * - URL はスキーム省略時に https:// を補う（「www.example.com/…」を貼った場合）
 * - URL は http / https のみ（javascript: などをリンクにしないため）
 * エラーは「n件目」付きでまとめて返す。
 */
export function normalizeSuppliers(raw: unknown): Supplier[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError("購入元の形式が正しくありません。");

  const errors: string[] = [];
  const result: Supplier[] = [];
  raw.forEach((item, index) => {
    const no = `購入元${index + 1}件目`;
    if (item === null || typeof item !== "object") {
      errors.push(`${no}の形式が正しくありません。`);
      return;
    }
    const rec = item as Record<string, unknown>;
    const name = trimText(rec.name).replace(/\s*[\r\n]+\s*/g, " ");
    const urlText = trimText(rec.url);
    if (!name && !urlText) return;

    if (!name) errors.push(`${no}：購入元の名前を入力してください。`);
    else if (name.length > Rules.supplierNameMaxLength) {
      errors.push(`${no}：名前は${Rules.supplierNameMaxLength}文字以内で入力してください。`);
    }

    let url = "";
    if (urlText) {
      const parsed = parseHttpUrl(urlText);
      if (!parsed) errors.push(`${no}：URL は http:// または https:// で始まる正しいアドレスを入力してください。`);
      else if (parsed.length > Rules.supplierUrlMaxLength) {
        errors.push(`${no}：URL は${Rules.supplierUrlMaxLength}文字以内で入力してください。`);
      } else url = parsed;
    }
    result.push({ name, url });
  });

  if (result.length > Rules.maxSuppliers) {
    errors.push(`購入元は${Rules.maxSuppliers}件までです。`);
  }
  if (errors.length > 0) throw new ValidationError(errors);
  return result;
}

/** http / https の URL として解釈できれば正規化した文字列、できなければ null。 */
export function parseHttpUrl(text: string): string | null {
  if (/\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // 「https://」だけ、「https://abc」のようなドットなしホスト（社内名は localhost 以外ほぼ無い）を弾く
  if (!u.hostname || (!u.hostname.includes(".") && u.hostname !== "localhost")) return null;
  // 入力どおりの表記を残す（new URL は末尾に / を足すなど書き換えるため、検証のみに使う）
  return withScheme;
}

/** 購入元の読み書き（products と同じ DB・同じトランザクション内で使う） */
export class SupplierRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 指定した商品の購入元を商品 ID ごとにまとめて返す。ids 省略時は全商品。 */
  loadMap(ids?: number[]): Map<number, Supplier[]> {
    const map = new Map<number, Supplier[]>();
    if (ids && ids.length === 0) return map;
    const rows = (
      ids && ids.length === 1
        ? this.db
            .prepare("SELECT product_id, name, url FROM product_suppliers WHERE product_id = ? ORDER BY position")
            .all(ids[0]!)
        : this.db.prepare("SELECT product_id, name, url FROM product_suppliers ORDER BY product_id, position").all()
    ) as { product_id: number; name: string; url: string }[];
    const filter = ids ? new Set(ids) : null;
    for (const r of rows) {
      const id = Number(r.product_id);
      if (filter && !filter.has(id)) continue;
      const list = map.get(id) ?? [];
      list.push({ name: String(r.name), url: String(r.url) });
      map.set(id, list);
    }
    return map;
  }

  /** 商品の購入元を丸ごと置き換える（並び順は配列の順）。 */
  replace(productId: number, suppliers: Supplier[]): void {
    this.db.prepare("DELETE FROM product_suppliers WHERE product_id = ?").run(productId);
    const insert = this.db.prepare(
      "INSERT INTO product_suppliers (product_id, position, name, url) VALUES (?, ?, ?, ?)",
    );
    suppliers.forEach((s, i) => insert.run(productId, i, s.name, s.url));
  }
}

export const sameSuppliers = (a: Supplier[], b: Supplier[]): boolean =>
  a.length === b.length && a.every((s, i) => s.name === b[i]!.name && s.url === b[i]!.url);
