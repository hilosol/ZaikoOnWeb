import { useEffect, useState } from "react";
import type { OrderNumbersResponse } from "../../../shared/types";
import { api, errorMessage } from "../api";

/** 受注番号リスト（サーバーPCのリストファイル）の読み込み状態 */
export function OrderListSection() {
  const [data, setData] = useState<OrderNumbersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.orderNumbers().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  };
  useEffect(load, []);

  const st = data?.status;
  return (
    <section className="card" aria-label="紐づけIDリスト">
      <h2>紐づけIDリスト（受注番号等）</h2>
      <p className="muted small">
        入出庫の「紐づけID」欄の候補です（ファイル名は 受注番号リスト.txt のまま）。サーバーPCのリストファイル（1行1件。「受注番号_案件名」＝案件フォルダ名そのまま、または番号だけ）を読みます。
        ファイルを置き換えると自動で反映されます。リストに無い番号も入力できます。
      </p>
      {error && <div className="error-box">{error}</div>}
      {st && (
        <dl className="log-export">
          <dt>ファイル</dt>
          <dd>
            <code data-testid="order-list-file">{st.file || "（未設定）"}</code>
          </dd>
          <dt>状態</dt>
          <dd data-testid="order-list-status">
            {st.exists ? `${st.count}件（ファイルの更新: ${st.modifiedAt ?? "-"}）` : "ファイルがありません（手入力のみ）"}
            {st.skipped > 0 && `・読み飛ばした行 ${st.skipped}`}
          </dd>
        </dl>
      )}
      {st?.error && <div className="error-box">{st.error}</div>}
      <div className="csv-actions">
        <button type="button" className="button" onClick={load}>
          読み直す
        </button>
      </div>
    </section>
  );
}
