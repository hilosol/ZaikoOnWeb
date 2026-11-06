import type { EditingInfo } from "../../shared/types.js";
import type { Clock } from "./clock.js";
import { ValidationError } from "./errors.js";

/**
 * 「誰がどの商品を編集中か」をメモリに持つ（DB には残さない。サーバーを再起動すれば消えてよい情報）。
 * 編集画面は15秒ごとに知らせ（heartbeat）、知らせが途絶えて EXPIRE_MS 経ったら編集中ではないとみなす。
 * 画面を閉じたまま・通信が切れたままでも自然に消えるので、ロックのような「解除し忘れ」が起きない。
 */
export const EDITING_EXPIRE_MS = 90_000; // 背景のタブではタイマーが1分に1回程度に間引かれるため、余裕を持たせる
const SESSION_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
/** 1つの商品を同時に編集中として数える上限（いたずら・不具合でメモリを使いすぎないため） */
const MAX_SESSIONS_PER_PRODUCT = 50;

interface Session {
  userName: string;
  clientIp: string;
  since: number;
  lastSeen: number;
}

export class EditingPresence {
  private readonly products = new Map<number, Map<string, Session>>();
  /** 閉じた編集画面。閉じた後に届いた知らせ（通信の順番が入れ替わったもの）で「編集中」に戻さないため */
  private readonly closed = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  private now(): number {
    return this.clock.now().getTime();
  }

  private alive(productId: number): Map<string, Session> {
    const sessions = this.products.get(productId);
    if (!sessions) return new Map();
    const limit = this.now() - EDITING_EXPIRE_MS;
    for (const [id, s] of sessions) if (s.lastSeen < limit) sessions.delete(id);
    if (sessions.size === 0) this.products.delete(productId);
    return sessions;
  }

  private static checkSession(sessionId: unknown): string {
    if (typeof sessionId !== "string" || !SESSION_PATTERN.test(sessionId)) throw new ValidationError("編集の識別子が正しくありません。");
    return sessionId;
  }

  /** 編集中であることを知らせ、自分以外に編集中の人を返す */
  heartbeat(productId: number, sessionId: unknown, userName: string, clientIp: string): EditingInfo[] {
    const id = EditingPresence.checkSession(sessionId);
    this.forgetOldClosed();
    if (this.closed.has(id)) return this.others(productId, id);
    const sessions = this.alive(productId);
    const existing = sessions.get(id);
    if (!existing && sessions.size >= MAX_SESSIONS_PER_PRODUCT) return this.others(productId, id);
    sessions.set(id, { userName, clientIp, since: existing?.since ?? this.now(), lastSeen: this.now() });
    this.products.set(productId, sessions);
    return this.others(productId, id);
  }

  /** 編集画面を閉じた */
  leave(productId: number, sessionId: unknown): void {
    const id = EditingPresence.checkSession(sessionId);
    this.forgetOldClosed();
    this.closed.set(id, this.now());
    const sessions = this.products.get(productId);
    sessions?.delete(id);
    if (sessions && sessions.size === 0) this.products.delete(productId);
  }

  private forgetOldClosed(): void {
    const limit = this.now() - EDITING_EXPIRE_MS;
    for (const [id, at] of this.closed) if (at < limit) this.closed.delete(id);
  }

  /** その商品を編集中の人（exceptSession を除く。編集を始めた順） */
  others(productId: number, exceptSession = ""): EditingInfo[] {
    return [...this.alive(productId).entries()]
      .filter(([id]) => id !== exceptSession)
      .sort((a, b) => a[1].since - b[1].since)
      .map(([, s]) => ({ userName: s.userName, clientIp: s.clientIp, since: new Date(s.since).toISOString() }));
  }

  /** 編集中の商品の一覧（商品一覧に印を付けるため） */
  all(): Record<number, EditingInfo[]> {
    const result: Record<number, EditingInfo[]> = {};
    for (const productId of [...this.products.keys()]) {
      const list = this.others(productId);
      if (list.length > 0) result[productId] = list;
    }
    return result;
  }
}
