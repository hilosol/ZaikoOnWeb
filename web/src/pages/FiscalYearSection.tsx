import { useEffect, useState } from "react";
import { fiscalYearStartMonth } from "../../../shared/types";
import { api, errorMessage } from "../api";
import { useApp } from "../context";
import { useGeneralSettings } from "../generalSettings";
import { fiscalYearLabel, fiscalYearOf } from "../history/period";

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/** 年度（決算月）の設定。履歴ページの「年度」の選択肢に使う。全端末で共通 */
export function FiscalYearSection() {
  const app = useApp();
  const { settings, loaded, reload } = useGeneralSettings();
  const [endMonth, setEndMonth] = useState(settings.fiscalYearEndMonth);
  const [busy, setBusy] = useState(false);

  // 読み込みが終わったら保存済みの値を表示する
  useEffect(() => setEndMonth(settings.fiscalYearEndMonth), [settings.fiscalYearEndMonth]);

  const startMonth = fiscalYearStartMonth(endMonth);
  const example = fiscalYearLabel(fiscalYearOf(new Date(), startMonth), startMonth);
  const changed = endMonth !== settings.fiscalYearEndMonth;

  const save = async () => {
    const userName = app.requireUser();
    if (!userName) return;
    setBusy(true);
    try {
      await api.saveGeneralSettings({ fiscalYearEndMonth: endMonth }, userName);
      await reload();
      app.toast(`決算月を ${endMonth}月 にしました`);
    } catch (e) {
      app.toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="年度">
      <h2>年度（決算月）</h2>
      <p className="muted small">履歴ページの「年度」で選ぶ期間に使います。年度は始まった年で呼びます。全端末で共通の設定です。</p>
      <div className="csv-actions">
        <label>
          決算月{" "}
          <select
            className="plain-select"
            value={endMonth}
            onChange={(e) => setEndMonth(Number(e.target.value))}
            disabled={!loaded || busy}
            aria-label="決算月"
          >
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {m}月
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button primary" onClick={() => void save()} disabled={!loaded || busy || !changed}>
          保存
        </button>
      </div>
      <p className="small" data-testid="fiscal-example">
        今年度：{example}
      </p>
    </section>
  );
}
