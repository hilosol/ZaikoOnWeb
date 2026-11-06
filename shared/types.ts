/**
 * サーバーと画面で共有する型・定数。
 * 業務ルールの上限値はここに集約し、画面側の入力欄の制限とサーバー側の検証で同じ値を使う。
 */

export const Rules = {
  codeMaxLength: 50,
  nameMaxLength: 100,
  categoryMaxLength: 50,
  locationMaxLength: 100,
  destinationMaxLength: 50,
  noteMaxLength: 500,
  summaryMaxLength: 500,
  commentMaxLength: 200,
  orderNoMaxLength: 50,
  userNameMaxLength: 30,
  userIpNoteMaxLength: 30,
  /** 購入元：1商品あたりの件数・名前・URL の上限 */
  maxSuppliers: 5,
  supplierNameMaxLength: 50,
  supplierUrlMaxLength: 500,
  /** メール通知の宛先数の上限 */
  maxMailRecipients: 20,
  maxStock: 1_000_000,
  maxQuantityPerOperation: 100_000,
  /** 画面側で縮小した後の画像の上限 */
  maxUploadBytes: 5 * 1024 * 1024,
  /** 在庫CSVの取り込み */
  maxImportRows: 5000,
  maxImportBytes: 10 * 1024 * 1024,
  imageMaxDimension: 1024,
} as const;

/**
 * IN: 入庫 / OUT: 出庫 / TRANSFER: 人・部署への移管（在庫は減る） / INIT: 商品登録時の初期在庫
 * ADJUST: 棚卸調整（CSV 取り込みで在庫数を合わせた。quantity は差の絶対値、増減はコメントに記録）
 */
export type MovementType = "IN" | "OUT" | "TRANSFER" | "INIT" | "ADJUST" | "CANCEL";

/** 入庫の理由（スマホ画面の入庫で選ぶ）。集計できるよう決まった選択肢にする */
export const InReasons = ["購入", "戻り", "その他"] as const;
export type InReason = (typeof InReasons)[number];

export const MovementLabels: Record<MovementType, string> = {
  IN: "入庫",
  OUT: "出庫",
  TRANSFER: "移管",
  INIT: "初期登録",
  ADJUST: "棚卸調整",
  CANCEL: "取消",
};

/** 取消できる区分（初期登録・棚卸調整は在庫調整で直す） */
export const CancelableTypes: readonly MovementType[] = ["IN", "OUT", "TRANSFER"];

export interface Product {
  id: number;
  code: string;
  name: string;
  category: string;
  /** 保管場所（自由入力。複数ある場合は「上段A-1,上段B-1」のように区切る） */
  location: string;
  /** 概要（商品の説明。改行可。検索対象） */
  summary: string;
  /** 備考（商品ごとの固定メモ。改行可） */
  note: string;
  stock: number;
  warningStock: number;
  /** 画像のファイル名。null = 画像なし */
  imageFile: string | null;
  /** 購入元（登録順。0〜Rules.maxSuppliers 件） */
  suppliers: Supplier[];
  /** 簿外（帳簿に載せていない在庫）。在庫警告の対象には含める */
  offBook: boolean;
  /** 楽観的排他制御用。更新のたびに +1 */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 購入元（仕入先）。URL は任意で、http / https のみ */
export interface Supplier {
  name: string;
  /** 空文字 = URL なし */
  url: string;
}

export interface History {
  id: number;
  productId: number | null;
  productCode: string;
  productName: string;
  type: MovementType;
  quantity: number;
  stockAfter: number;
  /** 移管先（移管の場合のみ） */
  destination: string | null;
  /** 操作時のコメント（任意） */
  comment: string | null;
  /** 入庫の理由（購入・戻り・その他。入庫以外・未指定は null） */
  reason: string | null;
  /** 受注番号（任意。入庫・出庫・移管で入力） */
  orderNo: string | null;
  /** 取消の履歴の場合、取り消した元の履歴の ID */
  cancelOf: number | null;
  /** 取り消された履歴の場合、取消の履歴の ID */
  canceledBy: number | null;
  /** 操作した端末の ID（端末ID導入前の履歴は null） */
  deviceId: string | null;
  userName: string;
  clientIp: string;
  createdAt: string;
}

/** 商品コードの変更履歴 */
export interface CodeChange {
  id: number;
  /** 商品を削除した後も履歴は残す（その場合も ID はそのまま） */
  productId: number;
  oldCode: string;
  newCode: string;
  productName: string;
  userName: string;
  clientIp: string;
  createdAt: string;
}

/** 履歴の修正（受注番号・コメント等の変更、取消）の記録 */
export interface HistoryEdit {
  id: number;
  historyId: number;
  /** orderNo / comment / destination / reason / cancel */
  field: string;
  before: string;
  after: string;
  userName: string;
  clientIp: string;
  createdAt: string;
}

export const HistoryFieldLabels: Record<string, string> = {
  orderNo: "紐づけID",
  comment: "コメント",
  destination: "移管先",
  reason: "理由",
  cancel: "取消",
};

/** 履歴で直せるのはコメントと受注番号だけ（数量・区分は取消して入力し直す）。省略した項目は変えない */
export interface HistoryEditRequest {
  comment?: string;
  orderNo?: string;
  userName: string;
}

/** 端末（ブラウザ）。初回アクセス時に Cookie で ID を発行する */
export interface Device {
  id: string;
  /** 紐づけた入力者（未紐づけは null） */
  userId: number | null;
  userName: string;
  note: string;
  /** 機種・ブラウザ（User-Agent から推定。例: iPhone / Safari） */
  label: string;
  lastIp: string;
  firstSeen: string;
  lastSeen: string;
  /** 名前なしで記録された入出庫の件数（紐づけの手がかり） */
  unnamedCount: number;
}

export interface User {
  id: number;
  name: string;
  active: boolean;
  /** この人に紐づけた端末の IP アドレス（入力者を選ばずに操作したとき、この人として記録する） */
  ips: UserIp[];
}

export interface UserIp {
  ip: string;
  /** 端末のメモ（例: iPhone、事務所PC） */
  note: string;
}

/** 名前なし（入力者未選択・未紐づけ）で記録された端末の IP（紐づけの候補） */
export interface UnassignedIp {
  ip: string;
  count: number;
  lastAt: string;
}

export interface WhoAmI {
  ip: string;
  deviceId: string;
  /** この端末に紐づいた入力者（端末ID → IP の順。有効な人のみ。無ければ ""） */
  userName: string;
  source: "device" | "ip" | "";
}

export interface AuditLog {
  id: number;
  action: "PRODUCT_CREATE" | "PRODUCT_UPDATE" | "PRODUCT_DELETE" | "PRODUCT_IMPORT" | "USER_CHANGE" | "SETTINGS_CHANGE";
  target: string;
  detail: string;
  userName: string;
  clientIp: string;
  createdAt: string;
}

export const AuditLabels: Record<AuditLog["action"], string> = {
  PRODUCT_CREATE: "商品登録",
  PRODUCT_UPDATE: "商品更新",
  PRODUCT_DELETE: "商品削除",
  PRODUCT_IMPORT: "CSV取込",
  USER_CHANGE: "入力者設定",
  SETTINGS_CHANGE: "設定変更",
};

/** 画像の変更内容 */
export type ImageChange =
  | { action: "keep" }
  | { action: "remove" }
  | { action: "replace"; uploadId: string };

export interface ProductInput {
  code: string;
  name: string;
  category: string;
  location?: string;
  note?: string;
  summary?: string;
  warningStock: number;
  /** 簿外。省略（undefined）= 変更しない（新規は false） */
  offBook?: boolean;
  /** 購入元。省略（undefined）= 変更しない（CSV 取り込みなど購入元を扱わない経路のため） */
  suppliers?: Supplier[];
  /** 新規登録時のみ有効 */
  initialStock?: number;
}

export interface SaveProductRequest extends ProductInput {
  userName: string;
  image: ImageChange;
  /** 更新時に必須：画面で読み込んだ時点の version */
  version?: number;
}

export interface StockRequest {
  type: "IN" | "OUT" | "TRANSFER";
  quantity: number;
  userName: string;
  /** 移管の場合は必須 */
  destination?: string;
  /** 任意のコメント */
  comment?: string;
  /** 入庫の理由（InReasons のいずれか。入庫のみ） */
  reason?: string;
  /** 受注番号（任意。リストに無い番号も入力可） */
  orderNo?: string;
}

/** 受注番号リストの1件（リストファイルの「受注番号_案件名」を分けたもの） */
export interface OrderNumber {
  number: string;
  /** 案件名（「_」より後ろ。無ければ ""） */
  name: string;
}

export interface OrderListStatus {
  /** リストファイルのパス（サーバーPC上） */
  file: string;
  exists: boolean;
  count: number;
  /** ファイルの更新日時 */
  modifiedAt: string | null;
  /** 読み込めなかった場合の理由（前回読めた内容を使い続ける） */
  error: string;
  /** 読み飛ばした行数（長すぎる等） */
  skipped: number;
}

export interface OrderNumbersResponse {
  items: OrderNumber[];
  /** リストに無いが最近入力された番号（新しい順） */
  recent: string[];
  status: OrderListStatus;
}

export interface ApiErrorBody {
  error: string;
  details?: string[];
}

/** 在庫CSVの取り込み結果（確認時・実行時とも同じ形） */
export interface ImportResult {
  /** true = 確認のみ（DB は変更していない） */
  dryRun: boolean;
  /** 取り込みに使った列（CSV の見出し → 項目名） */
  columns: { header: string; field: string }[];
  /** 使わなかった列の見出し */
  ignoredColumns: string[];
  created: number;
  updated: number;
  /** 在庫数を合わせた件数（更新・新規に含まれる） */
  stockAdjusted: number;
  unchanged: number;
  errors: { line: number; code: string; messages: string[] }[];
  rows: { line: number; code: string; action: "create" | "update" | "unchanged"; changes: string[] }[];
}

/** 履歴 CSV の自動書き出しの状態 */
export interface LogExportStatus {
  /** 書き出し先フォルダ（サーバーの PC 上のパス） */
  dir: string;
  lastRunAt: string | null;
  written: number;
  failures: { file: string; reason: string }[];
}

// ================================================================ メール通知

/** none: 暗号化なし（社内リレー・25番） / starttls: 587番など / ssl: 465番 */
export type SmtpSecurity = "none" | "starttls" | "ssl";
export const SmtpSecurityLabels: Record<SmtpSecurity, string> = {
  none: "なし",
  starttls: "STARTTLS",
  ssl: "SSL/TLS",
};

/** メール通知の設定（画面に返す形。パスワードは返さず、設定済みかどうかだけ返す） */
export interface MailSettings {
  /** 毎日の在庫警告メールを送るか */
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  /** 自己署名証明書の社内サーバーを許可する（暗号化ありの場合のみ意味がある） */
  allowSelfSignedCert: boolean;
  /** 認証ユーザー（空 = 認証なし） */
  authUser: string;
  hasPassword: boolean;
  from: string;
  to: string[];
  /** 毎日の送信時刻 "HH:MM"（このPCの時計） */
  sendTime: string;
  /** メール内のリンクに使う画面のアドレス（空 = このPCの社内 IP から自動） */
  siteUrl: string;
}

/** 保存・テスト送信で送る形 */
export interface MailSettingsRequest extends Omit<MailSettings, "hasPassword" | "to"> {
  /** 配列、または改行・カンマ区切りの文字列 */
  to: string[] | string;
  /** 空・省略 = 保存済みのパスワードを使う */
  password?: string;
  /** true = 保存済みのパスワードを消す */
  clearPassword?: boolean;
  userName: string;
}

export interface MailStatus {
  /** 最後に送信を試みた日時と結果（テスト送信・手動送信・毎日の送信のいずれか） */
  lastAttemptAt: string | null;
  lastKind: "test" | "manual" | "daily" | null;
  lastOk: boolean | null;
  lastMessage: string;
  /** 毎日の送信を済ませた日（YYYY-MM-DD） */
  dailyDoneDate: string | null;
}

export interface MailSettingsResponse {
  settings: MailSettings;
  status: MailStatus;
  /** siteUrl が空のときに使われるアドレス */
  defaultSiteUrl: string;
}

export interface MailSendResult {
  sent: boolean;
  message: string;
}

// ================================================================ 履歴ページ（検索）

export type HistoryKind = "movements" | "edits" | "audit" | "codes";

export const HistoryKindLabels: Record<HistoryKind, string> = {
  movements: "入出庫",
  edits: "履歴の修正",
  audit: "操作ログ",
  codes: "コード変更",
};

/** 取消の扱い：all = すべて表示 / exclude = 取り消された履歴と取消の履歴を除く / only = それらだけ */
export type CanceledFilter = "all" | "exclude" | "only";

export interface HistorySearchQuery {
  kind: HistoryKind;
  /** 期間（YYYY-MM-DD。両端を含む。省略 = 制限なし） */
  from?: string;
  to?: string;
  /** キーワード（商品コード・名前・コメント・移管先・入力者など。大文字小文字・全角半角・ハイフン・ひらがなカタカナを区別しない） */
  q?: string;
  /** 以下は入出庫のみ */
  types?: MovementType[];
  canceled?: CanceledFilter;
  /** 入力者（"" = 未登録。省略 = すべて） */
  user?: string;
  orderNo?: string;
  productId?: number;
  limit?: number;
  offset?: number;
}

/** 修正記録の行（どの商品の履歴か分かるよう、商品コード・名前を付ける） */
export interface HistoryEditRow extends HistoryEdit {
  productCode: string;
  productName: string;
  historyType: MovementType | null;
}

export interface HistorySearchResult<T> {
  total: number;
  rows: T[];
  /** 入出庫のみ：絞り込んだ範囲の数量の合計（取り消された履歴は除く） */
  summary?: { IN: number; OUT: number; TRANSFER: number };
}

/** バックアップを残す期間 */
export type BackupRetention = "7d" | "30d" | "90d" | "1y" | "generations" | "unlimited";

export const BackupRetentionLabels: Record<BackupRetention, string> = {
  "7d": "7日分",
  "30d": "30日分",
  "90d": "90日分",
  "1y": "1年分",
  generations: "世代管理（直近30日は毎日・12か月は月1回・それより前は年1回）",
  unlimited: "無制限（消さない）",
};

export interface BackupSettings {
  retention: BackupRetention;
  /** 追加の保存先（外付けドライブ・USB 等のフォルダ。"" = サーバーPC内のみ） */
  extraDir: string;
}

export const DefaultBackupSettings: BackupSettings = { retention: "30d", extraDir: "" };

/** 保存先ごとの状態 */
export interface BackupPlaceStatus {
  /** フォルダのフルパス */
  dir: string;
  /** 最後に試した日時・結果 */
  lastAttemptAt: string | null;
  lastOk: boolean | null;
  lastMessage: string;
  /** 最後に成功した日時 */
  lastSuccessAt: string | null;
  /** バックアップの件数・合計サイズ（バイト）。読めなければ null */
  count: number | null;
  totalBytes: number | null;
  /** 保存先ドライブの空き容量（バイト）。取得できなければ null */
  freeBytes: number | null;
}

export interface BackupView {
  settings: BackupSettings;
  local: BackupPlaceStatus;
  /** 追加の保存先を設定していなければ null */
  extra: BackupPlaceStatus | null;
}

/** 空き容量がこれを下回ったら警告する */
export const BACKUP_LOW_FREE_BYTES = 1024 * 1024 * 1024;

/** プログラムの更新の状態（サーバーPCの画面にだけ返す） */
export interface UpdateStatus {
  /** GitHub とつながったフォルダか（setup-github.bat 済み） */
  supported: boolean;
  /** 今の版（コミットの短い ID。未確認なら ""） */
  current: string;
  /** 新しい版があるか（最後に確認した時点） */
  available: boolean;
  /** 新しい版の変更内容（新しい順。「ID 件名」） */
  commits: string[];
  checkedAt: string | null;
  /** 確認に失敗した理由（成功なら null） */
  checkError: string | null;
  /** 更新を実行中か */
  running: boolean;
  /** 最後の更新の結果 */
  lastResult: { ok: boolean; message: string; finishedAt: string } | null;
  /** GitHub の読み取り用トークンを設定済みか（トークン自体は返さない） */
  tokenConfigured: boolean;
}

/** /api/update/status の応答。このPC以外からは local: false だけを返す */
export type UpdateStatusResponse = ({ local: true } & UpdateStatus) | { local: false };

/** 全体の設定（設定画面で変更。サーバーPCの DB に保存し、全端末で共通） */
export interface GeneralSettings {
  /** 決算月（1〜12）。3 なら 4月〜翌3月 が1年度 */
  fiscalYearEndMonth: number;
}

export const DefaultGeneralSettings: GeneralSettings = { fiscalYearEndMonth: 3 };

/** 決算月が正しい値か（1〜12 の整数） */
export function isValidMonth(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12;
}

/** 決算月 → 年度の始まりの月（3月決算 → 4月、12月決算 → 1月） */
export function fiscalYearStartMonth(endMonth: number): number {
  return (endMonth % 12) + 1;
}

export const HistorySearchLimits = {
  pageSizeMax: 500,
  csvRowsMax: 200_000,
} as const;
