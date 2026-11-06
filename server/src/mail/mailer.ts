import nodemailer from "nodemailer";
import type { StoredMailSettings } from "./mailSettings.js";

export interface MailMessage {
  subject: string;
  text: string;
}

/** 送信の仕組み（テストでは偽物に差し替える） */
export interface Mailer {
  send(settings: StoredMailSettings, message: MailMessage): Promise<void>;
}

const TIMEOUT_MS = 15_000;

/** nodemailer で SMTP サーバーに送る。設定が画面から変わるため、送るたびに接続を作る（1日数通なので負荷は問題にならない） */
export class SmtpMailer implements Mailer {
  async send(s: StoredMailSettings, message: MailMessage): Promise<void> {
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.security === "ssl",
      requireTLS: s.security === "starttls",
      // 「なし」では STARTTLS も試さない（社内リレーで証明書が不正だと失敗するため）
      ignoreTLS: s.security === "none",
      auth: s.authUser ? { user: s.authUser, pass: s.password } : undefined,
      tls: s.allowSelfSignedCert ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
      // 本文にファイル・URL の読み込み指定が紛れても読みに行かない
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      await transport.sendMail({
        from: s.from,
        to: s.to,
        subject: message.subject,
        text: message.text,
      });
    } finally {
      transport.close();
    }
  }
}

/** 送信エラーを、何を確認すればよいか分かる日本語にする（元のエラーコードも付ける） */
export function describeMailError(error: unknown): string {
  const e = error as { code?: string; responseCode?: number; response?: string; message?: string };
  // nodemailer は接続エラーを ESOCKET / ECONNECTION にまとめることがあるため、元の errno が文中にあればそちらで判断する
  const inner = /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b/.exec(String(e?.message ?? ""))?.[1];
  const code = (e?.code === "ESOCKET" || e?.code === "ECONNECTION") && inner ? inner : (e?.code ?? "");
  const detail = [code, e?.responseCode, (e?.response ?? e?.message ?? "").toString().slice(0, 200)]
    .filter((x) => x !== undefined && x !== "")
    .join(" ");
  let hint: string;
  switch (code) {
    case "ECONNREFUSED":
      hint = "メールサーバーに接続を拒否されました。サーバー名・ポートを確認してください。";
      break;
    case "ETIMEDOUT":
    case "ETIMEOUT":
    case "ECONNECTION":
    case "ECONNRESET":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      hint = "メールサーバーに接続できませんでした（応答なし）。ポートがファイアウォールで塞がれていないか確認してください。";
      break;
    case "ENOTFOUND":
    case "EDNS":
    case "EAI_AGAIN":
      hint = "メールサーバーの名前が見つかりません。サーバー名を確認してください。";
      break;
    case "EAUTH":
      hint = "認証に失敗しました。ユーザー名・パスワードを確認してください。";
      break;
    case "ETLS":
    case "ESOCKET":
      hint = /certificate|self[- ]signed/i.test(detail)
        ? "サーバーの証明書を確認できませんでした。社内サーバーなら「自己署名証明書を許可」を試してください。"
        : "暗号化（TLS）の接続に失敗しました。暗号化の種類とポートの組み合わせを確認してください（25: なし / 587: STARTTLS / 465: SSL）。";
      break;
    case "EENVELOPE":
      hint = "送信元または宛先のアドレスがサーバーに受け付けられませんでした。";
      break;
    default:
      hint =
        e?.responseCode && e.responseCode >= 500
          ? "メールサーバーに送信を拒否されました。送信元アドレスや中継の許可を確認してください。"
          : "メールを送信できませんでした。";
  }
  return detail ? `${hint}（${detail}）` : hint;
}
