import { isIP } from "node:net";
import { Rules, type MailSettings, type SmtpSecurity } from "../../../shared/types.js";
import { ValidationError } from "../errors.js";
import { trimText } from "../text.js";

/** DB に保存する形（パスワードを含む。画面には返さない） */
export interface StoredMailSettings extends Omit<MailSettings, "hasPassword"> {
  password: string;
}

export const DEFAULT_MAIL_SETTINGS: StoredMailSettings = {
  enabled: false,
  host: "",
  port: 25,
  security: "none",
  allowSelfSignedCert: false,
  authUser: "",
  password: "",
  from: "",
  to: [],
  sendTime: "08:00",
  siteUrl: "",
};

const SECURITIES: readonly SmtpSecurity[] = ["none", "starttls", "ssl"];
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** 実用上十分な簡易チェック。改行・<>・"・空白を含むもの（ヘッダー差し込みの元）は弾く */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/;

export const isEmail = (s: string): boolean => s.length <= 254 && EMAIL_RE.test(s);

/** 宛先：配列または「改行・カンマ・セミコロン・空白」区切りの文字列。大文字小文字違いの重複は1つにする */
export function parseRecipients(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map((x) => trimText(x)) : trimText(raw).split(/[\s,;、，；]+/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

/** 時刻：「8:00」「８：００」も受け付けて "08:00" にする */
export function normalizeTime(raw: unknown): string | null {
  const s = trimText(raw).normalize("NFKC");
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const t = `${m[1]!.padStart(2, "0")}:${m[2]}`;
  return TIME_RE.test(t) ? t : null;
}

/**
 * 画面から送られた設定を検証して、保存する形にする。
 * - 「有効」にする場合だけ、サーバー・送信元・宛先を必須にする（途中まで入れて保存できるように）
 * - パスワードは空なら保存済みのものを使う。clearPassword で消せる
 * @param requireComplete true = 送信に必要な項目を必須にする（テスト送信時）
 */
export function normalizeMailSettings(
  raw: Record<string, unknown>,
  current: StoredMailSettings,
  requireComplete = false,
): StoredMailSettings {
  const errors: string[] = [];
  const enabled = raw.enabled === true;
  const mustBeComplete = enabled || requireComplete;

  const host = trimText(raw.host).toLowerCase();
  if (!host) {
    if (mustBeComplete) errors.push("メールサーバー（SMTP）を入力してください。");
  } else if (!(HOST_RE.test(host) || isIP(host) !== 0)) {
    errors.push("メールサーバーはホスト名（例: mail.example.co.jp）か IP アドレスで入力してください。");
  }

  const port = typeof raw.port === "string" ? Number(raw.port.normalize("NFKC")) : raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push("ポートは1〜65535の整数で入力してください。");
  }

  const security = raw.security as SmtpSecurity;
  if (!SECURITIES.includes(security)) errors.push("暗号化の指定が正しくありません。");

  const authUser = trimText(raw.authUser);
  if (authUser.length > 200 || CTRL_RE.test(authUser)) errors.push("認証ユーザーが正しくありません（200文字以内）。");

  let password = current.password;
  if (raw.clearPassword === true) password = "";
  if (typeof raw.password === "string" && raw.password !== "") {
    if (raw.password.length > 200 || /[\r\n]/.test(raw.password)) errors.push("パスワードが正しくありません（200文字以内）。");
    else password = raw.password;
  }
  if (!authUser) password = ""; // 認証なしならパスワードは持たない

  const from = trimText(raw.from);
  if (!from) {
    if (mustBeComplete) errors.push("送信元のメールアドレスを入力してください。");
  } else if (!isEmail(from)) errors.push(`送信元のメールアドレスが正しくありません: ${from}`);

  const to = parseRecipients(raw.to);
  const badTo = to.filter((t) => !isEmail(t));
  if (badTo.length > 0) errors.push(`宛先のメールアドレスが正しくありません: ${badTo.join(", ")}`);
  if (to.length === 0 && mustBeComplete) errors.push("宛先のメールアドレスを1つ以上入力してください。");
  if (to.length > Rules.maxMailRecipients) errors.push(`宛先は${Rules.maxMailRecipients}件までです。`);

  const sendTime = normalizeTime(raw.sendTime);
  if (!sendTime) errors.push("送信時刻は 0:00〜23:59 の形（例: 8:00）で入力してください。");

  const siteUrl = trimText(raw.siteUrl).replace(/\/+$/, "");
  if (siteUrl && !/^https?:\/\/[^\s/?#]+(?::\d+)?$/i.test(siteUrl)) {
    errors.push("画面のアドレスは http://192.168.1.10:28003 の形で入力してください（空欄なら自動）。");
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return {
    enabled,
    host,
    port: port as number,
    security,
    allowSelfSignedCert: raw.allowSelfSignedCert === true,
    authUser,
    password,
    from,
    to,
    sendTime: sendTime!,
    siteUrl,
  };
}

/** DB から読んだ値を、欠けた項目を既定値で補って使える形にする（古い形式・壊れた値への備え） */
export function fromStored(raw: unknown): StoredMailSettings {
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_MAIL_SETTINGS };
  const merged = { ...DEFAULT_MAIL_SETTINGS, ...(raw as Partial<StoredMailSettings>) };
  if (!Array.isArray(merged.to)) merged.to = [];
  if (!SECURITIES.includes(merged.security)) merged.security = "none";
  if (!normalizeTime(merged.sendTime)) merged.sendTime = DEFAULT_MAIL_SETTINGS.sendTime;
  return merged;
}

export function toPublic(s: StoredMailSettings): MailSettings {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: password !== "" };
}
