import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { csvText, historiesToCsv } from "../src/csv.js";
import { isLanAddress, normalizeIp } from "../src/network.js";
import { createFixture, JPEG, type Fixture } from "./helpers.js";

let f: Fixture;
let app: FastifyInstance;
let webDir: string;

beforeEach(async () => {
  f = createFixture();
  webDir = path.join(f.dir, "web");
  fs.mkdirSync(path.join(webDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(webDir, "index.html"), "<html>index</html>");
  fs.writeFileSync(path.join(webDir, "assets", "app-abc.js"), "console.log(1)");
  app = buildApp({ service: f.service, images: f.images, webDir });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  f.cleanup();
});

// app.inject の接続元は 127.0.0.1
const newProduct = { code: "A001", name: "りんご", category: "", warningStock: 3, initialStock: 5, userName: "山田", image: { action: "keep" } };

describe("API", () => {
  it("商品の登録 → 入出庫 → 履歴の一連の流れ", async () => {
    const created = await app.inject({ method: "POST", url: "/api/products", payload: newProduct });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const out = await app.inject({ method: "POST", url: `/api/products/${id}/stock`, payload: { type: "OUT", quantity: 2, userName: "山田" } });
    expect(out.json().stock).toBe(3);

    const histories = await app.inject({ url: "/api/histories?limit=10" });
    expect(histories.json()[0]).toMatchObject({ type: "OUT", quantity: 2, clientIp: "127.0.0.1", userName: "山田" });
  });

  it("移管は移管先を記録し、移管先の候補を返す", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/products", payload: newProduct })).json().id;
    const res = await app.inject({
      method: "POST", url: `/api/products/${id}/stock`,
      payload: { type: "TRANSFER", quantity: 2, userName: "山田", destination: "製造部 佐藤" },
    });
    expect(res.json().stock).toBe(3);
    const h = (await app.inject({ url: "/api/histories?limit=1" })).json()[0];
    expect(h).toMatchObject({ type: "TRANSFER", destination: "製造部 佐藤" });
    expect((await app.inject({ url: "/api/destinations" })).json()).toEqual(["製造部 佐藤"]);
    const csv = (await app.inject({ url: "/api/histories.csv" })).body;
    expect(csv).toContain("移管,,,2,3,製造部 佐藤,,山田");
  });

  it("接続元の IP を返す / 入力者なしの入出庫は CSV で (未登録)", async () => {
    expect((await app.inject({ url: "/api/whoami" })).json()).toMatchObject({ ip: "127.0.0.1", userName: "", source: "" });
    const id = (await app.inject({ method: "POST", url: "/api/products", payload: newProduct })).json().id;
    const res = await app.inject({ method: "POST", url: `/api/products/${id}/stock`, payload: { type: "IN", quantity: 1, userName: "" } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/histories.csv" })).body).toContain("入庫,,,1,6,,,(未登録),127.0.0.1");
  });

  it("入出庫のコメントを記録し CSV に出す", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/products", payload: newProduct })).json().id;
    await app.inject({ method: "POST", url: `/api/products/${id}/stock`, payload: { type: "OUT", quantity: 1, userName: "山田", comment: "修理用" } });
    expect((await app.inject({ url: "/api/histories?limit=1" })).json()[0].comment).toBe("修理用");
    expect((await app.inject({ url: "/api/histories.csv" })).body).toContain("出庫,,,1,4,,修理用,山田");
    await app.inject({ method: "POST", url: `/api/products/${id}/stock`, payload: { type: "IN", quantity: 2, userName: "山田", reason: "戻り" } });
    expect((await app.inject({ url: "/api/histories.csv" })).body).toContain("入庫,戻り,,2,6,,,山田");
  });

  it("コードでの検索（スマホ画面）", async () => {
    await app.inject({ method: "POST", url: "/api/products", payload: { ...newProduct, location: "上段A-1" } });
    const hit = (await app.inject({ url: "/api/products/by-code/" + encodeURIComponent("ａ００１") })).json();
    expect(hit.product).toMatchObject({ code: "A001", location: "上段A-1" });
    expect((await app.inject({ url: "/api/products/by-code/NONE" })).json()).toEqual({ product: null, oldCode: null });
  });

  it("業務エラーは日本語メッセージと適切なステータスを返す", async () => {
    const res = await app.inject({ method: "POST", url: "/api/products", payload: { ...newProduct, code: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("商品コードを入力");

    expect((await app.inject({ url: "/api/products/999" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/products/abc" })).statusCode).toBe(400);
  });

  it("入力者が未選択なら拒否する", async () => {
    const res = await app.inject({ method: "POST", url: "/api/products", payload: { ...newProduct, userName: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("入力者");
  });

  it("他の人が先に更新していたら 409", async () => {
    const p = (await app.inject({ method: "POST", url: "/api/products", payload: newProduct })).json();
    const body = { ...newProduct, version: p.version };
    expect((await app.inject({ method: "PUT", url: `/api/products/${p.id}`, payload: { ...body, name: "1" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/products/${p.id}`, payload: { ...body, name: "2" } })).statusCode).toBe(409);
  });

  it("JSON でない・壊れた本文は 400/415", async () => {
    const broken = await app.inject({ method: "POST", url: "/api/products", headers: { "content-type": "application/json" }, payload: "{" });
    expect(broken.statusCode).toBe(400);
    const text = await app.inject({ method: "POST", url: "/api/products", headers: { "content-type": "text/plain" }, payload: "x" });
    expect(text.statusCode).toBe(415);
  });

  it("画像のアップロードと配信", async () => {
    const up = await app.inject({ method: "POST", url: "/api/uploads", headers: { "content-type": "image/jpeg" }, payload: JPEG });
    expect(up.statusCode).toBe(201);
    const { uploadId } = up.json();
    const p = (await app.inject({ method: "POST", url: "/api/products", payload: { ...newProduct, image: { action: "replace", uploadId } } })).json();

    const img = await app.inject({ url: `/api/images/${p.imageFile}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("画像でないデータ・偽装された Content-Type は拒否する", async () => {
    const fake = await app.inject({ method: "POST", url: "/api/uploads", headers: { "content-type": "image/jpeg" }, payload: Buffer.from("<script>") });
    expect(fake.statusCode).toBe(400);
    const tooBig = await app.inject({ method: "POST", url: "/api/uploads", headers: { "content-type": "image/jpeg" }, payload: Buffer.alloc(6 * 1024 * 1024, 0xff) });
    expect(tooBig.statusCode).toBe(413);
  });

  it("画像の配信はパストラバーサルを受け付けない", async () => {
    expect((await app.inject({ url: "/api/images/..%2F..%2Fzaiko.db" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/images/zaiko.db" })).statusCode).toBe(404);
  });

  it("CSV は BOM 付きでダウンロードできる", async () => {
    await app.inject({ method: "POST", url: "/api/products", payload: newProduct });
    const res = await app.inject({ url: "/api/histories.csv" });
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.body.startsWith("﻿日時,商品コード")).toBe(true);
    expect(res.body).toContain("A001,りんご,初期登録,,,5,5,,,山田,127.0.0.1");
  });

  it("画面のファイル配信：assets は長期キャッシュ、それ以外は index.html", async () => {
    const asset = await app.inject({ url: "/assets/app-abc.js" });
    expect(asset.headers["cache-control"]).toContain("immutable");
    const spa = await app.inject({ url: "/products/1" });
    expect(spa.body).toBe("<html>index</html>");
    expect(spa.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await app.inject({ url: "/../../etc/passwd" })).body).toBe("<html>index</html>");
    expect((await app.inject({ url: "/%E0%A4%A" })).statusCode).toBe(400);
  });

  it("存在しない API は 404（index.html を返さない）", async () => {
    const res = await app.inject({ url: "/api/nothing" });
    expect(res.statusCode).toBe(404);
  });

  it("ローカルネットワーク以外からの接続は 403", async () => {
    const outside = buildApp({ service: f.service, images: f.images, isAllowedAddress: () => false });
    const res = await outside.inject({ url: "/api/products" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("ローカルネットワーク以外");
    await outside.close();
  });
});

describe("ローカルネットワーク判定", () => {
  it.each([
    ["127.0.0.1", true],
    ["192.168.1.5", true],
    ["::ffff:192.168.1.5", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["8.8.8.8", false],
    ["::ffff:8.8.8.8", false],
    ["::1", true],
    ["fe80::1%eth0", true],
    ["fd12:3456::1", true],
    ["2001:db8::1", false],
    ["", false],
    ["not-an-ip", false],
  ])("%s → %s", (ip, expected) => {
    expect(isLanAddress(ip)).toBe(expected);
  });

  it("IPv4 射影アドレスを通常の表記にする", () => {
    expect(normalizeIp("::ffff:192.168.0.2")).toBe("192.168.0.2");
  });
});

describe("CSV", () => {
  it.each([
    ["りんご", "りんご"],
    ["a,b", '"a,b"'],
    ['5"', '"5"""'],
    ["1\n2", '"1\n2"'],
    [" x ", '" x "'],
    ["=1+1", "'=1+1"],
    ["-5", "'-5"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["=a,b", "\"'=a,b\""],
  ])("%j → %j", (input, expected) => {
    expect(csvText(input)).toBe(expected);
  });

  it("ヘッダーと行の形式", () => {
    const csv = historiesToCsv([
      {
        id: 1, productId: 1, productCode: "A", productName: "りんご, 青", type: "IN", quantity: 3,
        stockAfter: 8, destination: null, comment: "棚卸し, 再確認", reason: "購入", orderNo: "YHO-26002", cancelOf: null, canceledBy: null, deviceId: null, userName: "山田", clientIp: "192.168.1.2", createdAt: "2026-01-02 03:04:05",
      },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "﻿日時,商品コード,商品名,区分,理由,紐づけID,数量,処理後在庫,移管先,コメント,入力者,端末IP,取消,履歴ID",
      '2026-01-02 03:04:05,A,"りんご, 青",入庫,購入,YHO-26002,3,8,,"棚卸し, 再確認",山田,192.168.1.2,,1',
      "",
    ]);
  });
});
