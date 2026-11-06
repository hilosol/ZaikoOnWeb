import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { extractCode, normalizeText } from "../../../shared/text";
import {
  Rules,
  type EditingInfo,
  type ImageChange,
  type Product,
  type SaveProductRequest,
  type Supplier,
} from "../../../shared/types";
import { api, ApiError, errorMessage, imageUrl } from "../api";
import { ErrorBox, formatNumber, ProductImage } from "../components/common";
import { ScannerDialog } from "../components/ScannerDialog";
import { SuppliersEditor } from "../components/Suppliers";
import { useApp } from "../context";
import { navigate, setLeaveGuard, useBeforeUnload } from "../hooks";
import { resizeImage } from "../image";
import { editorName } from "../components/EditingBadge";
import {
  displayValue,
  FieldLabels,
  fieldsOf,
  mergeProduct,
  type EditableFields,
  type FieldKey,
} from "./productMerge";

/** 編集中であることをサーバーに知らせる間隔 */
const HEARTBEAT_MS = 15_000;

/** この編集画面を表す識別子（http の社内アドレスでは crypto.randomUUID が使えないため自前で作る） */
const newSessionId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** 保存がぶつかったときの状態：相手の値・自分の値と、ぶつかった項目ごとの選択 */
interface MergeState {
  mine: EditableFields;
  theirs: EditableFields;
  taken: FieldKey[];
  conflicts: FieldKey[];
  choice: Partial<Record<FieldKey, "mine" | "theirs">>;
  /** 自分が選んでいた新しい画像（画像がぶつかって「相手」を選んだ後に「自分」に戻すため） */
  myImage: ImageState;
}

/** 0以上の整数（全角数字・カンマ可）。不正なら null */
export function parseNonNegativeInt(text: string, max: number): number | null {
  const s = normalizeText(text).replace(/,/g, "");
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
}

type ImageState =
  | { kind: "keep" }
  | { kind: "remove" }
  | { kind: "new"; blob: Blob; previewUrl: string };

interface FormState {
  code: string;
  name: string;
  category: string;
  location: string;
  note: string;
  summary: string;
  initialStock: string;
  warningStock: string;
}

const EMPTY_FORM: FormState = {
  code: "",
  name: "",
  category: "",
  location: "",
  note: "",
  summary: "",
  initialStock: "0",
  warningStock: "3",
};

export function ProductEditPage({
  productId,
  initialCode,
}: {
  productId: number | null;
  initialCode: string;
}) {
  const app = useApp();
  const isNew = productId === null;
  const [original, setOriginal] = useState<Product | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [form, setForm] = useState<FormState>({
    ...EMPTY_FORM,
    code: initialCode,
  });
  const [image, setImage] = useState<ImageState>({ kind: "keep" });
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [offBook, setOffBook] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    message: string;
    details?: string[];
  } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const previewRef = useRef<string | null>(null);
  /** 他に編集画面を開いている人 */
  const [others, setOthers] = useState<EditingInfo[]>([]);
  const [merge, setMerge] = useState<MergeState | null>(null);
  const mergeRef = useRef<HTMLDivElement>(null);
  // 保存がぶつかったら、画面の上に出す案内が見えるようにする
  const mergeShown = merge !== null;
  useEffect(() => {
    if (mergeShown) mergeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [mergeShown]);
  const sessionId = useRef(newSessionId());
  const userNameRef = useRef(app.userName);
  userNameRef.current = app.userName;

  // ------------------------------------------------------------ 編集中であることを知らせる（他の人の画面に「編集中」と出す）

  useEffect(() => {
    if (productId === null) return;
    const id = sessionId.current;
    const beat = () =>
      api.editingHeartbeat(productId, id, userNameRef.current).then(
        (r) => setOthers(r.others),
        () => undefined, // 知らせられなくても編集はできる
      );
    void beat();
    const timer = window.setInterval(() => void beat(), HEARTBEAT_MS);
    const leave = () => api.editingLeave(productId, id);
    window.addEventListener("pagehide", leave);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      leave();
    };
    // 入力者を選び直したら、次の知らせで名前が変わる（userNameRef で最新を読む）
  }, [productId]);

  // ------------------------------------------------------------ 読み込み

  const load = useCallback(async () => {
    if (productId === null) return;
    setLoading(true);
    try {
      const p = await api.product(productId);
      setOriginal(p);
      setForm({
        code: p.code,
        name: p.name,
        category: p.category,
        location: p.location,
        note: p.note,
        summary: p.summary,
        initialStock: "0",
        warningStock: String(p.warningStock),
      });
      setSuppliers(p.suppliers);
      setOffBook(p.offBook);
      replacePreview(null);
      setImage({ kind: "keep" });
      setDirty(false);
      setConflict(false);
      setMerge(null);
      setError(null);
    } catch (e) {
      app.toast(errorMessage(e), "error");
      if (e instanceof ApiError && e.status === 404)
        navigate({ page: "inventory" });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ------------------------------------------------------------ 未保存の変更の確認

  useBeforeUnload(dirty);
  useEffect(() => {
    setLeaveGuard(
      dirty
        ? () =>
            window.confirm(
              "変更内容が保存されていません。\n変更を破棄して移動しますか？",
            )
        : null,
    );
    return () => setLeaveGuard(null);
  }, [dirty]);

  // プレビュー用の一時 URL を解放する
  const replacePreview = (url: string | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
  };
  useEffect(() => () => replacePreview(null), []);

  const update =
    (key: keyof FormState) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      setDirty(true);
    };

  // ------------------------------------------------------------ 画像

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const blob = await resizeImage(file);
      const url = URL.createObjectURL(blob);
      replacePreview(url);
      setImage({ kind: "new", blob, previewUrl: url });
      setDirty(true);
    } catch (e) {
      setError({ message: errorMessage(e) });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void handleFile(e.dataTransfer.files[0]);
  };

  const removeImage = () => {
    replacePreview(null);
    setImage({ kind: "remove" });
    setDirty(true);
  };

  const previewSrc =
    image.kind === "new"
      ? image.previewUrl
      : image.kind === "remove"
        ? null
        : imageUrl(original?.imageFile);

  // ------------------------------------------------------------ 保存・削除

  const save = async () => {
    const userName = app.requireUser();
    if (!userName) return;

    const errors: string[] = [];
    const warningStock = parseNonNegativeInt(form.warningStock, Rules.maxStock);
    const initialStock = isNew
      ? parseNonNegativeInt(form.initialStock, Rules.maxStock)
      : 0;
    if (!normalizeText(form.code))
      errors.push("商品コードを入力してください。");
    if (!form.name.trim()) errors.push("商品名を入力してください。");
    if (initialStock === null)
      errors.push(
        `初期在庫は0〜${formatNumber(Rules.maxStock)}の整数で入力してください。`,
      );
    if (warningStock === null)
      errors.push(
        `警告在庫は0〜${formatNumber(Rules.maxStock)}の整数で入力してください。`,
      );
    if (errors.length > 0) {
      setError({ message: errors.join("\n"), details: errors });
      return;
    }

    // コードの変更は、印刷済みのラベル・他の資料との対応が変わるため確認する（旧コードは履歴に残り、読み取りでも見つかる）
    if (original && normalizeText(form.code) !== original.code) {
      const ok = window.confirm(
        `商品コードを「${original.code}」から「${normalizeText(form.code)}」に変更します。\n` +
          "変更は履歴に残り、旧コードのラベルを読み取っても、この商品が表示されます。\nよろしいですか？",
      );
      if (!ok) return;
    }

    setBusy(true);
    setError(null);
    try {
      let imageChange: ImageChange = {
        action: image.kind === "remove" ? "remove" : "keep",
      };
      if (image.kind === "new")
        imageChange = {
          action: "replace",
          uploadId: (await api.upload(image.blob)).uploadId,
        };

      const req: SaveProductRequest = {
        code: form.code,
        name: form.name,
        category: form.category,
        location: form.location,
        note: form.note,
        summary: form.summary,
        suppliers,
        offBook,
        warningStock: warningStock!,
        initialStock: isNew ? initialStock! : undefined,
        userName,
        image: imageChange,
        version: original?.version,
      };
      const saved = isNew
        ? await api.createProduct(req)
        : await api.updateProduct(productId!, req);

      setDirty(false);
      setLeaveGuard(null);
      app.toast(`「${saved.name}」を${isNew ? "登録" : "更新"}しました`);
      navigate({ page: "inventory" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !isNew && original) {
        await mergeWithLatest(original);
        return;
      }
      setError({
        message: errorMessage(e),
        details: e instanceof ApiError ? e.details : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------ 保存がぶつかったとき：項目ごとに内容を合わせる

  const myFields = (): EditableFields => ({
    code: form.code,
    name: form.name,
    category: form.category,
    location: form.location,
    note: form.note,
    summary: form.summary,
    warningStock: form.warningStock,
    offBook,
    suppliers,
    image: image.kind === "keep" ? "keep" : "changed",
    imageFile: original?.imageFile ?? null,
  });

  const applyFields = (f: EditableFields) => {
    setForm((cur) => ({
      ...cur,
      code: f.code,
      name: f.name,
      category: f.category,
      location: f.location,
      note: f.note,
      summary: f.summary,
      warningStock: f.warningStock,
    }));
    setSuppliers(f.suppliers);
    setOffBook(f.offBook);
  };

  /** 他の人が先に保存していた：今の内容を読み直し、相手の変更を取り込む。同じ項目を変えていたら選んでもらう */
  const mergeWithLatest = async (base: Product) => {
    let latest: Product;
    try {
      latest = await api.product(base.id);
    } catch (e) {
      setError({ message: errorMessage(e) });
      return;
    }
    const mine = myFields();
    const theirs = fieldsOf(latest);
    const r = mergeProduct(fieldsOf(base), mine, theirs);
    setOriginal(latest); // 次の保存は最新の版に対して行う
    applyFields(r.merged);
    setMerge({
      mine,
      theirs,
      taken: r.taken,
      conflicts: r.conflicts,
      choice: Object.fromEntries(r.conflicts.map((k) => [k, "mine"])),
      myImage: image,
    });
    setDirty(true);
  };

  /** ぶつかった項目で「相手の値」「自分の値」を選ぶ */
  const choose = (key: FieldKey, side: "mine" | "theirs") => {
    if (!merge) return;
    setMerge({ ...merge, choice: { ...merge.choice, [key]: side } });
    const src = side === "mine" ? merge.mine : merge.theirs;
    if (key === "image") {
      // 自分の新しい画像のプレビュー URL は解放せずに残す（「自分」に戻したときに使う）
      setImage(side === "theirs" ? { kind: "keep" } : merge.myImage);
    } else if (key === "suppliers") setSuppliers(src.suppliers);
    else if (key === "offBook") setOffBook(src.offBook);
    else setForm((cur) => ({ ...cur, [key]: src[key] as string }));
  };

  const remove = async () => {
    if (!original) return;
    const userName = app.requireUser();
    if (!userName) return;
    if (
      !window.confirm(
        `「${original.name}」を削除しますか？\n（入出庫の履歴は残ります）`,
      )
    )
      return;

    setBusy(true);
    try {
      await api.deleteProduct(original.id, original.version, userName);
      setDirty(false);
      setLeaveGuard(null);
      app.toast(`「${original.name}」を削除しました`);
      navigate({ page: "inventory" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      if (e instanceof ApiError && e.status === 404) {
        app.toast("この商品は既に削除されていました", "info");
        setDirty(false);
        setLeaveGuard(null);
        navigate({ page: "inventory" });
        return;
      }
      setError({ message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="loading">読み込み中…</div>;

  return (
    <div className="editor card">
      <h1>{isNew ? "商品登録" : "商品編集"}</h1>
      {others.length > 0 && (
        <div
          className="editing-notice"
          role="status"
          data-testid="editing-notice"
        >
          ✏ {others.map(editorName).join("・")}
          もこの商品を編集中です。同時に保存すると、後から保存した人に内容を合わせる確認が出ます。
        </div>
      )}
      {merge && (
        <div
          className="merge-panel"
          role="alert"
          data-testid="merge-panel"
          ref={mergeRef}
        >
          <h3>他の人が先にこの商品を保存しました</h3>
          <p className="small">
            {merge.taken.length > 0 && `相手の変更（${merge.taken.map((k) => FieldLabels[k]).join("・")}）を取り込みました。`}
            {merge.conflicts.length > 0
              ? "同じ項目を違う内容に変えています。項目ごとにどちらにするか選んでから「保存」を押してください。"
              : "あなたの変更はそのまま残っています。内容を確認して、もう一度「保存」を押してください。"}
          </p>
          {merge.conflicts.map((key) => (
            <div className="merge-row" key={key} data-testid={`merge-${key}`}>
              <strong className="small">{FieldLabels[key]}</strong>
              {(["theirs", "mine"] as const).map((side) => (
                <label
                  key={side}
                  className={merge.choice[key] === side ? "chosen" : ""}
                >
                  <input
                    type="radio"
                    name={`merge-${key}`}
                    checked={merge.choice[key] === side}
                    onChange={() => choose(key, side)}
                  />
                  <span>
                    <span className="muted small">
                      {side === "theirs" ? "相手の内容" : "あなたの内容"}：
                    </span>
                    <br />
                    {displayValue(
                      key,
                      side === "theirs" ? merge.theirs : merge.mine,
                      key === "image" && side === "mine"
                        ? merge.myImage.kind === "remove"
                          ? "画像を外す"
                          : "新しい画像"
                        : undefined,
                    )}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}

      <form
        className="editor-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="fields">
          <label className="field">
            <span>商品コード（必須）</span>
            <div className="input-with-button">
              <input
                type="text"
                value={form.code}
                onChange={update("code")}
                maxLength={Rules.codeMaxLength}
                autoComplete="off"
                autoFocus={isNew && !initialCode}
                // バーコードリーダーの Enter で保存されないようにする
                onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              />
              <button
                type="button"
                className="button"
                onClick={() => setScannerOpen(true)}
              >
                読み取り
              </button>
            </div>
          </label>

          <label className="field">
            <span>商品名（必須）</span>
            <input
              type="text"
              value={form.name}
              onChange={update("name")}
              maxLength={Rules.nameMaxLength}
              autoFocus={!!initialCode}
            />
          </label>

          <label className="field">
            <span>概要</span>
            <textarea
              value={form.summary}
              onChange={update("summary")}
              maxLength={Rules.summaryMaxLength}
              rows={2}
              placeholder="どんな商品か（検索の対象になります）"
            />
          </label>

          <label className="field">
            <span>カテゴリ</span>
            <input
              type="text"
              value={form.category}
              onChange={update("category")}
              maxLength={Rules.categoryMaxLength}
            />
          </label>

          <label className="check-field">
            <input
              type="checkbox"
              checked={offBook}
              onChange={(e) => {
                setOffBook(e.target.checked);
                setDirty(true);
              }}
            />
            <span>簿外（帳簿に載せていない在庫）</span>
          </label>

          <label className="field">
            <span>保管場所</span>
            <input
              type="text"
              value={form.location}
              onChange={update("location")}
              maxLength={Rules.locationMaxLength}
              placeholder="例: 上段A-1（複数ある場合は「,」で区切る）"
            />
          </label>

          <div className="field-row">
            {isNew ? (
              <label className="field">
                <span>初期在庫</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="num"
                  value={form.initialStock}
                  onChange={update("initialStock")}
                />
              </label>
            ) : (
              <div className="field">
                <span>現在の在庫</span>
                <div className="readonly-value">
                  {formatNumber(original?.stock ?? 0)}
                </div>
              </div>
            )}
            <label className="field">
              <span>警告在庫</span>
              <input
                type="text"
                inputMode="numeric"
                className="num"
                value={form.warningStock}
                onChange={update("warningStock")}
              />
              <small className="muted">この数以下になると警告</small>
            </label>
          </div>
          {!isNew && (
            <p className="muted small">
              在庫数は「在庫一覧」の入庫・出庫で変更します（必ず履歴が残るようにするため）。
            </p>
          )}

          <label className="field">
            <span>備考</span>
            <textarea
              value={form.note}
              onChange={update("note")}
              maxLength={Rules.noteMaxLength}
              rows={3}
              placeholder="商品ごとのメモ（例: 棚卸ドル払い、円払い別）"
            />
          </label>

          <SuppliersEditor
            value={suppliers}
            onChange={(next) => {
              setSuppliers(next);
              setDirty(true);
            }}
          />
        </div>

        <div className="image-field">
          <span className="field-label">商品画像</span>
          <div
            className={`drop-zone${dragOver ? " over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {previewSrc ? (
              <ProductImage
                src={previewSrc}
                size={240}
                alt={form.name || "商品画像"}
                zoomable
              />
            ) : (
              <div className="drop-hint">
                画像なし
                <span className="desktop-only">
                  <br />
                  ここに画像をドラッグ＆ドロップ
                </span>
              </div>
            )}
          </div>
          <div className="image-buttons">
            <label className="button mobile-only">
              📷 撮影
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => {
                  void handleFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="button">
              画像を選択
              <input
                type="file"
                accept="image/*"
                hidden
                data-testid="image-input"
                onChange={(e) => {
                  void handleFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              className="button"
              onClick={removeImage}
              disabled={!previewSrc}
            >
              画像を外す
            </button>
          </div>
          <p className="muted small">長辺1024pxに縮小して保存します。</p>
        </div>

        <div className="editor-errors">
          <ErrorBox message={error?.message ?? null} details={error?.details} />
          {conflict && (
            <button
              type="button"
              className="button"
              onClick={() => void load()}
            >
              最新の内容を読み込む（編集内容は破棄）
            </button>
          )}
        </div>

        <div className="editor-actions">
          {!isNew && (
            <button
              type="button"
              className="button danger"
              onClick={() => void remove()}
              disabled={busy}
            >
              削除
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="button"
            onClick={() => navigate({ page: "inventory" })}
            disabled={busy}
          >
            キャンセル
          </button>
          <button
            type="submit"
            className="button primary large"
            disabled={busy}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>

      {scannerOpen && (
        <ScannerDialog
          onDetected={(code) => {
            setScannerOpen(false);
            setForm((f) => ({ ...f, code: normalizeText(extractCode(code)) }));
            setDirty(true);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}
