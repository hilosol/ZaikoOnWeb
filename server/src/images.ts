import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Rules } from "../../shared/types.js";
import { ValidationError } from "./errors.js";

/**
 * 商品画像の保存。
 *  1. 画面から画像を受け取ったら uploads/ に一時保存し、uploadId を返す
 *  2. 商品の保存が成功したら images/ に移す（commit）。保存しなかった一時ファイルは定期的に削除
 * 画像の縮小・回転補正は画面（ブラウザ）側で行う。サーバーに画像処理ライブラリ（ネイティブモジュール）を
 * 入れずに済み、スマホからの送信量も減るため。サーバーは形式とサイズの検証だけを行う。
 */
export interface ImageStore {
  saveUpload(data: Buffer): string;
  commitUpload(uploadId: string): string;
  delete(fileName: string | null | undefined): void;
  resolve(fileName: string): string | null;
}

const SIGNATURES: { ext: string; test: (b: Buffer) => boolean }[] = [
  { ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: "png",
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: "webp",
    test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  },
];

const UPLOAD_ID = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const IMAGE_FILE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export class FileImageStore implements ImageStore {
  private readonly imagesDir: string;
  private readonly uploadsDir: string;

  constructor(dataDir: string) {
    this.imagesDir = path.join(dataDir, "images");
    this.uploadsDir = path.join(dataDir, "uploads");
    fs.mkdirSync(this.imagesDir, { recursive: true });
    fs.mkdirSync(this.uploadsDir, { recursive: true });
  }

  saveUpload(data: Buffer): string {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new ValidationError("画像データが空です。");
    if (data.length > Rules.maxUploadBytes) {
      throw new ValidationError(`画像が大きすぎます（上限 ${Rules.maxUploadBytes / 1024 / 1024}MB）。`);
    }
    // Content-Type は送信側で偽れるため、中身の先頭バイトで形式を判定する
    const sig = SIGNATURES.find((s) => s.test(data));
    if (!sig) throw new ValidationError("対応していない画像形式です（JPEG / PNG / WebP）。");

    const uploadId = `${randomUUID()}.${sig.ext}`;
    const finalPath = path.join(this.uploadsDir, uploadId);
    const tempPath = `${finalPath}.tmp`;
    fs.writeFileSync(tempPath, data, { flag: "wx" });
    fs.renameSync(tempPath, finalPath); // 書き込み途中のファイルが正式名で見えないようにする
    return uploadId;
  }

  commitUpload(uploadId: string): string {
    if (!UPLOAD_ID.test(uploadId)) throw new ValidationError("画像の指定が正しくありません。");
    const source = path.join(this.uploadsDir, uploadId);
    if (!fs.existsSync(source)) {
      throw new ValidationError("アップロードした画像が見つかりません。もう一度画像を選択してください。");
    }
    // uploadId は UUID なので、そのまま画像ファイル名として使っても衝突しない
    fs.renameSync(source, path.join(this.imagesDir, uploadId));
    return uploadId;
  }

  delete(fileName: string | null | undefined): void {
    if (!fileName || !IMAGE_FILE.test(fileName)) return;
    try {
      fs.rmSync(path.join(this.imagesDir, fileName), { force: true });
    } catch {
      // 削除できなくても業務処理は成功扱い（ゴミが残るだけ）
    }
  }

  /** 名前が正しく、ファイルが存在する場合にフルパスを返す（パストラバーサル対策で形式を限定）。 */
  resolve(fileName: string): string | null {
    if (!IMAGE_FILE.test(fileName)) return null;
    const full = path.join(this.imagesDir, fileName);
    return fs.existsSync(full) ? full : null;
  }

  /** 商品に使われなかった一時ファイルを削除する。 */
  cleanupUploads(olderThanMs: number, now = Date.now()): number {
    let removed = 0;
    for (const name of fs.readdirSync(this.uploadsDir)) {
      const full = path.join(this.uploadsDir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > olderThanMs) {
          fs.rmSync(full, { force: true });
          removed++;
        }
      } catch {
        // 同時に commit された等。次回に任せる
      }
    }
    return removed;
  }
}
