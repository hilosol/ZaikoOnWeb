import type {
  ApiErrorBody,
  AuditLog,
  CodeChange,
  ImportResult,
  History,
  MailSendResult,
  MailSettingsRequest,
  GeneralSettings,
  UpdateStatusResponse,
  MailSettingsResponse,
  Product,
  SaveProductRequest,
  StockRequest,
  User,
} from "../../shared/types";
import type {
  Device,
  HistoryEdit,
  HistoryEditRequest,
  HistorySearchResult,
  LogExportStatus,
  OrderNumbersResponse,
  UnassignedIp,
  WhoAmI,
} from "../../shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

const OFFLINE_MESSAGE =
  "サーバーに接続できません。サーバーPCが起動しているか、同じネットワーク（社内Wi-Fi）に接続しているか確認してください。";

async function request<T>(method: string, url: string, body?: unknown, contentType = "application/json"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": contentType },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, OFFLINE_MESSAGE);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // 403（社外からのアクセス）などはテキストで返る
  }
  if (!res.ok) {
    const err = data as ApiErrorBody | undefined;
    throw new ApiError(res.status, err?.error ?? (text || `エラーが発生しました（${res.status}）`), err?.details ?? []);
  }
  return data as T;
}

export const api = {
  users: (includeInactive = false) => request<User[]>("GET", `/api/users${includeInactive ? "?all=1" : ""}`),
  createUser: (name: string, userName: string) => request<User>("POST", "/api/users", { name, userName }),
  updateUser: (id: number, change: { name?: string; active?: boolean }, userName: string) =>
    request<User>("PATCH", `/api/users/${id}`, { ...change, userName }),

  products: () => request<Product[]>("GET", "/api/products"),
  product: (id: number) => request<Product>("GET", `/api/products/${id}`),
  productByCode: (code: string) =>
    request<{ product: Product | null; oldCode: string | null }>("GET", `/api/products/by-code/${encodeURIComponent(code)}`),
  codeChanges: (productId: number) => request<CodeChange[]>("GET", `/api/products/${productId}/code-changes`),
  destinations: () => request<string[]>("GET", "/api/destinations"),
  whoami: () => request<WhoAmI>("GET", "/api/whoami"),
  historyDetail: (id: number) => request<{ history: History; edits: HistoryEdit[] }>("GET", `/api/histories/${id}`),
  editHistory: (id: number, req: HistoryEditRequest) => request<History>("PATCH", `/api/histories/${id}`, req),
  cancelHistory: (id: number, reason: string, userName: string) =>
    request<History>("POST", `/api/histories/${id}/cancel`, { reason, userName }),
  devices: () => request<Device[]>("GET", "/api/devices"),
  linkDevice: (id: string, userId: number | null, note: string, userName: string) =>
    request<Device>("PATCH", `/api/devices/${id}`, { userId, note, userName }),
  deleteDevice: (id: string, userName: string) => request<void>("DELETE", `/api/devices/${id}`, { userName }),
  historySearch: <T,>(query: Record<string, string>) =>
    request<HistorySearchResult<T>>("GET", `/api/history-search?${new URLSearchParams(query).toString()}`),
  historySearchCsvUrl: (query: Record<string, string>) => `/api/history-search.csv?${new URLSearchParams(query).toString()}`,
  orderNumbers: () => request<OrderNumbersResponse>("GET", "/api/order-numbers"),
  linkUserIp: (userId: number, ip: string, note: string, replace: boolean, userName: string) =>
    request<User>("POST", `/api/users/${userId}/ips`, { ip, note, replace, userName }),
  unlinkUserIp: (ip: string, userName: string) => request<void>("DELETE", `/api/user-ips/${encodeURIComponent(ip)}`, { userName }),
  unassignedIps: () => request<UnassignedIp[]>("GET", "/api/unassigned-ips"),
  lowStock: () => request<Product[]>("GET", "/api/low-stock"),
  histories: (limit: number, productId?: number) =>
    request<History[]>("GET", `/api/histories?limit=${limit}${productId ? `&productId=${productId}` : ""}`),
  auditLogs: (limit = 100) => request<AuditLog[]>("GET", `/api/audit-logs?limit=${limit}`),
  serverInfo: () => request<{ urls: string[] }>("GET", "/api/server-info"),

  createProduct: (req: SaveProductRequest) => request<Product>("POST", "/api/products", req),
  updateProduct: (id: number, req: SaveProductRequest) => request<Product>("PUT", `/api/products/${id}`, req),
  deleteProduct: (id: number, version: number, userName: string) =>
    request<void>("DELETE", `/api/products/${id}`, { version, userName }),
  changeStock: (id: number, req: StockRequest) => request<Product>("POST", `/api/products/${id}/stock`, req),
  adjustStock: (id: number, stock: number, expectedStock: number, reason: string, userName: string) =>
    request<Product>("POST", `/api/products/${id}/adjust`, { stock, expectedStock, reason, userName }),

  logExport: () => request<LogExportStatus>("GET", "/api/log-export"),
  runLogExport: () => request<LogExportStatus>("POST", "/api/log-export/run", {}),
  updateStatus: () => request<UpdateStatusResponse>("GET", "/api/update/status"),
  updateCheck: () => request<UpdateStatusResponse>("POST", "/api/update/check"),
  updateRun: () => request<UpdateStatusResponse>("POST", "/api/update/run", {}),
  updateToken: (token: string) => request<UpdateStatusResponse>("PUT", "/api/update/token", { token }),
  generalSettings: () => request<GeneralSettings>("GET", "/api/settings/general"),
  saveGeneralSettings: (change: Partial<GeneralSettings>, userName: string) =>
    request<GeneralSettings>("PUT", "/api/settings/general", { ...change, userName }),
  mailSettings: () => request<MailSettingsResponse>("GET", "/api/settings/mail"),
  saveMailSettings: (req: MailSettingsRequest) => request<MailSettingsResponse>("PUT", "/api/settings/mail", req),
  testMail: (req: MailSettingsRequest) => request<MailSendResult>("POST", "/api/settings/mail/test", req),
  sendLowStockMailNow: (userName: string) => request<MailSendResult>("POST", "/api/settings/mail/send-now", { userName }),

  importProducts: (csv: string, dryRun: boolean, userName: string) =>
    request<ImportResult>("POST", "/api/products/import", { csv, dryRun, userName }),
  upload: (blob: Blob) => request<{ uploadId: string }>("POST", "/api/uploads", blob, blob.type || "image/jpeg"),
};

export const imageUrl = (file: string | null | undefined) => (file ? `/api/images/${encodeURIComponent(file)}` : null);

export const errorMessage = (e: unknown) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : "予期しないエラーが発生しました。";
