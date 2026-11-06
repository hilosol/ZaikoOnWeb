import type { AuditLog, CodeChange, History, HistoryEdit, MovementType } from "../../shared/types.js";

/** DB の行（node:sqlite が返す形） */
export type Row = Record<string, unknown>;

// DB の行 → 画面に返す型。InventoryService と履歴検索（historySearch.ts）で共用する

export const toHistory = (r: Row): History => ({
  id: Number(r.id),
  productId: r.product_id == null ? null : Number(r.product_id),
  productCode: String(r.product_code),
  productName: String(r.product_name),
  type: String(r.type) as MovementType,
  quantity: Number(r.quantity),
  stockAfter: Number(r.stock_after),
  destination: r.destination == null ? null : String(r.destination),
  comment: r.comment == null ? null : String(r.comment),
  reason: r.reason == null ? null : String(r.reason),
  orderNo: r.order_no == null ? null : String(r.order_no),
  cancelOf: r.cancel_of == null ? null : Number(r.cancel_of),
  canceledBy: r.canceled_by == null ? null : Number(r.canceled_by),
  deviceId: r.device_id == null ? null : String(r.device_id),
  userName: String(r.user_name),
  clientIp: String(r.client_ip),
  createdAt: String(r.created_at),
});

export const toHistoryEdit = (r: Row): HistoryEdit => ({
  id: Number(r.id),
  historyId: Number(r.history_id),
  field: String(r.field),
  before: String(r.before),
  after: String(r.after),
  userName: String(r.user_name),
  clientIp: String(r.client_ip),
  createdAt: String(r.created_at),
});

export const toCodeChange = (r: Row): CodeChange => ({
  id: Number(r.id),
  productId: Number(r.product_id),
  oldCode: String(r.old_code),
  newCode: String(r.new_code),
  productName: String(r.product_name),
  userName: String(r.user_name),
  clientIp: String(r.client_ip),
  createdAt: String(r.created_at),
});

export const toAudit = (r: Row): AuditLog => ({
  id: Number(r.id),
  action: String(r.action) as AuditLog["action"],
  target: String(r.target),
  detail: String(r.detail),
  userName: String(r.user_name),
  clientIp: String(r.client_ip),
  createdAt: String(r.created_at),
});
