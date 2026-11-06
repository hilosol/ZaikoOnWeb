import { useCallback, useEffect, useState } from "react";
import { CancelableTypes, HistoryFieldLabels, MovementLabels, Rules, type History, type HistoryEdit } from "../../../shared/types";
import { api, ApiError, errorMessage } from "../api";
import { useApp } from "../context";
import { ErrorBox, formatNumber, Modal } from "./common";

/**
 * 履歴の詳細・修正・取消（PC 画面）。
 * 直せるのはコメントだけ。数量・区分の誤りは「取消」して入力し直す
 * （取消は逆向きの履歴を作って在庫を戻す。元の履歴は残る）。直した内容はすべて修正履歴に残る。
 */
export function HistoryDialog({ historyId, onClose, onChanged }: { historyId: number; onClose: () => void; onChanged: () => void }) {
  const app = useApp();
  const [history, setHistory] = useState<History | null>(null);
  const [edits, setEdits] = useState<HistoryEdit[]>([]);
  const [comment, setComment] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.historyDetail(historyId);
      setHistory(d.history);
      setEdits(d.edits);
      setComment(d.history.comment ?? "");
    } catch (e) {
      setError({ message: errorMessage(e) });
    }
  }, [historyId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!history) {
    return (
      <Modal title="履歴" onClose={onClose}>
        {error ? <ErrorBox message={error.message} /> : <p className="muted">読み込み中…</p>}
      </Modal>
    );
  }

  const h = history;
  const editable = h.type !== "CANCEL";
  const dirty = comment.trim() !== (h.comment ?? "");
  const cancelable = CancelableTypes.includes(h.type) && h.canceledBy === null;

  const showError = (e: unknown) => setError({ message: errorMessage(e), details: e instanceof ApiError ? e.details : undefined });

  const save = async () => {
    const userName = app.requireUser();
    if (!userName) return;
    setBusy(true);
    setError(null);
    try {
      await api.editHistory(h.id, { comment, userName });
      app.toast("コメントを修正しました");
      onChanged();
      await load();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    const userName = app.requireUser();
    if (!userName) return;
    if (!cancelReason.trim()) {
      setError({ message: "取消の理由を入力してください。" });
      return;
    }
    const effect = h.type === "IN" ? `在庫を ${formatNumber(h.quantity)} 減らします` : `在庫を ${formatNumber(h.quantity)} 戻します`;
    if (!window.confirm(`この${MovementLabels[h.type]}（${formatNumber(h.quantity)}）を取り消します。\n${effect}。よろしいですか？`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelHistory(h.id, cancelReason, userName);
      app.toast(`${MovementLabels[h.type]}を取り消しました`);
      setCancelReason("");
      onChanged();
      await load();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="履歴の詳細・修正" onClose={onClose} wide>
      <dl className="history-detail">
        <dt>日時</dt>
        <dd>{h.createdAt}</dd>
        <dt>商品</dt>
        <dd>
          {h.productCode} {h.productName}
        </dd>
        <dt>区分・数量</dt>
        <dd>
          <b className={`type-${h.type}`}>{MovementLabels[h.type]}</b> {formatNumber(h.quantity)}（処理後在庫 {formatNumber(h.stockAfter)}）
          {h.canceledBy !== null && <span className="tag-label canceled">取消済</span>}
        </dd>
        {h.orderNo && (
          <>
            <dt>受注番号</dt>
            <dd>{h.orderNo}</dd>
          </>
        )}
        {h.destination && (
          <>
            <dt>移管先</dt>
            <dd>{h.destination}</dd>
          </>
        )}
        {h.reason && (
          <>
            <dt>理由</dt>
            <dd>{h.reason}</dd>
          </>
        )}
        <dt>入力者</dt>
        <dd>
          {h.userName || "(未登録)"}（{h.clientIp}）
        </dd>
      </dl>

      {editable ? (
        <div className="history-edit">
          <label className="field">
            <span>コメント</span>
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={Rules.commentMaxLength} />
          </label>
          <div className="history-edit-actions">
            <span className="muted small">直せるのはコメントだけです。数量・区分の間違いは、下の「取消」をして入力し直してください。</span>
            <span className="spacer" />
            <button type="button" className="button primary" onClick={() => void save()} disabled={busy || !dirty}>
              コメントを保存
            </button>
          </div>
        </div>
      ) : (
        <p className="muted small">取消の履歴は修正できません。</p>
      )}

      <ErrorBox message={error?.message ?? null} details={error?.details} />

      {cancelable && (
        <div className="history-cancel">
          <h3>取消</h3>
          <p className="muted small">
            {h.type === "IN" ? "在庫を" : "在庫を"} {formatNumber(h.quantity)} {h.type === "IN" ? "減らし" : "戻し"}、「取消」の履歴を残します（この履歴は消えません）。
          </p>
          <div className="inline-form">
            <input
              type="text"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              maxLength={Rules.commentMaxLength}
              placeholder="取消の理由（必須）例: 数量の入力間違い"
              aria-label="取消の理由"
            />
            <button type="button" className="button danger" onClick={() => void cancel()} disabled={busy}>
              この履歴を取り消す
            </button>
          </div>
        </div>
      )}

      <div className="history-edits">
        <h3>修正履歴</h3>
        {edits.length === 0 ? (
          <p className="muted small">修正はありません。</p>
        ) : (
          <table className="audit-table" data-testid="history-edits">
            <thead>
              <tr>
                <th>日時</th>
                <th>項目</th>
                <th>修正前</th>
                <th>修正後</th>
                <th>入力者</th>
              </tr>
            </thead>
            <tbody>
              {edits.map((e) => (
                <tr key={e.id}>
                  <td>{e.createdAt.slice(5, 16)}</td>
                  <td>{HistoryFieldLabels[e.field] ?? e.field}</td>
                  <td>{e.before || <span className="muted">（なし）</span>}</td>
                  <td>{e.after || <span className="muted">（なし）</span>}</td>
                  <td title={e.clientIp}>{e.userName || e.clientIp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
