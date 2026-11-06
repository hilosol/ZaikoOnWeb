import type { MailSendResult, MailSettingsResponse, MailStatus, Product } from "../../../shared/types.js";
import { formatLocal, type Clock } from "../clock.js";
import { ExternalServiceError, ValidationError } from "../errors.js";
import type { Actor } from "../inventory.js";
import type { SettingsStore } from "../settingsStore.js";
import { buildLowStockDigest, buildTestMessage } from "./lowStockDigest.js";
import { describeMailError, type Mailer, type MailMessage } from "./mailer.js";
import { fromStored, normalizeMailSettings, toPublic, type StoredMailSettings } from "./mailSettings.js";

const SETTINGS_KEY = "mail";
const STATUS_KEY = "mail_status";
/** 毎日の送信に失敗したときの再試行（間隔・1日の回数） */
const RETRY_INTERVAL_MS = 30 * 60 * 1000;
const MAX_DAILY_ATTEMPTS = 3;

const EMPTY_STATUS: MailStatus = { lastAttemptAt: null, lastKind: null, lastOk: null, lastMessage: "", dailyDoneDate: null };

/** 通知メールが必要とする在庫側の機能（InventoryService 全体に依存しないよう絞る） */
export interface NotifierInventory {
  lowStockProducts(): Product[];
  requireUser(actor: Actor): string;
  recordSettingsChange(target: string, detail: string, actor: Actor): void;
}

export interface NotifierOptions {
  store: SettingsStore;
  inventory: NotifierInventory;
  mailer: Mailer;
  clock: Clock;
  /** siteUrl 未設定時に使う画面のアドレス（このPCの社内 IP + ポート） */
  defaultSiteUrl: () => string;
  version: string;
}

const dateKey = (d: Date) => formatLocal(d).slice(0, 10);
const timeKey = (d: Date) => formatLocal(d).slice(11, 16);

/**
 * 在庫警告メール：設定の保存、テスト送信、手動送信、毎日の自動送信。
 * 自動送信は tick() を定期的に呼んで行う（タイマーは呼び出し側。テストで時刻を進めて検証できるように）。
 */
export class MailNotifier {
  private sending = false;
  /** 毎日の送信の再試行状態（メモリのみ。再起動したら数え直す） */
  private retry: { date: string; attempts: number; nextAt: number } | null = null;

  constructor(private readonly o: NotifierOptions) {}

  // ------------------------------------------------------------ 設定

  private stored(): StoredMailSettings {
    return fromStored(this.o.store.get(SETTINGS_KEY));
  }

  status(): MailStatus {
    const raw = this.o.store.get(STATUS_KEY);
    return raw && typeof raw === "object" ? { ...EMPTY_STATUS, ...(raw as Partial<MailStatus>) } : { ...EMPTY_STATUS };
  }

  private setStatus(change: Partial<MailStatus>): void {
    this.o.store.set(STATUS_KEY, { ...this.status(), ...change });
  }

  view(): MailSettingsResponse {
    return { settings: toPublic(this.stored()), status: this.status(), defaultSiteUrl: this.o.defaultSiteUrl() };
  }

  save(raw: Record<string, unknown>, actor: Actor): MailSettingsResponse {
    const userName = this.o.inventory.requireUser(actor);
    const before = this.stored();
    const after = normalizeMailSettings(raw, before);
    this.o.store.set(SETTINGS_KEY, after);
    this.o.inventory.recordSettingsChange("メール通知", describeChange(before, after), { ...actor, userName });
    return this.view();
  }

  // ------------------------------------------------------------ 送信

  /** テスト送信：保存前の画面の値で送れる（パスワード空欄なら保存済みを使う） */
  async sendTest(raw: Record<string, unknown>, actor: Actor): Promise<MailSendResult> {
    this.o.inventory.requireUser(actor);
    const settings = normalizeMailSettings(raw, this.stored(), true);
    const now = this.o.clock.now();
    await this.deliver("test", settings, buildTestMessage(now, this.o.version, this.siteUrl(settings)));
    return { sent: true, message: `テストメールを送信しました（宛先: ${settings.to.join(", ")}）。届いたか確認してください。` };
  }

  /** 今すぐ在庫警告を送る（保存済みの設定で。毎日の送信済み扱いにはしない） */
  async sendNow(actor: Actor): Promise<MailSendResult> {
    this.o.inventory.requireUser(actor);
    const settings = normalizeMailSettings({ ...this.stored(), enabled: true }, this.stored(), true);
    const products = this.o.inventory.lowStockProducts();
    if (products.length === 0) return { sent: false, message: "警告在庫以下の商品がないため、送信しませんでした。" };
    await this.deliver("manual", settings, buildLowStockDigest(products, this.o.clock.now(), this.siteUrl(settings), this.o.version));
    return { sent: true, message: `在庫警告（${products.length}件）を送信しました。` };
  }

  /**
   * 毎日の送信が必要か確認し、必要なら送る（1分ごとに呼ぶ想定）。
   * - 設定の時刻を過ぎていて、今日まだ送っていなければ送る（PC の起動が時刻より遅くても、その日の分は送る）
   * - 警告の商品が無ければ送らない（その日は済み扱い）
   * - 失敗したら30分ごとに再試行し、3回失敗したらその日はあきらめる（エラーメールの連打・接続の連打を防ぐ）
   */
  async tick(): Promise<void> {
    if (this.sending) return;
    const settings = this.stored();
    if (!settings.enabled) return;
    const now = this.o.clock.now();
    const today = dateKey(now);
    if (this.status().dailyDoneDate === today) return;
    if (timeKey(now) < settings.sendTime) return;
    if (this.retry?.date === today && now.getTime() < this.retry.nextAt) return;

    let complete: StoredMailSettings;
    try {
      complete = normalizeMailSettings({ ...settings }, settings, true);
    } catch (e) {
      this.setStatus({
        lastAttemptAt: formatLocal(now),
        lastKind: "daily",
        lastOk: false,
        lastMessage: `設定が不足しているため送信できません: ${(e as Error).message}`,
        dailyDoneDate: today,
      });
      return;
    }

    const products = this.o.inventory.lowStockProducts();
    if (products.length === 0) {
      this.setStatus({
        lastAttemptAt: formatLocal(now),
        lastKind: "daily",
        lastOk: true,
        lastMessage: "警告在庫以下の商品がないため、送信しませんでした。",
        dailyDoneDate: today,
      });
      return;
    }

    try {
      await this.deliver("daily", complete, buildLowStockDigest(products, now, this.siteUrl(complete), this.o.version));
      this.retry = null;
      this.setStatus({ dailyDoneDate: today });
    } catch {
      const attempts = (this.retry?.date === today ? this.retry.attempts : 0) + 1;
      this.retry = { date: today, attempts, nextAt: now.getTime() + RETRY_INTERVAL_MS };
      if (attempts >= MAX_DAILY_ATTEMPTS) {
        this.setStatus({ dailyDoneDate: today, lastMessage: `${this.status().lastMessage}（${attempts}回失敗したため、本日の送信を中止しました）` });
      }
    }
  }

  private siteUrl(s: StoredMailSettings): string {
    return s.siteUrl || this.o.defaultSiteUrl();
  }

  /** 送信して結果を記録する。失敗したら ExternalServiceError（画面にそのまま出せる文言） */
  private async deliver(kind: MailStatus["lastKind"], settings: StoredMailSettings, message: MailMessage): Promise<void> {
    if (this.sending) throw new ValidationError("別のメールを送信中です。少し待ってから再度お試しください。");
    this.sending = true;
    const at = formatLocal(this.o.clock.now());
    try {
      await this.o.mailer.send(settings, message);
      this.setStatus({ lastAttemptAt: at, lastKind: kind, lastOk: true, lastMessage: `送信しました: ${message.subject}` });
    } catch (e) {
      const text = describeMailError(e);
      this.setStatus({ lastAttemptAt: at, lastKind: kind, lastOk: false, lastMessage: text });
      throw new ExternalServiceError(text);
    } finally {
      this.sending = false;
    }
  }
}

function describeChange(before: StoredMailSettings, after: StoredMailSettings): string {
  const changes: string[] = [];
  if (before.enabled !== after.enabled) changes.push(after.enabled ? "通知を有効化" : "通知を無効化");
  if (before.host !== after.host || before.port !== after.port || before.security !== after.security) {
    changes.push(`サーバー: ${after.host || "なし"}:${after.port}（${after.security}）`);
  }
  if (before.authUser !== after.authUser) changes.push(`認証ユーザー: ${after.authUser || "なし"}`);
  if (before.password !== after.password) changes.push(after.password ? "パスワードを変更" : "パスワードを削除");
  if (before.allowSelfSignedCert !== after.allowSelfSignedCert) changes.push(`自己署名証明書: ${after.allowSelfSignedCert ? "許可" : "不許可"}`);
  if (before.from !== after.from) changes.push(`送信元: ${after.from || "なし"}`);
  if (before.to.join(",") !== after.to.join(",")) changes.push(`宛先: ${after.to.join(", ") || "なし"}`);
  if (before.sendTime !== after.sendTime) changes.push(`送信時刻: ${after.sendTime}`);
  if (before.siteUrl !== after.siteUrl) changes.push(`画面のアドレス: ${after.siteUrl || "自動"}`);
  return changes.length > 0 ? changes.join(" / ") : "変更なし";
}
