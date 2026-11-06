import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AuditLabels,
  fiscalYearStartMonth,
  HistoryFieldLabels,
  HistoryKindLabels,
  MovementLabels,
  type AuditLog,
  type CanceledFilter,
  type CodeChange,
  type History,
  type HistoryEditRow,
  type HistoryKind,
  type HistorySearchResult,
  type MovementType,
  type Product,
} from "../../../shared/types";
import { api, errorMessage } from "../api";
import { ErrorBox, formatNumber } from "../components/common";
import { HistoryDialog } from "../components/HistoryDialog";
import { OrderNoField, useOrderNumbers } from "../components/OrderNoField";
import { useApp } from "../context";
import { useGeneralSettings } from "../generalSettings";
import { fiscalYearLabel, fiscalYearOf, fiscalYearPeriod, matchPreset, PresetLabels, presetPeriod, type Period, type PeriodPreset } from "./period";

const PAGE_SIZE = 100;
const KINDS = Object.keys(HistoryKindLabels) as HistoryKind[];
/** 年度の選択肢：今年度から何年分さかのぼるか */
const FISCAL_YEARS_BACK = 5;

/** 区分の選択肢（入出庫のみ）。値はカンマ区切りの区分 */
const TYPE_OPTIONS: { label: string; value: string }[] = [
  { label: "区分：すべて", value: "" },
  { label: "入庫・出庫・移管", value: "IN,OUT,TRANSFER" },
  ...(["IN", "OUT", "TRANSFER", "ADJUST", "INIT", "CANCEL"] as MovementType[]).map((t) => ({ label: MovementLabels[t], value: t })),
];

/** 入力者の選択肢の「すべて」（"" は未登録を表すため別の値にする） */
const ALL_USERS = "__all__";

/**
 * 履歴ページ。入出庫・履歴の修正・操作ログ・コード変更を、期間（既定は直近3か月）と条件で絞り込んで見る。
 * 期間のボタン（3か月・半年・1年・年度）は開始日・終了日の欄に日付を入れるだけ。日付を直接変えれば任意の期間になる。
 */
export function HistoryPage({ productId }: { productId: number | null }) {
  const app = useApp();
  const today = useMemo(() => new Date(), []);
  const startMonth = fiscalYearStartMonth(useGeneralSettings().settings.fiscalYearEndMonth);
  const fiscalYears = useMemo(() => {
    const now = fiscalYearOf(today, startMonth);
    return Array.from({ length: FISCAL_YEARS_BACK }, (_, i) => now - i);
  }, [today, startMonth]);

  const [kind, setKind] = useState<HistoryKind>("movements");
  const [period, setPeriod] = useState<Period>(() => presetPeriod("3m", today));
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [types, setTypes] = useState("");
  const [canceled, setCanceled] = useState<CanceledFilter>("all");
  const [user, setUser] = useState(ALL_USERS);
  const [orderNo, setOrderNo] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  const [filterProductId, setFilterProductId] = useState<number | null>(productId);
  const [pageIndex, setPageIndex] = useState(0);
  const [result, setResult] = useState<HistorySearchResult<unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openHistoryId, setOpenHistoryId] = useState<number | null>(null);
  const orderNumbers = useOrderNumbers();

  // キーワードは入力が止まってから検索する（1文字ごとに問い合わせない）
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedKeyword(keyword), 300);
    return () => window.clearTimeout(t);
  }, [keyword]);

  // 商品で絞り込む場合（在庫一覧の「この商品の履歴をすべて見る」から来たとき）は商品名を表示する
  useEffect(() => {
    if (filterProductId === null) {
      setProduct(null);
      return;
    }
    api.product(filterProductId).then(setProduct, () => setProduct(null));
  }, [filterProductId]);

  const periodError = period.from && period.to && period.from > period.to ? "開始日が終了日より後になっています。" : null;

  const query = useMemo(() => {
    const q: Record<string, string> = { kind, limit: String(PAGE_SIZE), offset: String(pageIndex * PAGE_SIZE) };
    if (period.from) q.from = period.from;
    if (period.to) q.to = period.to;
    if (debouncedKeyword.trim()) q.q = debouncedKeyword.trim();
    if (kind === "movements") {
      if (types) q.types = types;
      if (canceled !== "all") q.canceled = canceled;
      if (user !== ALL_USERS) q.user = user;
      if (orderNo.trim()) q.orderNo = orderNo.trim();
      if (filterProductId !== null) q.productId = String(filterProductId);
    }
    return q;
  }, [kind, period, debouncedKeyword, types, canceled, user, orderNo, filterProductId, pageIndex]);

  const load = useCallback(async () => {
    if (periodError) return;
    setLoading(true);
    try {
      setResult(await api.historySearch<unknown>(query));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [query, periodError]);

  useEffect(() => {
    void load();
  }, [load]);

  // 条件を変えたら1ページ目に戻す
  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPageIndex(0);
  };
  const changePeriod = resetPage(setPeriod);

  const { preset, fiscalYear } = matchPreset(period, today, fiscalYears, startMonth);
  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const csvQuery = { ...query };
  delete csvQuery.limit;
  delete csvQuery.offset;

  return (
    <div className="history-page">
      <section className="card">
        <div className="history-kinds" role="tablist" aria-label="履歴の種類">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={kind === k ? "active" : ""}
              onClick={() => {
                setKind(k);
                setPageIndex(0);
                setResult(null);
              }}
            >
              {HistoryKindLabels[k]}
            </button>
          ))}
        </div>

        <div className="history-period">
          <label>
            <span className="muted small">期間</span>
            <input
              type="date"
              value={period.from}
              max={period.to || undefined}
              onChange={(e) => changePeriod({ ...period, from: e.target.value })}
              aria-label="開始日"
            />
          </label>
          <span className="muted">〜</span>
          <input
            type="date"
            value={period.to}
            min={period.from || undefined}
            onChange={(e) => changePeriod({ ...period, to: e.target.value })}
            aria-label="終了日"
          />
          <div className="period-presets">
            {(Object.keys(PresetLabels) as PeriodPreset[]).map((p) => (
              <button
                key={p}
                type="button"
                className={`button small${preset === p ? " active" : ""}`}
                onClick={() => changePeriod(presetPeriod(p, today))}
              >
                {PresetLabels[p]}
              </button>
            ))}
            <select
              className={`plain-select small${fiscalYear !== null ? " active" : ""}`}
              value={fiscalYear ?? ""}
              onChange={(e) => e.target.value && changePeriod(fiscalYearPeriod(Number(e.target.value), startMonth))}
              aria-label="年度"
            >
              <option value="">年度…</option>
              {fiscalYears.map((y) => (
                <option key={y} value={y}>
                  {fiscalYearLabel(y, startMonth)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="history-filters">
          <input
            type="search"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPageIndex(0);
            }}
            placeholder={kind === "movements" ? "キーワード（商品コード・名前・コメント・移管先・入力者）" : "キーワード"}
            aria-label="キーワード"
          />
          {kind === "movements" && (
            <>
              <select className="plain-select" value={types} onChange={(e) => resetPage(setTypes)(e.target.value)} aria-label="区分">
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select className="plain-select" value={user} onChange={(e) => resetPage(setUser)(e.target.value)} aria-label="入力者">
                <option value={ALL_USERS}>入力者：すべて</option>
                {app.users.map((u) => (
                  <option key={u.id} value={u.name}>
                    {u.name}
                  </option>
                ))}
                <option value="">（未登録）</option>
              </select>
              <select
                className="plain-select"
                value={canceled}
                onChange={(e) => resetPage(setCanceled)(e.target.value as CanceledFilter)}
                aria-label="取消の扱い"
              >
                <option value="all">取消：すべて表示</option>
                <option value="exclude">取消分を除く</option>
                <option value="only">取消分のみ</option>
              </select>
              <div className="history-order">
                <OrderNoField value={orderNo} onChange={resetPage(setOrderNo)} data={orderNumbers.data} />
              </div>
            </>
          )}
        </div>
        {kind === "movements" && filterProductId !== null && (
          <div className="history-product-filter">
            <span className="tag-label">商品</span>
            {product ? `${product.code} ${product.name}` : `ID ${filterProductId}`}
            <button type="button" className="button small" onClick={() => resetPage(setFilterProductId)(null)}>
              商品の絞り込みを解除
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="history-result-head">
          <span data-testid="history-total">
            {loading && !result ? "読み込み中…" : `${formatNumber(total)} 件`}
          </span>
          {kind === "movements" && result?.summary && (
            <span className="history-summary" data-testid="history-summary" title="取り消された分を除いた合計">
              <span className="type-IN">入庫 {formatNumber(result.summary.IN)}</span>
              <span className="type-OUT">出庫 {formatNumber(result.summary.OUT)}</span>
              <span className="type-TRANSFER">移管 {formatNumber(result.summary.TRANSFER)}</span>
            </span>
          )}
          <span className="spacer" />
          <a className={`button small${total === 0 || periodError ? " disabled" : ""}`} href={api.historySearchCsvUrl(csvQuery)} download>
            この条件でCSV出力
          </a>
        </div>

        <ErrorBox message={periodError ?? error} />
        {result && total === 0 && !periodError && <p className="muted">条件に合う記録はありません。</p>}
        {result && total > 0 && (
          <div className="table-scroll">
            {kind === "movements" && <MovementTable rows={result.rows as History[]} onOpen={setOpenHistoryId} />}
            {kind === "edits" && <EditTable rows={result.rows as HistoryEditRow[]} onOpen={setOpenHistoryId} />}
            {kind === "audit" && <AuditTable rows={result.rows as AuditLog[]} />}
            {kind === "codes" && <CodeTable rows={result.rows as CodeChange[]} />}
          </div>
        )}

        {pages > 1 && (
          <div className="history-pager">
            <button type="button" className="button small" disabled={pageIndex === 0} onClick={() => setPageIndex((i) => i - 1)}>
              ← 新しい{PAGE_SIZE}件
            </button>
            <span className="muted small">
              {pageIndex + 1} / {pages} ページ（{formatNumber(pageIndex * PAGE_SIZE + 1)}〜{formatNumber(Math.min(total, (pageIndex + 1) * PAGE_SIZE))} 件目）
            </span>
            <button type="button" className="button small" disabled={pageIndex + 1 >= pages} onClick={() => setPageIndex((i) => i + 1)}>
              古い{PAGE_SIZE}件 →
            </button>
          </div>
        )}
      </section>

      {openHistoryId !== null && <HistoryDialog historyId={openHistoryId} onClose={() => setOpenHistoryId(null)} onChanged={() => void load()} />}
    </div>
  );
}

// ------------------------------------------------------------ 表

const dt = (s: string) => s.slice(0, 16);

function MovementTable({ rows, onOpen }: { rows: History[]; onOpen: (id: number) => void }) {
  return (
    <table className="audit-table history-table" data-testid="history-table">
      <thead>
        <tr>
          <th>日時</th>
          <th>商品</th>
          <th>区分</th>
          <th className="num">数量</th>
          <th className="num">処理後</th>
          <th>紐づけID</th>
          <th>移管先・理由</th>
          <th>コメント</th>
          <th>入力者</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr
            key={h.id}
            className={`clickable type-${h.type}${h.canceledBy !== null ? " canceled" : ""}`}
            onClick={() => onOpen(h.id)}
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onOpen(h.id)}
            title="クリックで詳細・修正"
          >
            <td className="nowrap">{dt(h.createdAt)}</td>
            <td>
              <span className="code">{h.productCode}</span> {h.productName}
            </td>
            <td className="nowrap">
              <span className="type">{MovementLabels[h.type]}</span>
              {h.canceledBy !== null && <span className="tag-label canceled">取消済</span>}
            </td>
            <td className="num qty">{formatNumber(h.quantity)}</td>
            <td className="num">{formatNumber(h.stockAfter)}</td>
            <td className="nowrap">{h.orderNo ?? ""}</td>
            <td>{h.destination ?? h.reason ?? ""}</td>
            <td className="history-comment">{h.comment ?? ""}</td>
            <td className="nowrap" title={h.clientIp}>
              {h.userName || <span className="muted">{h.clientIp}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditTable({ rows, onOpen }: { rows: HistoryEditRow[]; onOpen: (id: number) => void }) {
  return (
    <table className="audit-table history-table">
      <thead>
        <tr>
          <th>日時</th>
          <th>商品</th>
          <th>区分</th>
          <th>項目</th>
          <th>修正前</th>
          <th>修正後</th>
          <th>入力者</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.id} className="clickable" onClick={() => onOpen(e.historyId)} title="クリックで元の履歴を表示">
            <td className="nowrap">{dt(e.createdAt)}</td>
            <td>
              <span className="code">{e.productCode}</span> {e.productName}
            </td>
            <td className="nowrap">{e.historyType ? MovementLabels[e.historyType] : ""}</td>
            <td className="nowrap">{HistoryFieldLabels[e.field] ?? e.field}</td>
            <td>{e.before || <span className="muted">（なし）</span>}</td>
            <td>{e.after || <span className="muted">（なし）</span>}</td>
            <td className="nowrap" title={e.clientIp}>
              {e.userName || e.clientIp}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditTable({ rows }: { rows: AuditLog[] }) {
  return (
    <table className="audit-table history-table">
      <thead>
        <tr>
          <th>日時</th>
          <th>操作</th>
          <th>対象</th>
          <th>内容</th>
          <th>入力者</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.id}>
            <td className="nowrap">{dt(l.createdAt)}</td>
            <td className="nowrap">{AuditLabels[l.action] ?? l.action}</td>
            <td>{l.target}</td>
            <td>{l.detail}</td>
            <td className="nowrap" title={l.clientIp}>
              {l.userName || l.clientIp}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CodeTable({ rows }: { rows: CodeChange[] }) {
  return (
    <table className="audit-table history-table">
      <thead>
        <tr>
          <th>日時</th>
          <th>旧コード</th>
          <th>新コード</th>
          <th>商品名</th>
          <th>入力者</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id}>
            <td className="nowrap">{dt(c.createdAt)}</td>
            <td className="code">{c.oldCode}</td>
            <td className="code">{c.newCode}</td>
            <td>{c.productName}</td>
            <td className="nowrap" title={c.clientIp}>
              {c.userName || c.clientIp}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
