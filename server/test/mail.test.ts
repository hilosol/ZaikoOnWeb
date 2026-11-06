import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rules } from "../../shared/types.js";
import { buildApp } from "../src/app.js";
import { ExternalServiceError, ValidationError } from "../src/errors.js";
import { buildLowStockDigest } from "../src/mail/lowStockDigest.js";
import { describeMailError, type Mailer, type MailMessage } from "../src/mail/mailer.js";
import { DEFAULT_MAIL_SETTINGS, normalizeMailSettings, normalizeTime, parseRecipients, type StoredMailSettings } from "../src/mail/mailSettings.js";
import { MailNotifier } from "../src/mail/notifier.js";
import { SettingsStore } from "../src/settingsStore.js";
import { createFixture, type Fixture } from "./helpers.js";

class FakeMailer implements Mailer {
  sent: { settings: StoredMailSettings; message: MailMessage }[] = [];
  failWith: unknown = null;
  async send(settings: StoredMailSettings, message: MailMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push({ settings, message });
  }
}

let f: Fixture;
let mailer: FakeMailer;
let notifier: MailNotifier;

const valid = {
  enabled: true,
  host: "mail.hisol.jp",
  port: 25,
  security: "none",
  allowSelfSignedCert: false,
  authUser: "",
  from: "prober-zaiko@hisol.jp",
  to: "machida@hisol.jp",
  sendTime: "08:00",
  siteUrl: "",
  userName: "山田",
};

beforeEach(() => {
  f = createFixture();
  mailer = new FakeMailer();
  notifier = new MailNotifier({
    store: new SettingsStore(f.db),
    inventory: f.service,
    mailer,
    clock: f.clock,
    defaultSiteUrl: () => "http://192.168.1.5:8080",
    version: "2026.11.04 09:00",
  });
});
afterEach(() => f.cleanup());

const details = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).details ?? [];
  }
  throw new Error("ValidationError が発生しませんでした");
};

const addLowStock = () =>
  f.service.registerProduct(
    { code: "AP-00001", name: "りんご", category: "", location: "上段A-1", warningStock: 3, initialStock: 1, suppliers: [{ name: "モノタロウ", url: "https://www.monotaro.com/" }] },
    { action: "keep" },
    f.actor,
  );

describe("メール設定の入力チェック", () => {
  it("宛先は改行・カンマ・全角読点区切りを受け付け、重複を除く", () => {
    expect(parseRecipients("a@x.jp, b@x.jp\nA@x.jp；c@x.jp、")).toEqual(["a@x.jp", "b@x.jp", "c@x.jp"]);
    expect(parseRecipients(["a@x.jp", " ", "a@x.jp"])).toEqual(["a@x.jp"]);
  });

  it("時刻は 8:00・全角も受け付け、範囲外は拒否", () => {
    expect(normalizeTime("8:00")).toBe("08:00");
    expect(normalizeTime("０８：３０")).toBe("08:30");
    expect(normalizeTime("23:59")).toBe("23:59");
    expect(normalizeTime("24:00")).toBeNull();
    expect(normalizeTime("8時")).toBeNull();
  });

  it("有効にする場合はサーバー・送信元・宛先が必須", () => {
    const errs = details(() => normalizeMailSettings({ ...valid, host: "", from: "", to: "" }, DEFAULT_MAIL_SETTINGS));
    expect(errs).toHaveLength(3);
  });

  it("無効なら途中まで入力した状態で保存できる", () => {
    const s = normalizeMailSettings({ ...valid, enabled: false, host: "", to: "" }, DEFAULT_MAIL_SETTINGS);
    expect(s.enabled).toBe(false);
  });

  it.each([
    ["host", "mail server"],
    ["host", "-bad.example"],
    ["port", 0],
    ["port", 65536],
    ["port", 25.5],
    ["security", "tls"],
    ["from", "prober-zaiko@hisol.jp\r\nBcc: x@evil.example"],
    ["from", "名前 <a@x.jp>"],
    ["to", "machida@hisol"],
    ["sendTime", "25:00"],
    ["siteUrl", "javascript:alert(1)"],
    ["siteUrl", "http://192.168.1.5:8080/path"],
  ])("不正な値を拒否する: %s = %s", (key, value) => {
    expect(details(() => normalizeMailSettings({ ...valid, [key]: value }, DEFAULT_MAIL_SETTINGS))).toHaveLength(1);
  });

  it("ポートは文字列（全角）でも受け付ける。IP アドレスのサーバーも可", () => {
    const s = normalizeMailSettings({ ...valid, host: "192.168.1.20", port: "５８７" }, DEFAULT_MAIL_SETTINGS);
    expect(s).toMatchObject({ host: "192.168.1.20", port: 587 });
  });

  it("宛先の上限（境界値）", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `u${i}@x.jp`);
    expect(normalizeMailSettings({ ...valid, to: list(Rules.maxMailRecipients) }, DEFAULT_MAIL_SETTINGS).to).toHaveLength(Rules.maxMailRecipients);
    expect(details(() => normalizeMailSettings({ ...valid, to: list(Rules.maxMailRecipients + 1) }, DEFAULT_MAIL_SETTINGS))).toHaveLength(1);
  });

  it("パスワード：空欄なら保存済みを使い、clearPassword で消す。認証ユーザーなしなら持たない", () => {
    const cur = { ...DEFAULT_MAIL_SETTINGS, authUser: "u", password: "secret" };
    expect(normalizeMailSettings({ ...valid, authUser: "u", password: "" }, cur).password).toBe("secret");
    expect(normalizeMailSettings({ ...valid, authUser: "u", password: "new" }, cur).password).toBe("new");
    expect(normalizeMailSettings({ ...valid, authUser: "u", clearPassword: true }, cur).password).toBe("");
    expect(normalizeMailSettings({ ...valid, authUser: "", password: "x" }, cur).password).toBe("");
  });
});

describe("メール設定の保存", () => {
  it("パスワードは画面に返さず、設定済みかどうかだけ返す。監査ログに残す（パスワードは書かない）", () => {
    const res = notifier.save({ ...valid, authUser: "prober", password: "p@ss" }, f.actor);
    expect(res.settings).not.toHaveProperty("password");
    expect(res.settings.hasPassword).toBe(true);
    expect(res.settings.to).toEqual(["machida@hisol.jp"]);
    expect(res.defaultSiteUrl).toBe("http://192.168.1.5:8080");
    const log = f.service.auditLogs(1)[0]!;
    expect(log.action).toBe("SETTINGS_CHANGE");
    expect(log.detail).toContain("パスワードを変更");
    expect(log.detail).not.toContain("p@ss");
  });

  it("未登録の入力者は保存できない", () => {
    expect(() => notifier.save(valid, { userName: "", clientIp: "192.168.1.9" })).toThrow();
  });
});

describe("テスト送信・手動送信", () => {
  it("保存前の画面の値でテスト送信できる", async () => {
    const r = await notifier.sendTest(valid, f.actor);
    expect(r.sent).toBe(true);
    expect(mailer.sent[0]!.settings.host).toBe("mail.hisol.jp");
    expect(mailer.sent[0]!.message.subject).toContain("テスト");
    expect(notifier.status()).toMatchObject({ lastKind: "test", lastOk: true });
    // 毎日の送信済み扱いにはしない
    expect(notifier.status().dailyDoneDate).toBeNull();
  });

  it("送信に失敗したら 502 相当のエラーと、原因の手がかりを記録する", async () => {
    mailer.failWith = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    await expect(notifier.sendTest(valid, f.actor)).rejects.toBeInstanceOf(ExternalServiceError);
    expect(notifier.status()).toMatchObject({ lastKind: "test", lastOk: false });
    expect(notifier.status().lastMessage).toMatch(/接続を拒否.*ECONNREFUSED/);
  });

  it("手動送信：警告の商品が無ければ送らない、あれば送る", async () => {
    notifier.save(valid, f.actor);
    expect((await notifier.sendNow(f.actor)).sent).toBe(false);
    addLowStock();
    expect((await notifier.sendNow(f.actor)).sent).toBe(true);
    expect(mailer.sent).toHaveLength(1);
  });

  it("手動送信は設定が不足していればエラー", async () => {
    await expect(notifier.sendNow(f.actor)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("毎日の自動送信", () => {
  const at = (h: number, m: number, day = 2) => {
    f.clock.current = new Date(2026, 10, day, h, m, 0);
  };

  beforeEach(() => {
    notifier.save(valid, f.actor);
    addLowStock();
  });

  it("送信時刻の前は送らず、過ぎたら1日1回だけ送る", async () => {
    at(7, 59);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(0);
    at(8, 0);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(1);
    at(8, 1);
    await notifier.tick();
    at(17, 0);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(1);
    expect(notifier.status()).toMatchObject({ dailyDoneDate: "2026-11-02", lastKind: "daily", lastOk: true });
    // 翌日はまた送る
    at(8, 0, 3);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(2);
  });

  it("PC の起動が送信時刻より遅くても、その日の分は送る", async () => {
    at(13, 30);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(1);
  });

  it("無効にしていれば送らない", async () => {
    notifier.save({ ...valid, enabled: false }, f.actor);
    at(9, 0);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(0);
  });

  it("警告の商品が無ければ送らず、その日は済み扱い", async () => {
    const p = f.service.findByCode("AP-00001")!;
    f.service.changeStock(p.id, "IN", 10, f.actor);
    at(8, 0);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(0);
    expect(notifier.status()).toMatchObject({ dailyDoneDate: "2026-11-02", lastOk: true });
  });

  it("失敗したら30分ごとに再試行し、3回失敗したらその日はやめる", async () => {
    mailer.failWith = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    at(8, 0);
    await notifier.tick(); // 1回目
    at(8, 10);
    await notifier.tick(); // 待機中
    at(8, 30);
    await notifier.tick(); // 2回目
    at(9, 0);
    await notifier.tick(); // 3回目 → 中止
    expect(notifier.status().dailyDoneDate).toBe("2026-11-02");
    expect(notifier.status().lastMessage).toMatch(/3回失敗/);
    mailer.failWith = null;
    at(10, 0);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(0);
  });

  it("再試行中に成功すればその日は済み", async () => {
    mailer.failWith = Object.assign(new Error("x"), { code: "ECONNECTION" });
    at(8, 0);
    await notifier.tick();
    mailer.failWith = null;
    at(8, 30);
    await notifier.tick();
    expect(mailer.sent).toHaveLength(1);
    expect(notifier.status()).toMatchObject({ dailyDoneDate: "2026-11-02", lastOk: true });
  });
});

describe("メール本文", () => {
  it("商品・在庫・場所・購入元・スマホ画面へのリンクを含む", () => {
    const p = addLowStock();
    const m = buildLowStockDigest([p], new Date(2026, 10, 4, 8, 0), "http://192.168.1.5:8080", "v");
    expect(m.subject).toBe("【在庫管理】在庫警告 1件（2026/11/04）");
    expect(m.text).toContain("■ AP-00001  りんご");
    expect(m.text).toContain("在庫 1 ／ 警告 3");
    expect(m.text).toContain("場所: 上段A-1");
    expect(m.text).toContain("購入元: モノタロウ  https://www.monotaro.com/");
    expect(m.text).toContain("http://192.168.1.5:8080/m?id=AP-00001");
  });

  it("送信エラーの説明", () => {
    expect(describeMailError({ code: "EAUTH", responseCode: 535 })).toMatch(/認証に失敗/);
    expect(describeMailError({ code: "ESOCKET", message: "self-signed certificate" })).toMatch(/自己署名証明書/);
    expect(describeMailError({ responseCode: 550, response: "relay denied" })).toMatch(/拒否.*550 relay denied/);
    expect(describeMailError(null)).toBe("メールを送信できませんでした。");
    // nodemailer が接続拒否を ESOCKET として返す場合も、接続の問題として案内する
    expect(describeMailError({ code: "ESOCKET", message: "connect ECONNREFUSED 127.0.0.1:2599" })).toMatch(/接続を拒否/);
  });
});

describe("メール設定の API", () => {
  it("取得・保存・テスト送信（失敗は 502）", async () => {
    const app = buildApp({ service: f.service, images: f.images, mail: notifier });
    try {
      const get = await app.inject({ method: "GET", url: "/api/settings/mail", remoteAddress: "192.168.1.10" });
      expect(get.statusCode).toBe(200);
      expect(get.json().settings.enabled).toBe(false);

      const put = await app.inject({ method: "PUT", url: "/api/settings/mail", payload: valid, remoteAddress: "192.168.1.10" });
      expect(put.statusCode).toBe(200);
      expect(put.json().settings.enabled).toBe(true);

      const bad = await app.inject({ method: "PUT", url: "/api/settings/mail", payload: { ...valid, port: "x" }, remoteAddress: "192.168.1.10" });
      expect(bad.statusCode).toBe(400);

      mailer.failWith = Object.assign(new Error("x"), { code: "ENOTFOUND" });
      const test = await app.inject({ method: "POST", url: "/api/settings/mail/test", payload: valid, remoteAddress: "192.168.1.10" });
      expect(test.statusCode).toBe(502);
      expect(test.json().error).toMatch(/名前が見つかりません/);
    } finally {
      await app.close();
    }
  });
});
