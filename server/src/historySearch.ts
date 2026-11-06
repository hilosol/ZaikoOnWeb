import type { DatabaseSync } from "node:sqlite";
import {
  AuditLabels,
  HistoryFieldLabels,
  HistorySearchLimits,
  MovementLabels,
  type AuditLog,
  type CanceledFilter,
  type CodeChange,
  type History,
  type HistoryEditRow,
  type HistoryKind,
  type HistorySearchQuery,
  type HistorySearchResult,
  type MovementType,
} from "../../shared/types.js";
import { ValidationError } from "./errors.js";
import { toAudit, toCodeChange, toHistory, toHistoryEdit } from "./rows.js";
import { searchKey } from "./text.js";

type Row = Record<string, unknown>;

const KINDS: readonly HistoryKind[] = ["movements", "edits", "audit", "codes"];
const TYPES = Object.keys(MovementLabels) as MovementType[];
const CANCELED: readonly CanceledFilter[] = ["all", "exclude", "only"];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 検索条件（検証済み）。期間は [fromAt, toBefore) の日時文字列で持つ */
export interface ParsedHistoryQuery {
  kind: HistoryKind;
  fromAt: string | null;
  toBefore: string | null;
  q: string;
  types: MovementType[];
  canceled: CanceledFilter;
  user: string | null;
  orderNo: string;
  productId: number | null;
  limit: number;
  offset: number;
}

function parseDate(value: string, label: string): Date {
  const m = DATE.exec(value);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  // 2026-02-30 のような存在しない日付も拒否する
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    throw new ValidationError(`${label}の日付が正しくありません（例: 2026-11-06）。`);
  }
  return d;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 画面から来た検索条件（URL のクエリ）を検証する。不正な値は日本語のエラーにする */
export function parseHistoryQuery(raw: Record<string, unknown>, forCsv = false): ParsedHistoryQuery {
  const kind = (text(raw.kind) || "movements") as HistoryKind;
  if (!KINDS.includes(kind)) throw new ValidationError("履歴の種類が正しくありません。");

  const from = text(raw.from);
  const to = text(raw.to);
  const fromDate = from ? parseDate(from, "開始") : null;
  const toDate = to ? parseDate(to, "終了") : null;
  if (fromDate && toDate && fromDate > toDate) throw new ValidationError("開始日が終了日より後になっています。");
  // 終了日はその日を含める（翌日の 0 時より前）
  const toNext = toDate ? new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1) : null;

  const typesText = text(raw.types);
  const types = typesText ? (typesText.split(",") as MovementType[]) : [];
  if (types.some((t) => !TYPES.includes(t))) throw new ValidationError("区分の指定が正しくありません。");

  const canceled = (text(raw.canceled) || "all") as CanceledFilter;
  if (!CANCELED.includes(canceled)) throw new ValidationError("取消の扱いの指定が正しくありません。");

  const productIdText = text(raw.productId);
  const productId = productIdText ? Number(productIdText) : null;
  if (productId !== null && !(Number.isSafeInteger(productId) && productId > 0)) throw new ValidationError("商品の指定が正しくありません。");

  const intOf = (v: unknown, def: number, min: number, max: number, label: string) => {
    const t = text(v);
    if (!t) return def;
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new ValidationError(`${label}は${min}〜${max}の整数で指定してください。`);
    return n;
  };

  return {
    kind,
    fromAt: fromDate ? `${ymd(fromDate)} 00:00:00` : null,
    toBefore: toNext ? `${ymd(toNext)} 00:00:00` : null,
    q: text(raw.q).slice(0, 100),
    types,
    canceled,
    // user は「指定なし（undefined）」と「未登録（空文字）」を区別する
    user: typeof raw.user === "string" ? raw.user.trim() : null,
    orderNo: text(raw.orderNo).slice(0, 100),
    productId,
    limit: forCsv ? HistorySearchLimits.csvRowsMax : intOf(raw.limit, 100, 1, HistorySearchLimits.pageSizeMax, "表示件数"),
    offset: forCsv ? 0 : intOf(raw.offset, 0, 0, Number.MAX_SAFE_INTEGER, "表示位置"),
  };
}

/** キーワード検索：各行の検索対象の文字列をつないで、正規化した部分一致で比べる（アプリ内の他の検索と同じ規則） */
function keywordFilter<T>(rows: T[], q: string, fields: (row: T) => (string | null | undefined)[]): T[] {
  const words = q.split(/[\s　]+/).map(searchKey).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const hay = fields(r)
      .map((f) => searchKey(f ?? ""))
      .join("\n");
    return words.every((w) => hay.includes(w));
  });
}

/** 期間の条件（created_at は "YYYY-MM-DD HH:MM:SS" のローカル時刻文字列なので、文字列の大小で比べられる） */
function periodWhere(q: ParsedHistoryQuery, column: string, where: string[], params: (string | number)[]): void {
  if (q.fromAt) {
    where.push(`${column} >= ?`);
    params.push(q.fromAt);
  }
  if (q.toBefore) {
    where.push(`${column} < ?`);
    params.push(q.toBefore);
  }
}

const page = <T>(rows: T[], q: ParsedHistoryQuery): HistorySearchResult<T> => ({
  total: rows.length,
  rows: rows.slice(q.offset, q.offset + q.limit),
});

/**
 * 履歴ページの検索。期間・区分などは SQL で絞り、キーワードは正規化して JS で絞る
 * （ひらがな・カタカナ・全角半角・ハイフンを区別しない比較は SQL では難しいため。件数は社内用途で数万件程度の想定）。
 */
export class HistorySearch {
  constructor(private readonly db: DatabaseSync) {}

  movements(q: ParsedHistoryQuery): HistorySearchResult<History> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    periodWhere(q, "created_at", where, params);
    if (q.types.length > 0) {
      where.push(`type IN (${q.types.map(() => "?").join(",")})`);
      params.push(...q.types);
    }
    if (q.user !== null) {
      where.push("user_name = ?");
      params.push(q.user);
    }
    if (q.productId !== null) {
      where.push("product_id = ?");
      params.push(q.productId);
    }
    if (q.canceled === "exclude") where.push("canceled_by IS NULL AND type <> 'CANCEL'");
    if (q.canceled === "only") where.push("(canceled_by IS NOT NULL OR type = 'CANCEL')");
    const sql = `SELECT * FROM histories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
    let rows = (this.db.prepare(sql).all(...params) as Row[]).map(toHistory);

    if (q.orderNo) {
      const key = searchKey(q.orderNo);
      rows = rows.filter((h) => h.orderNo !== null && searchKey(h.orderNo).includes(key));
    }
    rows = keywordFilter(rows, q.q, (h) => [
      h.productCode,
      h.productName,
      h.comment,
      h.destination,
      h.orderNo,
      h.reason,
      h.userName,
      MovementLabels[h.type],
    ]);

    // 合計は「実際に効いている」入出庫だけ（取り消された履歴は除く。取消の履歴も数えない）
    const summary = { IN: 0, OUT: 0, TRANSFER: 0 };
    for (const h of rows) {
      if (h.canceledBy !== null) continue;
      if (h.type === "IN" || h.type === "OUT" || h.type === "TRANSFER") summary[h.type] += h.quantity;
    }
    return { ...page(rows, q), summary };
  }

  edits(q: ParsedHistoryQuery): HistorySearchResult<HistoryEditRow> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    periodWhere(q, "e.created_at", where, params);
    const sql = `SELECT e.*, h.product_code, h.product_name, h.type AS history_type
                   FROM history_edits e LEFT JOIN histories h ON h.id = e.history_id
                  ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC`;
    const rows = (this.db.prepare(sql).all(...params) as Row[]).map(
      (r): HistoryEditRow => ({
        ...toHistoryEdit(r),
        productCode: String(r.product_code ?? ""),
        productName: String(r.product_name ?? ""),
        historyType: r.history_type == null ? null : (String(r.history_type) as MovementType),
      }),
    );
    return page(
      keywordFilter(rows, q.q, (e) => [e.productCode, e.productName, HistoryFieldLabels[e.field] ?? e.field, e.before, e.after, e.userName]),
      q,
    );
  }

  audit(q: ParsedHistoryQuery): HistorySearchResult<AuditLog> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    periodWhere(q, "created_at", where, params);
    const sql = `SELECT * FROM audit_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
    const rows = (this.db.prepare(sql).all(...params) as Row[]).map(toAudit);
    return page(
      keywordFilter(rows, q.q, (l) => [AuditLabels[l.action] ?? l.action, l.target, l.detail, l.userName]),
      q,
    );
  }

  codes(q: ParsedHistoryQuery): HistorySearchResult<CodeChange> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    periodWhere(q, "created_at", where, params);
    const sql = `SELECT * FROM product_code_changes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
    const rows = (this.db.prepare(sql).all(...params) as Row[]).map(toCodeChange);
    return page(
      keywordFilter(rows, q.q, (c) => [c.oldCode, c.newCode, c.productName, c.userName]),
      q,
    );
  }

  search(q: ParsedHistoryQuery): HistorySearchResult<unknown> {
    switch (q.kind) {
      case "edits":
        return this.edits(q);
      case "audit":
        return this.audit(q);
      case "codes":
        return this.codes(q);
      default:
        return this.movements(q);
    }
  }
}

export type { HistorySearchQuery };
