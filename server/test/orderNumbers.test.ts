import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rules } from "../../shared/types.js";
import { buildApp } from "../src/app.js";
import { InventoryService } from "../src/inventory.js";
import { decodeText, OrderNumberList, parseOrderList } from "../src/orderNumbers.js";
import { createFixture, type Fixture } from "./helpers.js";

describe("受注番号リストの解釈", () => {
  it("フォルダ名そのまま：最初の「_」の前を受注番号、後ろを案件名にする", () => {
    const { items } = parseOrderList(
      "AWO-26008_湖北工業_AW610M\r\nEBO-26001_岡本工作機械製作所（三益半導体工業）_4探針プローバー\r\nYHO-26003_NANOIONICS KOREA_HMP-400\r\n",
    );
    expect(items).toEqual([
      { number: "AWO-26008", name: "湖北工業_AW610M" },
      { number: "EBO-26001", name: "岡本工作機械製作所（三益半導体工業）_4探針プローバー" },
      { number: "YHO-26003", name: "NANOIONICS KOREA_HMP-400" },
    ]);
  });

  it("番号だけの行・空行・# のコメント行・前後の空白", () => {
    expect(parseOrderList("  YHO-26002  \n\n# メモ\nYHO-26003\n").items).toEqual([
      { number: "YHO-26002", name: "" },
      { number: "YHO-26003", name: "" },
    ]);
  });

  it("PowerShell の dir の出力をそのまま貼っても読める（見出し行は除く）", () => {
    const text = [
      "",
      "    Directory: S:\\003_PROBER\\案件",
      "",
      "Mode                 LastWriteTime         Length Name",
      "----                 -------------         ------ ----",
      "d----l        2026/09/15      9:43                AWO-26008_湖北工業_AW610M",
      "d----l        2026/10/09      8:34                YHO-26042_キオクシア_高温プローバー",
    ].join("\r\n");
    expect(parseOrderList(text).items.map((x) => x.number)).toEqual(["AWO-26008", "YHO-26042"]);
  });

  it("同じ番号（表記ゆれ含む）は最初の行を使い、長すぎる番号は読み飛ばす", () => {
    const r = parseOrderList(`YHO-26002_京都大学\nyho26002_重複\n${"X".repeat(Rules.orderNoMaxLength + 1)}_長い\n${"Y".repeat(Rules.orderNoMaxLength)}\n`);
    expect(r.items.map((x) => x.number)).toEqual(["YHO-26002", "Y".repeat(Rules.orderNoMaxLength)]);
    expect(r.skipped).toBe(1);
  });

  it("文字コード：UTF-8（BOMあり/なし）・Shift_JIS・UTF-16 を判定して読む", () => {
    const text = "YHO-26002_京都大学";
    expect(decodeText(Buffer.from(text, "utf8"))).toBe(text);
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]))).toBe(text);
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]))).toBe(text);
    // 「京都大学」の Shift_JIS
    const sjis = Buffer.concat([Buffer.from("YHO-26002_", "ascii"), Buffer.from([0x8b, 0x9e, 0x93, 0x73, 0x91, 0xe5, 0x8a, 0x77])]);
    expect(decodeText(sjis)).toBe(text);
  });
});

describe("受注番号の記録", () => {
  let f: Fixture;
  let file: string;
  let list: OrderNumberList;
  let service: InventoryService;
  let pid: number;

  beforeEach(() => {
    f = createFixture();
    file = path.join(f.dir, "受注番号リスト.txt");
    fs.writeFileSync(file, "YHO-26002_京都大学_HMP-400\nYHO-26003_NANOIONICS KOREA_HMP-400\n");
    list = new OrderNumberList(file);
    service = new InventoryService(f.db, f.images, f.clock, list);
    pid = service.registerProduct({ code: "A001", name: "りんご", category: "", warningStock: 0, initialStock: 10 }, { action: "keep" }, f.actor).id;
  });
  afterEach(() => f.cleanup());

  it("入庫・出庫・移管で記録し、リストの表記にそろえる（全角・小文字・ハイフンなし）", () => {
    service.changeStock(pid, "OUT", 1, f.actor, { orderNo: "ｙｈｏ26002" });
    service.changeStock(pid, "TRANSFER", 1, f.actor, { destination: "製造部", orderNo: "YHO-26003" });
    service.changeStock(pid, "IN", 1, f.actor, { orderNo: "  " });
    expect(service.recentHistories(3).map((h) => h.orderNo)).toEqual([null, "YHO-26003", "YHO-26002"]);
  });

  it("リストに無い番号もそのまま記録でき、最近の入力として候補に出る", () => {
    service.changeStock(pid, "OUT", 1, f.actor, { orderNo: "NEW-27001" });
    service.changeStock(pid, "OUT", 1, f.actor, { orderNo: "YHO-26002" });
    expect(service.recentHistories(2).map((h) => h.orderNo)).toEqual(["YHO-26002", "NEW-27001"]);
    expect(service.recentOrderNumbers()).toEqual(["NEW-27001"]);
  });

  it("長すぎる・文字列以外は拒否し、在庫も変えない", () => {
    expect(() => service.changeStock(pid, "OUT", 1, f.actor, { orderNo: "x".repeat(Rules.orderNoMaxLength + 1) })).toThrow(/受注番号は50文字以内/);
    expect(() => service.changeStock(pid, "OUT", 1, f.actor, { orderNo: 123 })).toThrow(/受注番号の形式/);
    expect(service.getProduct(pid).stock).toBe(10);
    service.changeStock(pid, "OUT", 1, f.actor, { orderNo: "x".repeat(Rules.orderNoMaxLength) });
    expect(service.getProduct(pid).stock).toBe(9);
  });

  it("ファイルを置き換えると次の参照で読み直す。消すと空になる", () => {
    expect(list.list().items).toHaveLength(2);
    fs.writeFileSync(file, "YHO-26004_三井化学_HMP-600\n");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(list.list().items).toEqual([{ number: "YHO-26004", name: "三井化学_HMP-600" }]);
    fs.rmSync(file);
    expect(list.list()).toMatchObject({ items: [], status: { exists: false, count: 0 } });
  });

  it("ファイルが無くても手入力で記録できる", () => {
    const none = new OrderNumberList(path.join(f.dir, "無い.txt"));
    const s = new InventoryService(f.db, f.images, f.clock, none);
    s.changeStock(pid, "OUT", 1, f.actor, { orderNo: "yho-26002" });
    expect(s.recentHistories(1)[0]!.orderNo).toBe("yho-26002");
  });

  it("API：リストと最近の入力、状態を返す。入出庫で受注番号を受け付ける", async () => {
    const app = buildApp({ service, images: f.images, orderList: list });
    try {
      await app.inject({ method: "POST", url: `/api/products/${pid}/stock`, payload: { type: "OUT", quantity: 1, userName: "山田", orderNo: "TMP-1" } });
      const r = (await app.inject({ url: "/api/order-numbers" })).json();
      expect(r.items).toHaveLength(2);
      expect(r.recent).toEqual(["TMP-1"]);
      expect(r.status).toMatchObject({ exists: true, count: 2, error: "" });
    } finally {
      await app.close();
    }
  });
});
