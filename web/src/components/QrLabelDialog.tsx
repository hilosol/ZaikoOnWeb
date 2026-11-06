import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { productUrl } from "../../../shared/text";
import type { Product } from "../../../shared/types";
import { api } from "../api";
import { Modal } from "./common";

const BASE_URL_KEY = "zaiko.qrBaseUrl";

const isLocal = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/**
 * QR に入れるアドレス（スマホからサーバーPCに届くアドレス）。
 * 1. 以前この画面で決めたアドレス  2. 今開いているアドレス（localhost 以外）  3. サーバーPCの社内向けアドレス
 */
async function defaultBaseUrl(): Promise<string> {
  try {
    const saved = localStorage.getItem(BASE_URL_KEY);
    if (saved) return saved;
  } catch {
    // localStorage が使えない環境
  }
  if (!isLocal(window.location.hostname)) return window.location.origin;
  try {
    const info = await api.serverInfo();
    if (info.urls[0]) return info.urls[0];
  } catch {
    // 取得できなければ今のアドレス
  }
  return window.location.origin;
}

function isValidBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && !isLocal(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 商品の QR ラベル。QR にはスマホ用画面の URL を入れるので、スマホの標準カメラで読み取るとその商品の画面が開く。
 * 「印刷」はラベル部分だけを印刷する（styles.css の @media print）。
 */
export function QrLabelDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const valid = isValidBaseUrl(baseUrl);
  const url = valid ? productUrl(baseUrl, product.code) : "";

  useEffect(() => {
    // 既定のアドレスは非同期で決まるため、それより先に入力された場合は上書きしない
    void defaultBaseUrl().then((d) => setBaseUrl((current) => (current === "" ? d : current)));
  }, []);

  useEffect(() => {
    if (!url) {
      setQr(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" })
      .then((data) => !cancelled && setQr(data))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [url]);

  const print = () => {
    try {
      localStorage.setItem(BASE_URL_KEY, baseUrl.replace(/\/+$/, ""));
    } catch {
      // 保存できなくても印刷はできる
    }
    window.print();
  };

  return (
    <Modal title="QRラベル" onClose={onClose}>
      <div className="label-print-area">
        <div className="qr-label">
          {qr ? <img src={qr} alt={`${product.code} の QR コード`} /> : <div className="qr-placeholder">アドレスを確認してください</div>}
          <div className="qr-label-code">{product.code}</div>
          <div className="qr-label-name">{product.name}</div>
        </div>
      </div>

      <label className="field qr-base">
        <span>QR に入れるアドレス（スマホからサーバーPCを開くアドレス）</span>
        <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value.trim())} placeholder="http://192.168.0.210:28003" />
      </label>
      {!valid && baseUrl && (
        <div className="error-box">
          「http://192.168.0.210:28003」の形で、スマホから届くアドレスを入力してください（localhost・127.0.0.1 は使えません）。
        </div>
      )}
      {url && <p className="muted small qr-url">{url}</p>}
      <p className="muted small">スマホの標準カメラで読み取ると、この商品のスマホ用画面が開きます。サーバーPCのIPアドレスが変わるとラベルの作り直しが必要です。</p>

      <div className="m-dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          閉じる
        </button>
        <button type="button" className="button primary" onClick={print} disabled={!qr}>
          印刷
        </button>
      </div>
    </Modal>
  );
}
