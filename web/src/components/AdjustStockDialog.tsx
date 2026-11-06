import { useState } from "react";
import { normalizeText } from "../../../shared/text";
import { Rules, type Product } from "../../../shared/types";
import { api, ApiError, errorMessage } from "../api";
import { useApp } from "../context";
import { formatNumber, Modal } from "./common";

/** 在庫調整（棚卸し）：実際に数えた数を入力して在庫を合わせる。PC 画面のみ */
export function AdjustStockDialog({
  product,
  onClose,
  onDone,
  onRefresh,
}: {
  product: Product;
  onClose: () => void;
  /** 調整できた：閉じて一覧を更新 */
  onDone: () => Promise<void> | void;
  /** 一覧だけ更新（ダイアログは開いたまま、最新の在庫を表示する） */
  onRefresh: () => Promise<void> | void;
}) {
  const app = useApp();
  const [stockText, setStockText] = useState(String(product.stock));
  const [reason, setReason] = useState("棚卸し");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const t = normalizeText(stockText).replace(/,/g, "");
  const target = /^\d+$/.test(t) && Number(t) <= Rules.maxStock ? Number(t) : null;
  const delta = target === null ? null : target - product.stock;

  const submit = async () => {
    const userName = app.requireUser();
    if (!userName) return;
    if (target === null) {
      setError(`調整後の在庫は0〜${formatNumber(Rules.maxStock)}の整数で入力してください。`);
      return;
    }
    if (!reason.trim()) {
      setError("調整の理由を入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.adjustStock(product.id, target, product.stock, reason, userName);
      app.toast(`「${updated.name}」の在庫を ${formatNumber(product.stock)} → ${formatNumber(updated.stock)} に調整しました`);
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      // 他の端末で在庫が変わっていた場合は、最新の在庫を表示し直してもらう
      if (e instanceof ApiError && e.status === 409) await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="在庫調整" onClose={onClose}>
      <p className="muted small">
        {product.code} {product.name}
        <br />
        実際に数えた数を入力してください。差は「棚卸調整」として履歴に残ります。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="adjust-grid">
          <div className="field">
            <span>現在の在庫</span>
            <div className="readonly-value">{formatNumber(product.stock)}</div>
          </div>
          <label className="field">
            <span>調整後の在庫</span>
            <input
              type="text"
              inputMode="numeric"
              className={`num${target === null ? " invalid" : ""}`}
              value={stockText}
              onChange={(e) => setStockText(e.target.value)}
              onFocus={(e) => e.target.select()}
              autoFocus
              aria-label="調整後の在庫"
            />
          </label>
          <div className="field">
            <span>差</span>
            <div className={`readonly-value${delta !== null && delta < 0 ? " danger" : ""}`} data-testid="adjust-delta">
              {delta === null ? "—" : `${delta > 0 ? "+" : ""}${formatNumber(delta)}`}
            </div>
          </div>
        </div>
        <label className="field">
          <span>理由（必須）</span>
          <input
            type="text"
            value={reason}
            maxLength={Rules.commentMaxLength}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例: 棚卸し、破損分、数え間違いの修正"
            aria-label="理由"
          />
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="m-dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="button primary" disabled={busy || target === null || delta === 0}>
            調整する
          </button>
        </div>
      </form>
    </Modal>
  );
}
