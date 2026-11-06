import fs from "node:fs";
import { Rules, type OrderListStatus, type OrderNumber } from "../../shared/types.js";
import { formatLocal } from "./clock.js";
import { searchKey } from "./text.js";

/**
 * ファイルの中身を文字列にする。BOM（UTF-8 / UTF-16）を見て判定し、BOM が無ければ UTF-8 として読み、
 * UTF-8 として不正なら Shift_JIS とみなす（PowerShell 5.1 の Set-Content 既定は Shift_JIS、Out-File 既定は UTF-16）。
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

/** PowerShell の dir（Get-ChildItem）の出力をそのまま貼った場合の行（例: "d----l  2026/09/15  9:43   AWO-26008_湖北工業"） */
const DIR_LINE = /^[d-][-a-z]{5}\s+\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:[\d,]+\s+)?(.+)$/i;
/** dir 出力の見出し・区切り行 */
const DIR_HEADER = /^(Mode\s+LastWriteTime|[-\s]{4,}$|\s*(Directory|ディレクトリ):)/i;
const CTRL = /[\u0000-\u001f\u007f]/;

/**
 * リストファイルを解釈する。1行1件で「受注番号_案件名」（フォルダ名そのまま）または「受注番号」だけ。
 * - 空行・# で始まる行は読み飛ばす
 * - 最初の「_」より前を受注番号、後ろを案件名とする
 * - 同じ受注番号が複数あれば最初の行を使う（大文字小文字・全角半角・ハイフンの違いも同じとみなす）
 */
export function parseOrderList(text: string): { items: OrderNumber[]; skipped: number } {
  const items: OrderNumber[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || DIR_HEADER.test(raw)) continue;
    const dir = DIR_LINE.exec(line);
    if (dir) line = dir[1]!.trim();
    const i = line.indexOf("_");
    const number = (i > 0 ? line.slice(0, i) : line).trim();
    const name = i > 0 ? line.slice(i + 1).trim() : "";
    if (!number || number.length > Rules.orderNoMaxLength || CTRL.test(line)) {
      skipped++;
      continue;
    }
    const key = searchKey(number);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ number, name });
  }
  return { items, skipped };
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 受注番号リストファイル（data\受注番号リスト.txt）。
 * ファイルの更新日時・サイズが変わったときだけ読み直す（毎回の読み込みを避けつつ、置き換えたらすぐ反映する）。
 * 読めなかった場合は前回読めた内容を使い続け、理由を状態に残す。
 */
export class OrderNumberList {
  private items: OrderNumber[] = [];
  private byKey = new Map<string, OrderNumber>();
  private signature = "";
  private status: OrderListStatus;

  constructor(private readonly file: string) {
    this.status = { file, exists: false, count: 0, modifiedAt: null, error: "", skipped: 0 };
  }

  private refresh(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") {
        this.set([], "");
        this.status = { ...this.status, exists: false, count: 0, modifiedAt: null, error: "", skipped: 0 };
      } else {
        this.status = { ...this.status, error: `リストファイルを確認できません（${(e as { code?: string }).code ?? (e as Error).message}）。` };
      }
      return;
    }
    const sig = `${stat.mtimeMs}:${stat.size}`;
    if (sig === this.signature) return;
    try {
      if (!stat.isFile()) throw Object.assign(new Error("ファイルではありません"), { code: "EISDIR" });
      if (stat.size > MAX_FILE_BYTES) throw Object.assign(new Error("大きすぎます"), { code: "EFBIG" });
      const { items, skipped } = parseOrderList(decodeText(fs.readFileSync(this.file)));
      this.set(items, sig);
      this.status = { file: this.file, exists: true, count: items.length, modifiedAt: formatLocal(stat.mtime), error: "", skipped };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const reason =
        code === "EBUSY" || code === "EPERM" || code === "EACCES"
          ? "他のプログラムで開かれているか、読み取り権限がありません"
          : code === "EFBIG"
            ? `ファイルが大きすぎます（${MAX_FILE_BYTES / 1024 / 1024}MBまで）`
            : (e as Error).message;
      this.status = { ...this.status, exists: true, error: `リストファイルを読み込めませんでした（${reason}）。前回読み込んだ内容を使っています。` };
    }
  }

  private set(items: OrderNumber[], sig: string): void {
    this.items = items;
    this.byKey = new Map(items.map((x) => [searchKey(x.number), x]));
    this.signature = sig;
  }

  list(): { items: OrderNumber[]; status: OrderListStatus } {
    this.refresh();
    return { items: this.items, status: { ...this.status } };
  }

  /** 入力された番号に対応するリストの番号（大文字小文字・全角半角・ハイフンの違いを吸収）。無ければ null */
  find(number: string): OrderNumber | null {
    this.refresh();
    return this.byKey.get(searchKey(number)) ?? null;
  }
}
