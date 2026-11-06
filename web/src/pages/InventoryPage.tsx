import { useCallback, useEffect, useMemo, useState } from "react";
import { extractCode, matchesKeyword, normalizeText, searchKey } from "../../../shared/text";
import { MovementLabels, Rules, type CodeChange, type History, type Product } from "../../../shared/types";
import { api, errorMessage } from "../api";
import { AdjustStockDialog } from "../components/AdjustStockDialog";
import { QrLabelDialog } from "../components/QrLabelDialog";
import { ScannerDialog } from "../components/ScannerDialog";
import { HistoryDialog } from "../components/HistoryDialog";
import { OrderNoField, useOrderNumbers } from "../components/OrderNoField";
import { SupplierLinks } from "../components/Suppliers";
import { ErrorBox, formatNumber, ProductImage, shortDateTime } from "../components/common";
import { useApp } from "../context";
import { navigate, useLocalStorage, usePolling } from "../hooks";

type Tab = "products" | "low" | "history";

/** カテゴリ絞り込みの特別な値 */
const ALL_CATEGORIES = "";
const NO_CATEGORY = "\u0000none";
const POLL_MS = 10_000;

/** 数量欄の解釈（全角数字・カンマ可）。範囲外・整数でなければ null */
export function parseQuantity(text: string): number | null {
  const s = normalizeText(text).replace(/,/g, "");
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= Rules.maxQuantityPerOperation ? n : null;
}

/** 簿外の絞り込み */
type OffBookFilter = "all" | "only" | "exclude";
const OFF_BOOK_FILTERS: readonly OffBookFilter[] = ["all", "only", "exclude"];

export const matchesOffBook = (p: Product, filter: OffBookFilter): boolean =>
  filter === "all" || (filter === "only" ? p.offBook : !p.offBook);

/** 簿外の小さな札 */
export function OffBookBadge({ product }: { product: Product }) {
  return product.offBook ? <span className="tag-label off-book">簿外</span> : null;
}

export function InventoryPage() {
  const app = useApp();
  const [products, setProducts] = useState<Product[]>([]);
  const [lowStock, setLowStock] = useState<Product[]>([]);
  const [histories, setHistories] = useState<History[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useLocalStorage("zaiko.categoryFilter", ALL_CATEGORIES);
  const [offBookRaw, setOffBookFilter] = useLocalStorage("zaiko.offBookFilter", "all");
  // 記憶した値が壊れていた場合は「すべて」
  const offBookFilter: OffBookFilter = (OFF_BOOK_FILTERS as readonly string[]).includes(offBookRaw) ? (offBookRaw as OffBookFilter) : "all";
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("products");
  const [scannerOpen, setScannerOpen] = useState(false);
  /** 入出庫の受注番号（商品を切り替えても残す。画面を開き直すと消える） */
  const [orderNo, setOrderNo] = useState("");

  const reload = useCallback(async () => {
    try {
      const [p, l, h] = await Promise.all([api.products(), api.lowStock(), api.histories(50)]);
      setProducts(p);
      setLowStock(l);
      setHistories(h);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  usePolling(reload, POLL_MS);

  /** カテゴリの一覧（件数付き・五十音順）。選択肢はいつも全商品から作る */
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    const named = [...counts.entries()].filter(([c]) => c !== "").sort(([a], [b]) => a.localeCompare(b, "ja"));
    return { named, none: counts.get("") ?? 0 };
  }, [products]);

  // 記憶していたカテゴリが無くなった（全商品のカテゴリが変わった等）場合は「すべて」に戻す
  const categoryValid =
    category === ALL_CATEGORIES || (category === NO_CATEGORY ? categories.none > 0 : categories.named.some(([c]) => c === category));
  const activeCategory = categoryValid ? category : ALL_CATEGORIES;

  const filtered = useMemo(
    () =>
      products.filter(
        (p) =>
          (activeCategory === ALL_CATEGORIES || p.category === (activeCategory === NO_CATEGORY ? "" : activeCategory)) &&
          matchesOffBook(p, offBookFilter) &&
          matchesKeyword(p, keyword),
      ),
    [products, keyword, activeCategory, offBookFilter],
  );
  // 他の端末で削除された場合は選択を外す
  const selected = products.find((p) => p.id === selectedId) ?? null;

  const selectByCode = (raw: string): boolean => {
    const code = normalizeText(extractCode(raw));
    // 完全一致 → 大文字小文字・ハイフンの違いを無視（候補が1件に決まる場合のみ）
    const loose = products.filter((p) => searchKey(p.code) === searchKey(code));
    const hit = products.find((p) => p.code === code) ?? (loose.length === 1 ? loose[0] : undefined);
    if (!hit) return false;
    setSelectedId(hit.id);
    setTab("products");
    return true;
  };

  /**
   * 変更前のコード（旧コード）として登録があれば、現在の商品を選ぶ。
   * コード変更前に印刷したラベルを読んだ場合のため。一覧は現在のコードしか持たないのでサーバーに問い合わせる。
   */
  const selectByOldCode = async (raw: string): Promise<boolean> => {
    const code = normalizeText(extractCode(raw));
    if (!code) return false;
    try {
      const { product, oldCode } = await api.productByCode(code);
      if (!product || !oldCode) return false;
      setSelectedId(product.id);
      setTab("products");
      app.toast(`「${oldCode}」は旧コードです。現在のコード「${product.code}」の商品を選択しました`, "info");
      return true;
    } catch {
      return false;
    }
  };

  const onSearchEnter = async () => {
    // USB バーコードリーダー（キーボードとして入力 + Enter）での読み取りに対応
    if (selectByCode(keyword)) {
      setKeyword("");
      return;
    }
    if (filtered.length === 1) setSelectedId(filtered[0]!.id);
    else if (filtered.length === 0) {
      if (await selectByOldCode(keyword)) {
        setKeyword("");
        return;
      }
      app.toast(`「${keyword}」に該当する商品はありません`, "info");
    }
  };

  const onScanned = async (scanned: string) => {
    const code = extractCode(scanned);
    setScannerOpen(false);
    if (selectByCode(code)) {
      setKeyword("");
      app.toast(`「${normalizeText(code)}」を選択しました`, "info");
      return;
    }
    if (await selectByOldCode(code)) {
      setKeyword("");
      return;
    }
    if (window.confirm(`コード「${code}」の商品は登録されていません。\nこのコードで新しく登録しますか？`)) {
      navigate({ page: "new", code: normalizeText(code) });
    }
  };

  if (!loaded) return <div className="loading">読み込み中…</div>;

  return (
    <div className="inventory" data-tab={tab} data-selected={selected ? "true" : undefined}>
      {loadError && <ErrorBox message={loadError} />}

      <div className="mobile-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "products"} onClick={() => setTab("products")}>
          商品
        </button>
        <button type="button" role="tab" aria-selected={tab === "low"} onClick={() => setTab("low")}>
          在庫警告{lowStock.length > 0 && <span className="badge">{lowStock.length}</span>}
        </button>
        <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
          履歴
        </button>
      </div>

      <section className="card products-card">
        <div className="toolbar">
          <div className="search">
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onSearchEnter();
                }
              }}
              placeholder="コード・商品名で検索"
              aria-label="検索"
              enterKeyHint="search"
            />
          </div>
          <select
            className="category-filter"
            value={activeCategory}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="カテゴリで絞り込み"
          >
            <option value={ALL_CATEGORIES}>すべてのカテゴリ（{products.length}）</option>
            {categories.named.map(([c, n]) => (
              <option key={c} value={c}>
                {c}（{n}）
              </option>
            ))}
            {categories.none > 0 && <option value={NO_CATEGORY}>（カテゴリなし）（{categories.none}）</option>}
          </select>
          <select
            className="offbook-filter"
            value={offBookFilter}
            onChange={(e) => setOffBookFilter(e.target.value)}
            aria-label="簿外で絞り込み"
          >
            <option value="all">簿外：すべて</option>
            <option value="only">簿外のみ（{products.filter((p) => p.offBook).length}）</option>
            <option value="exclude">簿外以外（{products.filter((p) => !p.offBook).length}）</option>
          </select>
          <button type="button" className="button scan-button" onClick={() => setScannerOpen(true)}>
            <span aria-hidden="true">▦</span> 読み取り
          </button>
          <a className="button desktop-only" href="/api/products.csv" download title="在庫一覧をCSVで保存（Excelで開けます）">
            CSV出力
          </a>
          <button type="button" className="button primary desktop-only" onClick={() => navigate({ page: "new", code: "" })}>
            ＋ 商品登録
          </button>
        </div>

        {products.length === 0 ? (
          <div className="empty">
            <p>商品が登録されていません。</p>
            <button type="button" className="button primary" onClick={() => navigate({ page: "new", code: "" })}>
              最初の商品を登録する
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            該当する商品はありません。
            {(activeCategory !== ALL_CATEGORIES || offBookFilter !== "all") && (
              <div>
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    setCategory(ALL_CATEGORIES);
                    setOffBookFilter("all");
                  }}
                >
                  絞り込みを解除
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="product-list" role="list">
            <div className="product-row header" aria-hidden="true">
              <span />
              <span>商品コード / 商品名</span>
              <span>カテゴリ</span>
              <span className="num">在庫</span>
              <span className="num">警告</span>
            </div>
            {filtered.map((p) => (
              <button
                type="button"
                role="listitem"
                key={p.id}
                className={`product-row${p.id === selectedId ? " selected" : ""}${p.stock <= p.warningStock ? " low" : ""}`}
                onClick={() => setSelectedId(p.id)}
              >
                <ProductImage file={p.imageFile} size={48} />
                <span className="name-cell">
                  <span className="code">
                    {p.code}
                    <OffBookBadge product={p} />
                    {p.location && (
                      <span className="location">
                        <span className="tag-label">場所</span>
                        {p.location}
                      </span>
                    )}
                  </span>
                  <span className="name" title={p.summary || undefined}>
                    {p.name}
                  </span>
                </span>
                <span className="category">{p.category}</span>
                <span className="num stock">{formatNumber(p.stock)}</span>
                <span className="num warning">{formatNumber(p.warningStock)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <aside className="side">
        {selected ? (
          <StockPanel
            key={selected.id}
            product={selected}
            onClose={() => setSelectedId(null)}
            onChanged={reload}
            orderNo={orderNo}
            onOrderNoChange={setOrderNo}
          />
        ) : (
          <div className="card hint desktop-only">一覧から商品を選ぶか「読み取り」でコードを読み取ると、ここで入庫・出庫できます。</div>
        )}

        <section className="card low-card">
          <h2>
            在庫警告 <span className="count">{lowStock.length}件</span>
          </h2>
          {lowStock.length === 0 ? (
            <p className="muted">警告在庫を下回っている商品はありません。</p>
          ) : (
            <ul className="simple-list">
              {lowStock.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(p.id);
                      setTab("products");
                    }}
                  >
                    <span className="name">
                      {p.name}
                      <OffBookBadge product={p} />
                    </span>
                    <span className="code muted">{p.code}</span>
                    <span className="num danger">
                      {formatNumber(p.stock)} / {formatNumber(p.warningStock)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card history-card">
          <div className="card-title-row">
            <h2>履歴（最新50件）</h2>
            <a className="button small" href="/api/histories.csv" download>
              CSV出力
            </a>
          </div>
          <HistoryList histories={histories} onChanged={() => void reload()} />
        </section>
      </aside>

      {scannerOpen && <ScannerDialog onDetected={(c) => void onScanned(c)} onClose={() => setScannerOpen(false)} />}
    </div>
  );
}

/** 入出庫の履歴一覧。行をクリックすると詳細（修正・取消）を開く */
function HistoryList({ histories, compact, onChanged }: { histories: History[]; compact?: boolean; onChanged: () => void }) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (histories.length === 0) return <p className="muted">履歴はまだありません。</p>;
  return (
    <>
      <ul className="history-list">
        {histories.map((h) => (
          <li
            key={h.id}
            className={`type-${h.type}${h.canceledBy !== null ? " canceled" : ""}`}
            role="button"
            tabIndex={0}
            title="クリックで詳細・修正"
            onClick={() => setOpenId(h.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpenId(h.id);
              }
            }}
          >
            <span className="time">{shortDateTime(h.createdAt)}</span>
            {!compact && (
              <span className="name" title={h.destination ? `${h.productName} → ${h.destination}` : h.productName}>
                {h.productName}
              </span>
            )}
            <span className="type">{MovementLabels[h.type]}</span>
            <span className="num qty">{formatNumber(h.quantity)}</span>
            <span className="who" title={`${h.userName}（${h.clientIp}）`}>
              {h.destination ? `→${h.destination}` : h.userName || h.clientIp}
            </span>
            {(h.reason || h.comment || h.orderNo || h.canceledBy !== null) && (
              <span className="comment" title={h.comment ?? undefined}>
                {h.canceledBy !== null && <span className="tag-label canceled">取消済</span>}
                {h.orderNo && <span className="tag-label order-no">受注 {h.orderNo}</span>}
                {h.reason && <span className="tag-label in-reason">{h.reason}</span>}
                {h.comment && `💬 ${h.comment}`}
              </span>
            )}
          </li>
        ))}
      </ul>
      {openId !== null && <HistoryDialog historyId={openId} onClose={() => setOpenId(null)} onChanged={onChanged} />}
    </>
  );
}

/** 選択中の商品の入出庫（スマホでは画面下から出るパネル） */
/**
 * 選択中の商品の入出庫（スマホでは画面下から出るパネル）。
 * 受注番号は商品を切り替えても残す（同じ受注の部品を続けて出庫することが多いため）。親で持つ
 */
function StockPanel({
  product,
  onClose,
  onChanged,
  orderNo,
  onOrderNoChange,
}: {
  product: Product;
  onClose: () => void;
  onChanged: () => Promise<void>;
  orderNo: string;
  onOrderNoChange: (value: string) => void;
}) {
  const orderNumbers = useOrderNumbers();
  const app = useApp();
  const [qtyText, setQtyText] = useState("1");
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<History[]>([]);
  const [labelOpen, setLabelOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [codeChanges, setCodeChanges] = useState<CodeChange[]>([]);

  // コードが変わったら旧コードの一覧も取り直す
  useEffect(() => {
    let cancelled = false;
    api
      .codeChanges(product.id)
      .then((list) => !cancelled && setCodeChanges(list))
      .catch(() => {
        // 補助情報なので失敗しても表示しないだけ
      });
    return () => {
      cancelled = true;
    };
  }, [product.id, product.code]);

  const loadRecent = useCallback(async () => {
    try {
      setRecent(await api.histories(5, product.id));
    } catch {
      // 補助情報なので失敗しても表示しないだけ
    }
  }, [product.id]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent, product.stock]);

  const qty = parseQuantity(qtyText);
  const step = (d: number) => setQtyText(String(Math.min(Rules.maxQuantityPerOperation, Math.max(1, (qty ?? 1) + d))));

  const submit = async (type: "IN" | "OUT") => {
    const userName = app.requireUser();
    if (!userName) return;
    if (qty === null) {
      app.toast(`数量は1〜${formatNumber(Rules.maxQuantityPerOperation)}の整数で入力してください。`, "error");
      return;
    }
    setBusy(true);
    try {
      const updated = await api.changeStock(product.id, { type, quantity: qty, userName, comment, orderNo });
      app.toast(
        `「${updated.name}」を ${formatNumber(qty)} 個${MovementLabels[type]}しました（在庫 ${formatNumber(updated.stock)}${orderNo.trim() ? `・受注 ${orderNo.trim()}` : ""}）`,
      );
      orderNumbers.reload(); // 手入力した番号を候補に加える
      setQtyText("1");
      setComment("");
    } catch (e) {
      app.toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  const low = product.stock <= product.warningStock;

  return (
    <section className="card stock-panel" aria-label="入出庫">
      <button type="button" className="icon-button close-sheet" onClick={onClose} aria-label="閉じる">
        ×
      </button>
      <div className="stock-head">
        <ProductImage file={product.imageFile} size={112} alt={product.name} zoomable />
        <div className="stock-info">
          <div className="name">{product.name}</div>
          {product.summary && <div className="small summary-line">{product.summary}</div>}
          <div className="muted small">
            {product.code}
            {product.category && ` / ${product.category}`}
            <OffBookBadge product={product} />
          </div>
          {codeChanges.length > 0 && (
            <div className="small old-code-line" data-testid="old-codes">
              <span className="tag-label">旧コード</span>
              {codeChanges.map((c) => `${c.oldCode}（${shortDateTime(c.createdAt).slice(0, 5)}変更）`).join("、")}
            </div>
          )}
          {product.location && (
            <div className="small location-line">
              <span className="tag-label">場所</span>
              {product.location}
            </div>
          )}
          {product.note && (
            <div className="small note-line">
              <span className="tag-label note">備考</span>
              {product.note}
            </div>
          )}
          <SupplierLinks suppliers={product.suppliers ?? []} />
          <div className={`stock-value${low ? " danger" : ""}`}>
            <span className="label">在庫</span>
            <span className="value" data-testid="stock-value">
              {formatNumber(product.stock)}
            </span>
            <span className="muted small">（警告 {formatNumber(product.warningStock)}）</span>
          </div>
        </div>
      </div>

      <div className="qty-row">
        <span className="label">数量</span>
        <button type="button" className="button step" onClick={() => step(-1)} disabled={busy} aria-label="1減らす">
          −
        </button>
        <input
          type="text"
          inputMode="numeric"
          className={qty === null ? "invalid" : ""}
          value={qtyText}
          onChange={(e) => setQtyText(e.target.value)}
          onFocus={(e) => e.target.select()}
          aria-label="数量"
        />
        <button type="button" className="button step" onClick={() => step(1)} disabled={busy} aria-label="1増やす">
          ＋
        </button>
      </div>

      <input
        type="text"
        className="comment-input"
        value={comment}
        maxLength={Rules.commentMaxLength}
        onChange={(e) => setComment(e.target.value)}
        placeholder="コメント（任意）例: 修理用、発注分入荷"
        aria-label="コメント"
      />
      <OrderNoField value={orderNo} onChange={onOrderNoChange} data={orderNumbers.data} disabled={busy} />

      <div className="stock-buttons">
        <button type="button" className="button in large" disabled={busy || qty === null} onClick={() => void submit("IN")}>
          入庫
        </button>
        <button type="button" className="button out large" disabled={busy || qty === null} onClick={() => void submit("OUT")}>
          出庫
        </button>
      </div>

      <div className="stock-footer">
        <button type="button" className="button small" onClick={() => setAdjustOpen(true)}>
          在庫調整
        </button>
        <button type="button" className="button small" onClick={() => setLabelOpen(true)}>
          QRラベル
        </button>
        <button type="button" className="button small" onClick={() => navigate({ page: "edit", id: product.id })}>
          商品を編集
        </button>
      </div>
      {labelOpen && <QrLabelDialog product={product} onClose={() => setLabelOpen(false)} />}
      {adjustOpen && (
        <AdjustStockDialog
          product={product}
          onClose={() => setAdjustOpen(false)}
          onDone={async () => {
            setAdjustOpen(false);
            await onChanged();
          }}
          onRefresh={onChanged}
        />
      )}

      {recent.length > 0 && (
        <div className="recent">
          <div className="muted small">この商品の最近の履歴</div>
          <HistoryList
            histories={recent}
            compact
            onChanged={() => {
              void loadRecent();
              void onChanged();
            }}
          />
        </div>
      )}
    </section>
  );
}
