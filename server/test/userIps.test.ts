import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ConflictError, ValidationError } from "../src/errors.js";
import { createFixture, type Fixture } from "./helpers.js";

let f: Fixture;
let suzukiId: number;
beforeEach(() => {
  f = createFixture();
  suzukiId = f.service.createUser("鈴木", f.actor).id;
  f.service.registerProduct({ code: "A001", name: "りんご", category: "", warningStock: 0, initialStock: 10 }, { action: "keep" }, f.actor);
});
afterEach(() => f.cleanup());

const phone = { userName: "", clientIp: "192.168.1.23" };
const productId = () => f.service.findByCode("A001")!.id;

describe("端末の IP と入力者の紐づけ", () => {
  it("紐づけた IP からの名前なしの入出庫は、その人として記録する", () => {
    f.service.linkUserIp(suzukiId, "192.168.1.23", "iPhone", false, f.actor);
    f.service.changeStock(productId(), "OUT", 1, phone);
    expect(f.service.recentHistories(1)[0]).toMatchObject({ userName: "鈴木", clientIp: "192.168.1.23" });
  });

  it("画面で名前を選んだ場合はそちらを優先する", () => {
    f.service.linkUserIp(suzukiId, "192.168.1.23", "", false, f.actor);
    f.service.changeStock(productId(), "OUT", 1, { ...phone, userName: "山田" });
    expect(f.service.recentHistories(1)[0]!.userName).toBe("山田");
  });

  it("紐づけの無い IP は従来どおり名前なし", () => {
    f.service.changeStock(productId(), "OUT", 1, phone);
    expect(f.service.recentHistories(1)[0]!.userName).toBe("");
  });

  it("無効化した人の紐づけは使わない", () => {
    f.service.linkUserIp(suzukiId, "192.168.1.23", "", false, f.actor);
    f.service.updateUser(suzukiId, { active: false }, f.actor);
    f.service.changeStock(productId(), "OUT", 1, phone);
    expect(f.service.recentHistories(1)[0]!.userName).toBe("");
    expect(f.service.userNameForIp("192.168.1.23")).toBe("");
  });

  it("商品の登録・変更も、紐づけた IP なら入力者を選ばずにできる", () => {
    f.service.linkUserIp(suzukiId, "192.168.1.23", "", false, f.actor);
    f.service.registerProduct({ code: "B001", name: "みかん", category: "", warningStock: 0 }, { action: "keep" }, phone);
    expect(f.service.auditLogs(1)[0]).toMatchObject({ action: "PRODUCT_CREATE", userName: "鈴木" });
    expect(() =>
      f.service.registerProduct({ code: "C001", name: "x", category: "", warningStock: 0 }, { action: "keep" }, { userName: "", clientIp: "192.168.1.99" }),
    ).toThrow(/入力者を選択/);
  });

  it("一覧に紐づけた IP とメモを返す（1人に複数可）", () => {
    f.service.linkUserIp(suzukiId, "192.168.1.23", "iPhone", false, f.actor);
    f.service.linkUserIp(suzukiId, "192.168.1.40", "事務所PC", false, f.actor);
    expect(f.service.listUsers().find((u) => u.name === "鈴木")!.ips).toEqual([
      { ip: "192.168.1.23", note: "iPhone" },
      { ip: "192.168.1.40", note: "事務所PC" },
    ]);
  });

  it("別の人に紐づいた IP は、付け替えを指定しない限り拒否する", () => {
    const yamadaId = f.service.listUsers().find((u) => u.name === "山田")!.id;
    f.service.linkUserIp(suzukiId, "192.168.1.23", "", false, f.actor);
    expect(() => f.service.linkUserIp(yamadaId, "192.168.1.23", "", false, f.actor)).toThrow(ConflictError);
    f.service.linkUserIp(yamadaId, "192.168.1.23", "", true, f.actor);
    expect(f.service.userNameForIp("192.168.1.23")).toBe("山田");
    expect(f.service.auditLogs(1)[0]!.detail).toContain("鈴木 から付け替え");
  });

  it.each(["", "abc", "192.168.1.256", "192.168.1", "127.0.0.1", "::1", "::ffff:127.0.0.1"])("不正・共有PC本体の IP は拒否: %s", (ip) => {
    expect(() => f.service.linkUserIp(suzukiId, ip, "", false, f.actor)).toThrow(ValidationError);
  });

  it("IPv4 射影アドレスは IPv4 にそろえる。IPv6 も可", () => {
    f.service.linkUserIp(suzukiId, "::ffff:192.168.1.23", "", false, f.actor);
    expect(f.service.userNameForIp("192.168.1.23")).toBe("鈴木");
    f.service.linkUserIp(suzukiId, "fe80::1", "", false, f.actor);
    expect(f.service.userNameForIp("fe80::1")).toBe("鈴木");
  });

  it("メモの文字数上限", () => {
    expect(() => f.service.linkUserIp(suzukiId, "192.168.1.23", "あ".repeat(31), false, f.actor)).toThrow(/30文字/);
  });

  it("解除すると名前なしに戻り、操作ログに残る", () => {
    f.service.linkUserIp(suzukiId, "192.168.1.23", "", false, f.actor);
    f.service.unlinkUserIp("192.168.1.23", f.actor);
    expect(f.service.userNameForIp("192.168.1.23")).toBe("");
    expect(f.service.auditLogs(1)[0]!.detail).toBe("IP 192.168.1.23 の紐づけを解除");
    expect(() => f.service.unlinkUserIp("192.168.1.23", f.actor)).toThrow(/見つかりません/);
  });

  it("名前なしで記録された IP を紐づけの候補として返す（紐づけ済み・共有PC本体は除く）", () => {
    f.service.changeStock(productId(), "OUT", 1, phone);
    f.service.changeStock(productId(), "OUT", 1, phone);
    f.service.changeStock(productId(), "OUT", 1, { userName: "", clientIp: "192.168.1.50" });
    f.service.changeStock(productId(), "OUT", 1, { userName: "", clientIp: "127.0.0.1" });
    expect(f.service.unassignedIps()).toEqual([
      expect.objectContaining({ ip: "192.168.1.23", count: 2 }),
      expect.objectContaining({ ip: "192.168.1.50", count: 1 }),
    ]);
    f.service.linkUserIp(suzukiId, "192.168.1.23", "", false, f.actor);
    expect(f.service.unassignedIps().map((x) => x.ip)).toEqual(["192.168.1.50"]);
  });

  it("API：whoami は紐づいた人を返す。紐づけ・解除", async () => {
    const app = buildApp({ service: f.service, images: f.images, isAllowedAddress: () => true });
    try {
      const link = await app.inject({ method: "POST", url: `/api/users/${suzukiId}/ips`, payload: { ip: "127.0.0.2", userName: "山田" }, remoteAddress: "192.168.1.10" });
      expect(link.statusCode).toBe(400);
      const ok = await app.inject({ method: "POST", url: `/api/users/${suzukiId}/ips`, payload: { ip: "192.168.1.23", note: "iPhone", userName: "山田" }, remoteAddress: "192.168.1.10" });
      expect(ok.statusCode).toBe(201);
      const who = await app.inject({ url: "/api/whoami", remoteAddress: "192.168.1.23" });
      expect(who.json()).toMatchObject({ ip: "192.168.1.23", userName: "鈴木", source: "ip" });
      const del = await app.inject({ method: "DELETE", url: "/api/user-ips/192.168.1.23", payload: { userName: "山田" }, remoteAddress: "192.168.1.10" });
      expect(del.statusCode).toBe(204);
      expect((await app.inject({ url: "/api/whoami", remoteAddress: "192.168.1.23" })).json().userName).toBe("");
    } finally {
      await app.close();
    }
  });
});
