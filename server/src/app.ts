import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { DefaultGeneralSettings, HistoryKindLabels, Rules, type UpdateStatusResponse, type ApiErrorBody, type ImageChange, type OrderNumbersResponse, type WhoAmI } from "../../shared/types.js";

/** "YYYY-MM-DD 00:00:00"（翌日の0時）→ その前日 "YYYYMMDD"（CSV のファイル名用） */
function previousDay(toBefore: string): string {
  const [y, m, d] = toBefore.slice(0, 10).split("-").map(Number);
  const prev = new Date(y!, m! - 1, d! - 1);
  return `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, "0")}${String(prev.getDate()).padStart(2, "0")}`;
}
import { auditLogsToCsv, codeChangesToCsv, historiesToCsv, historyEditRowsToCsv } from "./csv.js";
import { productsToCsv } from "./productCsv.js";
import { AppError, ForbiddenError, ValidationError } from "./errors.js";
import { IMAGE_CONTENT_TYPES, type ImageStore } from "./images.js";
import type { Actor, InventoryService } from "./inventory.js";
import type { LogExportStatus } from "./logExport.js";
import type { MailNotifier } from "./mail/notifier.js";
import type { OrderNumberList } from "./orderNumbers.js";
import { isDeviceId, newDeviceId } from "./devices.js";
import { isLanAddress, isSelfAddress, lanAddresses, normalizeIp } from "./network.js";
import type { Updater } from "./updater.js";
import type { BackupService } from "./backup.js";
import { EditingPresence } from "./presence.js";
import { systemClock } from "./clock.js";
import { APP_VERSION } from "./version.js";
import type { GeneralSettingsService } from "./generalSettings.js";

export interface AppOptions {
  service: InventoryService;
  images: ImageStore;
  /** メール通知（未指定ならメール関連の API は 404） */
  mail?: MailNotifier;
  /** デモ環境（ZAIKO_DEMO=1）。画面に「デモ」と表示する */
  demo?: boolean;
  /** 受注番号リスト（未指定なら候補は最近入力した番号のみ） */
  orderList?: Pick<OrderNumberList, "list">;
  /** 編集中の表示（未指定なら buildApp の中で作る） */
  presence?: EditingPresence;
  /** バックアップ（未指定なら関連 API は 404） */
  backup?: Pick<BackupService, "view" | "saveSettings" | "testDir" | "run">;
  /** プログラムの更新（未指定なら関連 API は「使えない」と返す） */
  updater?: Pick<Updater, "status" | "check" | "start" | "saveToken">;
  /** テスト用：このPC自身からの接続かの判定を差し替える */
  isSelfAddress?: (ip: string) => boolean;
  /** 全体の設定（決算月など）。未指定なら既定値を返し、保存の API は 404 */
  general?: Pick<GeneralSettingsService, "get" | "save">;
  /** 履歴 CSV の自動書き出し（未指定なら関連 API は 404） */
  logExporter?: { getStatus(): LogExportStatus; run(): LogExportStatus };
  /** ビルド済みの画面（index.html のあるフォルダ）。未指定なら API のみ */
  webDir?: string;
  /** テスト用：ローカルネットワーク判定を差し替える */
  isAllowedAddress?: (ip: string) => boolean;
  logger?: boolean;
}

type Body = Record<string, unknown>;

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function buildApp(options: AppOptions): FastifyInstance {
  const { service, images } = options;
  const isAllowed = options.isAllowedAddress ?? isLanAddress;

  const app = Fastify({
    // 全リクエストのログ（info）は量が多くログファイルが肥大化するため、警告・エラーのみ出す
    logger: options.logger ? { level: "warn" } : false,
    // 接続元 IP は偽装可能なヘッダー（X-Forwarded-For）ではなく TCP 接続から取る
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  });

  // 他サイトのページからフォーム送信で操作される（CSRF）のを防ぐため、ブラウザがプリフライトなしで送れる
  // text/plain は受け付けない（フォーム形式は Fastify が元々受け付けない）。更新系は JSON か画像のみ
  app.removeContentTypeParser("text/plain");

  // 画像は JSON ではなくバイナリのまま受け取る（Base64 化による 33% の増加を避ける）
  app.addContentTypeParser(
    ["image/jpeg", "image/png", "image/webp"],
    { parseAs: "buffer", bodyLimit: Rules.maxUploadBytes + 1024 },
    (_req, body, done) => done(null, body),
  );

  const clientIp = (req: FastifyRequest) => normalizeIp(req.socket.remoteAddress);
  /** onRequest で Cookie から読んだ（無ければ発行した）端末ID */
  const deviceIds = new WeakMap<FastifyRequest, string>();
  const actorOf = (req: FastifyRequest): Actor => ({
    userName: typeof (req.body as Body | undefined)?.userName === "string" ? ((req.body as Body).userName as string) : "",
    clientIp: clientIp(req),
    deviceId: deviceIds.get(req),
  });
  const idOf = (req: FastifyRequest): number => {
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError("IDが正しくありません。");
    return id;
  };
  const bodyOf = (req: FastifyRequest): Body => {
    const body = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("送信内容が正しくありません。");
    }
    return body as Body;
  };

  // ------------------------------------------------------------ 共通処理

  app.addHook("onRequest", async (req, reply) => {
    const ip = clientIp(req);
    if (!isAllowed(ip)) {
      req.log.warn({ ip }, "社外からの接続を拒否");
      return reply.code(403).type("text/plain; charset=utf-8").send("ローカルネットワーク以外からはアクセスできません。");
    }
  });

  /**
   * 端末ID：Cookie（zaiko_device）で端末ごとに発行する。スマホは IP が変わることがあるため、人との紐づけに使う。
   * - HttpOnly（画面のスクリプトから読めない）、SameSite=Lax（QR からカメラで開いた場合も送られる。Strict だと送られず別の端末扱いになる）
   * - 有効期限5年。サーバー側で発行した Cookie は、iPhone の Safari でもスクリプトで保存した値のように7日で消されない
   */
  app.addHook("onRequest", async (req, reply) => {
    const m = /(?:^|;\s*)zaiko_device=([^;]*)/.exec(req.headers.cookie ?? "");
    let id = m?.[1];
    if (!isDeviceId(id)) {
      id = newDeviceId();
      reply.header("Set-Cookie", `zaiko_device=${id}; Path=/; Max-Age=${5 * 365 * 24 * 3600}; HttpOnly; SameSite=Lax`);
    }
    deviceIds.set(req, id);
    if (req.url.startsWith("/api/")) {
      service.touchDevice(id, clientIp(req), String(req.headers["user-agent"] ?? ""));
    }
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", CSP);
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (error instanceof AppError) {
      const body: ApiErrorBody = { error: error.message, details: error.details };
      return reply.code(error.status).send(body);
    }
    const status = error.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: "送信データが大きすぎます。" });
    if (status === 415) return reply.code(415).send({ error: "対応していないデータ形式です。" });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: "送信内容が正しくありません。" });

    req.log.error(error);
    return reply.code(500).send({ error: "サーバーでエラーが発生しました。しばらくしてから再度お試しください。" });
  });

  // ------------------------------------------------------------ API

  /** demo: デモ（お試し・説明用）環境か。画面に「デモ」と表示して本番と取り違えないようにする */
  app.get("/api/health", async () => ({ ok: true, version: APP_VERSION, demo: options.demo === true }));

  /** スマホ等から開くためのアドレス（このPCの社内向け IP + 待ち受けポート） */
  app.get("/api/server-info", async (req) => {
    const port = req.socket.localPort;
    return { urls: lanAddresses().map((ip) => `http://${ip}:${port}`) };
  });

  // ------------------------------------------------------------ バックアップ

  const backup = options.backup;
  if (backup) {
    app.get("/api/backup", async () => backup.view());
    app.put("/api/backup/settings", async (req) => {
      const body = bodyOf(req);
      const view = backup.saveSettings(body, actorOf(req));
      // 保存先を変えたらすぐにコピーして、結果を見せる
      return body.extraDir !== undefined ? backup.run() : view;
    });
    app.post("/api/backup/test", async (req) => backup.testDir(bodyOf(req).extraDir));
    app.post("/api/backup/run", async (req) => {
      bodyOf(req);
      return backup.run();
    });
  }

  // ------------------------------------------------------------ プログラムの更新（このPCの画面からだけ）

  const isSelf = options.isSelfAddress ?? ((ip: string) => isSelfAddress(ip));
  const updater = options.updater;
  /** 他の端末には更新の存在自体を見せない（社内の人に「ネットにつながっている」と思わせないため） */
  const requireSelf = (req: FastifyRequest) => {
    if (!isSelf(clientIp(req))) throw new ForbiddenError("プログラムの更新は、サーバーPCの画面からだけ行えます。");
    if (!updater) throw new ValidationError("この環境ではプログラムの更新を使えません。");
    return updater;
  };
  app.get("/api/update/status", async (req): Promise<UpdateStatusResponse> =>
    isSelf(clientIp(req)) && updater ? { local: true, ...updater.status() } : { local: false },
  );
  app.post("/api/update/check", async (req) => ({ local: true, ...(await requireSelf(req).check()) }));
  app.post("/api/update/run", async (req) => {
    bodyOf(req);
    return { local: true, ...(await requireSelf(req).start()) };
  });
  app.put("/api/update/token", async (req) => ({ local: true, ...(await requireSelf(req).saveToken(bodyOf(req).token)) }));

  // ------------------------------------------------------------ 全体の設定（決算月など）

  const general = options.general;
  app.get("/api/settings/general", async () => general?.get() ?? { ...DefaultGeneralSettings });
  if (general) {
    app.put("/api/settings/general", async (req) => general.save(bodyOf(req), actorOf(req)));
  }

  // ------------------------------------------------------------ メール通知の設定

  const mail = options.mail;
  if (mail) {
    app.get("/api/settings/mail", async () => mail.view());
    app.put("/api/settings/mail", async (req) => mail.save(bodyOf(req), actorOf(req)));
    app.post("/api/settings/mail/test", async (req) => mail.sendTest(bodyOf(req), actorOf(req)));
    app.post("/api/settings/mail/send-now", async (req) => {
      bodyOf(req);
      return mail.sendNow(actorOf(req));
    });
  }

  // ------------------------------------------------------------ 履歴 CSV の自動書き出し

  const logExporter = options.logExporter;
  if (logExporter) {
    app.get("/api/log-export", async () => logExporter.getStatus());
    app.post("/api/log-export/run", async () => logExporter.run());
  }

  app.get("/api/users", async (req) => {
    const all = (req.query as { all?: string }).all === "1";
    return service.listUsers(all);
  });
  app.post("/api/users", async (req, reply) => {
    const body = bodyOf(req);
    reply.code(201);
    return service.createUser(body.name, actorOf(req));
  });
  app.post("/api/users/:id/ips", async (req, reply) => {
    const body = bodyOf(req);
    reply.code(201);
    return service.linkUserIp(idOf(req), body.ip, body.note, body.replace, actorOf(req));
  });
  app.delete("/api/user-ips/:ip", async (req, reply) => {
    service.unlinkUserIp((req.params as { ip: string }).ip, actorOf(req));
    return reply.code(204).send();
  });
  app.get("/api/unassigned-ips", async () => service.unassignedIps());
  app.patch("/api/users/:id", async (req) => {
    const body = bodyOf(req);
    return service.updateUser(idOf(req), { name: body.name, active: body.active }, actorOf(req));
  });

  app.get("/api/products", async (req) => service.searchProducts((req.query as { q?: string }).q));
  /** oldCode: 変更前のコードで見つかった場合の旧コード（画面で「コードが変わった」と知らせる） */
  app.get("/api/products/by-code/:code", async (req) => service.lookupCode((req.params as { code: string }).code));
  app.get("/api/products/:id/code-changes", async (req) => service.codeChanges(idOf(req)));
  app.get("/api/products/:id", async (req) => service.getProduct(idOf(req)));

  app.post("/api/products", async (req, reply) => {
    const body = bodyOf(req);
    const product = service.registerProduct(body, parseImageChange(body.image), actorOf(req));
    reply.code(201);
    return product;
  });
  // ------------------------------------------------------------ 編集中の表示（同じ商品を同時に編集しないよう知らせる）

  const presence = options.presence ?? new EditingPresence(systemClock);
  /** 名前は選んだ名前 → 端末に紐づいた人 → 無し（未登録の名前は表示しない） */
  const editingName = (req: FastifyRequest) => {
    try {
      return service.resolveStockUser(actorOf(req));
    } catch {
      return "";
    }
  };
  app.post("/api/products/:id/editing", async (req) => {
    const id = idOf(req);
    return { others: presence.heartbeat(id, bodyOf(req).sessionId, editingName(req), clientIp(req)) };
  });
  app.post("/api/products/:id/editing/leave", async (req, reply) => {
    presence.leave(idOf(req), bodyOf(req).sessionId);
    reply.code(204);
  });
  app.get("/api/editing", async () => presence.all());

  app.put("/api/products/:id", async (req) => {
    const body = bodyOf(req);
    return service.updateProduct(idOf(req), body, body.version, parseImageChange(body.image), actorOf(req));
  });
  app.delete("/api/products/:id", async (req, reply) => {
    const body = bodyOf(req);
    service.deleteProduct(idOf(req), body.version, actorOf(req));
    return reply.code(204).send();
  });
  app.post("/api/products/:id/stock", async (req) => {
    const body = bodyOf(req);
    return service.changeStock(idOf(req), body.type, body.quantity, actorOf(req), {
      destination: body.destination,
      comment: body.comment,
      reason: body.reason,
      orderNo: body.orderNo,
    });
  });
  app.post("/api/products/:id/adjust", async (req) => {
    const body = bodyOf(req);
    return service.adjustStock(idOf(req), body.stock, body.expectedStock, actorOf(req), body.reason);
  });
  app.get("/api/destinations", async () => service.recentDestinations());
  /** 接続元の IP（スマホ画面の「リストに無い（IPで記録）」の表示用） */
  app.get("/api/order-numbers", async (): Promise<OrderNumbersResponse> => {
    const fromFile = options.orderList?.list() ?? {
      items: [],
      status: { file: "", exists: false, count: 0, modifiedAt: null, error: "", skipped: 0 },
    };
    return { items: fromFile.items, recent: service.recentOrderNumbers(), status: fromFile.status };
  });

  app.get("/api/whoami", async (req): Promise<WhoAmI> => {
    const ip = clientIp(req);
    const deviceId = deviceIds.get(req) ?? "";
    const linked = service.linkedUserName({ clientIp: ip, deviceId });
    return { ip, deviceId, userName: linked.userName, source: linked.source };
  });

  // ------------------------------------------------------------ 端末

  app.get("/api/devices", async () => service.listDevices());
  app.patch("/api/devices/:deviceId", async (req) => {
    const body = bodyOf(req);
    return service.linkDevice((req.params as { deviceId: string }).deviceId, body.userId ?? null, body.note, actorOf(req));
  });
  app.delete("/api/devices/:deviceId", async (req, reply) => {
    service.deleteDevice((req.params as { deviceId: string }).deviceId, actorOf(req));
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ 履歴の修正・取消

  app.get("/api/histories/:id", async (req) => {
    const id = idOf(req);
    return { history: service.getHistory(id), edits: service.historyEdits(id) };
  });
  app.patch("/api/histories/:id", async (req) => {
    const body = bodyOf(req);
    const { userName: _u, ...change } = body;
    return service.editHistory(idOf(req), change, actorOf(req));
  });
  app.post("/api/histories/:id/cancel", async (req) => {
    const body = bodyOf(req);
    return service.cancelHistory(idOf(req), body.reason, actorOf(req));
  });

  app.get("/api/low-stock", async () => service.lowStockProducts());
  app.get("/api/histories", async (req) => {
    const q = req.query as { limit?: string; productId?: string };
    const productId = q.productId ? Number(q.productId) : undefined;
    return service.recentHistories(Number(q.limit ?? 100), Number.isSafeInteger(productId) ? productId : undefined);
  });
  // ------------------------------------------------------------ 履歴ページ（検索・CSV）

  app.get("/api/history-search", async (req) => service.searchHistories(req.query as Record<string, unknown>).result);
  app.get("/api/history-search.csv", async (req, reply) => {
    const { query, result } = service.searchHistories(req.query as Record<string, unknown>, true);
    const rows = result.rows as never[];
    const csv =
      query.kind === "edits"
        ? historyEditRowsToCsv(rows)
        : query.kind === "audit"
          ? auditLogsToCsv(rows)
          : query.kind === "codes"
            ? codeChangesToCsv(rows)
            : historiesToCsv(rows);
    const label = HistoryKindLabels[query.kind];
    const span = `${query.fromAt?.slice(0, 10).replace(/-/g, "") ?? "最初"}-${query.toBefore ? previousDay(query.toBefore) : "最新"}`;
    reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="history_${query.kind}.csv"; filename*=UTF-8''${encodeURIComponent(`${label}_${span}.csv`)}`);
    return csv;
  });

  app.get("/api/histories.csv", async (_req, reply) => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="history_${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(`在庫履歴_${stamp}.csv`)}`);
    return historiesToCsv(service.allHistories());
  });
  app.get("/api/products.csv", async (_req, reply) => {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    reply
      .type("text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="stock_${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(`在庫一覧_${stamp}.csv`)}`);
    return productsToCsv(service.searchProducts());
  });
  /** 在庫CSVの取り込み。dryRun=true で確認のみ。CSV は画面側で文字コードを判別し、文字列として送る */
  app.post("/api/products/import", { bodyLimit: Rules.maxImportBytes }, async (req) => {
    const body = bodyOf(req);
    return service.importProducts(body.csv, body.dryRun !== false, actorOf(req));
  });
  app.get("/api/audit-logs", async (req) => service.auditLogs(Number((req.query as { limit?: string }).limit ?? 100)));

  app.post("/api/uploads", async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new ValidationError("画像データを送信してください。");
    reply.code(201);
    return { uploadId: images.saveUpload(req.body) };
  });

  app.get("/api/images/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const full = images.resolve(file);
    if (!full) return reply.code(404).send({ error: "画像が見つかりません。" });
    const ext = path.extname(full).slice(1);
    // 画像ファイル名は内容ごとに一意（差し替え時は別名）なので、長期キャッシュしてよい
    reply.type(IMAGE_CONTENT_TYPES[ext] ?? "application/octet-stream").header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(full));
  });

  app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "API が見つかりません。" }));

  // ------------------------------------------------------------ 画面（ビルド済みファイル）

  if (options.webDir) registerStatic(app, path.resolve(options.webDir));

  return app;
}

function parseImageChange(value: unknown): ImageChange {
  if (value === undefined || value === null) return { action: "keep" };
  const v = value as { action?: unknown; uploadId?: unknown };
  if (v.action === "keep" || v.action === "remove") return { action: v.action };
  if (v.action === "replace" && typeof v.uploadId === "string") return { action: "replace", uploadId: v.uploadId };
  throw new ValidationError("画像の指定が正しくありません。");
}

function registerStatic(app: FastifyInstance, root: string): void {
  const indexPath = path.join(root, "index.html");

  const sendFile = (reply: FastifyReply, full: string) => {
    const ext = path.extname(full).toLowerCase();
    // ビルド時にファイル名へハッシュが付く assets/ は長期キャッシュ、index.html は毎回確認
    const immutable = full.startsWith(path.join(root, "assets") + path.sep);
    reply
      .type(STATIC_TYPES[ext] ?? "application/octet-stream")
      .header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.send(fs.createReadStream(full));
  };

  app.get("/*", async (req, reply) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(req.url.split("?")[0] ?? "/");
    } catch {
      return reply.code(400).send(); // 不正な % エンコード
    }
    const full = path.resolve(root, "." + urlPath);
    // root の外を指すパス（../ など）は拒否
    if (full !== root && !full.startsWith(root + path.sep)) return reply.code(404).send();
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return sendFile(reply, full);
    // 画面内の URL（#/... 以外の直接アクセス）も index.html を返す
    if (fs.existsSync(indexPath)) return sendFile(reply, indexPath);
    return reply.code(404).send();
  });
}
