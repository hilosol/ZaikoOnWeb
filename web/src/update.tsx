import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateStatus, UpdateStatusResponse } from "../../shared/types";
import { api, errorMessage } from "./api";
import { Modal, shortDateTime } from "./components/common";
import { useApp } from "./context";
import { usePolling } from "./hooks";
import { APP_VERSION } from "./version";

/**
 * プログラムの更新（サーバーPCの画面だけに出す）。
 * 他の端末には API が local: false しか返さないので、ここの表示は一切出ない。
 */

const STATUS_POLL_MS = 30 * 60 * 1000;
const PROGRESS_POLL_MS = 3000;
const PROGRESS_LIMIT_MS = 20 * 60 * 1000;

/** 更新の状態。サーバーPC以外・取得失敗のときは null */
export function useUpdateStatus(): { status: UpdateStatus | null; setStatus: (s: UpdateStatusResponse) => void; reload: () => void } {
  const [status, setRaw] = useState<UpdateStatus | null>(null);
  const setStatus = useCallback((s: UpdateStatusResponse) => setRaw(s.local ? s : null), []);
  const reload = useCallback(() => {
    api.updateStatus().then(setStatus, () => undefined);
  }, [setStatus]);
  useEffect(reload, [reload]);
  usePolling(reload, STATUS_POLL_MS);
  return { status, setStatus, reload };
}

/** 新しい版があるとき、画面の上に出すお知らせ */
export function UpdateBanner() {
  const { status, reload } = useUpdateStatus();
  const [open, setOpen] = useState(false);
  if (!status || (!status.available && !status.running && !open)) return null;
  return (
    <>
      {(status.available || status.running) && (
        <div className="update-banner" role="status">
          {status.running ? "プログラムを更新しています…" : `新しい版があります（変更 ${status.commits.length} 件）`}
          <button type="button" className="button small" onClick={() => setOpen(true)}>
            {status.running ? "状況を見る" : "内容を見て更新"}
          </button>
        </div>
      )}
      {open && (
        <UpdateDialog
          status={status}
          onClose={() => {
            setOpen(false);
            reload();
          }}
        />
      )}
    </>
  );
}

type Progress = { phase: "idle" } | { phase: "running"; since: number } | { phase: "done"; message: string } | { phase: "failed"; message: string };

/** 変更内容の確認と更新の実行。更新中はサーバーが一度止まるので、戻ってくるまで待つ */
export function UpdateDialog({ status, onClose }: { status: UpdateStatus; onClose: () => void }) {
  const app = useApp();
  const [progress, setProgress] = useState<Progress>(status.running ? { phase: "running", since: Date.now() } : { phase: "idle" });
  const startedAt = useRef<number>(Date.now());

  const run = async () => {
    if (!window.confirm("プログラムを更新します。数分間、すべての端末で在庫管理が使えなくなります。\n入力中の人がいないか確認してから続けてください。")) return;
    try {
      startedAt.current = Date.now();
      await api.updateRun();
      setProgress({ phase: "running", since: Date.now() });
    } catch (e) {
      app.toast(errorMessage(e), "error");
    }
  };

  // 更新中：サーバーが止まって戻るまで待ち、結果を表示する
  useEffect(() => {
    if (progress.phase !== "running") return;
    const id = window.setInterval(async () => {
      if (Date.now() - progress.since > PROGRESS_LIMIT_MS) {
        setProgress({ phase: "failed", message: "更新が終わりません。サーバーPCの data\\update.log を確認してください。" });
        return;
      }
      try {
        const health = (await (await fetch("/api/health", { cache: "no-store" })).json()) as { version?: string };
        if (health.version && health.version !== APP_VERSION) {
          setProgress({ phase: "done", message: "更新しました。画面を読み込み直します。" });
          window.setTimeout(() => window.location.reload(), 1500);
          return;
        }
        const s = await api.updateStatus();
        if (!s.local || s.running || !s.lastResult) return;
        if (Date.parse(s.lastResult.finishedAt) < startedAt.current - 60_000) return; // 前回の結果
        setProgress(s.lastResult.ok ? { phase: "done", message: s.lastResult.message } : { phase: "failed", message: s.lastResult.message });
      } catch {
        // 再起動中はつながらないので待つ
      }
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(id);
  }, [progress]);

  return (
    <Modal title="プログラムの更新" onClose={progress.phase === "running" ? undefined : onClose} wide>
      {progress.phase === "idle" && (
        <>
          {status.commits.length > 0 ? (
            <>
              <p className="small">新しい版の変更内容（新しい順）：</p>
              <ul className="update-commits" data-testid="update-commits">
                {status.commits.map((c) => (
                  <li key={c}>{c.replace(/^\S+\s/, "")}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted small">新しい版はありません。</p>
          )}
          <p className="muted small">更新中は数分間、すべての端末で使えなくなります。データ（在庫・履歴・写真）はそのまま残ります。</p>
          <div className="m-dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              閉じる
            </button>
            <button type="button" className="button primary" onClick={() => void run()} disabled={status.commits.length === 0}>
              更新する
            </button>
          </div>
        </>
      )}
      {progress.phase === "running" && <p data-testid="update-progress">更新しています…（数分かかります。この画面のままお待ちください）</p>}
      {progress.phase === "done" && <p data-testid="update-progress">{progress.message}</p>}
      {progress.phase === "failed" && (
        <>
          <div className="error-box" data-testid="update-progress">
            更新に失敗しました。前の版のまま使えます。
            <br />
            {progress.message}
          </div>
          <div className="m-dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              閉じる
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** 設定画面の「プログラムの更新」（サーバーPCの画面にだけ出す） */
export function UpdateSection({ status, onChange }: { status: UpdateStatus; onChange: (s: UpdateStatusResponse) => void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(false);

  const act = async (action: () => Promise<UpdateStatusResponse>, done?: string) => {
    setBusy(true);
    try {
      onChange(await action());
      if (done) app.toast(done);
      return true;
    } catch (e) {
      app.toast(errorMessage(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="プログラムの更新">
      <h2>プログラムの更新</h2>
      <p className="muted small">この項目はサーバーPCの画面にだけ表示されます。新しい版は6時間ごとに確認し、あれば画面の上でお知らせします。</p>
      <dl className="log-export">
        <dt>今の版</dt>
        <dd>
          {APP_VERSION}
          {status.current && <span className="muted">（{status.current}）</span>}
        </dd>
        <dt>最後の確認</dt>
        <dd data-testid="update-check-result">
          {status.checkedAt ? shortDateTime(status.checkedAt) : "まだ確認していません"}
          {status.checkedAt && !status.checkError && (status.available ? `・新しい版があります（変更 ${status.commits.length} 件）` : "・最新です")}
        </dd>
        {status.lastResult && (
          <>
            <dt>最後の更新</dt>
            <dd>
              {status.lastResult.finishedAt && shortDateTime(status.lastResult.finishedAt)}・{status.lastResult.ok ? "成功" : "失敗"}：{status.lastResult.message}
            </dd>
          </>
        )}
      </dl>
      {status.checkError && <div className="error-box">{status.checkError}</div>}
      <div className="csv-actions">
        <button type="button" className="button" disabled={busy || !status.supported} onClick={() => void act(api.updateCheck)}>
          {busy ? "確認中…" : "今すぐ確認"}
        </button>
        <button type="button" className="button primary" disabled={busy || (!status.available && !status.running)} onClick={() => setOpen(true)}>
          {status.running ? "更新の状況を見る" : "内容を見て更新"}
        </button>
      </div>

      <h3 className="small">GitHub の読み取り用トークン {status.tokenConfigured ? "（設定済み）" : "（未設定）"}</h3>
      <p className="muted small">
        画面からの更新は、サーバーPCで動いているサーバー（Windows の SYSTEM）が GitHub に接続します。このリポジトリだけを読める期限付きのトークン（Fine-grained
        token、Contents: Read-only）を貼り付けてください。トークンはサーバーPCの data フォルダに保存され、画面には表示されません。
      </p>
      <form
        className="csv-actions"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api.updateToken(token), token.trim() ? "トークンを保存しました" : "トークンを削除しました").then((ok) => ok && setToken(""));
        }}
      >
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={status.tokenConfigured ? "変更する場合のみ入力（空で保存すると削除）" : "github_pat_..."}
          aria-label="GitHub のトークン"
          autoComplete="off"
          disabled={busy || !status.supported}
        />
        <button type="submit" className="button" disabled={busy || !status.supported || (!token.trim() && !status.tokenConfigured)}>
          {token.trim() || !status.tokenConfigured ? "保存" : "削除"}
        </button>
      </form>
      {open && <UpdateDialog status={status} onClose={() => setOpen(false)} />}
    </section>
  );
}
