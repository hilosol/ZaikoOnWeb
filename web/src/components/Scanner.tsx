import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { loadImage } from "../image";
import { Modal } from "./common";

const FORMATS = [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
];

const CAMERA_KEY = "zaiko.cameraId";

const loadCameraId = () => {
  try {
    return localStorage.getItem(CAMERA_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveCameraId = (id: string) => {
  try {
    if (id) localStorage.setItem(CAMERA_KEY, id);
    else localStorage.removeItem(CAMERA_KEY);
  } catch {
    // 保存できなくても今回は使える
  }
};

function createReader() {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints);
}

/**
 * QR コードの読み取り（jsQR）。
 * ZXing は一部の QR（模様の組み合わせ）を読み取れないことがあるため、QR は jsQR を優先する。
 * バーコード（JAN 等）は jsQR が対応していないので ZXing で読む。
 */
function decodeQrFromCanvas(canvas: HTMLCanvasElement, inversion: "attemptBoth" | "dontInvert"): string | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data.data, data.width, data.height, { inversionAttempts: inversion })?.data ?? null;
}

/** 撮影した写真からコードを読み取る。大きな写真は縮小してから解析する（速度のため）。 */
export async function decodeFromPhoto(file: Blob): Promise<string | null> {
  const img = await loadImage(file);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d", { willReadFrequently: true })!.drawImage(img, 0, 0, canvas.width, canvas.height);

  const qr = decodeQrFromCanvas(canvas, "attemptBoth");
  if (qr) return qr;
  try {
    return createReader().decodeFromCanvas(canvas).getText();
  } catch {
    return null; // 見つからない（NotFoundException）
  }
}

/**
 * カメラ映像から QR を読み取る（jsQR）。ZXing の連続読み取りと並行して動かし、先に読めた方を使う。
 * 負荷を抑えるため 0.25 秒ごと・長辺 800px に縮小して解析する。
 */
function startQrLoop(video: HTMLVideoElement, onFound: (text: string) => void): () => void {
  const canvas = document.createElement("canvas");
  const id = window.setInterval(() => {
    if (video.readyState < 2 || video.videoWidth === 0) return;
    const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d", { willReadFrequently: true })?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const text = decodeQrFromCanvas(canvas, "dontInvert");
    if (text) onFound(text);
  }, 250);
  return () => window.clearInterval(id);
}

/**
 * QR コード・バーコードの読み取り。
 * ・HTTPS（または localhost）で開いている場合：カメラ映像からリアルタイムで読み取る
 * ・HTTP の場合：ブラウザの制約でカメラ映像を使えないため、写真を撮って読み取る
 * どちらも読めない場合に備えて手入力もできる。
 */
export function Scanner({ onDetected, onClose }: { onDetected: (code: string) => void; onClose: () => void }) {
  const liveSupported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const [mode, setMode] = useState<"live" | "photo">(liveSupported ? "live" : "photo");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const doneRef = useRef(false);
  // Windows PC は内蔵カメラ・赤外線カメラ・仮想カメラなど複数あり、映像の出ないカメラが選ばれることがあるため選べるようにする
  const [cameraId, setCameraId] = useState(loadCameraId);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [noVideo, setNoVideo] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const finish = (code: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDetected(code.trim());
  };

  useEffect(() => {
    const video = videoRef.current;
    if (mode !== "live" || !video) return;
    let controls: IScannerControls | null = null;
    let cancelled = false;
    setNoVideo(false);
    setErrorDetail(null);
    const stopQrLoop = startQrLoop(video, (text) => {
      if (cancelled) return;
      controls?.stop();
      finish(text);
    });

    const onResult = (result: { getText(): string } | undefined, _err: unknown, c: IScannerControls) => {
      if (result) {
        c.stop();
        finish(result.getText());
      }
    };
    const start = (constraints: MediaStreamConstraints) => createReader().decodeFromConstraints(constraints, video, onResult);

    // カメラ指定あり → そのカメラ。指定なし → 背面カメラ優先、ドライバーが受け付けない場合は条件なし（どのカメラでも）で再試行
    const startWithFallback = async () => {
      if (cameraId) return start({ video: { deviceId: { exact: cameraId } } });
      try {
        return await start({ video: { facingMode: { ideal: "environment" } } });
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (name === "NotAllowedError" || name === "SecurityError" || cancelled) throw e;
        return start({ video: true });
      }
    };

    startWithFallback()
      .then(async (c) => {
        if (cancelled) {
          c.stop();
          return;
        }
        controls = c;
        // カメラの名前は使用を許可した後でないと取得できないため、起動後に一覧を取る
        try {
          const list = await BrowserMultiFormatReader.listVideoInputDevices();
          if (!cancelled) setCameras(list);
        } catch {
          // 一覧が取れなくても読み取りは続ける
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const name = (e as { name?: string }).name;
        const detail = `${name ?? "Error"}: ${(e as { message?: string }).message ?? String(e)}`;
        console.warn("カメラの起動に失敗", e);
        setErrorDetail(detail);
        if (cameraId && (name === "OverconstrainedError" || name === "NotFoundError" || name === "NotReadableError")) {
          // 記憶していたカメラが外された・他のアプリが使用中 → 既定のカメラでやり直す
          saveCameraId("");
          setCameraId("");
          setMessage("選択していたカメラが使えないため、既定のカメラに切り替えました。");
          return;
        }
        setMessage(
          name === "NotAllowedError"
            ? "カメラの使用が許可されていません。ブラウザのアドレスバーのカメラの許可と、Windows の「設定 → プライバシーとセキュリティ → カメラ → デスクトップ アプリがカメラにアクセスできるようにする」を確認してください。"
            : name === "NotReadableError" || name === "AbortError"
              ? "カメラを開けませんでした。他のアプリ（カメラアプリ・Teams・Zoom など）を閉じてから「再試行」を押してください。"
              : name === "NotFoundError" || name === "OverconstrainedError"
                ? "ブラウザからカメラが見つかりません。Windows の「設定 → プライバシーとセキュリティ → カメラ」で、デスクトップ アプリのカメラへのアクセスが許可されているか確認してください。"
                : "カメラを起動できませんでした。",
        );
        setMode("photo");
      });

    // 映像が届かない（真っ黒・赤外線カメラ等）場合の案内
    const timer = window.setTimeout(() => {
      if (!cancelled && (video.readyState < 2 || video.videoWidth === 0)) setNoVideo(true);
    }, 4000);

    return () => {
      cancelled = true;
      stopQrLoop();
      window.clearTimeout(timer);
      controls?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cameraId, attempt]);

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const code = await decodeFromPhoto(file);
      if (code) finish(code);
      else setMessage("読み取れませんでした。コードが画面の中央に大きく、ピントが合うように撮り直してください。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "画像を読み込めませんでした。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="QR・バーコード読み取り" onClose={onClose}>
      {mode === "live" ? (
        <div className="scanner-live">
          {cameras.length > 0 && (
            <label className="camera-select">
              <span>カメラ</span>
              <select
                value={cameraId}
                onChange={(e) => {
                  saveCameraId(e.target.value);
                  setCameraId(e.target.value);
                  setMessage(null);
                }}
                aria-label="カメラ"
              >
                <option value="">自動（背面カメラ優先）</option>
                {cameras.map((c, i) => (
                  <option key={c.deviceId || i} value={c.deviceId}>
                    {c.label || `カメラ ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="scanner-video">
            <video ref={videoRef} muted playsInline />
            <div className="scanner-frame" aria-hidden="true" />
          </div>
          {noVideo ? (
            <div className="error-box">
              映像が届いていません。上の「カメラ」で別のカメラを選んでください（顔認証用の赤外線カメラや仮想カメラは映りません）。
            </div>
          ) : (
            <p className="muted">コードを枠の中に写してください。</p>
          )}
          <button type="button" className="button small" onClick={() => setMode("photo")}>
            写真・画像ファイルから読み取る
          </button>
        </div>
      ) : (
        <div className="scanner-photo">
          <label className={`button primary large${busy ? " disabled" : ""}`}>
            {busy ? "読み取り中…" : "📷 撮影して読み取る"}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              disabled={busy}
              data-testid="scan-photo-input"
              onChange={(e) => {
                void onPhoto(e.target.files?.[0]);
                e.target.value = ""; // 同じ写真を選び直せるようにする
              }}
            />
          </label>
          {!liveSupported && (
            <p className="muted small">
              ※ 現在の接続（http）ではカメラ映像からの連続読み取りが使えないため、写真から読み取ります。
            </p>
          )}
        </div>
      )}

      {message && <div className="error-box">{message}</div>}
      {errorDetail && mode === "photo" && liveSupported && (
        <div className="camera-error">
          <code>{errorDetail}</code>
          <button
            type="button"
            className="button small"
            onClick={() => {
              setMessage(null);
              setAttempt((n) => n + 1);
              setMode("live");
            }}
          >
            再試行
          </button>
        </div>
      )}

      <form
        className="scanner-manual"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) finish(manual);
        }}
      >
        <input
          type="text"
          inputMode="text"
          placeholder="IDを手入力"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          aria-label="IDを手入力"
        />
        <button type="submit" className="button" disabled={!manual.trim()}>
          決定
        </button>
      </form>
    </Modal>
  );
}

export default Scanner;
