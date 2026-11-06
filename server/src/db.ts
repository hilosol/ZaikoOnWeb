import { DatabaseSync } from "node:sqlite";

/**
 * DB 構造の変更履歴。配列の i 番目が「バージョン i → i+1」の SQL。
 * 構造を変えるときは末尾に追加する（既存の要素は絶対に書き換えない）。
 */
const MIGRATIONS: readonly string[] = [
  // v0 → v1
  `
  CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at  TEXT    NOT NULL
  );

  CREATE TABLE products (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    category      TEXT    NOT NULL DEFAULT '',
    stock         INTEGER NOT NULL CHECK (stock BETWEEN 0 AND 1000000),
    warning_stock INTEGER NOT NULL CHECK (warning_stock BETWEEN 0 AND 1000000),
    image_file    TEXT    NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
  );

  -- 商品を削除しても履歴は残す（商品ID・商品名は記録時点の値を保持）
  CREATE TABLE histories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER NULL,
    product_code TEXT    NOT NULL,
    product_name TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('IN', 'OUT', 'INIT')),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    stock_after  INTEGER NOT NULL,
    user_name    TEXT    NOT NULL,
    client_ip    TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
  );
  CREATE INDEX ix_histories_created_at ON histories (created_at);
  CREATE INDEX ix_histories_product_id ON histories (product_id);

  -- 商品の登録・変更・削除など、在庫数以外の操作の記録
  CREATE TABLE audit_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL,
    detail     TEXT NOT NULL,
    user_name  TEXT NOT NULL,
    client_ip  TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ix_audit_logs_created_at ON audit_logs (created_at);
  `,

  // v1 → v2: 保管場所、移管（人・部署への払い出し）
  // SQLite は CHECK 制約を変更できないため、histories は作り直してデータを移す
  `
  ALTER TABLE products ADD COLUMN location TEXT NOT NULL DEFAULT '';

  CREATE TABLE histories_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER NULL,
    product_code TEXT    NOT NULL,
    product_name TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('IN', 'OUT', 'TRANSFER', 'INIT')),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    stock_after  INTEGER NOT NULL,
    destination  TEXT    NULL,
    user_name    TEXT    NOT NULL,
    client_ip    TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
  );
  INSERT INTO histories_new (id, product_id, product_code, product_name, type, quantity, stock_after, user_name, client_ip, created_at)
       SELECT id, product_id, product_code, product_name, type, quantity, stock_after, user_name, client_ip, created_at FROM histories;
  DROP TABLE histories;
  ALTER TABLE histories_new RENAME TO histories;
  CREATE INDEX ix_histories_created_at ON histories (created_at);
  CREATE INDEX ix_histories_product_id ON histories (product_id);
  CREATE INDEX ix_histories_destination ON histories (destination);
  `,

  // v2 → v3: 商品の備考、入出庫・移管のコメント
  `
  ALTER TABLE products ADD COLUMN note TEXT NOT NULL DEFAULT '';
  ALTER TABLE histories ADD COLUMN comment TEXT NULL;
  `,

  // v3 → v4: 商品の概要
  `
  ALTER TABLE products ADD COLUMN summary TEXT NOT NULL DEFAULT '';
  `,

  // v4 → v5: 履歴の区分に「棚卸調整」（ADJUST）を追加。CHECK 制約は変更できないため作り直す
  `
  CREATE TABLE histories_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER NULL,
    product_code TEXT    NOT NULL,
    product_name TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('IN', 'OUT', 'TRANSFER', 'INIT', 'ADJUST')),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    stock_after  INTEGER NOT NULL,
    destination  TEXT    NULL,
    comment      TEXT    NULL,
    user_name    TEXT    NOT NULL,
    client_ip    TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
  );
  INSERT INTO histories_new (id, product_id, product_code, product_name, type, quantity, stock_after, destination, comment, user_name, client_ip, created_at)
       SELECT id, product_id, product_code, product_name, type, quantity, stock_after, destination, comment, user_name, client_ip, created_at FROM histories;
  DROP TABLE histories;
  ALTER TABLE histories_new RENAME TO histories;
  CREATE INDEX ix_histories_created_at ON histories (created_at);
  CREATE INDEX ix_histories_product_id ON histories (product_id);
  CREATE INDEX ix_histories_destination ON histories (destination);
  `,

  // v5 → v6: 入庫の理由（購入・戻り・その他）
  `
  ALTER TABLE histories ADD COLUMN reason TEXT NULL;
  `,

  // v6 → v7: 購入元（1商品に複数。商品を削除したら一緒に消える）
  `
  CREATE TABLE product_suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    position   INTEGER NOT NULL CHECK (position >= 0),
    name       TEXT    NOT NULL CHECK (name <> ''),
    url        TEXT    NOT NULL DEFAULT '',
    UNIQUE (product_id, position)
  );
  `,

  // v7 → v8: アプリの設定（メール通知など。値は JSON）
  `
  CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // v8 → v9: 簿外フラグ、商品IDの変更履歴（商品を削除しても残すため外部キーは付けない）
  `
  ALTER TABLE products ADD COLUMN off_book INTEGER NOT NULL DEFAULT 0 CHECK (off_book IN (0, 1));
  CREATE TABLE product_code_changes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER NOT NULL,
    old_code     TEXT    NOT NULL,
    new_code     TEXT    NOT NULL,
    product_name TEXT    NOT NULL,
    user_name    TEXT    NOT NULL,
    client_ip    TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
  );
  CREATE INDEX ix_code_changes_old_code ON product_code_changes (old_code COLLATE NOCASE);
  CREATE INDEX ix_code_changes_product_id ON product_code_changes (product_id);
  `,

  // v9 → v10: 端末の IP と入力者の紐づけ（1つの IP は1人まで。1人に複数の IP 可）
  `
  CREATE TABLE user_ips (
    ip         TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    note       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
  );
  CREATE INDEX ix_user_ips_user_id ON user_ips (user_id);
  CREATE INDEX ix_histories_client_ip ON histories (client_ip);
  `,

  // v10 → v11: 受注番号（入庫・出庫・移管で任意入力）
  `
  ALTER TABLE histories ADD COLUMN order_no TEXT NULL;
  CREATE INDEX ix_histories_order_no ON histories (order_no);
  `,

  // v11 → v12: 履歴の取消（CANCEL）・修正履歴・端末ID。区分の CHECK 制約を変えるため histories を作り直す
  `
  CREATE TABLE histories_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER NULL,
    product_code TEXT    NOT NULL,
    product_name TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('IN', 'OUT', 'TRANSFER', 'INIT', 'ADJUST', 'CANCEL')),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    stock_after  INTEGER NOT NULL,
    destination  TEXT    NULL,
    comment      TEXT    NULL,
    reason       TEXT    NULL,
    order_no     TEXT    NULL,
    cancel_of    INTEGER NULL,
    canceled_by  INTEGER NULL,
    device_id    TEXT    NULL,
    user_name    TEXT    NOT NULL,
    client_ip    TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
  );
  INSERT INTO histories_new (id, product_id, product_code, product_name, type, quantity, stock_after, destination, comment, reason, order_no, user_name, client_ip, created_at)
       SELECT id, product_id, product_code, product_name, type, quantity, stock_after, destination, comment, reason, order_no, user_name, client_ip, created_at FROM histories;
  DROP TABLE histories;
  ALTER TABLE histories_new RENAME TO histories;
  CREATE INDEX ix_histories_created_at ON histories (created_at);
  CREATE INDEX ix_histories_product_id ON histories (product_id);
  CREATE INDEX ix_histories_destination ON histories (destination);
  CREATE INDEX ix_histories_client_ip ON histories (client_ip);
  CREATE INDEX ix_histories_order_no ON histories (order_no);
  CREATE INDEX ix_histories_device_id ON histories (device_id);

  CREATE TABLE history_edits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    history_id INTEGER NOT NULL,
    field      TEXT    NOT NULL,
    before     TEXT    NOT NULL,
    after      TEXT    NOT NULL,
    user_name  TEXT    NOT NULL,
    client_ip  TEXT    NOT NULL,
    created_at TEXT    NOT NULL
  );
  CREATE INDEX ix_history_edits_history_id ON history_edits (history_id);
  CREATE INDEX ix_history_edits_created_at ON history_edits (created_at);

  CREATE TABLE devices (
    id         TEXT    PRIMARY KEY,
    user_id    INTEGER NULL REFERENCES users (id) ON DELETE SET NULL,
    note       TEXT    NOT NULL DEFAULT '',
    user_agent TEXT    NOT NULL DEFAULT '',
    last_ip    TEXT    NOT NULL DEFAULT '',
    first_seen TEXT    NOT NULL,
    last_seen  TEXT    NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * DB を開き、構造を最新にする。
 * @param backupBeforeUpgrade 既存の DB の構造を更新する場合に、更新前の状態を保存するパスを返す関数
 */
export function openDatabase(path: string, backupBeforeUpgrade?: (fromVersion: number) => string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL: 読み込み中でも書き込みを待たせない。busy_timeout: 書き込みが重なったときに即エラーにせず待つ
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const version = getSchemaVersion(db);
  if (backupBeforeUpgrade && version > 0 && version < SCHEMA_VERSION) {
    backupDatabase(db, backupBeforeUpgrade(version));
  }
  migrate(db);
  return db;
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/** DB 構造を最新にする。全体を1トランザクションで行い、失敗したら元に戻る。 */
export function migrate(db: DatabaseSync): void {
  const current = getSchemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `データベースが新しいバージョンのアプリで作成されています（DB: v${current}、アプリ: v${SCHEMA_VERSION}）。アプリを更新してください。`,
    );
  }
  if (current === SCHEMA_VERSION) return;

  transaction(db, () => {
    for (let v = current; v < SCHEMA_VERSION; v++) {
      db.exec(MIGRATIONS[v]!);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  });
}

/**
 * 書き込みトランザクション。BEGIN IMMEDIATE で開始時に書き込みロックを取るため、
 * 「読んでから書く」処理が同時に走っても途中で割り込まれない。
 * 入れ子には対応しない（呼び出し側で1段だけ使う）。
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ROLLBACK の失敗より元のエラーを優先する
    }
    throw error;
  }
}

/** オンラインバックアップ（稼働中でも整合の取れたコピーが作れる）。 */
export function backupDatabase(db: DatabaseSync, destPath: string): void {
  db.prepare("VACUUM INTO ?").run(destPath);
}
