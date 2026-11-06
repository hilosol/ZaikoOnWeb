import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BackupService, describeFsError, normalizeBackupDir, selectBackupsToDelete } from "../src/backup.js";
import { backupDatabase } from "../src/db.js";
import { SettingsStore } from "../src/settingsStore.js";
import { createFixture, type Fixture } from "./helpers.js";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 9, 0, 0);
/** start から n 日分の YYYYMMDD */
function days(start: Date, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
  });
}

describe("残す期間の規則", () => {
  const today = d(2026, 11, 7);
  it("30日分：今日を含めて30日分を残す（境界）", () => {
    const all = days(d(2026, 10, 1), 38); // 10/1〜11/7
    const del = selectBackupsToDelete(all, today, "30d");
    expect(del).toEqual(days(d(2026, 10, 1), 8)); // 10/1〜10/8 を削除、10/9〜11/7 の30日分を残す
  });
  it("7日分・90日分・1年分", () => {
    const all = days(d(2025, 1, 1), 676); // 2025/1/1〜2026/11/7
    expect(all.length - selectBackupsToDelete(all, today, "7d").length).toBe(7);
    expect(all.length - selectBackupsToDelete(all, today, "90d").length).toBe(90);
    expect(all.length - selectBackupsToDelete(all, today, "1y").length).toBe(365);
  });
  it("無制限は消さない", () => {
    expect(selectBackupsToDelete(days(d(2020, 1, 1), 2000), today, "unlimited")).toEqual([]);
  });
  it("世代管理：直近30日は毎日、1年以内は各月の最初、それより前は各年の最初", () => {
    const all = days(d(2024, 3, 15), 968); // 2024/3/15〜2026/11/7
    const del = new Set(selectBackupsToDelete(all, today, "generations"));
    const kept = all.filter((x) => !del.has(x));
    expect(kept.filter((x) => x >= "20261009")).toHaveLength(30); // 直近30日
    expect(kept).toContain("20260101"); // 1年以内の月初
    expect(kept).toContain("20251201");
    expect(kept).not.toContain("20251202");
    expect(kept).toContain("20240315"); // 2024年の最初の分（年の途中から始まっていても残す）
    expect(kept).toContain("20250101");
    expect(kept).not.toContain("20240401"); // 1年より前の月初は残さない
    expect(kept.length).toBeLessThan(50);
  });
  it("抜けている日があっても、その月・年に残っている最初の分を残す", () => {
    // 1年以内：各月の最初（1/5・2/10）を残す。1年より前：その年の最初（2024/6/3）だけ残す
    const del = selectBackupsToDelete(["20240603", "20240704", "20260105", "20260210", "20260211"], today, "generations");
    expect(del).toEqual(["20240704", "20260211"]);
  });
});

describe("追加の保存先の確認", () => {
  const dataDir = path.resolve("/srv/zaiko/data");
  it.each([
    ["", ""],
    ["  ", ""],
    [null, ""],
    ["/mnt/usb/zaiko/", "/mnt/usb/zaiko"],
    ['"/mnt/usb/zaiko"', "/mnt/usb/zaiko"],
  ])("%o → %o", (raw, expected) => {
    expect(normalizeBackupDir(raw, dataDir)).toBe(expected);
  });
  it.each([
    ["\\\\nas\\share\\zaiko", /ネットワークの場所/],
    ["//nas/share", /ネットワークの場所/],
    ["zaiko-backup", /ドライブ名から始まる/],
    ["/srv/zaiko/data/backup2", /data フォルダの中/],
    ["/srv/zaiko/data", /data フォルダの中/],
    ["/" + "x".repeat(201), /200文字以内/],
    [123, /フォルダの場所/],
  ])("拒否: %s", (raw, message) => {
    expect(() => normalizeBackupDir(raw, dataDir)).toThrow(message);
  });
  it("Windows のドライブ名だけ（E:）は拒否", () => {
    expect(() => normalizeBackupDir("E:", dataDir, path.win32.isAbsolute)).toThrow(/ドライブ名から始まる/);
    expect(normalizeBackupDir("E:\\zaiko-backup\\", "C:\\zaiko\\data", path.win32.isAbsolute)).toBe("E:\\zaiko-backup");
  });
  it("ファイル操作のエラーを日本語に", () => {
    expect(describeFsError({ code: "ENOENT" })).toMatch(/接続されているか/);
    expect(describeFsError({ code: "EPERM" })).toMatch(/許可されていません/);
    expect(describeFsError({ code: "ENOSPC" })).toMatch(/空き容量/);
  });
});

describe("バックアップの実行", () => {
  let f: Fixture;
  let extraRoot: string;
  let service: BackupService;
  let store: SettingsStore;
  const dataDir = () => f.dir;
  const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

  beforeEach(() => {
    f = createFixture();
    extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zaiko-extra-"));
    store = new SettingsStore(f.db);
    service = new BackupService({ dataDir: dataDir(), store, clock: f.clock, auditor: f.service, backupDatabase: (dest) => backupDatabase(f.db, dest) });
  });
  afterEach(() => {
    f.cleanup();
    fs.rmSync(extraRoot, { recursive: true, force: true });
  });

  it("サーバーPC内に1日1回作る（同じ日は作り直さない）。既定は30日分", () => {
    const v1 = service.run();
    expect(list(path.join(dataDir(), "backup"))).toEqual(["zaiko_20261102.db"]);
    expect(v1.settings.retention).toBe("30d");
    expect(v1.local).toMatchObject({ lastOk: true, count: 1 });
    expect(v1.local.totalBytes).toBeGreaterThan(0);
    const mtime = fs.statSync(path.join(dataDir(), "backup", "zaiko_20261102.db")).mtimeMs;
    f.clock.advance(60);
    service.run();
    expect(fs.statSync(path.join(dataDir(), "backup", "zaiko_20261102.db")).mtimeMs).toBe(mtime);
    expect(v1.extra).toBeNull();
  });

  it("古い分は設定に従って消す。アップグレード前のバックアップなど他のファイルは消さない", () => {
    const dir = path.join(dataDir(), "backup");
    fs.mkdirSync(dir, { recursive: true });
    for (const x of days(d(2026, 10, 20), 13)) fs.writeFileSync(path.join(dir, `zaiko_${x}.db`), "x");
    fs.writeFileSync(path.join(dir, "zaiko_before_upgrade_v11_1.db"), "x");
    service.saveSettings({ retention: "7d" }, f.actor);
    service.run();
    expect(list(dir)).toEqual([...days(d(2026, 10, 27), 7).map((x) => `zaiko_${x}.db`), "zaiko_before_upgrade_v11_1.db"].sort());
  });

  it("追加の保存先：DB と写真をコピーし、写真は増えた・変わった分だけ。消えた写真は残す", () => {
    const extra = path.join(extraRoot, "zaiko-backup");
    const imgDir = path.join(dataDir(), "images");
    fs.writeFileSync(path.join(imgDir, "a.jpg"), "AAA");
    fs.writeFileSync(path.join(imgDir, "b.jpg"), "BBB");
    const v = service.saveSettings({ extraDir: extra }, f.actor);
    expect(v.extra).toMatchObject({ dir: extra, lastOk: null });
    const r1 = service.run();
    expect(r1.extra).toMatchObject({ lastOk: true, count: 1 });
    expect(r1.extra!.lastMessage).toContain("写真 2 枚");
    expect(list(path.join(extra, "db"))).toEqual(["zaiko_20261102.db"]);
    expect(list(path.join(extra, "images"))).toEqual(["a.jpg", "b.jpg"]);

    const r2 = service.run();
    expect(r2.extra!.lastMessage).toBe("保存しました（追加分なし）");

    fs.rmSync(path.join(imgDir, "a.jpg"));
    fs.writeFileSync(path.join(imgDir, "b.jpg"), "BBBB"); // 大きさが変わった
    const later = new Date(Date.now() + 10_000);
    fs.writeFileSync(path.join(imgDir, "d.jpg"), "DDD");
    fs.copyFileSync(path.join(imgDir, "d.jpg"), path.join(extra, "images", "d.jpg"));
    fs.utimesSync(path.join(imgDir, "d.jpg"), later, later); // 同じ大きさで、2秒以上新しい
    fs.writeFileSync(path.join(imgDir, "c.jpg"), "C");
    expect(service.run().extra!.lastMessage).toContain("写真 3 枚");
    expect(list(path.join(extra, "images"))).toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
    expect(fs.readFileSync(path.join(extra, "images", "b.jpg"), "utf8")).toBe("BBBB");
    expect(list(path.join(extra, "db")).some((x) => x.endsWith(".tmp"))).toBe(false);
  });

  it("追加の保存先：書けなかった日の分も、書けるようになったらまとめてコピーする", () => {
    const drive = path.join(extraRoot, "drive");
    fs.writeFileSync(drive, "x"); // ドライブが使えない状態の代わり（ファイルの下にはフォルダを作れない）
    service.saveSettings({ extraDir: path.join(drive, "zaiko") }, f.actor);
    expect(service.run().extra!.lastOk).toBe(false);
    fs.rmSync(drive); // 挿し直した
    f.clock.advance(24 * 60);
    const v = service.run();
    expect(v.extra).toMatchObject({ lastOk: true, count: 2 });
    expect(list(path.join(drive, "zaiko", "db"))).toEqual(["zaiko_20261102.db", "zaiko_20261103.db"]);
  });

  it("追加の保存先に書けないときは失敗を記録し、サーバーPC内のバックアップは続ける", () => {
    const blocker = path.join(extraRoot, "file");
    fs.writeFileSync(blocker, "x"); // ファイルの下にフォルダは作れない
    service.saveSettings({ extraDir: path.join(blocker, "zaiko") }, f.actor);
    const v = service.run();
    expect(v.local.lastOk).toBe(true);
    expect(v.extra).toMatchObject({ lastOk: false, lastSuccessAt: null });
    expect(v.extra!.lastMessage).toMatch(/保存先/);
  });

  it("設定の変更は操作ログに残す。不正な値は拒否", () => {
    service.saveSettings({ retention: "unlimited", extraDir: path.join(extraRoot, "b") }, f.actor);
    const log = f.db.prepare("SELECT detail FROM audit_logs WHERE action = 'SETTINGS_CHANGE' ORDER BY id DESC").get() as { detail: string };
    expect(log.detail).toContain("無制限");
    expect(log.detail).toContain("追加の保存先");
    expect(() => service.saveSettings({ retention: "forever" }, f.actor)).toThrow(/残す期間/);
    expect(() => service.saveSettings({ extraDir: "\\\\nas\\x" }, f.actor)).toThrow(/ネットワーク/);
    expect(service.settings()).toEqual({ retention: "unlimited", extraDir: path.join(extraRoot, "b") });
  });

  it("書き込みテスト：書ければ ok、書けなければ理由。テスト用のファイルは残さない", () => {
    const dir = path.join(extraRoot, "t");
    expect(service.testDir(dir)).toMatchObject({ ok: true });
    expect(list(dir)).toEqual([]);
    const blocker = path.join(extraRoot, "file");
    fs.writeFileSync(blocker, "x");
    expect(service.testDir(path.join(blocker, "x")).ok).toBe(false);
    expect(() => service.testDir("")).toThrow(/保存先を入力/);
  });

  it("保存された設定が壊れていたら既定値", () => {
    store.set("backup", { retention: "???", extraDir: 5 });
    expect(service.settings()).toEqual({ retention: "30d", extraDir: "" });
  });

  it("API：取得・設定（保存先を変えたらすぐコピー）・テスト・今すぐ実行", async () => {
    const app = buildApp({ service: f.service, images: f.images, backup: service, isAllowedAddress: () => true });
    try {
      expect((await app.inject({ method: "GET", url: "/api/backup" })).json()).toMatchObject({ settings: { retention: "30d", extraDir: "" } });
      const extra = path.join(extraRoot, "api");
      const saved = await app.inject({ method: "PUT", url: "/api/backup/settings", payload: { extraDir: extra, userName: "山田" } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().extra).toMatchObject({ dir: extra, lastOk: true });
      expect((await app.inject({ method: "POST", url: "/api/backup/test", payload: { extraDir: extra } })).json()).toMatchObject({ ok: true });
      expect((await app.inject({ method: "PUT", url: "/api/backup/settings", payload: { retention: "x" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/backup/run", payload: {} })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
