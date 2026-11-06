import { Rules, type Supplier } from "../../../shared/types";

/** 画面でリンクにしてよい URL か（サーバーでも検証済みだが、表示側でも http/https 以外はリンクにしない） */
export const isSafeHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/** 購入元のリスト（URL があればリンク。別タブで開く） */
export function SupplierList({ suppliers }: { suppliers: Supplier[] }) {
  return (
    <ul className="supplier-list">
      {suppliers.map((s, i) => (
        <li key={i}>
          {s.url && isSafeHttpUrl(s.url) ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
              {s.name}
              <span className="ext" aria-hidden="true">↗</span>
            </a>
          ) : (
            <span>{s.name}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** PC の詳細欄用：ラベル付き。0件なら何も出さない */
export function SupplierLinks({ suppliers }: { suppliers: Supplier[] }) {
  if (suppliers.length === 0) return null;
  return (
    <div className="small supplier-line" data-testid="supplier-links">
      <span className="tag-label">購入元</span>
      <SupplierList suppliers={suppliers} />
    </div>
  );
}

/** 購入元の入力欄（商品編集画面）。空欄の行は保存時にサーバー側で捨てる */
export function SuppliersEditor({
  value,
  onChange,
}: {
  value: Supplier[];
  onChange: (next: Supplier[]) => void;
}) {
  const set = (index: number, key: keyof Supplier, text: string) =>
    onChange(value.map((s, i) => (i === index ? { ...s, [key]: text } : s)));
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));
  const move = (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[index], next[j]] = [next[j]!, next[index]!];
    onChange(next);
  };
  const full = value.length >= Rules.maxSuppliers;

  return (
    <fieldset className="field suppliers-editor">
      <legend>購入元（{Rules.maxSuppliers}件まで）</legend>
      {value.length === 0 && <p className="muted small">登録なし</p>}
      {value.map((s, i) => (
        <div className="supplier-row" key={i}>
          <input
            type="text"
            value={s.name}
            onChange={(e) => set(i, "name", e.target.value)}
            maxLength={Rules.supplierNameMaxLength}
            placeholder="名前（例: モノタロウ）"
            aria-label={`購入元${i + 1} 名前`}
          />
          <input
            // type="url" だとブラウザが「www.…」（https:// 省略）を弾くため text にして、補完はサーバーで行う
            type="text"
            spellCheck={false}
            value={s.url}
            onChange={(e) => set(i, "url", e.target.value)}
            maxLength={Rules.supplierUrlMaxLength}
            placeholder="URL（任意）https://…"
            aria-label={`購入元${i + 1} URL`}
            inputMode="url"
          />
          <div className="supplier-row-buttons">
            <button type="button" className="button icon" onClick={() => move(i, -1)} disabled={i === 0} title="上へ" aria-label={`購入元${i + 1}を上へ`}>
              ↑
            </button>
            <button type="button" className="button icon" onClick={() => move(i, 1)} disabled={i === value.length - 1} title="下へ" aria-label={`購入元${i + 1}を下へ`}>
              ↓
            </button>
            <button type="button" className="button icon" onClick={() => remove(i)} title="削除" aria-label={`購入元${i + 1}を削除`}>
              ✕
            </button>
          </div>
        </div>
      ))}
      <div>
        <button type="button" className="button" onClick={() => onChange([...value, { name: "", url: "" }])} disabled={full}>
          ＋ 購入元を追加
        </button>
      </div>
    </fieldset>
  );
}
