import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { GeneralSettingsService } from "../src/generalSettings.js";
import { SettingsStore } from "../src/settingsStore.js";
import { createFixture, type Fixture } from "./helpers.js";

describe("全体の設定（決算月）", () => {
  let f: Fixture;
  let general: GeneralSettingsService;
  let store: SettingsStore;
  beforeEach(() => {
    f = createFixture();
    store = new SettingsStore(f.db);
    general = new GeneralSettingsService(store, f.service);
  });
  afterEach(() => f.cleanup());

  const auditCount = () => (f.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'SETTINGS_CHANGE'").get() as { n: number }).n;

  it("未保存なら既定の3月決算", () => {
    expect(general.get()).toEqual({ fiscalYearEndMonth: 3 });
  });

  it("保存して読み直せる。変わったときだけ監査ログに残す", () => {
    expect(general.save({ fiscalYearEndMonth: 12 }, f.actor)).toEqual({ fiscalYearEndMonth: 12 });
    expect(new GeneralSettingsService(store, f.service).get()).toEqual({ fiscalYearEndMonth: 12 });
    expect(auditCount()).toBe(1);
    general.save({ fiscalYearEndMonth: 12 }, f.actor);
    general.save({}, f.actor); // 省略した項目は変えない
    expect(general.get()).toEqual({ fiscalYearEndMonth: 12 });
    expect(auditCount()).toBe(1);
  });

  it.each([1, 12])("境界値 %i 月は保存できる", (m) => {
    expect(general.save({ fiscalYearEndMonth: m }, f.actor).fiscalYearEndMonth).toBe(m);
  });

  it.each([0, 13, 3.5, -1, "3", null, true, Number.NaN])("1〜12 の整数以外は拒否し、値は変えない: %o", (v) => {
    expect(() => general.save({ fiscalYearEndMonth: v }, f.actor)).toThrow(/決算月は 1〜12/);
    expect(general.get()).toEqual({ fiscalYearEndMonth: 3 });
  });

  it("入力者が無いと保存できない", () => {
    expect(() => general.save({ fiscalYearEndMonth: 12 }, { ...f.actor, userName: "" })).toThrow();
    expect(general.get()).toEqual({ fiscalYearEndMonth: 3 });
  });

  it("保存済みの値が壊れていたら既定値で補う", () => {
    store.set("general", { fiscalYearEndMonth: 99 });
    expect(general.get()).toEqual({ fiscalYearEndMonth: 3 });
    store.set("general", "broken");
    expect(general.get()).toEqual({ fiscalYearEndMonth: 3 });
  });

  it("API：取得・保存（不正な値は 400）", async () => {
    const app = buildApp({ service: f.service, images: f.images, general, isAllowedAddress: () => true });
    try {
      expect((await app.inject({ method: "GET", url: "/api/settings/general" })).json()).toEqual({ fiscalYearEndMonth: 3 });
      const ok = await app.inject({ method: "PUT", url: "/api/settings/general", payload: { fiscalYearEndMonth: 9, userName: "山田" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ fiscalYearEndMonth: 9 });
      const bad = await app.inject({ method: "PUT", url: "/api/settings/general", payload: { fiscalYearEndMonth: 13, userName: "山田" } });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("API：設定サービスが無い場合は既定値を返す", async () => {
    const app = buildApp({ service: f.service, images: f.images, isAllowedAddress: () => true });
    try {
      expect((await app.inject({ method: "GET", url: "/api/settings/general" })).json()).toEqual({ fiscalYearEndMonth: 3 });
    } finally {
      await app.close();
    }
  });
});
