import { Rules } from "../../shared/types";

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

/**
 * 選択された画像を長辺 1024px の JPEG に縮小する。
 * ・スマホの写真（数MB）をそのまま送らずに済み、社内Wi-Fiでも速い
 * ・最近のブラウザは画像の回転情報（EXIF）を反映して描画するため、向きも補正される
 * ・透過部分は白で塗る（商品写真用途のため JPEG に統一）
 */
export async function resizeImage(file: File, maxDimension: number = Rules.imageMaxDimension): Promise<Blob> {
  if (file.type && !file.type.startsWith("image/")) throw new Error("画像ファイルを選択してください。");
  if (file.size === 0) throw new Error("画像ファイルが空です。");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("画像が大きすぎます（30MBまで）。");

  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error("画像のサイズを取得できませんでした。");

  const scale = Math.min(1, maxDimension / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした。");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("画像を変換できませんでした。");
  if (blob.size > Rules.maxUploadBytes) throw new Error("画像を十分に小さくできませんでした。");
  return blob;
}

/** 画像を読み込む（デコードに失敗したら分かりやすいエラーにする）。 */
export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("この画像は読み込めません（HEIC など未対応の形式の可能性があります）。JPEG か PNG を選択してください。"));
    };
    img.src = url;
  });
}
