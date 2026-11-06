import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { searchKey } from "../../../shared/text";
import { Rules, type OrderNumbersResponse } from "../../../shared/types";
import { api } from "../api";

/** 候補の1件（リストの番号、またはリストに無いが最近入力された番号） */
interface Candidate {
  number: string;
  name: string;
  recent: boolean;
}

const MAX_SHOWN = 50;

/**
 * 受注番号の候補（リストファイル＋最近の入力）を読み込む。
 * 画面に戻ったとき（リストファイルを置き換えた後など）にも読み直す。
 */
export function useOrderNumbers(): { data: OrderNumbersResponse | null; reload: () => void } {
  const [data, setData] = useState<OrderNumbersResponse | null>(null);
  const reload = useCallback(() => {
    api.orderNumbers().then(setData, () => undefined); // 候補が出ないだけで入力はできるため、失敗は表示しない
  }, []);
  useEffect(() => {
    reload();
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);
  return { data, reload };
}

/** 候補の絞り込み（番号・案件名。大文字小文字・全角半角・ハイフン・ひらがなカタカナを区別しない） */
export function filterCandidates(all: Candidate[], text: string): Candidate[] {
  const key = searchKey(text);
  if (!key) return all;
  const starts: Candidate[] = [];
  const contains: Candidate[] = [];
  for (const c of all) {
    const n = searchKey(c.number);
    if (n.startsWith(key)) starts.push(c);
    else if (n.includes(key) || searchKey(c.name).includes(key)) contains.push(c);
  }
  return [...starts, ...contains];
}

/**
 * 受注番号の入力欄。リストから選ぶか、そのまま入力する（リストに無い番号も可）。
 * 入力中は番号・案件名で候補を絞り込む。キーボード（↑↓・Enter・Esc）でも選べる。
 */
export function OrderNoField({
  value,
  onChange,
  data,
  disabled,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  data: OrderNumbersResponse | null;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /** ↓ キーで、入力済みでも全件を出す */
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const all = useMemo<Candidate[]>(
    () => [
      ...(data?.recent ?? []).map((n) => ({ number: n, name: "", recent: true })),
      ...(data?.items ?? []).map((x) => ({ ...x, recent: false })),
    ],
    [data],
  );
  const matched = useMemo(() => {
    // リストの番号と完全に一致したら候補は閉じる（候補の一覧が入出庫ボタンに重なって押せなくなるのを防ぐ）。
    // 選び直すときは × で消すか ↓ キーで全件を出す
    const exact = value.trim() !== "" && all.some((c) => searchKey(c.number) === searchKey(value));
    if (exact) return showAll ? all : [];
    return filterCandidates(all, value);
  }, [all, value, showAll]);
  const shown = matched.slice(0, MAX_SHOWN);
  const selected = value.trim() ? all.find((c) => !c.recent && searchKey(c.number) === searchKey(value)) : undefined;

  const choose = (c: Candidate) => {
    onChange(c.number);
    setOpen(false);
    setShowAll(false);
    setActive(-1);
  };

  return (
    <div className={`order-field ${className}`}>
      <div className="order-input">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setShowAll(false);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setShowAll(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              if (shown.length === 0) setShowAll(true);
              else setActive((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(-1, i - 1));
            } else if (e.key === "Enter") {
              // 候補を選んでいれば確定。フォームの送信（入出庫の実行）にはしない
              e.preventDefault();
              if (open && active >= 0 && shown[active]) choose(shown[active]!);
              else setOpen(false);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          maxLength={Rules.orderNoMaxLength}
          placeholder="受注番号（任意）リストから選択 or 入力"
          aria-label="受注番号"
          role="combobox"
          aria-expanded={open && shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        {value && (
          <button
            type="button"
            className="order-clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            aria-label="受注番号を消す"
            disabled={disabled}
          >
            ×
          </button>
        )}
      </div>
      {/* 入力中も表示する（入力欄から離れたときに表示が増えて下の行がずれ、クリックがずれるのを防ぐ。候補の一覧はこの上に重なる） */}
      {value.trim() && (
        <div className="order-hint small" data-testid="order-hint">
          {selected ? selected.name || "（案件名なし）" : "リストに無い番号です（そのまま記録します）"}
        </div>
      )}
      {open && shown.length > 0 && (
        <ul className="order-suggest" id={listId} role="listbox">
          {shown.map((c, i) => (
            <li key={`${c.recent ? "r" : "l"}-${c.number}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={i === active ? "active" : ""}
                // 入力欄の blur より先に選択を確定させる
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(c)}
              >
                <span className="order-number">{c.number}</span>
                <span className="order-name">{c.recent ? "（最近の手入力）" : c.name}</span>
              </button>
            </li>
          ))}
          {matched.length > MAX_SHOWN && <li className="order-more muted small">ほか {matched.length - MAX_SHOWN} 件（入力して絞り込み）</li>}
        </ul>
      )}
    </div>
  );
}
