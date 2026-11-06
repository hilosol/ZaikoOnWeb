import { useCallback, useEffect, useState } from "react";
import {
  Rules,
  SmtpSecurityLabels,
  type MailSettings,
  type MailSettingsRequest,
  type MailStatus,
  type SmtpSecurity,
} from "../../../shared/types";
import { api, ApiError, errorMessage } from "../api";
import { ErrorBox } from "../components/common";
import { useApp } from "../context";

interface FormState {
  enabled: boolean;
  host: string;
  port: string;
  security: SmtpSecurity;
  allowSelfSignedCert: boolean;
  authUser: string;
  password: string;
  clearPassword: boolean;
  from: string;
  to: string;
  sendTime: string;
  siteUrl: string;
}

/** 暗号化の種類ごとの標準ポート（種類を変えたとき、ポートが標準値のままなら合わせて変える） */
const DEFAULT_PORTS: Record<SmtpSecurity, number> = { none: 25, starttls: 587, ssl: 465 };

const toForm = (s: MailSettings): FormState => ({
  enabled: s.enabled,
  host: s.host,
  port: String(s.port),
  security: s.security,
  allowSelfSignedCert: s.allowSelfSignedCert,
  authUser: s.authUser,
  password: "",
  clearPassword: false,
  from: s.from,
  to: s.to.join("\n"),
  sendTime: s.sendTime,
  siteUrl: s.siteUrl,
});

const KIND_LABELS: Record<NonNullable<MailStatus["lastKind"]>, string> = {
  test: "テスト送信",
  manual: "手動送信",
  daily: "毎日の送信",
};

/** メール通知（在庫警告）の設定。SMTP サーバー・宛先・送信時刻をこの画面で変更する */
export function MailSettingsSection() {
  const app = useApp();
  const [form, setForm] = useState<FormState | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [defaultSiteUrl, setDefaultSiteUrl] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test" | "send">("");
  const [error, setError] = useState<{ message: string; details?: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = (r: { settings: MailSettings; status: MailStatus; defaultSiteUrl: string }) => {
    setForm(toForm(r.settings));
    setHasPassword(r.settings.hasPassword);
    setStatus(r.status);
    setDefaultSiteUrl(r.defaultSiteUrl);
    setDirty(false);
  };

  const load = useCallback(async () => {
    try {
      apply(await api.mailSettings());
    } catch (e) {
      setError({ message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!form) {
    return (
      <section className="card">
        <h2>メール通知</h2>
        {error ? <ErrorBox message={error.message} /> : <p className="muted">読み込み中…</p>}
      </section>
    );
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setDirty(true);
    setNotice(null);
  };

  const changeSecurity = (security: SmtpSecurity) => {
    const isDefaultPort = Object.values(DEFAULT_PORTS).map(String).includes(form.port.trim());
    setForm((f) => (f ? { ...f, security, port: isDefaultPort ? String(DEFAULT_PORTS[security]) : f.port } : f));
    setDirty(true);
  };

  const request = (userName: string): MailSettingsRequest => ({
    enabled: form.enabled,
    host: form.host,
    // 数値にできない場合は文字列のまま送り、サーバー側のエラーメッセージを出す
    port: (Number.isFinite(Number(form.port)) && form.port.trim() !== "" ? Number(form.port) : form.port) as number,
    security: form.security,
    allowSelfSignedCert: form.allowSelfSignedCert,
    authUser: form.authUser,
    password: form.password,
    clearPassword: form.clearPassword,
    from: form.from,
    to: form.to,
    sendTime: form.sendTime,
    siteUrl: form.siteUrl,
    userName,
  });

  const showError = (e: unknown) => setError({ message: errorMessage(e), details: e instanceof ApiError ? e.details : undefined });

  const save = async () => {
    const userName = app.requireUser();
    if (!userName) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      apply(await api.saveMailSettings(request(userName)));
      app.toast("メール通知の設定を保存しました");
    } catch (e) {
      showError(e);
    } finally {
      setBusy("");
    }
  };

  /** 送信系の操作の後は、前回の送信結果を更新する（失敗時も結果が記録されるため） */
  const refreshStatus = async () => {
    try {
      setStatus((await api.mailSettings()).status);
    } catch {
      // 状態の再取得に失敗しても、操作の結果は表示済み
    }
  };

  const test = async () => {
    const userName = app.requireUser();
    if (!userName) return;
    setBusy("test");
    setError(null);
    setNotice(null);
    try {
      setNotice((await api.testMail(request(userName))).message);
    } catch (e) {
      showError(e);
    } finally {
      setBusy("");
      await refreshStatus();
    }
  };

  const sendNow = async () => {
    if (dirty && !window.confirm("変更が保存されていません。保存済みの設定で送信しますか？")) return;
    const userName = app.requireUser();
    if (!userName) return;
    setBusy("send");
    setError(null);
    setNotice(null);
    try {
      setNotice((await api.sendLowStockMailNow(userName)).message);
    } catch (e) {
      showError(e);
    } finally {
      setBusy("");
      await refreshStatus();
    }
  };

  const disabled = busy !== "";

  return (
    <section className="card mail-settings" aria-label="メール通知">
      <h2>メール通知</h2>
      <p className="muted small">
        警告在庫以下の商品があるとき、1日1回、一覧をメールで送ります（該当なしの日は送りません）。
        このPCが送信時刻に止まっていた場合は、起動後にその日の分を送ります。
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="check-field">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          <span>毎日の在庫警告メールを送る</span>
        </label>

        <div className="mail-grid">
          <fieldset className="mail-group">
            <legend>メールサーバー（SMTP）</legend>
            <label className="field">
              <span>サーバー名</span>
              <input
                type="text"
                value={form.host}
                onChange={(e) => set("host", e.target.value)}
                placeholder="例: mail.hisol.jp / 192.168.1.20"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>暗号化</span>
                <select value={form.security} onChange={(e) => changeSecurity(e.target.value as SmtpSecurity)}>
                  {(Object.keys(SmtpSecurityLabels) as SmtpSecurity[]).map((k) => (
                    <option key={k} value={k}>
                      {SmtpSecurityLabels[k]}（{DEFAULT_PORTS[k]}番が一般的）
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>ポート</span>
                <input type="text" inputMode="numeric" className="num" value={form.port} onChange={(e) => set("port", e.target.value)} />
              </label>
            </div>
            {form.security !== "none" && (
              <label className="check-field small">
                <input
                  type="checkbox"
                  checked={form.allowSelfSignedCert}
                  onChange={(e) => set("allowSelfSignedCert", e.target.checked)}
                />
                <span>自己署名証明書を許可（社内サーバーで証明書エラーになる場合のみ）</span>
              </label>
            )}
            <div className="field-row">
              <label className="field">
                <span>認証ユーザー（不要なら空欄）</span>
                <input type="text" value={form.authUser} onChange={(e) => set("authUser", e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <label className="field">
                <span>パスワード{hasPassword && !form.clearPassword ? "（設定済み・変更時のみ入力）" : ""}</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  autoComplete="new-password"
                  disabled={!form.authUser.trim() || form.clearPassword}
                  placeholder={hasPassword ? "••••••••" : ""}
                />
              </label>
            </div>
            {hasPassword && (
              <label className="check-field small">
                <input type="checkbox" checked={form.clearPassword} onChange={(e) => set("clearPassword", e.target.checked)} />
                <span>保存済みのパスワードを削除する</span>
              </label>
            )}
          </fieldset>

          <fieldset className="mail-group">
            <legend>送信内容</legend>
            <label className="field">
              <span>送信元アドレス</span>
              <input
                type="email"
                value={form.from}
                onChange={(e) => set("from", e.target.value)}
                placeholder="例: prober-zaiko@hisol.jp"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>宛先（1行に1件。{Rules.maxMailRecipients}件まで）</span>
              <textarea
                value={form.to}
                onChange={(e) => set("to", e.target.value)}
                rows={3}
                placeholder="例: machida@hisol.jp"
                spellCheck={false}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>送信時刻（毎日）</span>
                <input type="time" value={form.sendTime} onChange={(e) => set("sendTime", e.target.value)} required />
              </label>
              <label className="field">
                <span>メール内リンクのアドレス</span>
                <input
                  type="text"
                  value={form.siteUrl}
                  onChange={(e) => set("siteUrl", e.target.value)}
                  placeholder={defaultSiteUrl ? `自動: ${defaultSiteUrl}` : "例: http://192.168.1.10:28003"}
                  spellCheck={false}
                />
              </label>
            </div>
          </fieldset>
        </div>

        <ErrorBox message={error?.message ?? null} details={error?.details} />
        {notice && (
          <div className="notice-box" role="status">
            {notice}
          </div>
        )}

        <div className="mail-actions">
          <button type="button" className="button" onClick={() => void test()} disabled={disabled}>
            {busy === "test" ? "送信中…" : "テスト送信"}
          </button>
          <button type="button" className="button" onClick={() => void sendNow()} disabled={disabled}>
            {busy === "send" ? "送信中…" : "今すぐ在庫警告を送る"}
          </button>
          <span className="spacer" />
          {dirty && (
            <button type="button" className="button" onClick={() => void load()} disabled={disabled}>
              元に戻す
            </button>
          )}
          <button type="submit" className="button primary" disabled={disabled || !dirty}>
            {busy === "save" ? "保存中…" : "保存"}
          </button>
        </div>
        <p className="muted small">テスト送信は、保存前の入力内容で送ります。「今すぐ送る」は保存済みの設定で送ります。</p>
      </form>

      {status && status.lastAttemptAt && (
        <div className={`mail-status ${status.lastOk ? "ok" : "ng"}`} data-testid="mail-status">
          <span className="tag-label">{status.lastOk ? "成功" : "失敗"}</span>
          <span>
            前回の送信（{status.lastKind ? KIND_LABELS[status.lastKind] : "-"}）：{status.lastAttemptAt}
          </span>
          <div className="mail-status-message">{status.lastMessage}</div>
          {status.dailyDoneDate && <div className="muted small">毎日の送信：{status.dailyDoneDate} 分は処理済み</div>}
        </div>
      )}
    </section>
  );
}
