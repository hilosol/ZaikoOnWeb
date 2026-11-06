import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { systemClock } from "./clock.js";
import { backupDatabase, openDatabase } from "./db.js";
import { FileImageStore } from "./images.js";
import { InventoryService } from "./inventory.js";
import { SmtpMailer } from "./mail/mailer.js";
import { MailNotifier } from "./mail/notifier.js";
import { SettingsStore } from "./settingsStore.js";
import { CsvLogExporter } from "./logExport.js";
import { lanAddresses } from "./network.js";
import { OrderNumberList } from "./orderNumbers.js";
import { APP_VERSION } from "./version.js";

/**
 * 起動処理。設定は環境変数で変更できる（start.bat で指定）。
 *   ZAIKO_PORT      待ち受けポート（既定 28003）
 *   ZAIKO_DATA_DIR  データの保存先（既定: このプログラムと同じ場所の data フォルダ）
 *   ZAIKO_ORDER_LIST 受注番号リストのファイル（既定: データの保存先の 受注番号リスト.txt）
 *   ZAIKO_DEMO      1 = デモ（お試し・説明用）環境。画面に「デモ」と表示する
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ZAIKO_PORT ?? 28003);
const dataDir = path.resolve(process.env.ZAIKO_DATA_DIR ?? path.join(here, "..", "data"));
const webDir = path.join(here, "web");
const BACKUP_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`ZAIKO_PORT の値が正しくありません: ${process.env.ZAIKO_PORT}`);
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(path.join(dataDir, "zaiko.db"), (fromVersion) => {
  const dir = path.join(dataDir, "backup");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `zaiko_before_upgrade_v${fromVersion}_${Date.now()}.db`);
  console.log(`データベースの構造を更新します。更新前の状態を保存しました: ${dest}`);
  return dest;
});
const images = new FileImageStore(dataDir);
const isDemo = process.env.ZAIKO_DEMO === "1";
const orderListFile = path.resolve(process.env.ZAIKO_ORDER_LIST ?? path.join(dataDir, "受注番号リスト.txt"));
const orderList = new OrderNumberList(orderListFile);
const service = new InventoryService(db, images, systemClock, orderList);
const mail = new MailNotifier({
  store: new SettingsStore(db),
  inventory: service,
  mailer: new SmtpMailer(),
  clock: systemClock,
  defaultSiteUrl: () => {
    const ip = lanAddresses()[0];
    return ip ? `http://${ip}:${port}` : "";
  },
  version: APP_VERSION,
});
const logExporter = new CsvLogExporter(service, path.join(dataDir, "logs"), systemClock);
const app = buildApp({ service, images, mail, logExporter, orderList, demo: isDemo, webDir: fs.existsSync(webDir) ? webDir : undefined, logger: true });

/** 1日1回 DB をバックアップし、古いものを削除する（画像フォルダは対象外。README 参照）。 */
function dailyBackup(): void {
  try {
    const dir = path.join(dataDir, "backup");
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const dest = path.join(dir, `zaiko_${stamp}.db`);
    if (!fs.existsSync(dest)) backupDatabase(db, dest);

    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (/^zaiko_\d{8}\.db$/.test(name) && Date.now() - fs.statSync(full).mtimeMs > BACKUP_KEEP_DAYS * DAY_MS) {
        fs.rmSync(full, { force: true });
      }
    }
    images.cleanupUploads(DAY_MS);
  } catch (error) {
    app.log.error(error, "バックアップに失敗しました");
  }
}

/** 履歴の CSV を書き出す。失敗の内容が変わったときだけログに出す（Excel で開きっぱなしの場合に毎時同じ警告を出さない） */
let lastExportFailures = "";
function exportLogs(): void {
  try {
    const status = logExporter.run();
    const failures = status.failures.map((f) => `${f.file}: ${f.reason}`).join("\n");
    if (failures && failures !== lastExportFailures) app.log.warn(`履歴CSVを書き出せませんでした\n${failures}`);
    lastExportFailures = failures;
  } catch (error) {
    app.log.error(error, "履歴CSVの書き出しに失敗しました");
  }
}

function hourly(): void {
  dailyBackup();
  exportLogs();
}

hourly();
const timer = setInterval(hourly, 60 * 60 * 1000); // 1時間ごとに確認（バックアップは日付が変わったら作成）
timer.unref();

/** 在庫警告メール：1分ごとに送信時刻を過ぎたか確認する */
const mailTimer = setInterval(() => {
  mail.tick().catch((error) => app.log.error(error, "在庫警告メールの確認に失敗しました"));
}, 60 * 1000);
mailTimer.unref();

async function shutdown(signal: string) {
  console.log(`${signal} を受信。終了します`);
  clearInterval(timer);
  clearInterval(mailTimer);
  exportLogs(); // 終了前の操作も CSV に含める
  try {
    await app.close();
  } finally {
    db.close();
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: "0.0.0.0", port });
  const urls = [`http://localhost:${port}`, ...lanAddresses().map((ip) => `http://${ip}:${port}`)];
  console.log("\n========================================");
  console.log(` 在庫管理 を起動しました（バージョン ${APP_VERSION}）${isDemo ? " 【デモ環境】" : ""}`);
  console.log(" ブラウザ・スマホから次のアドレスを開いてください:");
  for (const url of urls) console.log(`   ${url}`);
  console.log(` データの保存先: ${dataDir}`);
  console.log(` 履歴のCSV（1時間ごとに更新）: ${path.join(dataDir, "logs")}`);
  console.log(` 受注番号リスト: ${orderListFile}（${orderList.list().status.exists ? `${orderList.list().status.count}件` : "ファイルなし"}）`);
  console.log(" 終了するには Ctrl+C を押してください");
  console.log("========================================\n");
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    code === "EADDRINUSE"
      ? `ポート ${port} は他のプログラムが使用中です。既に起動していないか確認するか、ZAIKO_PORT で別のポートを指定してください。`
      : `起動できませんでした: ${(error as Error).message}`,
  );
  db.close();
  process.exit(1);
}
