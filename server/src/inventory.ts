import type { DatabaseSync } from "node:sqlite";
import {
  InReasons,
  MovementLabels,
  Rules,
  type AuditLog,
  type Device,
  type HistoryEdit,
  CancelableTypes,
  type CodeChange,
  type ImportResult,
  type History,
  type ImageChange,
  type MovementType,
  type OrderNumber,
  type Product,
  type ProductInput,
  type UnassignedIp,
  type User,
  type UserIp,
} from "../../shared/types.js";
import { formatLocal, type Clock } from "./clock.js";
import { transaction } from "./db.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { ImageStore } from "./images.js";
import { mapColumns, parseCsv, unescapeCsvText, type ProductField } from "./productCsv.js";
import { normalizeSuppliers, sameSuppliers, SupplierRepository } from "./suppliers.js";
import { isIP } from "node:net";
import { DeviceRepository, isDeviceId } from "./devices.js";
import { HistorySearch, parseHistoryQuery, type ParsedHistoryQuery } from "./historySearch.js";
import { toAudit, toCodeChange, toHistory, toHistoryEdit, type Row } from "./rows.js";
import { normalizeIp } from "./network.js";
import { isIntegerInRange, matchesKeyword, normalizeText, searchKey, trimText } from "./text.js";

/** 入出庫の付帯情報（すべて任意。移管先は移管のときだけ必須） */
export interface StockDetails {
  destination?: unknown;
  comment?: unknown;
  /** 入庫の理由（入庫のときだけ使う） */
  reason?: unknown;
  orderNo?: unknown;
}

/** 受注番号の照合先（リストファイル）。無くても動く */
export interface OrderNumberLookup {
  find(number: string): OrderNumber | null;
}

/** 操作した人（画面で選んだ名前 + 接続元 IP + 端末ID） */
export interface Actor {
  userName: string;
  clientIp: string;
  /** Cookie で発行した端末ID（無い・不正な値なら undefined） */
  deviceId?: string;
}


const toProduct = (r: Row, suppliers: Product["suppliers"] = []): Product => ({
  id: Number(r.id),
  code: String(r.code),
  name: String(r.name),
  category: String(r.category),
  location: String(r.location ?? ""),
  note: String(r.note ?? ""),
  summary: String(r.summary ?? ""),
  stock: Number(r.stock),
  warningStock: Number(r.warning_stock),
  imageFile: r.image_file == null ? null : String(r.image_file),
  suppliers,
  offBook: Number(r.off_book) === 1,
  version: Number(r.version),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});




const toUser = (r: Row, ips: UserIp[] = []): User => ({ id: Number(r.id), name: String(r.name), active: Number(r.is_active) === 1, ips });


const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

/** 入力値を正規化して検証する。エラーはまとめて返す。 */
export function normalizeProductInput(input: Partial<ProductInput> | null | undefined, isNew: boolean): ProductInput {
  const code = normalizeText(input?.code);
  const name = trimText(input?.name);
  const category = trimText(input?.category);
  // 改行は1行にまとめる（CSV 等から貼り付けた場合）
  const location = trimText(input?.location).replace(/\s*[\r\n]+\s*/g, " ");
  // 備考は複数行を許可（改行コードは \n に統一）
  const note = trimText(input?.note).replace(/\r\n?/g, "\n");
  const summary = trimText(input?.summary).replace(/\r\n?/g, "\n");
  const errors: string[] = [];

  if (!code) errors.push("商品コードを入力してください。");
  else if (code.length > Rules.codeMaxLength) errors.push(`商品コードは${Rules.codeMaxLength}文字以内で入力してください。`);

  if (!name) errors.push("商品名を入力してください。");
  else if (name.length > Rules.nameMaxLength) errors.push(`商品名は${Rules.nameMaxLength}文字以内で入力してください。`);

  if (category.length > Rules.categoryMaxLength) {
    errors.push(`カテゴリは${Rules.categoryMaxLength}文字以内で入力してください。`);
  }

  if (location.length > Rules.locationMaxLength) {
    errors.push(`保管場所は${Rules.locationMaxLength}文字以内で入力してください。`);
  }
  if (summary.length > Rules.summaryMaxLength) {
    errors.push(`概要は${Rules.summaryMaxLength}文字以内で入力してください。`);
  }
  if (note.length > Rules.noteMaxLength) {
    errors.push(`備考は${Rules.noteMaxLength}文字以内で入力してください。`);
  }

  const max = Rules.maxStock.toLocaleString("ja-JP");
  if (!isIntegerInRange(input?.warningStock, 0, Rules.maxStock)) {
    errors.push(`警告在庫は0〜${max}の整数で入力してください。`);
  }
  if (isNew && !isIntegerInRange(input?.initialStock ?? 0, 0, Rules.maxStock)) {
    errors.push(`初期在庫は0〜${max}の整数で入力してください。`);
  }

  // 簿外：省略時は undefined（更新では変更しない、新規は false）
  let offBook: boolean | undefined = isNew ? false : undefined;
  if (input?.offBook !== undefined && input?.offBook !== null) {
    if (typeof input.offBook !== "boolean") errors.push("簿外の指定が正しくありません。");
    else offBook = input.offBook;
  }

  // 購入元：省略時は undefined のまま（＝変更しない）。エラーは他の項目とまとめて返す
  let suppliers: ProductInput["suppliers"];
  if (input?.suppliers !== undefined) {
    try {
      suppliers = normalizeSuppliers(input.suppliers);
    } catch (e) {
      if (e instanceof ValidationError) errors.push(...(e.details ?? [e.message]));
      else throw e;
    }
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return {
    code,
    name,
    category,
    location,
    note,
    summary,
    warningStock: input!.warningStock!,
    initialStock: isNew ? (input?.initialStock ?? 0) : undefined,
    offBook,
    suppliers,
  };
}

/**
 * 在庫に関する業務ルール。HTTP にも画面にも依存しないため、単体テストで直接検証できる。
 */
export class InventoryService {
  private readonly suppliers: SupplierRepository;
  private readonly devices: DeviceRepository;
  private readonly historySearch: HistorySearch;

  constructor(
    private readonly db: DatabaseSync,
    private readonly images: ImageStore,
    private readonly clock: Clock,
    private readonly orderNumbers: OrderNumberLookup | null = null,
  ) {
    this.suppliers = new SupplierRepository(db);
    this.devices = new DeviceRepository(db);
    this.historySearch = new HistorySearch(db);
  }

  /** 履歴ページの検索（raw は URL のクエリ。検証して日本語のエラーにする） */
  searchHistories(raw: Record<string, unknown>, forCsv = false): { query: ParsedHistoryQuery; result: ReturnType<HistorySearch["search"]> } {
    const query = parseHistoryQuery(raw, forCsv);
    return { query, result: this.historySearch.search(query) };
  }

  /** DB の行を Product にする（購入元はまとめて1回で読む） */
  private toProducts(rows: Row[]): Product[] {
    if (rows.length === 0) return [];
    const map = this.suppliers.loadMap(rows.length === 1 ? [Number(rows[0]!.id)] : undefined);
    return rows.map((r) => toProduct(r, map.get(Number(r.id)) ?? []));
  }

  private toOneProduct(row: Row): Product {
    return this.toProducts([row])[0]!;
  }

  private now(): string {
    return formatLocal(this.clock.now());
  }

  // ================================================================ 入力者

  listUsers(includeInactive = false): User[] {
    const sql = includeInactive
      ? "SELECT * FROM users ORDER BY is_active DESC, name"
      : "SELECT * FROM users WHERE is_active = 1 ORDER BY name";
    const ipRows = this.db.prepare("SELECT ip, user_id, note FROM user_ips ORDER BY ip").all() as Row[];
    const ipsByUser = new Map<number, UserIp[]>();
    for (const r of ipRows) {
      const list = ipsByUser.get(Number(r.user_id)) ?? [];
      list.push({ ip: String(r.ip), note: String(r.note) });
      ipsByUser.set(Number(r.user_id), list);
    }
    return (this.db.prepare(sql).all() as Row[]).map((r) => toUser(r, ipsByUser.get(Number(r.id)) ?? []));
  }

  private getUser(id: number): User {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("対象の入力者が見つかりません。");
    const ips = (this.db.prepare("SELECT ip, note FROM user_ips WHERE user_id = ? ORDER BY ip").all(id) as Row[]).map((r) => ({
      ip: String(r.ip),
      note: String(r.note),
    }));
    return toUser(row, ips);
  }

  // ---------------------------------------------------------------- 端末の IP との紐づけ

  /**
   * 端末の IP を入力者に紐づける。入力者を選ばずに操作したとき、この人として記録する。
   * - 1つの IP は1人まで。別の人に紐づいている場合は replace=true のときだけ付け替える
   * - 127.0.0.1 など自分自身のアドレス（サーバーPC本体からの操作）は複数人が使うため紐づけできない
   */
  linkUserIp(userId: number, rawIp: unknown, rawNote: unknown, replace: unknown, actor: Actor): User {
    const ip = normalizeIp(trimText(rawIp));
    if (!ip || isIP(ip) === 0) throw new ValidationError("IP アドレスの形式が正しくありません（例: 192.168.1.23）。");
    if (ip === "::1" || ip.startsWith("127.")) {
      throw new ValidationError("サーバーPC本体（127.0.0.1）は複数の人が使うため、紐づけできません。");
    }
    const note = trimText(rawNote).replace(/\s*[\r\n]+\s*/g, " ");
    if (note.length > Rules.userIpNoteMaxLength) {
      throw new ValidationError(`端末のメモは${Rules.userIpNoteMaxLength}文字以内で入力してください。`);
    }
    return transaction(this.db, () => {
      const user = this.getUser(userId);
      const current = this.db
        .prepare("SELECT u.id, u.name FROM user_ips i JOIN users u ON u.id = i.user_id WHERE i.ip = ?")
        .get(ip) as Row | undefined;
      if (current && Number(current.id) !== userId && replace !== true) {
        throw new ConflictError(`${ip} は既に「${String(current.name)}」に紐づいています。`);
      }
      this.db
        .prepare(
          `INSERT INTO user_ips (ip, user_id, note, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET user_id = excluded.user_id, note = excluded.note`,
        )
        .run(ip, userId, note, this.now());
      const detail = current && Number(current.id) !== userId ? `${String(current.name)} から付け替え` : "紐づけ";
      this.audit("USER_CHANGE", user.name, `IP ${ip}${note ? `（${note}）` : ""} を${detail}`, actor);
      return this.getUser(userId);
    });
  }

  unlinkUserIp(rawIp: unknown, actor: Actor): void {
    const ip = normalizeIp(trimText(rawIp));
    transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT u.name FROM user_ips i JOIN users u ON u.id = i.user_id WHERE i.ip = ?")
        .get(ip) as Row | undefined;
      if (!row) throw new NotFoundError("この IP の紐づけは見つかりません。");
      this.db.prepare("DELETE FROM user_ips WHERE ip = ?").run(ip);
      this.audit("USER_CHANGE", String(row.name), `IP ${ip} の紐づけを解除`, actor);
    });
  }

  /** IP に紐づいた有効な入力者の名前。無ければ ""（無効化された人には紐づけない） */
  userNameForIp(rawIp: unknown): string {
    const ip = normalizeIp(trimText(rawIp));
    if (!ip) return "";
    const row = this.db
      .prepare("SELECT u.name FROM user_ips i JOIN users u ON u.id = i.user_id WHERE i.ip = ? AND u.is_active = 1")
      .get(ip) as Row | undefined;
    return row ? String(row.name) : "";
  }

  /** 名前なしで記録された入出庫の IP（紐づけ済みは除く。最近使われた順） */
  unassignedIps(limit = 20): UnassignedIp[] {
    const rows = this.db
      .prepare(
        `SELECT client_ip AS ip, COUNT(*) AS count, MAX(created_at) AS last_at FROM histories
          WHERE user_name = '' AND client_ip <> '' AND client_ip <> '::1' AND client_ip NOT LIKE '127.%'
            AND client_ip NOT IN (SELECT ip FROM user_ips)
          GROUP BY client_ip ORDER BY last_at DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({ ip: String(r.ip), count: Number(r.count), lastAt: String(r.last_at) }));
  }

  createUser(name: unknown, actor: Actor): User {
    const n = this.validateUserName(name);
    try {
      return transaction(this.db, () => {
        const r = this.db.prepare("INSERT INTO users (name, created_at) VALUES (?, ?)").run(n, this.now());
        this.audit("USER_CHANGE", n, "追加", actor);
        return { id: Number(r.lastInsertRowid), name: n, active: true, ips: [] };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ValidationError(`「${n}」は既に登録されています。`);
      throw e;
    }
  }

  updateUser(id: number, change: { name?: unknown; active?: unknown }, actor: Actor): User {
    try {
      return transaction(this.db, () => {
        const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
        if (!row) throw new NotFoundError("対象の入力者が見つかりません。");
        const before = toUser(row);
        const name = change.name === undefined ? before.name : this.validateUserName(change.name);
        if (change.active !== undefined && typeof change.active !== "boolean") {
          throw new ValidationError("有効/無効の指定が正しくありません。");
        }
        const active = change.active === undefined ? before.active : change.active;

        this.db.prepare("UPDATE users SET name = ?, is_active = ? WHERE id = ?").run(name, active ? 1 : 0, id);
        const details: string[] = [];
        if (name !== before.name) details.push(`名前: ${before.name} → ${name}`);
        if (active !== before.active) details.push(active ? "有効化" : "無効化");
        if (details.length > 0) this.audit("USER_CHANGE", name, details.join(" / "), actor);
        return this.getUser(id);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ValidationError("同じ名前の入力者が既に登録されています。");
      throw e;
    }
  }

  /**
   * 入出庫・移管の入力者。
   * 画面で選んだ名前 → 無ければ端末の IP に紐づいた人 → それも無ければ名前なし（端末の IP は常に記録される）。
   * 名前が指定された場合は、登録済みで有効な名前であること（無効化された名前での記録を防ぐ）。
   */
  resolveStockUser(actor: Actor): string {
    return trimText(actor.userName) === "" ? this.linkedUserName(actor).userName : this.requireActiveUser(actor.userName);
  }

  /** 商品の登録・変更などで使う入力者。画面で選んだ名前 → 無ければ端末に紐づいた人。どちらも無ければエラー */
  requireUser(actor: Actor): string {
    if (trimText(actor.userName) === "") {
      const linked = this.linkedUserName(actor).userName;
      if (linked) return linked;
    }
    return this.requireActiveUser(actor.userName);
  }

  /**
   * 端末に紐づいた入力者：端末ID の紐づけ → IP の紐づけ の順
   * （スマホは IP が変わることがあるため端末ID を優先する）。
   */
  linkedUserName(actor: Pick<Actor, "clientIp" | "deviceId">): { userName: string; source: "device" | "ip" | "" } {
    const byDevice = this.devices.userNameFor(actor.deviceId);
    if (byDevice) return { userName: byDevice, source: "device" };
    const byIp = this.userNameForIp(actor.clientIp);
    return byIp ? { userName: byIp, source: "ip" } : { userName: "", source: "" };
  }

  // ---------------------------------------------------------------- 端末（Cookie の端末ID）

  /** 端末からのアクセスを記録する（初回は登録）。不正な ID は無視 */
  touchDevice(id: string | undefined, ip: string, userAgent: string): void {
    if (!isDeviceId(id)) return;
    const now = this.clock.now();
    this.devices.touch(id, ip, userAgent, formatLocal(now), now.getTime());
  }

  listDevices(): Device[] {
    return this.devices.list();
  }

  /** 端末を入力者に紐づける（userId = null で解除）。メモも同時に保存する */
  linkDevice(id: unknown, userId: unknown, rawNote: unknown, actor: Actor): Device {
    if (!isDeviceId(id)) throw new ValidationError("端末の指定が正しくありません。");
    if (userId !== null && !(typeof userId === "number" && Number.isSafeInteger(userId))) {
      throw new ValidationError("入力者の指定が正しくありません。");
    }
    const note = trimText(rawNote).replace(/\s*[\r\n]+\s*/g, " ");
    if (note.length > Rules.userIpNoteMaxLength) {
      throw new ValidationError(`端末のメモは${Rules.userIpNoteMaxLength}文字以内で入力してください。`);
    }
    return transaction(this.db, () => {
      const before = this.devices.get(id);
      if (!before) throw new NotFoundError("端末が見つかりません。");
      let userName = "";
      if (userId !== null) {
        const row = this.db.prepare("SELECT name FROM users WHERE id = ? AND is_active = 1").get(userId) as Row | undefined;
        if (!row) throw new ValidationError("有効な入力者を選んでください。");
        userName = String(row.name);
      }
      this.devices.setLink(id, userId, note);
      const label = `${before.label}${note ? `（${note}）` : ""}`;
      if (before.userId !== userId) {
        this.audit("USER_CHANGE", userName || before.userName, userId === null ? `端末 ${label} の紐づけを解除` : `端末 ${label} を紐づけ`, actor);
      }
      return this.devices.get(id)!;
    });
  }

  deleteDevice(id: unknown, actor: Actor): void {
    if (!isDeviceId(id)) throw new ValidationError("端末の指定が正しくありません。");
    transaction(this.db, () => {
      const d = this.devices.get(id);
      if (!d) throw new NotFoundError("端末が見つかりません。");
      this.devices.delete(id);
      this.audit("USER_CHANGE", d.userName || "(未紐づけ)", `端末 ${d.label}${d.note ? `（${d.note}）` : ""} を一覧から削除`, actor);
    });
  }


  /** 商品の登録・変更・削除では、登録済みで有効な入力者の名前を必須にする。 */
  requireActiveUser(userName: unknown): string {
    const name = trimText(userName);
    const row = name ? this.db.prepare("SELECT 1 FROM users WHERE name = ? AND is_active = 1").get(name) : undefined;
    if (!row) throw new ValidationError("入力者を選択してください。");
    return name;
  }

  private validateUserName(value: unknown): string {
    const name = trimText(value);
    if (!name) throw new ValidationError("名前を入力してください。");
    if (name.length > Rules.userNameMaxLength) {
      throw new ValidationError(`名前は${Rules.userNameMaxLength}文字以内で入力してください。`);
    }
    return name;
  }

  // ================================================================ 参照

  /**
   * 商品コード・商品名・カテゴリで検索（大文字小文字・全角半角を区別しない）。
   * SQLite の LIKE / lower() は ASCII 以外を正しく扱えないため、絞り込みはメモリ上で行う。
   * 数万件規模になったら全文検索（FTS5）の導入を検討する。
   */
  searchProducts(keyword?: string): Product[] {
    const all = this.toProducts(this.db.prepare("SELECT * FROM products ORDER BY code").all() as Row[]);
    return keyword ? all.filter((p) => matchesKeyword(p, keyword)) : all;
  }

  getProduct(id: number): Product {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("商品が見つかりません。他の人が削除した可能性があります。");
    return this.toOneProduct(row);
  }

  /**
   * 入力・読み取りした ID から商品を探す。無ければ null。
   * スマホのキーボードは小文字が既定のため、大文字小文字は区別しない（"ap-00001" でも AP-00001 が見つかる）。
   * ハイフンの有無も区別しない（"AP00001" でも AP-00001 が見つかる）。
   * 完全一致 → 大文字小文字の違いのみ → ハイフンの違いも無視 の順に探し、
   * 候補が複数あって決められない場合は null（誤った商品を出さないため）。
   */
  findByCode(code: unknown): Product | null {
    const c = normalizeText(code);
    if (!c) return null;
    const rows = this.db.prepare("SELECT * FROM products WHERE code = ? COLLATE NOCASE").all(c) as Row[];
    const exact = rows.find((r) => r.code === c);
    if (exact) return this.toOneProduct(exact);
    if (rows.length === 1) return this.toOneProduct(rows[0]!);
    if (rows.length > 1) return null;

    const key = searchKey(c);
    if (!key) return null;
    const loose = (this.db.prepare("SELECT * FROM products").all() as Row[]).filter((r) => searchKey(r.code) === key);
    return loose.length === 1 ? this.toOneProduct(loose[0]!) : null;
  }

  /**
   * 読み取り・入力したコードから商品を探す。現在のコードで見つからなければ、変更前のコード（旧コード）でも探す
   * （コード変更前に印刷した QR ラベルを読んでも、現在の商品を表示するため）。
   * oldCode: 旧コードで見つかった場合、その旧コード
   */
  lookupCode(code: unknown): { product: Product | null; oldCode: string | null } {
    const current = this.findByCode(code);
    if (current) return { product: current, oldCode: null };
    const c = normalizeText(code);
    if (!c) return { product: null, oldCode: null };
    // 同じ旧コードが何度か使われていた場合は、最後に変更されたものを採る
    let row = this.db
      .prepare("SELECT * FROM product_code_changes WHERE old_code = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1")
      .get(c) as Row | undefined;
    if (!row) {
      const key = searchKey(c);
      if (!key) return { product: null, oldCode: null };
      row = (this.db.prepare("SELECT * FROM product_code_changes ORDER BY id DESC").all() as Row[]).find(
        (r) => searchKey(r.old_code) === key,
      );
    }
    if (!row) return { product: null, oldCode: null };
    const productRow = this.db.prepare("SELECT * FROM products WHERE id = ?").get(Number(row.product_id)) as Row | undefined;
    return productRow ? { product: this.toOneProduct(productRow), oldCode: String(row.old_code) } : { product: null, oldCode: null };
  }

  /** 商品コードの変更履歴（新しい順）。productId 指定時はその商品のみ */
  codeChanges(productId?: number): CodeChange[] {
    const rows =
      productId === undefined
        ? this.db.prepare("SELECT * FROM product_code_changes ORDER BY id DESC").all()
        : this.db.prepare("SELECT * FROM product_code_changes WHERE product_id = ? ORDER BY id DESC").all(productId);
    return (rows as Row[]).map(toCodeChange);
  }

  // ---------------------------------------------------------------- 月別（CSV の自動保存用。month = "YYYY-MM"）

  /** 入出庫履歴・操作ログ・コード変更のいずれかがある月（古い順） */
  activityMonths(): string[] {
    const rows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 7) AS m FROM histories
         UNION SELECT substr(created_at, 1, 7) FROM audit_logs
         UNION SELECT substr(created_at, 1, 7) FROM product_code_changes
         UNION SELECT substr(created_at, 1, 7) FROM history_edits
         ORDER BY m`,
      )
      .all() as { m: string }[];
    return rows.map((r) => r.m).filter((m) => /^\d{4}-\d{2}$/.test(m));
  }

  historiesInMonth(month: string): History[] {
    return (
      this.db.prepare("SELECT * FROM histories WHERE created_at LIKE ? ORDER BY created_at, id").all(`${month}-%`) as Row[]
    ).map(toHistory);
  }

  auditLogsInMonth(month: string): AuditLog[] {
    return (
      this.db.prepare("SELECT * FROM audit_logs WHERE created_at LIKE ? ORDER BY created_at, id").all(`${month}-%`) as Row[]
    ).map(toAudit);
  }

  codeChangesInMonth(month: string): CodeChange[] {
    return (
      this.db.prepare("SELECT * FROM product_code_changes WHERE created_at LIKE ? ORDER BY created_at, id").all(`${month}-%`) as Row[]
    ).map(toCodeChange);
  }

  lowStockProducts(): Product[] {
    return this.toProducts(
      this.db.prepare("SELECT * FROM products WHERE stock <= warning_stock ORDER BY stock, code").all() as Row[],
    );
  }

  recentHistories(limit: number, productId?: number): History[] {
    const n = Math.min(Math.max(Math.trunc(limit) || 0, 0), 1000);
    if (n === 0) return [];
    const rows =
      productId === undefined
        ? this.db.prepare("SELECT * FROM histories ORDER BY created_at DESC, id DESC LIMIT ?").all(n)
        : this.db
            .prepare("SELECT * FROM histories WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
            .all(productId, n);
    return (rows as Row[]).map(toHistory);
  }

  allHistories(): History[] {
    return (this.db.prepare("SELECT * FROM histories ORDER BY created_at, id").all() as Row[]).map(toHistory);
  }

  auditLogs(limit: number): AuditLog[] {
    const n = Math.min(Math.max(Math.trunc(limit) || 0, 0), 1000);
    return (
      this.db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?").all(n) as Row[]
    ).map(toAudit);
  }

  // ================================================================ 商品の登録・更新・削除

  registerProduct(rawInput: Partial<ProductInput>, image: ImageChange, actor: Actor): Product {
    const input = normalizeProductInput(rawInput, true);
    const userName = this.requireUser(actor);
    if (image.action === "remove") throw new ValidationError("画像の指定が正しくありません。");

    const pending: { committed: string | null } = { committed: null };
    try {
      return transaction(this.db, () => {
        this.ensureCodeIsUnique(input.code, null);
        // 画像の確定は DB 更新より前。DB 更新に失敗したら catch で消す
        if (image.action === "replace") pending.committed = this.images.commitUpload(image.uploadId);

        const now = this.now();
        const r = this.db
          .prepare(
            `INSERT INTO products (code, name, category, location, note, summary, stock, warning_stock, image_file, off_book, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(input.code, input.name, input.category, input.location ?? "", input.note ?? "", input.summary ?? "", input.initialStock!, input.warningStock, pending.committed, input.offBook ? 1 : 0, now, now);
        const newId = Number(r.lastInsertRowid);
        if (input.suppliers && input.suppliers.length > 0) this.suppliers.replace(newId, input.suppliers);
        const product = this.getProduct(newId);

        if (product.stock > 0) this.insertHistory(product, "INIT", product.stock, { userName, clientIp: actor.clientIp, deviceId: actor.deviceId });
        this.audit("PRODUCT_CREATE", product.code, `${product.name}（初期在庫 ${product.stock}）`, { ...actor, userName });
        return product;
      });
    } catch (e) {
      this.images.delete(pending.committed);
      throw this.translateUnique(e);
    }
  }

  /**
   * 商品情報を更新する。在庫数は変更しない（在庫は入出庫でのみ変え、必ず履歴を残すため）。
   * expectedVersion が DB と異なる場合は、他の人が先に更新したとみなして ConflictError。
   */
  updateProduct(
    id: number,
    rawInput: Partial<ProductInput>,
    expectedVersion: unknown,
    image: ImageChange,
    actor: Actor,
  ): Product {
    const input = normalizeProductInput(rawInput, false);
    const userName = this.requireUser(actor);
    if (!isIntegerInRange(expectedVersion, 1, Number.MAX_SAFE_INTEGER)) {
      throw new ValidationError("更新対象のバージョンが指定されていません。");
    }

    // 画像の確定は DB 更新より前。DB 更新に失敗したら catch で消す（クロージャ内で代入するためオブジェクトで持つ）
    const pending: { committed: string | null } = { committed: null };
    let result: { after: Product; oldImage: string | null };
    try {
      result = transaction(this.db, () => {
        const before = this.getProduct(id);
        if (before.version !== expectedVersion) throw new ConflictError();
        this.ensureCodeIsUnique(input.code, id);

        let imageFile = before.imageFile;
        if (image.action === "replace") imageFile = pending.committed = this.images.commitUpload(image.uploadId);
        else if (image.action === "remove") imageFile = null;

        this.db
          .prepare(
            `UPDATE products SET code = ?, name = ?, category = ?, location = ?, note = ?, summary = ?, warning_stock = ?, image_file = ?,
                    off_book = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND version = ?`,
          )
          .run(input.code, input.name, input.category, input.location ?? "", input.note ?? "", input.summary ?? "", input.warningStock, imageFile, (input.offBook ?? before.offBook) ? 1 : 0, this.now(), id, expectedVersion);
        if (input.suppliers !== undefined && !sameSuppliers(before.suppliers, input.suppliers)) {
          this.suppliers.replace(id, input.suppliers);
        }

        const after = this.getProduct(id);
        if (before.code !== after.code) this.recordCodeChange(after, before.code, { ...actor, userName });
        this.audit("PRODUCT_UPDATE", after.code, describeChanges(before, after), { ...actor, userName });
        return { after, oldImage: before.imageFile };
      });
    } catch (e) {
      this.images.delete(pending.committed);
      throw this.translateUnique(e);
    }

    // DB の更新が確定してから古い画像を消す（失敗時に画像だけ消えるのを防ぐ）
    if (result.oldImage && result.oldImage !== result.after.imageFile) this.images.delete(result.oldImage);
    return result.after;
  }

  /** 商品を削除する。入出庫の履歴は残す。 */
  deleteProduct(id: number, expectedVersion: unknown, actor: Actor): void {
    const userName = this.requireUser(actor);
    const deleted = transaction(this.db, () => {
      const product = this.getProduct(id);
      if (expectedVersion !== undefined && product.version !== expectedVersion) throw new ConflictError();
      this.db.prepare("DELETE FROM products WHERE id = ?").run(id);
      this.audit("PRODUCT_DELETE", product.code, `${product.name}（削除時の在庫 ${product.stock}）`, { ...actor, userName });
      return product;
    });
    this.images.delete(deleted.imageFile);
  }

  // ================================================================ 入出庫

  /**
   * 入庫・出庫。在庫更新と履歴追加は同一トランザクション。
   * 在庫の増減は「UPDATE ... WHERE 増減後の在庫が範囲内」で行うため、複数の端末から同時に出庫しても
   * 在庫がマイナスになることはない。
   */
  changeStock(id: number, type: unknown, quantity: unknown, actor: Actor, details: StockDetails = {}): Product {
    const { destination, comment, reason } = details;
    if (type !== "IN" && type !== "OUT" && type !== "TRANSFER") {
      throw new ValidationError("入庫・出庫・移管のいずれかを指定してください。");
    }
    // 移管（人・部署への払い出し）は在庫が減る。移管先は必須
    let dest: string | null = null;
    if (type === "TRANSFER") {
      dest = trimText(destination);
      if (!dest) throw new ValidationError("移管先（人・部署）を入力してください。");
      if (dest.length > Rules.destinationMaxLength) {
        throw new ValidationError(`移管先は${Rules.destinationMaxLength}文字以内で入力してください。`);
      }
    }
    if (!isIntegerInRange(quantity, 1, Rules.maxQuantityPerOperation)) {
      throw new ValidationError(
        `数量は1〜${Rules.maxQuantityPerOperation.toLocaleString("ja-JP")}の整数で入力してください。`,
      );
    }
    // コメントは任意。1行にまとめて保存
    const memo = trimText(comment).replace(/\s*[\r\n]+\s*/g, " ");
    if (memo.length > Rules.commentMaxLength) {
      throw new ValidationError(`コメントは${Rules.commentMaxLength}文字以内で入力してください。`);
    }
    // 入庫の理由は任意（PC 画面からは無し）。指定する場合は決まった選択肢のみ。入庫以外では無視する
    let inReason: string | null = null;
    if (type === "IN" && reason !== undefined && reason !== null && reason !== "") {
      if (typeof reason !== "string" || !(InReasons as readonly string[]).includes(reason)) {
        throw new ValidationError(`入庫の理由は ${InReasons.join("・")} から選んでください。`);
      }
      inReason = reason;
    }
    const orderNo = this.normalizeOrderNo(details.orderNo);
    const userName = this.resolveStockUser(actor);
    const delta = type === "IN" ? quantity : -quantity;

    return transaction(this.db, () => {
      const r = this.db
        .prepare(
          `UPDATE products SET stock = stock + ?, updated_at = ?
            WHERE id = ? AND stock + ? BETWEEN 0 AND ?`,
        )
        .run(delta, this.now(), id, delta, Rules.maxStock);

      const product = this.getProduct(id); // 存在しなければ NotFoundError
      if (Number(r.changes) === 0) {
        throw new ValidationError(
          type !== "IN"
            ? `在庫が不足しています（現在の在庫: ${product.stock.toLocaleString("ja-JP")}、${type === "OUT" ? "出庫" : "移管"}数: ${quantity.toLocaleString("ja-JP")}）。`
            : `在庫の上限（${Rules.maxStock.toLocaleString("ja-JP")}）を超えるため入庫できません（現在の在庫: ${product.stock.toLocaleString("ja-JP")}）。`,
        );
      }
      this.insertHistory(product, type, quantity, { userName, clientIp: actor.clientIp, deviceId: actor.deviceId }, dest, memo || null, inReason, orderNo);
      return product;
    });
  }

  /**
   * 在庫調整（棚卸し）：在庫数を実際に数えた数に合わせる。差は「棚卸調整」として履歴に残す。
   * 理由は必須。登録済みの入力者が必要（PC 画面からのみ使う想定）。
   * expectedStock（画面に表示していた在庫）が現在の在庫と違う場合は、他の端末で入出庫があったとみなして ConflictError
   * （数え直した数で、他の人の操作を黙って上書きしないため）。
   */
  adjustStock(id: number, target: unknown, expectedStock: unknown, actor: Actor, reason: unknown): Product {
    if (!isIntegerInRange(target, 0, Rules.maxStock)) {
      throw new ValidationError(`調整後の在庫は0〜${Rules.maxStock.toLocaleString("ja-JP")}の整数で入力してください。`);
    }
    const memo = trimText(reason).replace(/\s*[\r\n]+\s*/g, " ");
    if (!memo) throw new ValidationError("調整の理由を入力してください。");
    if (memo.length > Rules.commentMaxLength) {
      throw new ValidationError(`理由は${Rules.commentMaxLength}文字以内で入力してください。`);
    }
    const userName = this.requireUser(actor);

    return transaction(this.db, () => {
      const current = this.getProduct(id);
      if (expectedStock !== undefined && expectedStock !== current.stock) {
        throw new ConflictError(
          `他の端末で入出庫があり、在庫が ${current.stock.toLocaleString("ja-JP")} に変わっています。数を確認してから、もう一度調整してください。`,
        );
      }
      const delta = target - current.stock;
      if (delta === 0) throw new ValidationError("現在の在庫と同じ数です。調整は不要です。");

      this.db.prepare("UPDATE products SET stock = ?, updated_at = ? WHERE id = ?").run(target, this.now(), id);
      const after = this.getProduct(id);
      this.insertHistory(after, "ADJUST", Math.abs(delta), { userName, clientIp: actor.clientIp, deviceId: actor.deviceId }, null, `${memo}（${delta > 0 ? "+" : ""}${delta}）`);
      return after;
    });
  }

  /** 過去に使った移管先（入力候補用。よく使う順） */
  recentDestinations(limit = 50): string[] {
    const rows = this.db
      .prepare(
        `SELECT destination, COUNT(*) AS n, MAX(created_at) AS last FROM histories
          WHERE type = 'TRANSFER' AND destination IS NOT NULL AND destination <> ''
          GROUP BY destination ORDER BY n DESC, last DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(Math.trunc(limit) || 0, 0), 500)) as Row[];
    return rows.map((r) => String(r.destination));
  }

  // ================================================================ 在庫CSVの取り込み

  /**
   * 在庫CSVを取り込む。dryRun = true なら確認のみ（DB は変更しない）。
   * ・新しい商品コード → 新規登録（在庫は「初期登録」として履歴に残る）
   * ・登録済みの商品コード → CSV にある列の項目を上書き。在庫数が違えば CSV の数に合わせ「棚卸調整」として履歴に残す
   * ・CSV に無い商品は変更しない（削除しない）。CSV に無い列の項目も変更しない
   * 1行でもエラーがあれば何も反映しない（全件を1トランザクションで反映）。
   */
  importProducts(csvText: unknown, dryRun: boolean, actor: Actor): ImportResult {
    if (typeof csvText !== "string" || !csvText.trim()) throw new ValidationError("CSV の内容が空です。");
    const userName = this.requireUser(actor);

    let parsed: { line: number; cells: string[] }[];
    try {
      parsed = parseCsv(csvText);
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
    const [head, ...data] = parsed;
    if (!head || data.length === 0) throw new ValidationError("CSV に見出し行とデータ行が必要です。");
    if (data.length > Rules.maxImportRows) {
      throw new ValidationError(`一度に取り込めるのは ${Rules.maxImportRows.toLocaleString("ja-JP")} 行までです（${data.length.toLocaleString("ja-JP")} 行あります）。`);
    }
    const map = mapColumns(head.cells);
    if (map.index.code === undefined) {
      throw new ValidationError(`「商品コード」の列が見つかりません（見出し: ${head.cells.join(", ")}）。`);
    }
    if (map.duplicated.length > 0) {
      throw new ValidationError(`同じ項目の列が複数あります: ${map.duplicated.join(", ")}`);
    }

    const existing = new Map(this.searchProducts().map((p) => [p.code, p]));
    const seen = new Map<string, number>();
    const errors: ImportResult["errors"] = [];
    type Plan = { line: number; code: string; input: ProductInput; existing?: Product; stockTarget?: number; changes: string[] };
    const plans: Plan[] = [];

    for (const row of data) {
      const get = (f: ProductField): string | undefined => {
        const i = map.index[f];
        return i === undefined ? undefined : unescapeCsvText(row.cells[i] ?? "");
      };
      const code = normalizeText(get("code"));
      const messages: string[] = [];
      if (!code) {
        errors.push({ line: row.line, code: "", messages: ["商品コードが空です。"] });
        continue;
      }
      if (seen.has(code)) {
        errors.push({ line: row.line, code, messages: [`${seen.get(code)}行目と商品コードが重複しています。`] });
        continue;
      }
      seen.set(code, row.line);
      const ex = existing.get(code);

      const num = (f: ProductField, label: string): number | undefined => {
        const v = get(f);
        if (v === undefined) return undefined;
        const t = normalizeText(v).replace(/,/g, "");
        if (t === "") return undefined; // 空欄 = 変更しない（新規なら 0）
        if (!/^-?\d+$/.test(t)) {
          messages.push(`${label}は整数で入力してください（「${v}」）。`);
          return undefined;
        }
        return Number(t);
      };
      const stock = num("stock", "在庫");
      let offBook = ex?.offBook ?? false;
      const offBookText = get("offBook");
      if (offBookText !== undefined) {
        const flag = parseFlag(offBookText);
        if (flag === null) messages.push(`簿外は「○」か空欄で入力してください（「${offBookText}」）。`);
        else offBook = flag;
      }
      const warning = num("warningStock", "警告在庫");
      const pick = (f: ProductField, current: string) => get(f) ?? current;

      if (stock !== undefined && (stock < 0 || stock > Rules.maxStock)) {
        messages.push(`在庫は0〜${Rules.maxStock.toLocaleString("ja-JP")}の範囲で入力してください（「${stock}」）。`);
      }
      if (!ex && get("name") === undefined) messages.push("新規の商品には「商品名」の列が必要です。");
      if (messages.length > 0) {
        errors.push({ line: row.line, code, messages });
        continue;
      }

      let input: ProductInput;
      try {
        input = normalizeProductInput(
          {
            code,
            name: pick("name", ex?.name ?? ""),
            summary: pick("summary", ex?.summary ?? ""),
            category: pick("category", ex?.category ?? ""),
            location: pick("location", ex?.location ?? ""),
            note: pick("note", ex?.note ?? ""),
            warningStock: warning ?? ex?.warningStock ?? 0,
            initialStock: ex ? undefined : (stock ?? 0),
            offBook,
          },
          !ex,
        );
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        errors.push({ line: row.line, code, messages: e.details ?? [e.message] });
        continue;
      }

      if (!ex) {
        plans.push({ line: row.line, code, input, changes: [`新規登録（在庫 ${input.initialStock}）`] });
        continue;
      }
      const changes: string[] = [];
      const diff = (label: string, a: unknown, b: unknown) => {
        if (a !== b) changes.push(`${label}: ${a === "" ? "なし" : a} → ${b === "" ? "なし" : b}`);
      };
      diff("商品名", ex.name, input.name);
      if (ex.summary !== input.summary) changes.push("概要を変更");
      diff("カテゴリ", ex.category, input.category);
      diff("保管場所", ex.location, input.location);
      diff("警告在庫", ex.warningStock, input.warningStock);
      if (ex.note !== input.note) changes.push("備考を変更");
      if (ex.offBook !== input.offBook) changes.push(input.offBook ? "簿外に設定" : "簿外を解除");
      if (stock !== undefined && stock !== ex.stock) changes.push(`在庫: ${ex.stock} → ${stock}（棚卸調整）`);
      plans.push({ line: row.line, code, input, existing: ex, stockTarget: stock, changes });
    }

    const result: ImportResult = {
      dryRun: true,
      columns: map.columns,
      ignoredColumns: map.ignored,
      created: plans.filter((p) => !p.existing).length,
      updated: plans.filter((p) => p.existing && p.changes.length > 0).length,
      stockAdjusted: plans.filter((p) => p.existing && p.stockTarget !== undefined && p.stockTarget !== p.existing.stock).length,
      unchanged: plans.filter((p) => p.existing && p.changes.length === 0).length,
      errors,
      rows: plans.map((p) => ({
        line: p.line,
        code: p.code,
        action: !p.existing ? "create" : p.changes.length > 0 ? "update" : "unchanged",
        changes: p.changes,
      })),
    };
    if (dryRun || errors.length > 0) return result;

    const a: Actor = { userName, clientIp: actor.clientIp, deviceId: actor.deviceId };
    try {
      transaction(this.db, () => {
        const now = this.now();
        for (const p of plans) {
          const i = p.input;
          if (!p.existing) {
            const r = this.db
              .prepare(
                `INSERT INTO products (code, name, category, location, note, summary, stock, warning_stock, image_file, off_book, version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
              )
              .run(i.code, i.name, i.category, i.location ?? "", i.note ?? "", i.summary ?? "", i.initialStock!, i.warningStock, i.offBook ? 1 : 0, now, now);
            const created = this.getProduct(Number(r.lastInsertRowid));
            if (created.stock > 0) this.insertHistory(created, "INIT", created.stock, a, null, "CSV取込");
            continue;
          }
          if (p.changes.length === 0) continue;
          this.db
            .prepare(
              `UPDATE products SET name = ?, category = ?, location = ?, note = ?, summary = ?, warning_stock = ?, off_book = ?,
                      version = version + 1, updated_at = ? WHERE id = ?`,
            )
            .run(i.name, i.category, i.location ?? "", i.note ?? "", i.summary ?? "", i.warningStock, i.offBook ? 1 : 0, now, p.existing.id);
          if (p.stockTarget !== undefined) {
            // 確認後に他の端末で入出庫されていても、取り込み時点の在庫から差を計算する
            const current = this.getProduct(p.existing.id);
            const delta = p.stockTarget - current.stock;
            if (delta !== 0) {
              this.db.prepare("UPDATE products SET stock = ? WHERE id = ?").run(p.stockTarget, current.id);
              const after = this.getProduct(current.id);
              this.insertHistory(after, "ADJUST", Math.abs(delta), a, null, `CSV取込 ${delta > 0 ? "+" : ""}${delta}`);
            }
          }
        }
        this.audit(
          "PRODUCT_IMPORT",
          `${data.length}行`,
          `新規 ${result.created}件・更新 ${result.updated}件（うち在庫調整 ${result.stockAdjusted}件）・変更なし ${result.unchanged}件`,
          a,
        );
      });
    } catch (e) {
      throw this.translateUnique(e);
    }
    return { ...result, dryRun: false };
  }

  // ================================================================ 履歴の修正・取消

  getHistory(id: number): History {
    const row = this.db.prepare("SELECT * FROM histories WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("履歴が見つかりません。");
    return toHistory(row);
  }

  /** 履歴の修正の記録（新しい順）。historyId 指定時はその履歴のみ */
  historyEdits(historyId?: number): HistoryEdit[] {
    const rows =
      historyId === undefined
        ? this.db.prepare("SELECT * FROM history_edits ORDER BY id DESC LIMIT 1000").all()
        : this.db.prepare("SELECT * FROM history_edits WHERE history_id = ? ORDER BY id DESC").all(historyId);
    return (rows as Row[]).map(toHistoryEdit);
  }

  historyEditsInMonth(month: string): HistoryEdit[] {
    return (
      this.db.prepare("SELECT * FROM history_edits WHERE created_at LIKE ? ORDER BY created_at, id").all(`${month}-%`) as Row[]
    ).map(toHistoryEdit);
  }

  /**
   * 履歴のコメント・受注番号を直す（直せるのはこの2つだけ）。項目ごとに修正前 → 修正後を修正履歴に記録する。
   * 数量・区分の間違いは取消して入力し直す。移管先・理由は記録どおりに残す。
   * 省略した項目は変えない。空文字は消す。変わっていない項目は記録しない。
   */
  editHistory(id: number, change: Record<string, unknown>, actor: Actor): History {
    const userName = this.requireUser(actor);
    const other = Object.keys(change).filter((k) => k !== "comment" && k !== "orderNo");
    if (other.length > 0) throw new ValidationError("履歴で直せるのはコメントと紐づけIDだけです。");
    if (change.comment === undefined && change.orderNo === undefined) throw new ValidationError("直す内容を入力してください。");

    let comment: string | undefined;
    if (change.comment !== undefined) {
      if (typeof change.comment !== "string") throw new ValidationError("コメントの形式が正しくありません。");
      comment = trimText(change.comment).replace(/\s*[\r\n]+\s*/g, " ");
      if (comment.length > Rules.commentMaxLength) throw new ValidationError(`コメントは${Rules.commentMaxLength}文字以内で入力してください。`);
    }
    // 受注番号はリストの表記にそろえる（入出庫のときと同じ規則）
    const orderNo = change.orderNo !== undefined ? (this.normalizeOrderNo(change.orderNo) ?? "") : undefined;

    return transaction(this.db, () => {
      const h = this.getHistory(id);
      if (h.type === "CANCEL") throw new ValidationError("取消の履歴は修正できません。");
      const a = { ...actor, userName };
      if (comment !== undefined && (h.comment ?? "") !== comment) {
        this.db.prepare("UPDATE histories SET comment = ? WHERE id = ?").run(comment || null, id);
        this.insertHistoryEdit(id, "comment", h.comment ?? "", comment, a);
      }
      if (orderNo !== undefined && (h.orderNo ?? "") !== orderNo) {
        this.db.prepare("UPDATE histories SET order_no = ? WHERE id = ?").run(orderNo || null, id);
        this.insertHistoryEdit(id, "orderNo", h.orderNo ?? "", orderNo, a);
      }
      return this.getHistory(id);
    });
  }

  /**
   * 入庫・出庫・移管の履歴を取り消す。逆向きの「取消」の履歴を作って在庫を戻し、元の履歴に取消済みの印を付ける
   * （元の履歴は消さない。その後の履歴の処理後在庫とも矛盾しない）。理由は必須。
   */
  cancelHistory(id: number, rawReason: unknown, actor: Actor): History {
    const userName = this.requireUser(actor);
    const memo = trimText(rawReason).replace(/\s*[\r\n]+\s*/g, " ");
    if (!memo) throw new ValidationError("取消の理由を入力してください。");
    if (memo.length > Rules.commentMaxLength) throw new ValidationError(`理由は${Rules.commentMaxLength}文字以内で入力してください。`);

    return transaction(this.db, () => {
      const h = this.getHistory(id);
      if (!CancelableTypes.includes(h.type)) {
        throw new ValidationError(`${MovementLabels[h.type]}の履歴は取り消せません（在庫の修正は「在庫調整」で行ってください）。`);
      }
      if (h.canceledBy !== null) throw new ValidationError("この履歴は既に取り消されています。");
      // 商品を削除しても履歴の product_id は残るため、商品の有無を確かめる
      if (h.productId === null || !this.db.prepare("SELECT 1 FROM products WHERE id = ?").get(h.productId)) {
        throw new ValidationError("商品が削除されているため取り消せません。");
      }
      // 入庫の取消は在庫を減らし、出庫・移管の取消は在庫を増やす
      const delta = h.type === "IN" ? -h.quantity : h.quantity;
      const r = this.db
        .prepare("UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ? AND stock + ? BETWEEN 0 AND ?")
        .run(delta, this.now(), h.productId, delta, Rules.maxStock);
      const product = this.getProduct(h.productId); // 存在しなければ NotFoundError
      if (Number(r.changes) === 0) {
        throw new ValidationError(
          delta < 0
            ? `在庫が足りないため取り消せません（現在の在庫: ${product.stock.toLocaleString("ja-JP")}、取り消す入庫数: ${h.quantity.toLocaleString("ja-JP")}）。`
            : `在庫の上限（${Rules.maxStock.toLocaleString("ja-JP")}）を超えるため取り消せません。`,
        );
      }
      const label = `${h.createdAt.slice(5, 16).replace("-", "/")} ${MovementLabels[h.type]} ${h.quantity}`;
      const a = { userName, clientIp: actor.clientIp, deviceId: actor.deviceId };
      this.insertHistory(product, "CANCEL", h.quantity, a, h.destination, `${label} を取消：${memo}`, null, h.orderNo);
      const cancelId = Number((this.db.prepare("SELECT last_insert_rowid() AS id").get() as Row).id);
      this.db.prepare("UPDATE histories SET cancel_of = ? WHERE id = ?").run(id, cancelId);
      this.db.prepare("UPDATE histories SET canceled_by = ? WHERE id = ?").run(cancelId, id);
      this.insertHistoryEdit(id, "cancel", "", memo, a);
      return this.getHistory(cancelId);
    });
  }

  private insertHistoryEdit(historyId: number, field: string, before: string, after: string, actor: Actor): void {
    this.db
      .prepare(
        "INSERT INTO history_edits (history_id, field, before, after, user_name, client_ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(historyId, field, before, after, actor.userName, actor.clientIp, this.now());
  }

  // ================================================================ 設定変更の記録

  /** 設定画面での変更を監査ログに残す（呼び出し側で入力者を確認済みであること） */
  recordSettingsChange(target: string, detail: string, actor: Actor): void {
    this.audit("SETTINGS_CHANGE", target, detail, actor);
  }

  // ================================================================ 内部処理

  private insertHistory(
    product: Product,
    type: MovementType,
    quantity: number,
    actor: Actor,
    destination: string | null = null,
    comment: string | null = null,
    reason: string | null = null,
    orderNo: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO histories (product_id, product_code, product_name, type, quantity, stock_after, destination, comment, reason, order_no, device_id, user_name, client_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(product.id, product.code, product.name, type, quantity, product.stock, destination, comment, reason, orderNo, isDeviceId(actor.deviceId) ? actor.deviceId : null, actor.userName, actor.clientIp, this.now());
  }

  /**
   * 受注番号を検証・整形する。空なら null。
   * リストにある番号は、大文字小文字・全角半角・ハイフンの違いを吸収してリストの表記にそろえる
   * （「yho26002」と入力しても「YHO-26002」で記録し、後で番号ごとに集計できるようにする）。
   * リストに無い番号もそのまま記録できる（新しい案件でリストの更新前に使う場合など）。
   */
  private normalizeOrderNo(raw: unknown): string | null {
    if (raw !== undefined && raw !== null && typeof raw !== "string") throw new ValidationError("紐づけIDの形式が正しくありません。");
    const text = trimText(raw).replace(/\s*[\r\n]+\s*/g, " ");
    if (!text) return null;
    if (text.length > Rules.orderNoMaxLength) {
      throw new ValidationError(`紐づけIDは${Rules.orderNoMaxLength}文字以内で入力してください。`);
    }
    return this.orderNumbers?.find(text)?.number ?? text;
  }

  /** リストに無いが最近入力された受注番号（新しい順・重複なし） */
  recentOrderNumbers(limit = 30): string[] {
    const rows = this.db
      .prepare(
        `SELECT order_no, MAX(id) AS last FROM histories WHERE order_no IS NOT NULL AND order_no <> ''
          GROUP BY order_no ORDER BY last DESC LIMIT ?`,
      )
      .all(limit * 3) as Row[];
    return rows
      .map((r) => String(r.order_no))
      .filter((n) => !this.orderNumbers?.find(n))
      .slice(0, limit);
  }

  private recordCodeChange(product: Product, oldCode: string, actor: Actor): void {
    this.db
      .prepare(
        `INSERT INTO product_code_changes (product_id, old_code, new_code, product_name, user_name, client_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(product.id, oldCode, product.code, product.name, actor.userName, actor.clientIp, this.now());
  }

  private audit(action: AuditLog["action"], target: string, detail: string, actor: Actor): void {
    this.db
      .prepare(
        "INSERT INTO audit_logs (action, target, detail, user_name, client_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(action, target, detail, actor.userName || "(未選択)", actor.clientIp, this.now());
  }

  private ensureCodeIsUnique(code: string, excludeId: number | null): void {
    const row = this.db.prepare("SELECT id FROM products WHERE code = ?").get(code) as Row | undefined;
    if (row && Number(row.id) !== excludeId) throw new ValidationError(`商品コード「${code}」は既に登録されています。`);
  }

  private translateUnique(e: unknown): unknown {
    return isUniqueViolation(e) ? new ValidationError("同じ商品コードが既に登録されています。") : e;
  }
}

/** CSV の「簿外」列：○・1・はい 等 → true、空欄・0・いいえ 等 → false、それ以外 → null（エラー） */
export function parseFlag(text: string): boolean | null {
  const t = normalizeText(text).toLowerCase();
  if (["○", "〇", "◯", "●", "1", "はい", "yes", "y", "true", "簿外", "✓", "✔", "レ"].includes(t)) return true;
  if (["", "0", "いいえ", "no", "n", "false", "×", "✕", "-", "ー"].includes(t)) return false;
  return null;
}

function describeChanges(before: Product, after: Product): string {
  const changes: string[] = [];
  const add = (label: string, a: unknown, b: unknown) => {
    if (a !== b) changes.push(`${label}: ${a ?? "なし"} → ${b ?? "なし"}`);
  };
  add("コード", before.code, after.code);
  add("商品名", before.name, after.name);
  add("カテゴリ", before.category, after.category);
  add("保管場所", before.location, after.location);
  if (before.summary !== after.summary) changes.push("概要を変更");
  if (before.note !== after.note) changes.push("備考を変更");
  add("警告在庫", before.warningStock, after.warningStock);
  if (before.offBook !== after.offBook) changes.push(after.offBook ? "簿外に設定" : "簿外を解除");
  if (before.imageFile !== after.imageFile) changes.push(after.imageFile ? "画像を変更" : "画像を削除");
  if (!sameSuppliers(before.suppliers, after.suppliers)) {
    changes.push(`購入元: ${after.suppliers.map((s) => s.name).join("・") || "なし"}`);
  }
  return changes.length > 0 ? changes.join(" / ") : "変更なし";
}
