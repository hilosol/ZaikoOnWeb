import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { imageUrl } from "../api";

/**
 * 商品画像。画像が無い・読み込めない場合は「No Image」を表示する。
 * zoomable: クリック（タップ）で拡大表示する。画像が無い・読み込めない場合は拡大しない
 */
export function ProductImage({
  file,
  src,
  size,
  alt = "",
  zoomable = false,
}: {
  file?: string | null;
  src?: string | null;
  size: number;
  alt?: string;
  zoomable?: boolean;
}) {
  const url = src ?? imageUrl(file);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const canZoom = zoomable && !!url && !failed;

  const img = url && !failed ? (
    <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  ) : (
    <span className="no-image">No Image</span>
  );

  return (
    <>
      {canZoom ? (
        <button
          type="button"
          className="product-image zoomable"
          style={{ width: size, height: size }}
          onClick={(e) => {
            e.stopPropagation(); // 一覧の行の選択などに伝えない
            setZoomed(true);
          }}
          aria-label={`${alt || "商品画像"}を拡大`}
          title="クリックで拡大"
        >
          {img}
        </button>
      ) : (
        <div className="product-image" style={{ width: size, height: size }}>
          {img}
        </div>
      )}
      {zoomed && url && <ImageViewer src={url} alt={alt} onClose={() => setZoomed(false)} />}
    </>
  );
}

/** 画像の拡大表示。背景・画像のクリック、Esc、×ボタンで閉じる */
export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // 拡大中は後ろの画面がスクロールしないようにする
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  // 親要素（スマホの下から出るパネル等）の transform の影響を受けないよう body 直下に出す
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={`${alt || "商品画像"}（拡大）`} onClick={onClose}>
      <img src={src} alt={alt} />
      <button
        type="button"
        className="image-viewer-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="閉じる"
        autoFocus
      >
        ×
      </button>
      {alt && <div className="image-viewer-caption">{alt}</div>}
    </div>,
    document.body,
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose?: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className={`modal${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          {onClose && (
            <button type="button" className="icon-button" onClick={onClose} aria-label="閉じる">
              ×
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ message, details }: { message: string | null; details?: string[] }) {
  if (!message) return null;
  const lines = details && details.length > 1 ? details : [message];
  return (
    <div className="error-box" role="alert">
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

export const formatNumber = (n: number) => n.toLocaleString("ja-JP");

/** "2026-11-02 09:05:00" → "11/02 09:05" */
export const shortDateTime = (s: string) => (s.length >= 16 ? `${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)}` : s);
