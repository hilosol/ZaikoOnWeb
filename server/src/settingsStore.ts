import type { DatabaseSync } from "node:sqlite";

/**
 * アプリ設定の保存先（app_settings テーブル。値は JSON）。
 * 項目ごとに検証・既定値の補完は呼び出し側で行う（ここは読み書きだけ）。
 */
export class SettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 未保存・JSON が壊れている場合は undefined */
  get(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}
