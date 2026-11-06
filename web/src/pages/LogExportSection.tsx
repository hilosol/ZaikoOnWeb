import { useEffect, useState } from "react";
import type { LogExportStatus } from "../../../shared/types";
import { api, errorMessage } from "../api";
import { useApp } from "../context";

/** 履歴 CSV の自動保存（data\logs）の状態表示と、今すぐ書き出すボタン */
export function LogExportSection() {
  const app = useApp();
  const [status, setStatus] = useState<LogExportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.logExport().then(setStatus, (e) => setError(errorMessage(e)));
  }, []);

  const run = async () => {
    setBusy(true);
    try {
      const s = await api.runLogExport();
      setStatus(s);
      setError(null);
      if (s.failures.length === 0) app.toast(`履歴のCSVを書き出しました（${s.written}ファイル）`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="履歴のCSV保存">
      <h2>履歴のCSV保存（自動）</h2>
      <p className="muted small">
        入出庫履歴・操作ログ・商品コードの変更履歴を、月ごとの CSV ファイルとして共有PCに保存しています（1時間ごと・サーバー終了時に更新）。
        データベースとは別の控えとして、Excel でそのまま開けます。
      </p>
      {status && (
        <dl className="log-export">
          <dt>保存先</dt>
          <dd>
            <code data-testid="log-export-dir">{status.dir}</code>
          </dd>
          <dt>前回の書き出し</dt>
          <dd>{status.lastRunAt ? `${status.lastRunAt}（${status.written}ファイル）` : "まだありません"}</dd>
        </dl>
      )}
      {status && status.failures.length > 0 && (
        <div className="error-box" role="alert">
          {status.failures.map((f) => (
            <div key={f.file}>
              {f.file}：{f.reason}
            </div>
          ))}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      <div className="csv-actions">
        <button type="button" className="button" onClick={() => void run()} disabled={busy}>
          {busy ? "書き出し中…" : "今すぐ書き出す"}
        </button>
      </div>
      <p className="muted small">ファイル名の例：入出庫履歴_2026-11.csv ／ 操作ログ_2026-11.csv ／ コード変更履歴_2026-11.csv</p>
    </section>
  );
}
