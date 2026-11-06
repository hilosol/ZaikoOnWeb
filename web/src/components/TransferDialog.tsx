import { useEffect, useState } from "react";
import { Rules } from "../../../shared/types";
import { api } from "../api";
import { formatNumber, Modal } from "./common";

/**
 * 移管先の入力（過去の移管先を候補に出す）。PC 用画面・スマホ用画面で共通。
 * 入力チェック（必須・文字数）はここで行い、サーバーでも同じ規則で再チェックする。
 */
export function TransferDialog({
  productName,
  quantity,
  busy,
  onCancel,
  onSubmit,
}: {
  productName: string;
  quantity: number;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (destination: string) => void;
}) {
  const [dest, setDest] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.destinations().then(setCandidates).catch(() => setCandidates([]));
  }, []);

  const submit = () => {
    const d = dest.trim();
    if (!d) {
      setError("移管先（人・部署）を入力してください。");
      return;
    }
    if (d.length > Rules.destinationMaxLength) {
      setError(`移管先は${Rules.destinationMaxLength}文字以内で入力してください。`);
      return;
    }
    onSubmit(d);
  };

  return (
    <Modal title="移管" onClose={onCancel}>
      <p className="muted small">
        {productName} を {formatNumber(quantity)} 個移管します。在庫から差し引かれます。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>移管先（人・部署）</span>
          <input
            type="text"
            value={dest}
            maxLength={Rules.destinationMaxLength}
            onChange={(e) => {
              setDest(e.target.value);
              setError(null);
            }}
            autoFocus
            enterKeyHint="done"
          />
        </label>
        {candidates.length > 0 && (
          <div className="m-chips" aria-label="よく使う移管先">
            {candidates.slice(0, 12).map((c) => (
              <button key={c} type="button" className={`chip${c === dest ? " selected" : ""}`} onClick={() => setDest(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        <div className="m-dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="button transfer large" disabled={busy}>
            移管する
          </button>
        </div>
      </form>
    </Modal>
  );
}
