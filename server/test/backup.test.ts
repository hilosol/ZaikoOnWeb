import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BackupService, describeFsError, normalizeBackupDir, selectBackupsToDelete, type RetentionPolicy } from "../src/backup.js";
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
  const daily = (x: RetentionPolicy["daily"]): RetentionPolicy => ({ daily: x, monthlyEnabled: false, monthlyDay: 0, monthly: "12m" });
  const monthly = (day: number, m: RetentionPolicy["monthly"], dailyRetention: RetentionPolicy["daily"] = "30d"): RetentionPolicy => ({
    daily: dailyRetention,
    monthlyEnabled: true,
    monthlyDay: day,
    monthly: m,
  });
  const kept = (all: string[], policy: RetentionPolicy) => {
    const del = new Set(selectBackupsToDelete(all, today, policy));
    return all.filter((x) => !del.has(x));
  };

  it("毎日の分 30日：今日を含めて30日分を残す（境界）", () => {
    const all = days(d(2026, 10, 1), 38); // 10/1〜11/7
    expect(selectBackupsToDelete(all, today, daily("30d"))).toEqual(days(d(2026, 10, 1), 8)); // 10/1〜10/8 を削除
  });
  it("毎日の分 7日・90日・1年・無制限", () => {
    const all = days(d(2025, 1, 1), 676); // 2025/1/1〜2026/11/7
    expect(kept(all, daily("7d"))).toHaveLength(7);
    expect(kept(all, daily("90d"))).toHaveLength(90);
    expect(kept(all, daily("1y"))).toHaveLength(365);
    expect(selectBackupsToDelete(all, today, daily("unlimited"))).toEqual([]);
  });

  it("月1回の分（1日・12か月）：今月を含めて12か月分の1日を残す", () => {
    const all = days(d(2024, 1, 1), 1042); // 2024/1/1〜2026/11/7
    const k = kept(all, monthly(1, "12m", "7d"));
    const monthlyKept = k.filter((x) => x < "20261101");
    expect(monthlyKept).toEqual(["20251201", "20260101", "20260201", "20260301", "20260401", "20260501", "20260601", "20260701", "20260801", "20260901", "20261001"]);
    expect(k).toContain("20261101"); // 今月の1日（日次の7日分にも入る）
    expect(k).toHaveLength(11 + 7);
  });

  it("月末：月ごとの最終日（2月はうるう年も）", () => {
    const all = days(d(2027, 12, 1), 120); // 2027/12/1〜2028/3/29
    const del = new Set(selectBackupsToDelete(all, d(2028, 3, 29), monthly(0, "unlimited", "7d")));
    const k = all.filter((x) => !del.has(x));
    // 2027/11 月末(11/30)の分は無い → それ以降で最初の 12/1 が11月分として残る
    expect(k.filter((x) => x < "20280323")).toEqual(["20271201", "20271231", "20280131", "20280229"]);
  });

  it("指定日のバックアップが無い月は、それ以降で最初の分（月末が休みなら翌月1日）", () => {
    const all = ["20260929", "20261001", "20261015", "20261030", "20261031", "20261102"];
    const k = kept(all, monthly(0, "unlimited", "7d"));
    // 8月末の分が無い → 9/29（8月分）、9月末(9/30)が無い → 10/1（9月分）、10月末 → 10/31、日次7日分 → 11/2
    expect(k).toEqual(["20260929", "20261001", "20261031", "20261102"]);
    expect(kept(["20261016", "20261020"], monthly(15, "unlimited", "7d"))).toEqual(["20261016"]); // 10/15 が無い → 10/16
  });

  it("月1回の分の期間（24か月・36か月・無制限）と、指定日がまだ来ていない今月", () => {
    const all = days(d(2022, 1, 1), 1772); // 2022/1/1〜2026/11/7
    const monthOnly = (p: RetentionPolicy) => kept(all, { ...p, daily: "7d" }).filter((x) => x < "20261031");
    expect(monthOnly(monthly(28, "24m"))).toHaveLength(23); // 今月の28日はまだ（10月〜前年12月の23か月分）
    expect(monthOnly(monthly(28, "36m"))).toHaveLength(35);
    expect(monthOnly(monthly(1, "unlimited"))[0]).toBe("20220101");
  });

  it("月1回をオフにすると毎日の分だけ", () => {
    expect(kept(days(d(2025, 1, 1), 676), { ...monthly(1, "unlimited"), monthlyEnabled: false })).toHaveLength(30);
  });

  it("バックアップが無ければ何も消さない", () => {
    expect(selectBackupsToDelete([], today, monthly(1, "unlimited"))).toEqual([]);
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
    expect(v1.settings).toMatchObject({ daily: "30d", monthlyEnabled: false });
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
    service.saveSettings({ daily: "7d" }, f.actor);
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
    service.saveSettings({ daily: "unlimited", monthlyEnabled: true, monthlyDay: 0, monthly: "24m", extraDir: path.join(extraRoot, "b") }, f.actor);
    const log = f.db.prepare("SELECT detail FROM audit_logs WHERE action = 'SETTINGS_CHANGE' ORDER BY id DESC").get() as { detail: string };
    expect(log.detail).toContain("毎日の分: 30日分 → 無制限");
    expect(log.detail).toContain("月1回の分: 残さない → 月末の分を24か月");
    expect(log.detail).toContain("追加の保存先");
    expect(() => service.saveSettings({ daily: "forever" }, f.actor)).toThrow(/毎日の分を残す期間/);
    expect(() => service.saveSettings({ monthlyDay: 29 }, f.actor)).toThrow(/1〜28日 または 月末/);
    expect(() => service.saveSettings({ monthlyDay: 1.5 }, f.actor)).toThrow(/1〜28日/);
    expect(() => service.saveSettings({ monthly: "6m" }, f.actor)).toThrow(/月1回の分を残す期間/);
    expect(() => service.saveSettings({ monthlyEnabled: "yes" }, f.actor)).toThrow(/月1回の分を残すかどうか/);
    expect(() => service.saveSettings({ extraDir: "\\\\nas\\x" }, f.actor)).toThrow(/ネットワーク/);
    expect(service.settings()).toEqual({ daily: "unlimited", monthlyEnabled: true, monthlyDay: 0, monthly: "24m", extraDir: path.join(extraRoot, "b") });
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
    store.set("backup", { daily: "???", monthlyEnabled: "x", monthlyDay: 99, monthly: 1, extraDir: 5 });
    expect(service.settings()).toEqual({ daily: "30d", monthlyEnabled: false, monthlyDay: 0, monthly: "12m", extraDir: "" });
  });

  it("以前の形式（retention）の設定を読み替える", () => {
    store.set("backup", { retention: "generations", extraDir: "" });
    expect(service.settings()).toMatchObject({ daily: "30d", monthlyEnabled: true, monthlyDay: 1, monthly: "unlimited" });
    store.set("backup", { retention: "90d", extraDir: "" });
    expect(service.settings()).toMatchObject({ daily: "90d", monthlyEnabled: false });
  });

  it("API：取得・設定（保存先を変えたらすぐコピー）・テスト・今すぐ実行", async () => {
    const app = buildApp({ service: f.service, images: f.images, backup: service, isAllowedAddress: () => true });
    try {
      expect((await app.inject({ method: "GET", url: "/api/backup" })).json()).toMatchObject({ settings: { daily: "30d", extraDir: "" } });
      const extra = path.join(extraRoot, "api");
      const saved = await app.inject({ method: "PUT", url: "/api/backup/settings", payload: { extraDir: extra, userName: "山田" } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().extra).toMatchObject({ dir: extra, lastOk: true });
      expect((await app.inject({ method: "POST", url: "/api/backup/test", payload: { extraDir: extra } })).json()).toMatchObject({ ok: true });
      expect((await app.inject({ method: "PUT", url: "/api/backup/settings", payload: { daily: "x" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/backup/run", payload: {} })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
