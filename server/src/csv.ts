import {
  AuditLabels,
  HistoryFieldLabels,
  MovementLabels,
  type AuditLog,
  type CodeChange,
  type History,
  type HistoryEdit,
  type HistoryEditRow,
} from "../../shared/types.js";

/**
 * CSV の1フィールド（RFC 4180）。
 * Excel で開いたときに数式として実行されないよう、= + - @ などで始まる値は先頭に ' を付ける（CSV インジェクション対策）。
 */
export function csvText(value: string | null | undefined): string {
  let s = value ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  const needsQuotes = /[",\r\n]/.test(s) || /^\s|\s$/.test(s);
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel で文字化けしないよう先頭に BOM を付ける。 */
export const CSV_BOM = "﻿";

export function historiesToCsv(histories: readonly History[]): string {
  const lines = ["日時,商品コード,商品名,区分,理由,受注番号,数量,処理後在庫,移管先,コメント,入力者,端末IP,取消,履歴ID"];
  for (const h of histories) {
    lines.push(
      [
        h.createdAt,
        csvText(h.productCode),
        csvText(h.productName),
        MovementLabels[h.type],
        csvText(h.reason),
        csvText(h.orderNo),
        String(h.quantity),
        String(h.stockAfter),
        csvText(h.destination),
        csvText(h.comment),
        csvText(h.userName || "(未登録)"),
        csvText(h.clientIp),
        h.cancelOf !== null ? `取消元 #${h.cancelOf}` : h.canceledBy !== null ? `取消済 #${h.canceledBy}` : "",
        String(h.id),
      ].join(","),
    );
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

export function auditLogsToCsv(logs: readonly AuditLog[]): string {
  const lines = ["日時,操作,対象,内容,入力者,端末IP"];
  for (const l of logs) {
    lines.push(
      [l.createdAt, AuditLabels[l.action] ?? l.action, csvText(l.target), csvText(l.detail), csvText(l.userName), csvText(l.clientIp)].join(","),
    );
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

export function historyEditsToCsv(edits: readonly HistoryEdit[]): string {
  const lines = ["日時,履歴ID,項目,修正前,修正後,入力者,端末IP"];
  for (const e of edits) {
    lines.push(
      [
        e.createdAt,
        String(e.historyId),
        HistoryFieldLabels[e.field] ?? e.field,
        csvText(e.before),
        csvText(e.after),
        csvText(e.userName),
        csvText(e.clientIp),
      ].join(","),
    );
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

/** 履歴ページの「履歴の修正」の CSV（どの商品の履歴か分かるよう商品コード・名前を付ける） */
export function historyEditRowsToCsv(rows: readonly HistoryEditRow[]): string {
  const lines = ["日時,履歴ID,商品コード,商品名,区分,項目,修正前,修正後,入力者,端末IP"];
  for (const e of rows) {
    lines.push(
      [
        e.createdAt,
        String(e.historyId),
        csvText(e.productCode),
        csvText(e.productName),
        e.historyType ? MovementLabels[e.historyType] : "",
        HistoryFieldLabels[e.field] ?? e.field,
        csvText(e.before),
        csvText(e.after),
        csvText(e.userName),
        csvText(e.clientIp),
      ].join(","),
    );
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

export function codeChangesToCsv(changes: readonly CodeChange[]): string {
  const lines = ["日時,旧コード,新コード,商品名,入力者,端末IP"];
  for (const c of changes) {
    lines.push(
      [c.createdAt, csvText(c.oldCode), csvText(c.newCode), csvText(c.productName), csvText(c.userName), csvText(c.clientIp)].join(","),
    );
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}
