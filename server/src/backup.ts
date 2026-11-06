import fs from "node:fs";
import path from "node:path";
import {
  DefaultBackupSettings,
  type BackupPlaceStatus,
  type BackupRetention,
  type BackupSettings,
  type BackupView,
  BackupRetentionLabels,
} from "../../shared/types.js";
import type { Clock } from "./clock.js";
import { ValidationError } from "./errors.js";
import type { Actor } from "./inventory.js";
import type { SettingsAuditor } from "./generalSettings.js";
import type { SettingsStore } from "./settingsStore.js";

/**
 * 自動バックアップ。
 * - サーバーPC内（data\backup）：1日1回、データベースを丸ごとコピー（zaiko_YYYYMMDD.db）
 * - 追加の保存先（外付けドライブ・USB 等。任意）：
 *     db\     … サーバーPC内のバックアップのうち、まだ無いものをコピー（抜いていた日の分も挿し直せば追いつく）
 *     images\ … 商品写真。増えた・変わったファイルだけコピー（削除した商品の写真も消さずに残す）
 * - 古いバックアップは「残す期間」の設定に従って削除（保存先ごとに同じ規則）
 *
 * ネットワークの場所（\\NAS\...）は、サーバーが SYSTEM で動くため認証できず書き込めないので受け付けない。
 */

const SETTINGS_KEY = "backup";
const STATUS_KEY = "backupStatus";
const FILE_PATTERN = /^zaiko_(\d{8})\.db$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTIONS = Object.keys(BackupRetentionLabels) as BackupRetention[];
const MAX_DIR_LENGTH = 200;
const MTIME_TOLERANCE_MS = 2000;

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
/** 日付だけで数えた日数の差（時刻・夏時間の影響を受けない） */
const daysBetween = (from: Date, to: Date) =>
  Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY_MS);

/**
 * 残す期間の規則で、削除するバックアップ（YYYYMMDD）を選ぶ。今日の分は必ず残す。
 * 世代管理：直近30日は毎日分、それより前で1年以内は各月の最初の分、さらに前は各年の最初の分を残す。
 */
export function selectBackupsToDelete(dates: string[], today: Date, retention: BackupRetention): string[] {
  const days: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
  if (retention === "unlimited") return [];
  if (retention !== "generations") {
    const keep = days[retention] ?? 30;
    return dates.filter((d) => daysBetween(parseYmd(d), today) >= keep);
  }
  const sorted = [...dates].sort();
  const firstOf = (key: (d: string) => string) => {
    const seen = new Set<string>();
    const result = new Set<string>();
    for (const d of sorted) {
      const k = key(d);
      if (!seen.has(k)) {
        seen.add(k);
        result.add(d);
      }
    }
    return result;
  };
  const firstOfMonth = firstOf((d) => d.slice(0, 6));
  const firstOfYear = firstOf((d) => d.slice(0, 4));
  return sorted.filter((d) => {
    const age = daysBetween(parseYmd(d), today);
    if (age < 30) return false;
    if (age < 365 && firstOfMonth.has(d)) return false;
    return !firstOfYear.has(d);
  });
}

/**
 * 追加の保存先を確認して正規化する（"" = 使わない）。
 * サーバーPCのドライブのフルパスだけを受け付ける。
 */
export function normalizeBackupDir(raw: unknown, dataDir: string, isAbsolute: (p: string) => boolean = path.isAbsolute): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new ValidationError("保存先はフォルダの場所（例: E:\\zaiko-backup）で入力してください。");
  const dir = raw.trim().replace(/^"(.*)"$/, "$1").replace(/[\\/]+$/, "");
  if (dir === "") return "";
  if (dir.length > MAX_DIR_LENGTH) throw new ValidationError(`保存先は${MAX_DIR_LENGTH}文字以内で入力してください。`);
  if (/^(\\\\|\/\/)/.test(dir)) {
    throw new ValidationError(
      "ネットワークの場所（\\\\で始まる場所・NAS）には保存できません。外付けドライブや USB メモリのフォルダ（例: E:\\zaiko-backup）を指定してください。",
    );
  }
  if (!isAbsolute(dir) || /^[A-Za-z]:$/.test(dir)) {
    throw new ValidationError("保存先はドライブ名から始まるフォルダの場所（例: E:\\zaiko-backup）で入力してください。");
  }
  const rel = path.relative(path.resolve(dataDir), path.resolve(dir));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new ValidationError("保存先に data フォルダの中は指定できません（PC が壊れたときに一緒に失われるため）。");
  }
  return dir;
}

/** ファイル操作の失敗を、何を直せばよいか分かる文にする */
export function describeFsError(error: unknown): string {
  const code = (error as { code?: string }).code;
  switch (code) {
    case "ENOENT":
      return "保存先が見つかりません。外付けドライブが接続されているか、ドライブ文字が変わっていないか確認してください。";
    case "EACCES":
    case "EPERM":
      return "保存先に書き込めません（書き込みが許可されていません）。このPCで USB 記憶装置への書き込みが禁止されていないか確認してください。";
    case "ENOSPC":
      return "保存先の空き容量が足りません。";
    case "EROFS":
      return "保存先が読み取り専用です。";
    default:
      return `保存先に書き込めませんでした（${(error as Error).message ?? String(error)}）。`;
  }
}

interface StoredStatus {
  local?: Partial<BackupPlaceStatus>;
  extra?: Partial<BackupPlaceStatus> & { dir?: string };
}

const emptyPlace = (dir: string): BackupPlaceStatus => ({
  dir,
  lastAttemptAt: null,
  lastOk: null,
  lastMessage: "",
  lastSuccessAt: null,
  count: null,
  totalBytes: null,
  freeBytes: null,
});

export class BackupService {
  constructor(
    private readonly o: {
      dataDir: string;
      store: Pick<SettingsStore, "get" | "set">;
      clock: Clock;
      auditor: SettingsAuditor;
      /** データベースを指定のファイルにコピーする（VACUUM INTO） */
      backupDatabase: (destPath: string) => void;
      isAbsolute?: (p: string) => boolean;
    },
  ) {}

  private get localDir(): string {
    return path.join(this.o.dataDir, "backup");
  }

  private get imagesDir(): string {
    return path.join(this.o.dataDir, "images");
  }

  settings(): BackupSettings {
    const raw = this.o.store.get(SETTINGS_KEY);
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      retention: RETENTIONS.includes(obj.retention as BackupRetention) ? (obj.retention as BackupRetention) : DefaultBackupSettings.retention,
      extraDir: typeof obj.extraDir === "string" ? obj.extraDir : "",
    };
  }

  private storedStatus(): StoredStatus {
    const raw = this.o.store.get(STATUS_KEY);
    return raw && typeof raw === "object" ? (raw as StoredStatus) : {};
  }

  private saveStatus(change: StoredStatus): void {
    this.o.store.set(STATUS_KEY, { ...this.storedStatus(), ...change });
  }

  view(): BackupView {
    const settings = this.settings();
    const stored = this.storedStatus();
    const local = { ...emptyPlace(this.localDir), ...stored.local, dir: this.localDir, ...this.measure(this.localDir) };
    const extra = settings.extraDir
      ? {
          ...emptyPlace(settings.extraDir),
          // 保存先を変えたら、前の保存先の結果は表示しない
          ...(stored.extra?.dir === settings.extraDir ? stored.extra : {}),
          dir: settings.extraDir,
          ...this.measure(path.join(settings.extraDir, "db")),
        }
      : null;
    return { settings, local, extra };
  }

  /** バックアップの件数・合計サイズ・空き容量（読めないものは null） */
  private measure(dir: string): Pick<BackupPlaceStatus, "count" | "totalBytes" | "freeBytes"> {
    let count: number | null = null;
    let totalBytes: number | null = null;
    let freeBytes: number | null = null;
    try {
      const files = this.listBackups(dir);
      count = files.length;
      totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
    } catch {
      // 外付けドライブが外れている場合など
    }
    try {
      const st = fs.statfsSync(fs.existsSync(dir) ? dir : path.dirname(dir));
      freeBytes = Number(st.bavail) * Number(st.bsize);
    } catch {
      // 取得できない環境
    }
    return { count, totalBytes, freeBytes };
  }

  private listBackups(dir: string): string[] {
    return fs.readdirSync(dir).filter((f) => FILE_PATTERN.test(f));
  }

  saveSettings(raw: Record<string, unknown>, actor: Actor): BackupView {
    const userName = this.o.auditor.resolveStockUser(actor);
    const before = this.settings();
    const after: BackupSettings = { ...before };
    if (raw.retention !== undefined) {
      if (!RETENTIONS.includes(raw.retention as BackupRetention)) throw new ValidationError("残す期間を選んでください。");
      after.retention = raw.retention as BackupRetention;
    }
    if (raw.extraDir !== undefined) after.extraDir = normalizeBackupDir(raw.extraDir, this.o.dataDir, this.o.isAbsolute);

    const changes: string[] = [];
    if (after.retention !== before.retention) {
      changes.push(`残す期間: ${BackupRetentionLabels[before.retention]} → ${BackupRetentionLabels[after.retention]}`);
    }
    if (after.extraDir !== before.extraDir) changes.push(`追加の保存先: ${before.extraDir || "なし"} → ${after.extraDir || "なし"}`);
    if (changes.length > 0) {
      this.o.store.set(SETTINGS_KEY, after);
      this.o.auditor.recordSettingsChange("バックアップ", changes.join("、"), { ...actor, userName });
    }
    return this.view();
  }

  /** 保存先に書き込めるか試す（フォルダが無ければ作る）。保存前の入力値で試せる */
  testDir(raw: unknown): { ok: boolean; message: string } {
    const dir = normalizeBackupDir(raw, this.o.dataDir, this.o.isAbsolute);
    if (!dir) throw new ValidationError("保存先を入力してください。");
    const probe = path.join(dir, `.zaiko-write-test-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, "test");
      fs.rmSync(probe, { force: true });
      return { ok: true, message: `書き込めました（${dir}）。` };
    } catch (error) {
      try {
        fs.rmSync(probe, { force: true });
      } catch {
        // 消せなくても結果には影響しない
      }
      return { ok: false, message: describeFsError(error) };
    }
  }

  /**
   * バックアップを実行する（1時間ごとに呼ぶ。今日の分が既にあれば作り直さない）。
   * サーバーPC内が失敗しても、追加の保存先への写真のコピーなどは続ける。
   */
  run(): BackupView {
    const now = this.o.clock.now();
    const at = now.toISOString();
    const settings = this.settings();
    const stored = this.storedStatus();

    // 1. サーバーPC内
    try {
      fs.mkdirSync(this.localDir, { recursive: true });
      const dest = path.join(this.localDir, `zaiko_${ymd(now)}.db`);
      if (!fs.existsSync(dest)) {
        const temp = `${dest}.tmp`;
        fs.rmSync(temp, { force: true });
        this.o.backupDatabase(temp);
        fs.renameSync(temp, dest); // 途中で止まったファイルを正式なバックアップと見なさない
      }
      this.prune(this.localDir, now, settings.retention);
      this.saveStatus({ local: { lastAttemptAt: at, lastOk: true, lastMessage: "保存しました", lastSuccessAt: at } });
    } catch (error) {
      this.saveStatus({ local: { ...stored.local, lastAttemptAt: at, lastOk: false, lastMessage: describeFsError(error) } });
    }

    // 2. 追加の保存先
    if (settings.extraDir) {
      const prev = stored.extra?.dir === settings.extraDir ? stored.extra : {};
      try {
        const copied = this.copyToExtra(settings.extraDir, now, settings.retention);
        this.saveStatus({
          extra: {
            dir: settings.extraDir,
            lastAttemptAt: at,
            lastOk: true,
            lastMessage: copied.db + copied.images > 0 ? `保存しました（データベース ${copied.db} 件・写真 ${copied.images} 枚をコピー）` : "保存しました（追加分なし）",
            lastSuccessAt: at,
          },
        });
      } catch (error) {
        this.saveStatus({ extra: { ...prev, dir: settings.extraDir, lastAttemptAt: at, lastOk: false, lastMessage: describeFsError(error) } });
      }
    }
    return this.view();
  }

  private copyToExtra(extraDir: string, now: Date, retention: BackupRetention): { db: number; images: number } {
    if (!fs.existsSync(extraDir)) {
      // ドライブ自体が無い（抜いている）なら作らずに失敗とする。ドライブがあればフォルダを作る
      const root = path.parse(path.resolve(extraDir)).root;
      if (!fs.existsSync(root)) throw Object.assign(new Error("drive not found"), { code: "ENOENT" });
    }
    const dbDir = path.join(extraDir, "db");
    const imagesDir = path.join(extraDir, "images");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(imagesDir, { recursive: true });

    let db = 0;
    const existing = new Set(this.listBackups(dbDir));
    const kept = new Set(this.listBackups(dbDir).concat(this.listBackups(this.localDir)));
    const toDelete = new Set(selectBackupsToDelete([...kept].map((f) => FILE_PATTERN.exec(f)![1]!), now, retention));
    for (const file of fs.existsSync(this.localDir) ? this.listBackups(this.localDir) : []) {
      if (existing.has(file) || toDelete.has(FILE_PATTERN.exec(file)![1]!)) continue;
      copyAtomically(path.join(this.localDir, file), path.join(dbDir, file));
      db++;
    }
    this.prune(dbDir, now, retention);

    let images = 0;
    for (const file of fs.existsSync(this.imagesDir) ? fs.readdirSync(this.imagesDir) : []) {
      const src = path.join(this.imagesDir, file);
      const dest = path.join(imagesDir, file);
      const s = fs.statSync(src);
      if (!s.isFile()) continue;
      const d = fs.existsSync(dest) ? fs.statSync(dest) : null;
      // 更新日時はドライブの形式で精度が違う（FAT32 は2秒単位）ため、2秒までの差は同じとみなす
      if (d && d.size === s.size && d.mtimeMs + MTIME_TOLERANCE_MS >= s.mtimeMs) continue;
      copyAtomically(src, dest);
      images++;
    }
    return { db, images };
  }

  private prune(dir: string, now: Date, retention: BackupRetention): void {
    const files = this.listBackups(dir);
    const remove = new Set(selectBackupsToDelete(files.map((f) => FILE_PATTERN.exec(f)![1]!), now, retention));
    for (const f of files) {
      if (remove.has(FILE_PATTERN.exec(f)![1]!)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
}

/** 一時ファイルに書いてから名前を変える（コピー途中のファイルが正式名で残らないように）。更新日時も元に合わせる */
function copyAtomically(src: string, dest: string): void {
  const temp = `${dest}.tmp`;
  fs.copyFileSync(src, temp);
  const st = fs.statSync(src);
  fs.utimesSync(temp, st.atimeMs / 1000, st.mtimeMs / 1000);
  fs.renameSync(temp, dest);
}
