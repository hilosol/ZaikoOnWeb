/**
 * 変換済みの商品データ（plan.json）を、アプリと同じ業務ルール（InventoryService）で DB に登録する。
 * 画面から登録した場合と同じく、入力チェック・初期在庫の履歴・操作ログが残る。
 *
 * 使い方: npx tsx scripts/import-plan.ts <plan.json> <出力先 data フォルダ（空であること）>
 */
import fs from "node:fs";
import path from "node:path";
import { systemClock } from "../server/src/clock.js";
import { openDatabase } from "../server/src/db.js";
import { FileImageStore } from "../server/src/images.js";
import { InventoryService } from "../server/src/inventory.js";

interface PlanItem {
  code: string;
  name: string;
  category: string;
  location?: string;
  stock: number;
  warningStock: number;
  image: string | null;
}

const [planPath, dataDir] = process.argv.slice(2);
if (!planPath || !dataDir) {
  console.error("使い方: npx tsx scripts/import-plan.ts <plan.json> <出力先 data フォルダ>");
  process.exit(1);
}
if (fs.existsSync(path.join(dataDir, "zaiko.db"))) {
  console.error(`${dataDir} には既に DB があります。上書きを防ぐため、空のフォルダを指定してください。`);
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as { products: PlanItem[] };
const baseDir = path.dirname(path.resolve(planPath));
fs.mkdirSync(dataDir, { recursive: true });

const db = openDatabase(path.join(dataDir, "zaiko.db"));
const images = new FileImageStore(dataDir);
const service = new InventoryService(db, images, systemClock);

// 取り込み専用の入力者。取り込み後は無効化して、画面の選択肢には出さない
const IMPORTER = "データ取込";
const actor = { userName: IMPORTER, clientIp: "(初期取込)" };
const importer = service.createUser(IMPORTER, actor);

const errors: string[] = [];
let ok = 0;
for (const item of plan.products) {
  try {
    let image: { action: "keep" } | { action: "replace"; uploadId: string } = { action: "keep" };
    if (item.image) {
      const file = path.resolve(path.dirname(baseDir), item.image);
      image = { action: "replace", uploadId: images.saveUpload(fs.readFileSync(file)) };
    }
    service.registerProduct(
      {
        code: item.code,
        name: item.name,
        category: item.category,
        location: item.location ?? "",
        initialStock: item.stock,
        warningStock: item.warningStock,
      },
      image,
      actor,
    );
    ok++;
  } catch (e) {
    errors.push(`${item.code}: ${(e as Error).message}`);
  }
}

service.updateUser(importer.id, { active: false }, actor);
images.cleanupUploads(0); // 登録に失敗した商品の一時画像を消す
db.close();

console.log(`登録 ${ok} 件 / エラー ${errors.length} 件`);
for (const e of errors) console.log("  " + e);
process.exit(errors.length ? 1 : 0);
