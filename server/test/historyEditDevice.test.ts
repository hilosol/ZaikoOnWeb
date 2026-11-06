import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rules } from "../../shared/types.js";
import { buildApp } from "../src/app.js";
import { deviceLabel } from "../src/devices.js";
import { createFixture, type Fixture } from "./helpers.js";

let f: Fixture;
let pid: number;
beforeEach(() => {
  f = createFixture();
  pid = f.service.registerProduct({ code: "A001", name: "りんご", category: "", warningStock: 0, initialStock: 10 }, { action: "keep" }, f.actor).id;
});
afterEach(() => f.cleanup());

const last = () => f.service.recentHistories(1)[0]!;

describe("履歴の修正", () => {
  it("受注番号・コメント・移管先を直し、項目ごとに修正前→修正後・入力者・IPを記録する", () => {
    f.service.changeStock(pid, "TRANSFER", 2, f.actor, { destination: "製造部", comment: "貸出" });
    const h = last();
    f.clock.advance(10);
    const edited = f.service.editHistory(h.id, { orderNo: "YHO-26002", comment: "", destination: "品証部" }, { userName: "山田", clientIp: "192.168.1.30" });
    expect(edited).toMatchObject({ orderNo: "YHO-26002", comment: null, destination: "品証部", quantity: 2 });
    const edits = f.service.historyEdits(h.id);
    expect(edits.map((e) => [e.field, e.before, e.after])).toEqual(
      expect.arrayContaining([
        ["orderNo", "", "YHO-26002"],
        ["comment", "貸出", ""],
        ["destination", "製造部", "品証部"],
      ]),
    );
    expect(edits[0]).toMatchObject({ userName: "山田", clientIp: "192.168.1.30", createdAt: "2026-11-02 09:10:00" });
  });

  it("変わっていない項目は記録しない", () => {
    f.service.changeStock(pid, "OUT", 1, f.actor, { comment: "修理用" });
    f.service.editHistory(last().id, { comment: " 修理用 " }, f.actor);
    expect(f.service.historyEdits()).toHaveLength(0);
  });

  it("入庫の理由は決まった選択肢だけ。区分に合わない項目は拒否", () => {
    f.service.changeStock(pid, "IN", 1, f.actor, { reason: "購入" });
    const inId = last().id;
    expect(f.service.editHistory(inId, { reason: "戻り" }, f.actor).reason).toBe("戻り");
    expect(() => f.service.editHistory(inId, { reason: "盗難" }, f.actor)).toThrow(/購入・戻り・その他/);
    expect(() => f.service.editHistory(inId, { destination: "x" }, f.actor)).toThrow(/移管の履歴だけ/);
    f.service.changeStock(pid, "OUT", 1, f.actor);
    expect(() => f.service.editHistory(last().id, { reason: "購入" }, f.actor)).toThrow(/入庫の履歴だけ/);
  });

  it("境界値：コメント・移管先の文字数、移管先は空にできない", () => {
    f.service.changeStock(pid, "TRANSFER", 1, f.actor, { destination: "製造部" });
    const id = last().id;
    expect(() => f.service.editHistory(id, { destination: " " }, f.actor)).toThrow(/移管先/);
    expect(() => f.service.editHistory(id, { comment: "x".repeat(Rules.commentMaxLength + 1) }, f.actor)).toThrow(/200文字/);
    expect(f.service.editHistory(id, { comment: "x".repeat(Rules.commentMaxLength) }, f.actor).comment).toHaveLength(Rules.commentMaxLength);
  });

  it("入力者が分からない場合は修正できない", () => {
    f.service.changeStock(pid, "OUT", 1, f.actor);
    expect(() => f.service.editHistory(last().id, { comment: "x" }, { userName: "", clientIp: "192.168.1.99" })).toThrow(/入力者/);
  });

  it("存在しない履歴は 404 相当", () => {
    expect(() => f.service.editHistory(9999, { comment: "x" }, f.actor)).toThrow(/見つかりません/);
  });
});

describe("履歴の取消", () => {
  it("出庫を取り消すと在庫が戻り、取消の履歴（受注番号を引き継ぐ）と取消済の印、修正履歴を残す", () => {
    f.service.changeStock(pid, "OUT", 3, f.actor, { orderNo: "YHO-26002" });
    const out = last();
    const cancel = f.service.cancelHistory(out.id, "数量間違い", f.actor);
    expect(f.service.getProduct(pid).stock).toBe(10);
    expect(cancel).toMatchObject({ type: "CANCEL", quantity: 3, stockAfter: 10, cancelOf: out.id, orderNo: "YHO-26002" });
    expect(cancel.comment).toContain("出庫 3 を取消：数量間違い");
    expect(f.service.getHistory(out.id).canceledBy).toBe(cancel.id);
    expect(f.service.historyEdits(out.id)[0]).toMatchObject({ field: "cancel", after: "数量間違い" });
  });

  it("入庫の取消は在庫を減らす。在庫が足りなければ取り消せない（何も変えない）", () => {
    f.service.changeStock(pid, "IN", 5, f.actor);
    const inId = last().id;
    f.service.changeStock(pid, "OUT", 12, f.actor);
    expect(() => f.service.cancelHistory(inId, "誤入力", f.actor)).toThrow(/在庫が足りない/);
    expect(f.service.getProduct(pid).stock).toBe(3);
    expect(f.service.getHistory(inId).canceledBy).toBeNull();
  });

  it("二重の取消・取消の取消・初期登録の取消・理由なしは拒否", () => {
    f.service.changeStock(pid, "OUT", 1, f.actor);
    const id = last().id;
    expect(() => f.service.cancelHistory(id, " ", f.actor)).toThrow(/理由/);
    const c = f.service.cancelHistory(id, "誤り", f.actor);
    expect(() => f.service.cancelHistory(id, "誤り", f.actor)).toThrow(/既に取り消され/);
    expect(() => f.service.cancelHistory(c.id, "誤り", f.actor)).toThrow(/取消の履歴は取り消せません/);
    const init = f.service.allHistories().find((h) => h.type === "INIT")!;
    expect(() => f.service.cancelHistory(init.id, "誤り", f.actor)).toThrow(/初期登録の履歴は取り消せません/);
    expect(() => f.service.editHistory(c.id, { comment: "x" }, f.actor)).toThrow(/取消の履歴は修正できません/);
  });

  it("商品を削除した後は取り消せない", () => {
    f.service.changeStock(pid, "OUT", 1, f.actor);
    const id = last().id;
    f.service.deleteProduct(pid, undefined, f.actor);
    expect(() => f.service.cancelHistory(id, "誤り", f.actor)).toThrow(/削除されている/);
  });
});

describe("端末ID", () => {
  const dev = "0123456789abcdef0123456789abcdef";
  const phone = { userName: "", clientIp: "192.168.1.23", deviceId: dev };

  it("端末を記録し、紐づけた人として入出庫を記録する（IP が変わっても）", () => {
    f.service.touchDevice(dev, "192.168.1.23", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Version/18.0 Mobile/15E148 Safari/604.1");
    const suzuki = f.service.createUser("鈴木", f.actor);
    f.service.changeStock(pid, "OUT", 1, phone);
    expect(f.service.listDevices()[0]).toMatchObject({ id: dev, label: "iPhone / Safari", unnamedCount: 1, userId: null });
    f.service.linkDevice(dev, suzuki.id, "社用iPhone", f.actor);
    f.service.changeStock(pid, "OUT", 1, { ...phone, clientIp: "192.168.1.77" });
    expect(last()).toMatchObject({ userName: "鈴木", deviceId: dev, clientIp: "192.168.1.77" });
    expect(f.service.auditLogs(1)[0]!.detail).toContain("端末 iPhone / Safari（社用iPhone） を紐づけ");
  });

  it("端末の紐づけは IP の紐づけより優先。解除すると IP の紐づけに戻る", () => {
    f.service.touchDevice(dev, "192.168.1.23", "Android Chrome/120");
    const suzuki = f.service.createUser("鈴木", f.actor);
    const yamadaId = f.service.listUsers().find((u) => u.name === "山田")!.id;
    f.service.linkUserIp(yamadaId, "192.168.1.23", "", false, f.actor);
    f.service.linkDevice(dev, suzuki.id, "", f.actor);
    expect(f.service.linkedUserName(phone)).toEqual({ userName: "鈴木", source: "device" });
    f.service.linkDevice(dev, null, "", f.actor);
    expect(f.service.linkedUserName(phone)).toEqual({ userName: "山田", source: "ip" });
  });

  it("不正な端末ID・存在しない端末・無効な人には紐づけない", () => {
    expect(() => f.service.linkDevice("../etc", null, "", f.actor)).toThrow(/端末の指定/);
    expect(() => f.service.linkDevice(dev, null, "", f.actor)).toThrow(/見つかりません/);
    f.service.touchDevice(dev, "192.168.1.23", "");
    const u = f.service.createUser("退職者", f.actor);
    f.service.updateUser(u.id, { active: false }, f.actor);
    expect(() => f.service.linkDevice(dev, u.id, "", f.actor)).toThrow(/有効な入力者/);
    f.service.touchDevice("not-a-device-id", "192.168.1.23", "");
    expect(f.service.listDevices()).toHaveLength(1);
  });

  it("最終利用日時の更新は5分に1回まで（DB への書き込みを減らす）", () => {
    f.service.touchDevice(dev, "192.168.1.23", "");
    f.clock.advance(3);
    f.service.touchDevice(dev, "192.168.1.24", "");
    expect(f.service.listDevices()[0]!.lastIp).toBe("192.168.1.23");
    f.clock.advance(3);
    f.service.touchDevice(dev, "192.168.1.24", "");
    expect(f.service.listDevices()[0]).toMatchObject({ lastIp: "192.168.1.24", lastSeen: "2026-11-02 09:06:00" });
  });

  it("端末を一覧から削除できる", () => {
    f.service.touchDevice(dev, "192.168.1.23", "");
    f.service.deleteDevice(dev, f.actor);
    expect(f.service.listDevices()).toHaveLength(0);
  });

  it.each([
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", "Android / Chrome"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120", "Windows / Edge"],
    ["", "不明"],
  ])("端末の表示名: %s → %s", (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });

  it("API：Cookie が無ければ端末IDを発行し、あればそれを使う。不正な値は発行し直す", async () => {
    const app = buildApp({ service: f.service, images: f.images });
    try {
      const first = await app.inject({ url: "/api/whoami" });
      const cookie = String(first.headers["set-cookie"]);
      expect(cookie).toMatch(/^zaiko_device=[0-9a-f]{32}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
      const id = /zaiko_device=([0-9a-f]{32})/.exec(cookie)![1];
      expect(first.json().deviceId).toBe(id);
      const again = await app.inject({ url: "/api/whoami", headers: { cookie: `other=1; zaiko_device=${id}` } });
      expect(again.headers["set-cookie"]).toBeUndefined();
      expect(again.json().deviceId).toBe(id);
      const bad = await app.inject({ url: "/api/whoami", headers: { cookie: "zaiko_device=xyz" } });
      expect(String(bad.headers["set-cookie"])).toMatch(/zaiko_device=[0-9a-f]{32}/);
    } finally {
      await app.close();
    }
  });

  it("API：履歴の修正・取消", async () => {
    const app = buildApp({ service: f.service, images: f.images });
    try {
      f.service.changeStock(pid, "OUT", 2, f.actor);
      const id = last().id;
      const patch = await app.inject({ method: "PATCH", url: `/api/histories/${id}`, payload: { orderNo: "X-1", userName: "山田" } });
      expect(patch.json().orderNo).toBe("X-1");
      const detail = (await app.inject({ url: `/api/histories/${id}` })).json();
      expect(detail.edits[0]).toMatchObject({ field: "orderNo", after: "X-1" });
      const cancel = await app.inject({ method: "POST", url: `/api/histories/${id}/cancel`, payload: { reason: "誤り", userName: "山田" } });
      expect(cancel.json()).toMatchObject({ type: "CANCEL", cancelOf: id });
      const again = await app.inject({ method: "POST", url: `/api/histories/${id}/cancel`, payload: { reason: "誤り", userName: "山田" } });
      expect(again.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
