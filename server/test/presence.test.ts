import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { EDITING_EXPIRE_MS, EditingPresence } from "../src/presence.js";
import { createFixture, FakeClock } from "./helpers.js";

const S1 = "session-0001";
const S2 = "session-0002";

describe("編集中の表示", () => {
  it("自分以外に編集中の人を返す（編集を始めた順）", () => {
    const clock = new FakeClock();
    const p = new EditingPresence(clock);
    expect(p.heartbeat(1, S1, "山田", "192.168.0.10")).toEqual([]);
    clock.advance(1);
    expect(p.heartbeat(1, S2, "", "192.168.0.20")).toMatchObject([{ userName: "山田", clientIp: "192.168.0.10" }]);
    expect(p.heartbeat(1, S1, "山田", "192.168.0.10")).toMatchObject([{ userName: "", clientIp: "192.168.0.20" }]);
    expect(p.all()[1]!.map((e) => e.clientIp)).toEqual(["192.168.0.10", "192.168.0.20"]);
    expect(p.others(2)).toEqual([]);
  });

  it("知らせが途絶えたら（境界）編集中ではなくなる", () => {
    const clock = new FakeClock();
    const p = new EditingPresence(clock);
    p.heartbeat(1, S1, "山田", "a");
    clock.current = new Date(clock.current.getTime() + EDITING_EXPIRE_MS);
    expect(p.others(1)).toHaveLength(1);
    clock.current = new Date(clock.current.getTime() + 1);
    expect(p.others(1)).toEqual([]);
    expect(p.all()).toEqual({});
  });

  it("閉じたら消え、閉じた後に遅れて届いた知らせでは戻らない", () => {
    const p = new EditingPresence(new FakeClock());
    p.heartbeat(1, S1, "山田", "a");
    p.leave(1, S1);
    expect(p.others(1)).toEqual([]);
    p.heartbeat(1, S1, "山田", "a");
    expect(p.others(1)).toEqual([]);
  });

  it.each([undefined, "", "短い", "a".repeat(65), "invalid id!", 123])("識別子が正しくなければ拒否: %o", (id) => {
    expect(() => new EditingPresence(new FakeClock()).heartbeat(1, id, "", "a")).toThrow(/識別子/);
  });

  it("API：知らせると他の人を返し、一覧にも出る。閉じると消える。名前は登録済みの人だけ", async () => {
    const f = createFixture();
    const app = buildApp({ service: f.service, images: f.images, presence: new EditingPresence(f.clock), isAllowedAddress: () => true });
    try {
      await app.inject({ method: "POST", url: "/api/products/5/editing", payload: { sessionId: S1, userName: "山田" } });
      const r = await app.inject({ method: "POST", url: "/api/products/5/editing", payload: { sessionId: S2, userName: "存在しない人" } });
      expect(r.json().others).toMatchObject([{ userName: "山田" }]);
      expect((await app.inject({ method: "GET", url: "/api/editing" })).json()["5"].map((e: { userName: string }) => e.userName)).toEqual(["山田", ""]);
      const left = await app.inject({ method: "POST", url: "/api/products/5/editing/leave", payload: { sessionId: S1 } });
      expect(left.statusCode).toBe(204);
      expect((await app.inject({ method: "GET", url: "/api/editing" })).json()["5"]).toHaveLength(1);
      expect((await app.inject({ method: "POST", url: "/api/products/x/editing", payload: { sessionId: S1 } })).statusCode).toBe(400);
    } finally {
      await app.close();
      f.cleanup();
    }
  });
});
