import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getSchemaVersion, openDatabase, SCHEMA_VERSION } from "../src/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zaiko-mig-"));
  dirs.push(d);
  return d;
};

/** v1（初版）の構造で作られた DB を再現する */
function createV1(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)), created_at TEXT NOT NULL);
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
      stock INTEGER NOT NULL CHECK (stock BETWEEN 0 AND 1000000), warning_stock INTEGER NOT NULL CHECK (warning_stock BETWEEN 0 AND 1000000),
      image_file TEXT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE histories (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NULL, product_code TEXT NOT NULL, product_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('IN', 'OUT', 'INIT')), quantity INTEGER NOT NULL CHECK (quantity > 0), stock_after INTEGER NOT NULL,
      user_name TEXT NOT NULL, client_ip TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX ix_histories_created_at ON histories (created_at);
    CREATE INDEX ix_histories_product_id ON histories (product_id);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL,
      user_name TEXT NOT NULL, client_ip TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO products (code, name, stock, warning_stock, created_at, updated_at) VALUES ('A0', 'りんご', 5, 1, 't', 't');
    INSERT INTO histories (product_id, product_code, product_name, type, quantity, stock_after, user_name, client_ip, created_at)
      VALUES (1, 'A0', 'りんご', 'INIT', 5, 5, '山田', '1.1.1.1', '2026-01-01 00:00:00'),
             (1, 'A0', 'りんご', 'OUT', 2, 3, '山田', '1.1.1.1', '2026-01-02 00:00:00');
    PRAGMA user_version = 1;
  `);
  db.close();
}

describe("DB 構造の更新", () => {
  it("v1 の DB をデータを保ったまま最新にし、更新前にバックアップを取る", () => {
    const dir = tmp();
    const file = path.join(dir, "zaiko.db");
    createV1(file);
    const backup = path.join(dir, "before.db");

    const db = openDatabase(file, () => backup);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT location, note, summary FROM products").get()).toEqual({ location: "", note: "", summary: "" });
    expect(db.prepare("SELECT comment, reason FROM histories WHERE id = 1").get()).toEqual({ comment: null, reason: null });
    const rows = db.prepare("SELECT id, type, destination FROM histories ORDER BY id").all();
    expect(rows).toEqual([
      { id: 1, type: "INIT", destination: null },
      { id: 2, type: "OUT", destination: null },
    ]);
    // 移管が記録でき、ID は続きから振られる
    db.prepare(
      "INSERT INTO histories (product_id, product_code, product_name, type, quantity, stock_after, destination, user_name, client_ip, created_at) VALUES (1,'A0','りんご','TRANSFER',1,2,'製造部','山田','x','t')",
    ).run();
    expect(db.prepare("SELECT MAX(id) AS m FROM histories").get()).toEqual({ m: 3 });
    db.close();

    const old = new DatabaseSync(backup);
    expect(getSchemaVersion(old)).toBe(1);
    expect(old.prepare("SELECT COUNT(*) AS n FROM histories").get()).toEqual({ n: 2 });
    old.close();
  });

  it("最新の DB ではバックアップを取らない", () => {
    const file = path.join(tmp(), "zaiko.db");
    openDatabase(file).close();
    let called = false;
    openDatabase(file, () => {
      called = true;
      return "unused";
    }).close();
    expect(called).toBe(false);
  });

  it("新しいバージョンの DB は開かない", () => {
    const file = path.join(tmp(), "zaiko.db");
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
    db.close();
    expect(() => openDatabase(file)).toThrow(/新しいバージョン/);
  });
});
