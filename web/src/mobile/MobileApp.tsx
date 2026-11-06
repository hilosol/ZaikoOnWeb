import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { extractCode, normalizeText } from "../../../shared/text";
import { InReasons, MovementLabels, Rules, type History, type Product, type User } from "../../../shared/types";
import { api, ApiError, errorMessage } from "../api";
import { formatNumber, Modal, ProductImage, shortDateTime } from "../components/common";
import { ScannerDialog } from "../components/ScannerDialog";
import { OrderNoField, useOrderNumbers } from "../components/OrderNoField";
import { SupplierList } from "../components/Suppliers";
import { useLocalStorage } from "../hooks";
import { parseQuantity } from "../pages/InventoryPage";
import { suggestProducts } from "./suggest";
import { APP_VERSION } from "../version";

type Operation = "IN" | "TRANSFER" | "OUT";

const OP_LABEL: Record<Operation, string> = { IN: "入庫", TRANSFER: "移管", OUT: "出庫" };

/**
 * スマホ用画面（/m）。
 * ID を入力するか QR を読み取る → 場所・現在在庫を表示 → 入庫・移管・出庫。
 * 1画面で完結させ、片手で押しやすいよう大きなボタンにしている。
 */
export function MobileApp() {
  // 入力者は任意。未選択（または一覧に無い名前）なら名前なしで記録し、端末の IP で誰の操作かを追えるようにする
  const [userName, setUserName] = useLocalStorage("zaiko.userName", "");
  const [users, setUsers] = useState<User[]>([]);
  const [myIp, setMyIp] = useState("");
  const [ipUser, setIpUser] = useState("");

  const [idText, setIdText] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  const [recent, setRecent] = useState<History[]>([]);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "error" | "info" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [qtyText, setQtyText] = useState("1");
  const [transferOpen, setTransferOpen] = useState(false);
  const [inOpen, setInOpen] = useState(false);
  const [comment, setComment] = useState("");
  /** 受注番号（別の商品を表示しても残す。同じ受注の部品を続けて出庫することが多いため） */
  const [orderNo, setOrderNo] = useState("");
  const orderNumbers = useOrderNumbers();
  const idInputRef = useRef<HTMLInputElement>(null);
  // ID の候補表示用。商品数は多くない前提で、一覧を一度読み込んで端末内で絞り込む（入力のたびに通信しない）
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [idFocused, setIdFocused] = useState(false);

  // ------------------------------------------------------------ 入力者

  useEffect(() => {
    api.users().then(setUsers).catch((e) => setMessage({ text: errorMessage(e), kind: "error" }));
    api
      .whoami()
      .then((r) => {
        setMyIp(r.ip);
        setIpUser(r.userName);
      })
      .catch(() => setMyIp(""));
    const loadProducts = () => api.products().then(setAllProducts).catch(() => undefined);
    void loadProducts();
    // 画面に戻ったとき（他の端末で商品が追加された場合など）に読み直す
    const onVisible = () => document.visibilityState === "visible" && void loadProducts();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const showingCode = product ? normalizeText(idText) === product.code : false;
  const suggestions = idFocused && !showingCode ? suggestProducts(allProducts, idText) : [];

  const validUser = users.some((u) => u.name === userName) ? userName : "";
  // 端末の IP に紐づいた人（未選択のときはサーバーがこの人として記録する）
  const ipUserName = users.some((u) => u.name === ipUser) ? ipUser : "";
  const unselectedLabel = ipUserName ? `${ipUserName}（この端末）` : `未選択（IP${myIp ? ` ${myIp}` : ""} で記録）`;

  // ------------------------------------------------------------ 商品の検索

  const loadRecent = useCallback(async (id: number) => {
    try {
      setRecent(await api.histories(5, id));
    } catch {
      setRecent([]);
    }
  }, []);

  const lookup = async (raw: string) => {
    const code = normalizeText(extractCode(raw));
    if (!code) {
      setMessage({ text: "ID を入力してください。", kind: "error" });
      idInputRef.current?.focus();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const { product: p, oldCode } = await api.productByCode(code);
      if (!p) {
        setProduct(null);
        setMessage({ text: `ID「${code}」の商品は見つかりません。`, kind: "error" });
        return;
      }
      setProduct(p);
      setIdText(p.code);
      // 旧コード（コード変更前のラベル）で開いた場合は知らせる
      if (oldCode) setMessage({ text: `「${oldCode}」は旧コードです。現在のコードは「${p.code}」です。`, kind: "info" });
      // 再読み込み・ブックマークで同じ商品を開けるよう、アドレスにも反映する
      window.history.replaceState(null, "", `/m?id=${encodeURIComponent(p.code)}`);
      setQtyText("1");
      setComment("");
      setTransferOpen(false);
      void loadRecent(p.id);
    } catch (e) {
      setMessage({ text: errorMessage(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  // 他の端末での変更を反映（画面に戻ったとき）
  useEffect(() => {
    const refresh = async () => {
      if (document.visibilityState !== "visible" || !product) return;
      try {
        setProduct(await api.product(product.id));
        void loadRecent(product.id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setProduct(null);
          setMessage({ text: "この商品は削除されました。", kind: "error" });
        }
      }
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [product, loadRecent]);

  // QR（スマホの標準カメラ）から /m?id=… で開かれた場合は、その商品を表示する
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) {
      setIdText(id);
      void lookup(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = () => {
    window.history.replaceState(null, "", "/m");
    setProduct(null);
    setIdText("");
    setMessage(null);
    setTransferOpen(false);
    window.setTimeout(() => idInputRef.current?.focus(), 0);
  };

  // ------------------------------------------------------------ 入庫・移管・出庫

  const qty = parseQuantity(qtyText);
  const step = (d: number) => setQtyText(String(Math.min(Rules.maxQuantityPerOperation, Math.max(1, (qty ?? 1) + d))));

  const who = validUser || unselectedLabel;

  /** 入庫は理由を選ぶ画面（InDialog）が確認を兼ねるため、ここでは確認しない */
  const execute = async (op: Operation, destination?: string, reason?: string) => {
    if (!product) return;
    if (qty === null) {
      setMessage({ text: `数量は1〜${formatNumber(Rules.maxQuantityPerOperation)}の整数で入力してください。`, kind: "error" });
      return;
    }
    if (op !== "IN") {
      const lines = [
        `${product.name}`,
        `を ${formatNumber(qty)} 個${OP_LABEL[op]}します${op === "TRANSFER" ? `（移管先: ${destination}）` : ""}。`,
        orderNo.trim() ? `受注番号: ${orderNo.trim()}` : "",
        comment.trim() ? `コメント: ${comment.trim()}` : "",
        `入力者: ${who}`,
        "よろしいですか？",
      ].filter((l) => l !== "");
      if (!window.confirm(lines.join("\n"))) return;
    }

    setBusy(true);
    setMessage(null);
    const before = product.stock;
    try {
      const updated = await api.changeStock(product.id, { type: op, quantity: qty, userName: validUser, destination, comment, reason, orderNo });
      orderNumbers.reload(); // 手入力した番号を候補に加える
      setProduct(updated);
      setMessage({
        text: `${OP_LABEL[op]}しました（在庫 ${formatNumber(before)} → ${formatNumber(updated.stock)}）`,
        kind: "ok",
      });
      setQtyText("1");
      setComment("");
      setTransferOpen(false);
      setInOpen(false);
      void loadRecent(updated.id);
    } catch (e) {
      setMessage({ text: errorMessage(e), kind: "error" });
      // 他の端末で在庫が変わっていた場合に備えて最新を表示
      try {
        setProduct(await api.product(product.id));
      } catch {
        // 表示中の値のまま
      }
    } finally {
      setBusy(false);
    }
  };

  const low = product ? product.stock <= product.warningStock : false;

  return (
    <div className="m-app">
      <header className="m-header">
        <span className="m-brand">
          <img src="/icon-192.png" alt="" width={28} height={28} />
          在庫管理
        </span>
        <span className="app-version" title="ビルド日時">
          Ver. {APP_VERSION}
        </span>
      </header>

      <main className="m-main">
        <form
          className="m-search card"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void lookup(idText);
          }}
        >
          <label className="m-label" htmlFor="m-id">
            ID
          </label>
          <div className="m-search-row">
            <input
              id="m-id"
              ref={idInputRef}
              type="text"
              value={idText}
              onChange={(e) => setIdText(e.target.value)}
              onFocus={() => setIdFocused(true)}
              // 候補をタップしたときに先に閉じないよう、少し待ってから閉じる
              onBlur={() => window.setTimeout(() => setIdFocused(false), 150)}
              placeholder="例: AP-00001"
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls="m-suggest"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
            />
            <button type="submit" className="button primary" disabled={busy}>
              表示
            </button>
          </div>
          {suggestions.length > 0 && (
            <ul className="m-suggest" id="m-suggest" role="listbox" aria-label="候補">
              {suggestions.map((s) => (
                <li key={s.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()} // 入力欄のフォーカスを保つ
                    onClick={() => {
                      setIdText(s.code);
                      setIdFocused(false);
                      idInputRef.current?.blur(); // キーボードを閉じる
                      void lookup(s.code);
                    }}
                  >
                    <span className="m-suggest-code">{s.code}</span>
                    <span className="m-suggest-name">{s.name}</span>
                    {s.location && <span className="m-suggest-loc">場所 {s.location}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="button large m-scan" onClick={() => setScannerOpen(true)} disabled={busy}>
            ▦ QRを読み取る
          </button>
        </form>

        {message && (
          <div className={`m-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
            {message.text}
          </div>
        )}

        {product && (
          <section className="card m-product" aria-label="商品">
            <div className="m-product-head">
              <ProductImage file={product.imageFile} size={96} alt={product.name} zoomable />
              <div className="m-product-info">
                <div className="m-code">
                  {product.code}
                  {product.offBook && <span className="tag-label off-book">簿外</span>}
                </div>
                <div className="m-name">{product.name}</div>
                {product.summary && <div className="m-summary">{product.summary}</div>}
              </div>
            </div>

            <dl className="m-facts">
              <div>
                <dt>場所</dt>
                <dd data-testid="m-location">{product.location || <span className="muted">未設定</span>}</dd>
              </div>
              {product.note && (
                <div>
                  <dt>備考</dt>
                  <dd className="m-note">{product.note}</dd>
                </div>
              )}
              {(product.suppliers ?? []).length > 0 && (
                <div>
                  <dt>購入元</dt>
                  <dd className="m-suppliers" data-testid="m-suppliers">
                    <SupplierList suppliers={product.suppliers} />
                  </dd>
                </div>
              )}
              <div>
                <dt>現在在庫</dt>
                <dd className={`m-stock${low ? " danger" : ""}`} data-testid="m-stock">
                  {formatNumber(product.stock)}
                  {low && <span className="m-low">警告 {formatNumber(product.warningStock)} 以下</span>}
                </dd>
              </div>
            </dl>

            <label className="m-user">
              <span>入力者</span>
              <select value={validUser} onChange={(e) => setUserName(e.target.value)} aria-label="入力者">
                <option value="">{unselectedLabel}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.name}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="qty-row m-qty">
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
              className="comment-input m-comment"
              value={comment}
              maxLength={Rules.commentMaxLength}
              onChange={(e) => setComment(e.target.value)}
              placeholder="コメント（任意）"
              aria-label="コメント"
              enterKeyHint="done"
            />
            <OrderNoField value={orderNo} onChange={setOrderNo} data={orderNumbers.data} disabled={busy} className="m-order" />

            {/* 左から 出庫・移管・入庫 */}
            <div className="m-ops">
              <button type="button" className="button out large" disabled={busy || qty === null} onClick={() => void execute("OUT")}>
                出庫
              </button>
              <button type="button" className="button transfer large" disabled={busy || qty === null} onClick={() => setTransferOpen(true)}>
                移管
              </button>
              <button type="button" className="button in large" disabled={busy || qty === null} onClick={() => setInOpen(true)}>
                入庫
              </button>
            </div>

            {recent.length > 0 && (
              <div className="m-recent">
                <div className="muted small">最近の履歴</div>
                <ul>
                  {recent.map((h) => (
                    <li key={h.id} className={`type-${h.type}${h.canceledBy !== null ? " canceled" : ""}`}>
                      <span>{shortDateTime(h.createdAt)}</span>
                      <span className="type">{MovementLabels[h.type]}</span>
                      <span className="num qty">{formatNumber(h.quantity)}</span>
                      <span className="who">{h.destination ? `→ ${h.destination}` : h.userName || h.clientIp}</span>
                      {(h.reason || h.comment || h.orderNo || h.canceledBy !== null) && (
                        <span className="comment">
                          {h.canceledBy !== null && <span className="tag-label canceled">取消済</span>}
                          {h.orderNo && <span className="tag-label order-no">受注 {h.orderNo}</span>}
                          {h.reason && <span className="tag-label in-reason">{h.reason}</span>}
                          {h.comment && `💬 ${h.comment}`}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button type="button" className="button m-next" onClick={clear}>
              別の商品を表示
            </button>
          </section>
        )}

        <a className="m-pc-link" href="/">
          PC用の画面を開く
        </a>
      </main>

      {inOpen && product && (
        <InDialog
          productName={product.name}
          quantity={qty ?? 1}
          who={who}
          orderNo={orderNo.trim()}
          comment={comment}
          onCommentChange={setComment}
          busy={busy}
          onCancel={() => setInOpen(false)}
          onSubmit={(reason) => void execute("IN", undefined, reason)}
        />
      )}

      {transferOpen && product && (
        <TransferDialog
          productName={product.name}
          quantity={qty ?? 1}
          busy={busy}
          onCancel={() => setTransferOpen(false)}
          onSubmit={(dest) => void execute("TRANSFER", dest)}
        />
      )}

      {scannerOpen && (
        <ScannerDialog
          onDetected={(code) => {
            setScannerOpen(false);
            setIdText(normalizeText(extractCode(code)));
            void lookup(code);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}

    </div>
  );
}

/** 移管先の入力（過去の移管先を候補に出す） */
function TransferDialog({
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

/** 入庫の確認：理由（購入・戻り・その他）を選んでから確定する */
function InDialog({
  productName,
  quantity,
  who,
  orderNo,
  comment,
  onCommentChange,
  busy,
  onCancel,
  onSubmit,
}: {
  productName: string;
  quantity: number;
  who: string;
  orderNo: string;
  comment: string;
  onCommentChange: (v: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState<string>("");
  return (
    <Modal title="入庫" onClose={onCancel}>
      <p className="m-dialog-summary">
        {productName}
        <br />
        <b>{formatNumber(quantity)} 個</b>を入庫します（入力者: {who}）
        {orderNo && (
          <>
            <br />
            受注番号: {orderNo}
          </>
        )}
      </p>
      <div className="field">
        <span>理由（必須）</span>
        <div className="reason-buttons" role="radiogroup" aria-label="入庫の理由">
          {InReasons.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={reason === r}
              className={`chip reason${reason === r ? " selected" : ""}`}
              onClick={() => setReason(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>コメント（任意）</span>
        <input
          type="text"
          value={comment}
          maxLength={Rules.commentMaxLength}
          onChange={(e) => onCommentChange(e.target.value)}
          placeholder="例: 発注分入荷、○○さんから返却"
        />
      </label>
      <div className="m-dialog-actions">
        <button type="button" className="button" onClick={onCancel}>
          キャンセル
        </button>
        <button type="button" className="button in large" disabled={busy || !reason} onClick={() => onSubmit(reason)}>
          入庫する
        </button>
      </div>
    </Modal>
  );
}
