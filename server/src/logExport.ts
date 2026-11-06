import fs from "node:fs";
import path from "node:path";
import type { AuditLog, CodeChange, History, HistoryEdit, LogExportStatus } from "../../shared/types.js";

export type { LogExportStatus };
import { formatLocal, type Clock } from "./clock.js";
import { auditLogsToCsv, codeChangesToCsv, historiesToCsv, historyEditsToCsv } from "./csv.js";

/** 書き出しに必要なデータの取り出し（InventoryService が満たす。テストでは差し替え可能） */
export interface LogSource {
  activityMonths(): string[];
  historiesInMonth(month: string): History[];
  auditLogsInMonth(month: string): AuditLog[];
  codeChangesInMonth(month: string): CodeChange[];
  historyEditsInMonth(month: string): HistoryEdit[];
}

const KINDS = [
  { prefix: "入出庫履歴", rows: (s: LogSource, m: string) => s.historiesInMonth(m), csv: historiesToCsv },
  { prefix: "操作ログ", rows: (s: LogSource, m: string) => s.auditLogsInMonth(m), csv: auditLogsToCsv },
  { prefix: "コード変更履歴", rows: (s: LogSource, m: string) => s.codeChangesInMonth(m), csv: codeChangesToCsv },
  { prefix: "履歴の修正", rows: (s: LogSource, m: string) => s.historyEditsInMonth(m), csv: historyEditsToCsv },
] as const;

/**
 * 履歴を月別の CSV ファイルとして data\logs に書き出す（DB とは別に Excel で読める控えを残す）。
 * - 毎回 DB から作り直す（追記しない）。書き出しに失敗しても次回に完全な内容で書かれ、抜けや重複が起きない
 * - 今月と先月は毎回書き直す（月末の操作を確実に含めるため）。それより前の月は、ファイルが無い場合だけ書く
 * - 一時ファイルに書いてから置き換える（書き出し中に開いても壊れた内容を見せない）
 * - Excel で開いていて置き換えられない場合はその回はあきらめ、状態に記録して次回に再試行する
 */
export class CsvLogExporter {
  private status: LogExportStatus;

  constructor(
    private readonly source: LogSource,
    private readonly dir: string,
    private readonly clock: Clock,
  ) {
    this.status = { dir, lastRunAt: null, written: 0, failures: [] };
  }

  getStatus(): LogExportStatus {
    return { ...this.status, failures: [...this.status.failures] };
  }

  run(): LogExportStatus {
    const now = this.clock.now();
    const current = formatLocal(now).slice(0, 7);
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previous = formatLocal(prevDate).slice(0, 7);
    const failures: LogExportStatus["failures"] = [];
    let written = 0;

    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      this.status = { dir: this.dir, lastRunAt: formatLocal(now), written: 0, failures: [{ file: this.dir, reason: reasonOf(e) }] };
      return this.getStatus();
    }

    for (const month of this.source.activityMonths()) {
      const recent = month === current || month === previous;
      for (const kind of KINDS) {
        const file = path.join(this.dir, `${kind.prefix}_${month}.csv`);
        if (!recent && fs.existsSync(file)) continue;
        const rows = kind.rows(this.source, month) as never[];
        if (rows.length === 0) continue;
        try {
          writeAtomic(file, (kind.csv as (r: never[]) => string)(rows));
          written++;
        } catch (e) {
          failures.push({ file: path.basename(file), reason: reasonOf(e) });
        }
      }
    }
    this.status = { dir: this.dir, lastRunAt: formatLocal(now), written, failures };
    return this.getStatus();
  }
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function reasonOf(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    return "ファイルが他のプログラム（Excel など）で開かれているか、書き込み権限がありません。閉じると次回の書き出しで更新されます。";
  }
  if (code === "ENOSPC") return "ディスクの空きがありません。";
  return `書き出せませんでした（${code ?? (e as Error).message}）。`;
}
