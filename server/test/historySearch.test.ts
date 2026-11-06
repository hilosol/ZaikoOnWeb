import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistorySearchLimits } from "../../shared/types.js";
import { buildApp } from "../src/app.js";
import { parseHistoryQuery } from "../src/historySearch.js";
import { createFixture, type Fixture } from "./helpers.js";

let f: Fixture;
let apple: number;
let orange: number;
beforeEach(() => {
  f = createFixture();
  const keep = { action: "keep" } as const;
  apple = f.service.registerProduct({ code: "AP-00001", name: "リンゴ", category: "", warningStock: 0, initialStock: 100 }, keep, f.actor).id;
  orange = f.service.registerProduct({ code: "OR-00001", name: "みかん", category: "", warningStock: 0, initialStock: 100 }, keep, f.actor).id;
});
afterEach(() => f.cleanup());

const at = (y: number, m: number, d: number, h = 9) => {
  f.clock.current = new Date(y, m - 1, d, h, 0, 0);
};
const search = (raw: Record<string, unknown>) => f.service.searchHistories({ kind: "movements", ...raw }).result as {
  total: number;
  rows: { id: number; productCode: string; type: string; quantity: number; createdAt: string }[];
  summary: { IN: number; OUT: number; TRANSFER: number };
};

describe("検索条件の検証", () => {
  it("既定値", () => {
    expect(parseHistoryQuery({})).toMatchObject({ kind: "movements", fromAt: null, toBefore: null, canceled: "all", user: null, limit: 100, offset: 0 });
  });
  it("期間は両端の日を含む（終了日は翌日0時より前）。月末・年末の繰り上がり", () => {
    expect(parseHistoryQuery({ from: "2026-01-31", to: "2026-12-31" })).toMatchObject({
      fromAt: "2026-01-31 00:00:00",
      toBefore: "2027-01-01 00:00:00",
    });
    expect(parseHistoryQuery({ to: "2028-02-28" }).toBefore).toBe("2028-02-29 00:00:00");
  });
  it.each([
    [{ from: "2026-02-30" }, /開始の日付/],
    [{ to: "2026/11/06" }, /終了の日付/],
    [{ from: "2026-11-07", to: "2026-11-06" }, /開始日が終了日より後/],
    [{ kind: "x" }, /種類/],
    [{ types: "IN,BAD" }, /区分/],
    [{ canceled: "yes" }, /取消/],
    [{ productId: "-1" }, /商品/],
    [{ limit: "0" }, /表示件数/],
    [{ limit: String(HistorySearchLimits.pageSizeMax + 1) }, /表示件数/],
    [{ offset: "-1" }, /表示位置/],
  ])("不正な条件を拒否: %o", (raw, msg) => {
    expect(() => parseHistoryQuery(raw)).toThrow(msg);
  });
  it("CSV はページ送りを無視して上限まで", () => {
    expect(parseHistoryQuery({ limit: "5", offset: "10" }, true)).toMatchObject({ limit: HistorySearchLimits.csvRowsMax, offset: 0 });
  });
});

describe("入出庫の検索", () => {
  beforeEach(() => {
    at(2026, 5, 31, 23);
    f.service.changeStock(apple, "OUT", 1, f.actor, { orderNo: "YHO-26002", comment: "修理用" });
    at(2026, 6, 1, 0);
    f.service.changeStock(apple, "OUT", 2, f.actor, { orderNo: "YHO-26002" });
    at(2026, 6, 15);
    f.service.changeStock(orange, "IN", 5, { userName: "", clientIp: "192.168.1.50" }, { reason: "購入" });
    f.service.changeStock(orange, "TRANSFER", 3, f.actor, { destination: "製造部 佐藤" });
  });

  it("期間：終了日の23時台を含み、翌日0時は含まない", () => {
    expect(search({ from: "2026-05-31", to: "2026-05-31" }).rows.map((r) => r.quantity)).toEqual([1]);
    expect(search({ from: "2026-06-01", to: "2026-06-30" }).total).toBe(3);
  });

  it("新しい順・ページ送り・総件数", () => {
    const all = search({});
    expect(all.total).toBe(6); // 初期登録2件 + 4件
    const p2 = search({ limit: "2", offset: "2" });
    expect(p2.total).toBe(6);
    expect(p2.rows.map((r) => r.id)).toEqual(all.rows.slice(2, 4).map((r) => r.id));
  });

  it("キーワード：ひらがな/カタカナ・ハイフン・複数語（AND）", () => {
    expect(search({ q: "りんご" }).rows.every((r) => r.productCode === "AP-00001")).toBe(true);
    expect(search({ q: "ap00001 修理" }).total).toBe(1);
    expect(search({ q: "さとう" }).total).toBe(0); // 漢字の「佐藤」はかなで探せない（読みは持たない）
    expect(search({ q: "製造部" }).total).toBe(1);
  });

  it("区分・入力者（未登録）・受注番号・商品", () => {
    expect(search({ types: "OUT,TRANSFER" }).total).toBe(3);
    expect(search({ user: "" }).rows.map((r) => r.type)).toEqual(["IN"]);
    expect(search({ orderNo: "yho26002" }).total).toBe(2);
    expect(search({ productId: String(orange) }).total).toBe(3);
  });

  it("合計は絞り込んだ範囲で、取り消された分を除く", () => {
    expect(search({}).summary).toEqual({ IN: 5, OUT: 3, TRANSFER: 3 });
    const out2 = search({ orderNo: "YHO-26002" }).rows[0]!;
    f.service.cancelHistory(out2.id, "誤り", f.actor);
    const s = search({ orderNo: "YHO-26002" });
    expect(s.summary.OUT).toBe(1);
    expect(s.total).toBe(3); // 取消の履歴も受注番号を引き継ぐ
    expect(search({ orderNo: "YHO-26002", canceled: "exclude" }).total).toBe(1);
    expect(search({ orderNo: "YHO-26002", canceled: "only" }).total).toBe(2);
  });
});

describe("修正記録・操作ログ・ID変更の検索", () => {
  it("修正記録に商品ID・名前を付け、キーワードで探せる", () => {
    f.service.changeStock(apple, "OUT", 1, f.actor);
    const h = f.service.recentHistories(1)[0]!;
    f.service.editHistory(h.id, { comment: "棚卸し用" }, f.actor);
    const r = f.service.searchHistories({ kind: "edits", q: "りんご" }).result;
    expect(r.rows).toEqual([expect.objectContaining({ productCode: "AP-00001", productName: "リンゴ", field: "comment", after: "棚卸し用", historyType: "OUT" })]);
    expect(f.service.searchHistories({ kind: "edits", q: "コメント" }).result.total).toBe(1);
  });

  it("操作ログは操作の種類名でも探せる。ID変更は旧IDで探せる", () => {
    const p = f.service.getProduct(apple);
    f.service.updateProduct(apple, { code: "AP-99999", name: "リンゴ", category: "", warningStock: 0 }, p.version, { action: "keep" }, f.actor);
    expect(f.service.searchHistories({ kind: "audit", q: "商品更新 99999" }).result.total).toBe(1);
    expect(f.service.searchHistories({ kind: "codes", q: "ap00001" }).result.rows).toEqual([
      expect.objectContaining({ oldCode: "AP-00001", newCode: "AP-99999" }),
    ]);
  });
});

describe("API", () => {
  it("検索と、同じ条件の CSV（ページ送りなし・期間入りのファイル名）", async () => {
    const app = buildApp({ service: f.service, images: f.images });
    try {
      f.service.changeStock(apple, "OUT", 1, f.actor, { orderNo: "YHO-26002" });
      const r = await app.inject({ url: "/api/history-search?kind=movements&orderNo=YHO-26002&limit=1" });
      expect(r.json()).toMatchObject({ total: 1, summary: { OUT: 1 } });
      const bad = await app.inject({ url: "/api/history-search?from=2026-13-01" });
      expect(bad.statusCode).toBe(400);
      const csv = await app.inject({ url: "/api/history-search.csv?kind=movements&from=2026-08-01&to=2026-11-30&limit=1" });
      expect(csv.headers["content-disposition"]).toContain(encodeURIComponent("入出庫_20260801-20261130.csv"));
      expect(csv.body.split("\r\n").filter(Boolean)).toHaveLength(4); // 見出し + 初期登録2 + 出庫1
      const edits = await app.inject({ url: "/api/history-search.csv?kind=edits" });
      expect(edits.body).toMatch(/^﻿日時,履歴ID,商品ID,商品名,区分,項目,修正前,修正後,入力者,端末IP/);
    } finally {
      await app.close();
    }
  });
});
