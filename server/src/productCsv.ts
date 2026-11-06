import type { Product } from "../../shared/types.js";
import { CSV_BOM, csvText } from "./csv.js";
import { normalizeText } from "./text.js";

/** 在庫CSVの列。出力と取り込みで同じ見出しを使い、出力したものをそのまま取り込めるようにする */
export const PRODUCT_COLUMNS = [
  { field: "code", header: "商品ID", aliases: ["ID", "コード", "商品コード", "品番"] },
  { field: "name", header: "商品名", aliases: ["名称", "品名"] },
  { field: "summary", header: "概要", aliases: ["説明"] },
  { field: "category", header: "カテゴリ", aliases: ["カテゴリー", "分類"] },
  { field: "location", header: "保管場所", aliases: ["場所", "置き場"] },
  { field: "stock", header: "在庫", aliases: ["在庫数", "現在庫", "数量"] },
  { field: "warningStock", header: "警告在庫", aliases: ["閾値", "しきい値"] },
  { field: "note", header: "備考", aliases: ["メモ"] },
  { field: "offBook", header: "簿外", aliases: ["簿外品"] },
] as const;

export type ProductField = (typeof PRODUCT_COLUMNS)[number]["field"];

export function productsToCsv(products: readonly Product[]): string {
  const lines = [PRODUCT_COLUMNS.map((c) => c.header).join(",")];
  for (const p of products) {
    lines.push(
      [
        csvText(p.code),
        csvText(p.name),
        csvText(p.summary),
        csvText(p.category),
        csvText(p.location),
        String(p.stock),
        String(p.warningStock),
        csvText(p.note),
        p.offBook ? "○" : "",
      ].join(","),
    );
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

/**
 * CSV（RFC 4180）を行・列に分解する。引用符内のカンマ・改行・"" に対応。
 * 戻り値の各行には、元の CSV での行番号（1 始まり、複数行のセルは開始行）を付ける。
 * @throws Error 引用符が閉じていない場合
 */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const s = text.replace(/^﻿/, "");
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let rowStart = 1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push({ line: rowStart, cells });
      cells = [];
      cell = "";
      line++;
      rowStart = line;
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw new Error(`${rowStart}行目: 引用符（"）が閉じられていません。`);
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    rows.push({ line: rowStart, cells });
  }
  // 空行（すべてのセルが空）は除く
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ""));
}

/** 出力時に付けた数式対策の ' を外す（= + - @ の前の ' のみ） */
export function unescapeCsvText(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** 見出し行から、列番号と項目の対応を決める（見出しの表記ゆれ・全角半角・空白を吸収） */
export function mapColumns(headers: readonly string[]): {
  index: Partial<Record<ProductField, number>>;
  columns: { header: string; field: string }[];
  ignored: string[];
  duplicated: string[];
} {
  const key = (s: string) => normalizeText(s).replace(/\s+/g, "").toUpperCase();
  const index: Partial<Record<ProductField, number>> = {};
  const columns: { header: string; field: string }[] = [];
  const ignored: string[] = [];
  const duplicated: string[] = [];

  headers.forEach((h, i) => {
    const k = key(h);
    const col = PRODUCT_COLUMNS.find((c) => key(c.header) === k || c.aliases.some((a) => key(a) === k));
    if (!col) {
      if (h.trim()) ignored.push(h.trim());
      return;
    }
    if (index[col.field] !== undefined) {
      duplicated.push(col.header);
      return;
    }
    index[col.field] = i;
    columns.push({ header: h.trim(), field: col.header });
  });
  return { index, columns, ignored, duplicated };
}
