import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductInput } from "../../shared/types.js";
import { parseFlag } from "../src/inventory.js";
import { CsvLogExporter } from "../src/logExport.js";
import { productsToCsv } from "../src/productCsv.js";
import { createFixture, type Fixture } from "./helpers.js";

let f: Fixture;
beforeEach(() => {
  f = createFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  f.cleanup();
});

const input = (over: Partial<ProductInput> = {}): ProductInput => ({
  code: "A001",
  name: "りんご",
  category: "果物",
  warningStock: 3,
  initialStock: 10,
  ...over,
});
const keep = { action: "keep" } as const;

describe("簿外", () => {
  it("新規は既定で簿外ではない。指定すれば簿外で登録できる", () => {
    expect(f.service.registerProduct(input(), keep, f.actor).offBook).toBe(false);
    expect(f.service.registerProduct(input({ code: "B001", offBook: true }), keep, f.actor).offBook).toBe(true);
  });

  it("更新で切り替えられ、操作ログに残る。省略時は変更しない", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    const on = f.service.updateProduct(p.id, input({ offBook: true }), p.version, keep, f.actor);
    expect(on.offBook).toBe(true);
    expect(f.service.auditLogs(1)[0]!.detail).toBe("簿外に設定");
    const kept = f.service.updateProduct(p.id, input({ name: "青りんご" }), on.version, keep, f.actor);
    expect(kept.offBook).toBe(true);
  });

  it("真偽値以外は拒否する", () => {
    expect(() => f.service.registerProduct(input({ offBook: "yes" as unknown as boolean }), keep, f.actor)).toThrow(/簿外/);
  });

  it("簿外でも在庫警告の対象になる", () => {
    f.service.registerProduct(input({ offBook: true, initialStock: 1 }), keep, f.actor);
    expect(f.service.lowStockProducts().map((p) => p.code)).toEqual(["A001"]);
  });

  it("在庫CSV：簿外の列を○で出力し、取り込める（列が無ければ変更しない）", () => {
    const p = f.service.registerProduct(input({ offBook: true }), keep, f.actor);
    const csv = productsToCsv([p]);
    expect(csv.split("\r\n")[0]).toMatch(/,簿外$/);
    expect(csv.split("\r\n")[1]).toMatch(/,○$/);

    const off = f.service.importProducts("商品コード,簿外\nA001,\n", false, f.actor);
    expect(off.rows[0]!.changes).toContain("簿外を解除");
    expect(f.service.getProduct(p.id).offBook).toBe(false);

    f.service.importProducts("商品コード,簿外\nA001,はい\n", false, f.actor);
    expect(f.service.getProduct(p.id).offBook).toBe(true);
    f.service.importProducts("商品コード,商品名\nA001,りんご改\n", false, f.actor);
    expect(f.service.getProduct(p.id).offBook).toBe(true);

    const bad = f.service.importProducts("商品コード,簿外\nA001,たぶん\n", true, f.actor);
    expect(bad.errors[0]!.messages[0]).toMatch(/簿外は「○」か空欄/);
  });

  it.each([
    ["○", true], ["〇", true], ["1", true], ["はい", true], ["TRUE", true], ["簿外", true],
    ["", false], [" ", false], ["0", false], ["いいえ", false], ["×", false],
    ["2", null], ["多分", null],
  ])("簿外の値の解釈: 「%s」→ %s", (text, expected) => {
    expect(parseFlag(text)).toBe(expected);
  });
});

describe("商品コードの変更履歴", () => {
  it("コードを変えたら旧→新・入力者・IP を記録する（他の項目の変更では記録しない）", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    const v2 = f.service.updateProduct(p.id, input({ name: "青りんご" }), p.version, keep, f.actor);
    expect(f.service.codeChanges(p.id)).toHaveLength(0);
    f.clock.advance(5);
    f.service.updateProduct(p.id, input({ code: "AP-00001", name: "青りんご" }), v2.version, keep, f.actor);
    expect(f.service.codeChanges(p.id)).toEqual([
      expect.objectContaining({ productId: p.id, oldCode: "A001", newCode: "AP-00001", productName: "青りんご", userName: "山田", clientIp: "192.168.1.10", createdAt: "2026-11-02 09:05:00" }),
    ]);
  });

  it("全角→半角など正規化で同じになる変更は記録しない", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.updateProduct(p.id, input({ code: "Ａ００１" }), p.version, keep, f.actor);
    expect(f.service.codeChanges()).toHaveLength(0);
  });

  it("保存に失敗したら記録しない（重複コード）", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.registerProduct(input({ code: "B001" }), keep, f.actor);
    expect(() => f.service.updateProduct(p.id, input({ code: "B001" }), p.version, keep, f.actor)).toThrow();
    expect(f.service.codeChanges()).toHaveLength(0);
  });

  it("旧コードで読み取っても現在の商品が見つかる（大文字小文字・ハイフン違いも）", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.updateProduct(p.id, input({ code: "AP-00001" }), p.version, keep, f.actor);
    expect(f.service.lookupCode("AP-00001")).toMatchObject({ product: { id: p.id }, oldCode: null });
    expect(f.service.lookupCode("a001")).toMatchObject({ product: { id: p.id, code: "AP-00001" }, oldCode: "A001" });
    expect(f.service.lookupCode("A-001")).toMatchObject({ product: { id: p.id }, oldCode: "A001" });
    expect(f.service.lookupCode("ZZZ")).toEqual({ product: null, oldCode: null });
  });

  it("旧コードを別の商品が使っている場合は、現在の持ち主を優先する", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.updateProduct(p.id, input({ code: "A001-OLD" }), p.version, keep, f.actor);
    const q = f.service.registerProduct(input({ code: "A001", name: "新りんご" }), keep, f.actor);
    expect(f.service.lookupCode("A001")).toMatchObject({ product: { id: q.id }, oldCode: null });
  });

  it("同じ旧コードが何度も使われた場合は最後の変更を採る", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.updateProduct(p.id, input({ code: "X1" }), p.version, keep, f.actor);
    const q = f.service.registerProduct(input({ code: "A001", name: "2代目" }), keep, f.actor);
    f.service.updateProduct(q.id, input({ code: "X2", name: "2代目" }), q.version, keep, f.actor);
    expect(f.service.lookupCode("A001")).toMatchObject({ product: { id: q.id }, oldCode: "A001" });
  });

  it("商品を削除しても変更履歴は残り、旧コードでは見つからない", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    const v2 = f.service.updateProduct(p.id, input({ code: "X1" }), p.version, keep, f.actor);
    f.service.deleteProduct(p.id, v2.version, f.actor);
    expect(f.service.codeChanges()).toHaveLength(1);
    expect(f.service.lookupCode("A001")).toEqual({ product: null, oldCode: null });
  });
});

describe("履歴CSVの自動保存", () => {
  const dir = () => path.join(f.dir, "logs");
  const read = (name: string) => fs.readFileSync(path.join(dir(), name), "utf8");

  it("月ごとに入出庫履歴・操作ログ・コード変更履歴を書き出す（BOM付き）", () => {
    const p = f.service.registerProduct(input(), keep, f.actor);
    f.service.changeStock(p.id, "OUT", 2, f.actor, { comment: "修理用" });
    f.service.updateProduct(p.id, input({ code: "AP-00001" }), p.version, keep, f.actor);
    const status = new CsvLogExporter(f.service, dir(), f.clock).run();

    expect(status.failures).toEqual([]);
    expect(fs.readdirSync(dir()).sort()).toEqual(["コード変更履歴_2026-11.csv", "入出庫履歴_2026-11.csv", "操作ログ_2026-11.csv"].sort());
    expect(read("入出庫履歴_2026-11.csv")).toMatch(/^﻿日時,商品コード/);
    expect(read("入出庫履歴_2026-11.csv")).toContain("出庫,,,2,8,,修理用,山田,192.168.1.10");
    expect(read("コード変更履歴_2026-11.csv")).toContain("A001,AP-00001,りんご,山田,192.168.1.10");
    expect(read("操作ログ_2026-11.csv")).toContain("商品更新,AP-00001,コード: A001 → AP-00001");
  });

  it("今月・先月は毎回書き直し、それより前の月は無い場合だけ書く", () => {
    f.clock.current = new Date(2026, 8, 10, 9, 0); // 9月
    f.service.registerProduct(input(), keep, f.actor);
    f.clock.current = new Date(2026, 9, 10, 9, 0); // 10月
    f.service.registerProduct(input({ code: "B001" }), keep, f.actor);
    const ex = new CsvLogExporter(f.service, dir(), f.clock);
    ex.run();
    const sep = path.join(dir(), "操作ログ_2026-09.csv");
    fs.writeFileSync(sep, "手で編集");

    f.clock.current = new Date(2026, 10, 2, 9, 0); // 11月：9月は「先月より前」
    const s = ex.run();
    expect(fs.readFileSync(sep, "utf8")).toBe("手で編集");
    // 10月の入出庫・操作ログ ＋ 11月の操作ログ（テスト準備で入力者を登録した記録）
    expect(s.written).toBe(3);
  });

  it("Excel で開いていて置き換えられない場合は、理由を記録して他のファイルは書き出す", () => {
    f.service.registerProduct(input(), keep, f.actor);
    const real = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).includes("操作ログ")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return real(from, to);
    });
    const s = new CsvLogExporter(f.service, dir(), f.clock).run();
    expect(s.failures).toEqual([{ file: "操作ログ_2026-11.csv", reason: expect.stringMatching(/Excel/) }]);
    expect(fs.existsSync(path.join(dir(), "入出庫履歴_2026-11.csv"))).toBe(true);
    // 一時ファイルを残さない
    expect(fs.readdirSync(dir()).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("データが無ければ何も書かない", () => {
    const empty = { activityMonths: () => [], historiesInMonth: () => [], auditLogsInMonth: () => [], codeChangesInMonth: () => [], historyEditsInMonth: () => [] };
    const s = new CsvLogExporter(empty, dir(), f.clock).run();
    expect(s.written).toBe(0);
    expect(fs.readdirSync(dir())).toEqual([]);
  });
});
