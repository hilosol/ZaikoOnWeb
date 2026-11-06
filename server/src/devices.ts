import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Device } from "../../shared/types.js";

/** 端末ID：32桁の16進（Cookie の値をそのまま DB・履歴に入れるため、形式を厳しく確認する） */
const DEVICE_ID = /^[0-9a-f]{32}$/;

export const isDeviceId = (v: unknown): v is string => typeof v === "string" && DEVICE_ID.test(v);
export const newDeviceId = (): string => randomBytes(16).toString("hex");

/** User-Agent から「iPhone / Safari」のような短い表示名を作る（推定。正確でなくても端末の見分けに使えればよい） */
export function deviceLabel(ua: string): string {
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /Linux/.test(ua)
              ? "Linux"
              : "不明";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /CriOS|Chrome\//.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return browser ? `${os} / ${browser}` : os;
}

/** 最終利用日時の更新は、同じ端末なら5分に1回まで（画面の自動更新のたびに DB へ書かないため） */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

type Row = Record<string, unknown>;

/** 端末の記録・紐づけの読み書き */
export class DeviceRepository {
  private lastTouch = new Map<string, number>();

  constructor(private readonly db: DatabaseSync) {}

  /** 端末からのアクセスを記録する（初回は登録）。nowMs はテストで時刻を進めるため */
  touch(id: string, ip: string, userAgent: string, nowText: string, nowMs: number): void {
    const prev = this.lastTouch.get(id);
    if (prev !== undefined && nowMs - prev < TOUCH_INTERVAL_MS) return;
    this.lastTouch.set(id, nowMs);
    this.db
      .prepare(
        `INSERT INTO devices (id, user_agent, last_ip, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET user_agent = excluded.user_agent, last_ip = excluded.last_ip, last_seen = excluded.last_seen`,
      )
      .run(id, userAgent.slice(0, 300), ip, nowText, nowText);
  }

  list(): Device[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, u.name AS user_name,
                (SELECT COUNT(*) FROM histories h WHERE h.device_id = d.id AND h.user_name = '') AS unnamed
           FROM devices d LEFT JOIN users u ON u.id = d.user_id
          ORDER BY d.last_seen DESC`,
      )
      .all() as Row[];
    return rows.map(toDevice);
  }

  get(id: string): Device | null {
    const row = this.db
      .prepare(
        `SELECT d.*, u.name AS user_name,
                (SELECT COUNT(*) FROM histories h WHERE h.device_id = d.id AND h.user_name = '') AS unnamed
           FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? toDevice(row) : null;
  }

  setLink(id: string, userId: number | null, note: string): void {
    this.db.prepare("UPDATE devices SET user_id = ?, note = ? WHERE id = ?").run(userId, note, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    this.lastTouch.delete(id);
  }

  /** 端末に紐づいた有効な入力者の名前。無ければ "" */
  userNameFor(id: string | undefined): string {
    if (!isDeviceId(id)) return "";
    const row = this.db
      .prepare("SELECT u.name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND u.is_active = 1")
      .get(id) as Row | undefined;
    return row ? String(row.name) : "";
  }
}

const toDevice = (r: Row): Device => ({
  id: String(r.id),
  userId: r.user_id == null ? null : Number(r.user_id),
  userName: r.user_name == null ? "" : String(r.user_name),
  note: String(r.note ?? ""),
  label: deviceLabel(String(r.user_agent ?? "")),
  lastIp: String(r.last_ip ?? ""),
  firstSeen: String(r.first_seen),
  lastSeen: String(r.last_seen),
  unnamedCount: Number(r.unnamed ?? 0),
});
