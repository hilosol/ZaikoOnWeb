// デモ（お試し・説明用）のデータを作る。本番の data フォルダとは別のフォルダに作る。
//   npx tsx scripts/seed-demo.ts [出力フォルダ（既定: demo-data）] [--force]
//
// - 会社名・人名・購入元はすべて架空。URL は example.com / example.jp（実在しない例示用ドメイン）
// - データは DB に直接書かず、アプリ本体の処理（InventoryService）を通して作る
//   （在庫の範囲チェック・取消・修正履歴・操作ログが、画面で操作した場合と同じ形で残る）
// - 乱数は固定の種から作るので、何度実行しても同じ内容になる（日付だけは実行日から1年分）
import fs from "node:fs";
import path from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import type { Clock } from "../server/src/clock.js";
import { openDatabase } from "../server/src/db.js";
import { FileImageStore } from "../server/src/images.js";
import { InventoryService, type Actor } from "../server/src/inventory.js";
import type { Product } from "../shared/types.js";

// ---------------------------------------------------------------- 準備

const args = process.argv.slice(2);
const force = args.includes("--force");
const outDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? "demo-data");

if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
  if (!force) {
    console.error(`[中止] ${outDir} は空ではありません。作り直す場合は --force を付けてください（本番の data フォルダを指定しないこと）。`);
    process.exit(1);
  }
  if (fs.existsSync(path.join(outDir, "zaiko.db")) && !fs.existsSync(path.join(outDir, "DEMO.txt"))) {
    console.error(`[中止] ${outDir} にはデモ以外のデータベースがあるようです（DEMO.txt がありません）。本番のデータを消さないよう中止しました。`);
    process.exit(1);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "DEMO.txt"),
  "このフォルダは在庫管理のデモ（お試し・説明用）データです。実在の会社・人物とは関係ありません。\r\n" +
    "start-demo.bat で起動します。作り直す場合: npx tsx scripts/seed-demo.ts demo-data --force\r\n",
);

/** 固定の種の乱数（mulberry32）。同じ種なら毎回同じ並びになる */
let seed = 20261106;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const chance = (p: number) => rand() < p;

/** デモ用の時計（日付を進めながら記録する） */
class DemoClock implements Clock {
  current = new Date();
  now() {
    return new Date(this.current);
  }
}

// ---------------------------------------------------------------- 画像（色付きの簡単な図柄の PNG を自前で作る）

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // フィルタなし
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** カテゴリの色の背景に、商品ごとに少しずつ違う図形（円・四角・縞）を描く */
function productImage(color: [number, number, number], variant: number): Buffer {
  const size = 240;
  const light = color.map((c) => Math.round(c + (255 - c) * 0.75)) as [number, number, number];
  const shape = variant % 3;
  const r = 60 + (variant % 4) * 12;
  return png(size, size, (x, y) => {
    const dx = x - size / 2;
    const dy = y - size / 2;
    const inside =
      shape === 0
        ? dx * dx + dy * dy < r * r
        : shape === 1
          ? Math.abs(dx) < r * 0.8 && Math.abs(dy) < r * 0.8
          : Math.abs(dx) < r && Math.abs(dy) < r * 0.5 && Math.floor((x + y) / 14) % 2 === 0;
    return inside ? color : light;
  });
}

// ---------------------------------------------------------------- 架空のマスタ

const USERS = ["山田", "鈴木", "佐藤", "田中", "高橋", "伊藤"] as const;
const USER_IPS: Record<string, string> = { 山田: "192.168.0.101", 鈴木: "192.168.0.102", 佐藤: "192.168.0.103", 田中: "192.168.0.104", 高橋: "192.168.0.105", 伊藤: "192.168.0.106" };
const DESTINATIONS = ["製造部", "品質保証部", "開発部 佐藤", "組立課", "出荷検査", "サービス課 田中"] as const;
const LOCATIONS = [..."ABCD"].flatMap((r) => [1, 2, 3, 4, 5].map((n) => `棚${r}-${n}`)).concat(["キャビネット1-上", "キャビネット1-下", "防湿庫", "工具棚"]);
const SUPPLIERS = [
  { name: "サンプル商事", url: "https://www.example.com/shop/" },
  { name: "デモ電材", url: "https://example.jp/denzai/" },
  { name: "テスト工具店", url: "https://tools.example.com/" },
  { name: "架空ケミカル", url: "" },
  { name: "例示精機", url: "https://example.net/seiki/" },
] as const;

interface CategoryDef {
  name: string;
  prefix: string;
  color: [number, number, number];
  count: number;
  item: (i: number) => { name: string; summary: string };
}

const CATEGORIES: CategoryDef[] = [
  {
    name: "プローブ針",
    prefix: "PN",
    color: [52, 120, 198],
    count: 24,
    item: (i) => {
      const tip = [5, 10, 15, 25, 50, 100][i % 6]!;
      const mat = ["タングステン", "ベリリウム銅", "パラジウム合金", "レニウムタングステン"][i % 4]!;
      return { name: `${mat}針 先端${tip}µm`, summary: `${mat}製のプローブ針。先端径 ${tip}µm、全長 ${30 + (i % 3) * 5}mm。` };
    },
  },
  {
    name: "ケーブル",
    prefix: "CB",
    color: [40, 150, 110],
    count: 20,
    item: (i) => {
      const kind = ["同軸ケーブル SMA-SMA", "同軸ケーブル BNC-BNC", "トライアキシャルケーブル", "USBケーブル A-B", "LANケーブル Cat6"][i % 5]!;
      const len = [0.5, 1, 1.5, 2, 3][Math.floor(i / 5) % 5]!;
      return { name: `${kind} ${len}m`, summary: `${kind}、長さ ${len}m。` };
    },
  },
  {
    name: "コネクタ",
    prefix: "CN",
    color: [200, 120, 40],
    count: 16,
    item: (i) => {
      const k = ["SMAコネクタ オス", "SMAコネクタ メス", "BNCコネクタ", "トライアキシャル中継", "D-sub 9ピン", "D-sub 25ピン", "丸形コネクタ 4極", "端子台 10極"][i % 8]!;
      return { name: `${k}${i >= 8 ? "（基板用）" : ""}`, summary: `${k}。` };
    },
  },
  {
    name: "ネジ・締結",
    prefix: "SC",
    color: [120, 120, 130],
    count: 22,
    item: (i) => {
      const m = [2, 2.5, 3, 4, 5, 6][i % 6]!;
      const l = [6, 8, 10, 12, 16, 20][Math.floor(i / 6) % 6]!;
      const k = ["六角穴付ボルト", "なべ小ねじ", "皿小ねじ", "ナイロンナット"][Math.floor(i / 6) % 4]!;
      return { name: `${k} M${m}×${l}（100本入）`, summary: `${k} M${m}、長さ ${l}mm、ステンレス。` };
    },
  },
  {
    name: "治具",
    prefix: "JG",
    color: [150, 80, 170],
    count: 14,
    item: (i) => {
      const k = ["ウエハ吸着チャック", "サンプルホルダ", "位置決めピン", "プローブアーム", "顕微鏡アダプタ", "カードホルダ", "シールドボックス"][i % 7]!;
      const s = ["2インチ", "4インチ", "6インチ", "8インチ"][i % 4]!;
      return { name: `${k} ${s}用`, summary: `${s}ウエハ向けの${k}。` };
    },
  },
  {
    name: "消耗品",
    prefix: "CS",
    color: [210, 80, 80],
    count: 24,
    item: (i) => {
      const k = ["無塵ワイパー（100枚）", "ニトリル手袋 M（100枚）", "ニトリル手袋 L（100枚）", "IPA 500mL", "カプトンテープ 10mm", "静電防止袋 A4（50枚）", "綿棒（100本）", "シリコングリス"][i % 8]!;
      return { name: i >= 8 ? `${k} 予備${Math.floor(i / 8)}` : k, summary: `${k}。定期的に補充。` };
    },
  },
  {
    name: "電気部品",
    prefix: "EL",
    color: [220, 170, 30],
    count: 18,
    item: (i) => {
      const k = ["リレー 24V", "ヒューズ 2A", "ヒューズ 5A", "ACアダプタ 12V", "ファンモーター 60mm", "温度センサ", "ソリッドステートリレー", "電源ユニット 24V 5A", "LED表示灯 緑"][i % 9]!;
      return { name: `${k}${i >= 9 ? "（予備）" : ""}`, summary: `${k}。` };
    },
  },
  {
    name: "工具",
    prefix: "TL",
    color: [90, 100, 60],
    count: 12,
    item: (i) => {
      const k = ["精密ドライバーセット", "ピンセット 先細", "ピンセット 曲がり", "トルクドライバー", "ニッパー", "六角レンチセット", "はんだごて", "ルーペ 10倍", "デジタルノギス", "テスター", "ワイヤーストリッパー", "ラジオペンチ"][i % 12]!;
      return { name: k, summary: `${k}。使用後は工具棚へ戻す。` };
    },
  },
];

const CUSTOMERS = ["サンプル大学", "デモ工業", "テスト化学", "架空電子", "例示研究所", "ダミー精機", "モック材料", "仮称半導体", "見本技研", "試作大学"] as const;
const MODELS = ["HMP-400", "HMP-600", "HSP-100SC", "HSP-150SC", "マニュアルプローバー", "高温プローバー", "セミオートプローブシステム"] as const;

// ---------------------------------------------------------------- 作成

const clock = new DemoClock();
const db = openDatabase(path.join(outDir, "zaiko.db"));
const images = new FileImageStore(outDir);

// 紐づけIDリスト link-ids.txt（案件フォルダ名の形。前年度・今年度の案件）
const orderLines: string[] = [];
for (const fy of [25, 26]) {
  for (let n = 1; n <= 22; n++) {
    if (chance(0.15)) continue; // 欠番
    orderLines.push(`${pick(["YHO", "YHO", "YHO", "EBO", "AWO"])}-${fy}${String(n).padStart(3, "0")}_${pick(CUSTOMERS)}_${pick(MODELS)}`);
  }
}
fs.writeFileSync(path.join(outDir, "link-ids.txt"), "﻿" + orderLines.join("\r\n") + "\r\n");
const orderNumbers = orderLines.map((l) => l.split("_")[0]!);
const orderList = { find: (n: string) => (orderNumbers.includes(n) ? { number: n, name: "" } : null) };

const service = new InventoryService(db, images, clock, orderList);

const today = new Date();
today.setHours(0, 0, 0, 0);
const start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
const setTime = (day: Date, h: number, m: number) => {
  clock.current = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, int(0, 59));
};

// 入力者・紐づけ
setTime(start, 8, 30);
const admin: Actor = { userName: "", clientIp: "192.168.0.100" };
const userIds = new Map<string, number>();
for (const u of USERS) userIds.set(u, service.createUser(u, admin).id);
const actorOf = (name: string): Actor => ({ userName: name, clientIp: USER_IPS[name]! });
service.linkUserIp(userIds.get("山田")!, USER_IPS["山田"], "事務所PC", false, actorOf("山田"));

// スマホ（名前を選ばずに操作する端末）。一部は人に紐づける
const phones = [
  { id: "d0e0000000000000000000000000a001", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", ip: "192.168.0.151", owner: "鈴木" },
  { id: "d0e0000000000000000000000000a002", ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36", ip: "192.168.0.152", owner: "田中" },
  { id: "d0e0000000000000000000000000a003", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1", ip: "192.168.0.153", owner: "" },
];
for (const p of phones) service.touchDevice(p.id, p.ip, p.ua);
service.linkDevice(phones[0]!.id, userIds.get("鈴木")!, "鈴木のiPhone", actorOf("山田"));

// 商品
const products: Product[] = [];
let variant = 0;
for (const cat of CATEGORIES) {
  for (let i = 0; i < cat.count; i++) {
    const { name, summary } = cat.item(i);
    const warning = cat.name === "消耗品" ? int(5, 15) : cat.name === "工具" ? 1 : int(2, 8);
    let image: { action: "keep" } | { action: "replace"; uploadId: string } = { action: "keep" };
    if (chance(0.75)) image = { action: "replace", uploadId: images.saveUpload(productImage(cat.color, variant++)) };
    const supplierCount = chance(0.6) ? int(1, 3) : 0;
    const suppliers = [...SUPPLIERS].sort(() => rand() - 0.5).slice(0, supplierCount).map((s) => ({ name: s.name, url: s.url }));
    const p = service.registerProduct(
      {
        code: `${cat.prefix}-${String(i + 1).padStart(5, "0")}`,
        name,
        category: cat.name,
        location: pick(LOCATIONS),
        summary,
        note: chance(0.15) ? pick(["取扱注意", "発注は担当者に確認", "旧型品（在庫限り）", "要校正（年1回）"]) : "",
        warningStock: warning,
        initialStock: int(warning + 2, warning * 4 + 10),
        offBook: chance(0.06),
        suppliers,
      },
      image,
      actorOf("山田"),
    );
    products.push(p);
  }
}

// 1年分の入出庫（平日のみ。1日 9〜15件）
let ops = 0;
let cancels = 0;
const fresh = (id: number) => service.getProduct(id);
const manualOrders: string[] = [];

for (let day = new Date(start.getTime() + 86_400_000); day < today; day = new Date(day.getTime() + 86_400_000)) {
  if (day.getDay() === 0 || day.getDay() === 6) continue;
  const fy = (day.getMonth() + 1 >= 4 ? day.getFullYear() : day.getFullYear() - 1) % 100;
  const activeOrders = orderNumbers.filter((n) => n.includes(`-${fy}`) || n.includes(`-${fy - 1}`));
  const perDay = int(9, 15);
  for (let k = 0; k < perDay; k++) {
    setTime(day, 8 + Math.floor((k / perDay) * 10), int(0, 59));
    const p = fresh(pick(products).id);
    // 端末：PC（名前あり）7割、スマホ3割（紐づいた端末・紐づけなしの端末）
    let actor: Actor;
    if (chance(0.7)) actor = actorOf(pick(USERS));
    else {
      const ph = pick(phones);
      actor = { userName: "", clientIp: ph.ip, deviceId: ph.id };
      service.touchDevice(ph.id, ph.ip, ph.ua);
    }
    const orderNo = chance(0.6)
      ? chance(0.92) || manualOrders.length === 0
        ? pick(activeOrders.length ? activeOrders : orderNumbers)
        : pick(manualOrders)
      : undefined;
    if (orderNo === undefined && chance(0.01)) manualOrders.push(`TMP-${fy}${String(int(1, 99)).padStart(2, "0")}`);

    try {
      if (p.stock <= p.warningStock && chance(0.85)) {
        // 補充
        service.changeStock(p.id, "IN", int(p.warningStock * 2, p.warningStock * 4 + 5), actor, {
          reason: "購入",
          comment: chance(0.3) ? pick(["定期発注分", "急ぎで手配", "まとめ買い"]) : undefined,
        });
      } else {
        const r = rand();
        if (r < 0.7 && p.stock > 0) {
          service.changeStock(p.id, "OUT", Math.min(p.stock, int(1, 4)), actor, {
            orderNo,
            comment: chance(0.15) ? pick(["修理用", "立ち上げ作業", "予備として持ち出し", "検査用"]) : undefined,
          });
        } else if (r < 0.85 && p.stock > 0) {
          service.changeStock(p.id, "TRANSFER", Math.min(p.stock, int(1, 3)), actor, { destination: pick(DESTINATIONS), orderNo });
        } else {
          service.changeStock(p.id, "IN", int(1, 3), actor, { reason: pick(["戻り", "戻り", "その他"]), comment: chance(0.4) ? "未使用のため返却" : undefined });
        }
      }
      ops++;
      // まれに入力ミス → 取消して入力し直す
      if (chance(0.012)) {
        const last = service.recentHistories(1)[0]!;
        if (last.type !== "IN" || fresh(p.id).stock >= last.quantity) {
          clock.current = new Date(clock.current.getTime() + int(2, 20) * 60_000);
          service.cancelHistory(last.id, pick(["数量の入力間違い", "別の商品と間違えた", "二重に登録した"]), actor.userName ? actor : actorOf(pick(USERS)));
          cancels++;
        }
      }
      // まれにコメントを後から直す
      if (chance(0.006)) {
        const last = service.recentHistories(1)[0]!;
        if (last.type !== "CANCEL") {
          clock.current = new Date(clock.current.getTime() + int(10, 120) * 60_000);
          service.editHistory(last.id, { comment: pick(["修理用（客先対応）", "受注番号は後日確認", "試作用に変更"]) }, actorOf(pick(USERS)));
        }
      }
    } catch {
      // 在庫の範囲外など（デモなので飛ばす）
    }
  }

  // 月末の棚卸し：数件の在庫を実数に合わせる
  const next = new Date(day.getTime() + 86_400_000);
  if (next.getMonth() !== day.getMonth()) {
    setTime(day, 17, 30);
    for (let j = 0; j < int(2, 5); j++) {
      const p = fresh(pick(products).id);
      const target = Math.max(0, p.stock + pick([-2, -1, -1, 1]));
      try {
        service.adjustStock(p.id, target, p.stock, actorOf("山田"), pick(["棚卸差異", "破損のため廃棄", "数え間違いの修正"]));
      } catch {
        // 変化なし等
      }
    }
  }
}

// 年の途中で商品IDを変更した例（旧IDの QR を読んでも開ける）
setTime(new Date(today.getTime() - 120 * 86_400_000), 10, 0);
for (const p of [products[3]!, products[40]!]) {
  const cur = fresh(p.id);
  service.updateProduct(
    cur.id,
    { code: `${cur.code}-N`, name: cur.name, category: cur.category, location: cur.location, summary: cur.summary, note: cur.note, warningStock: cur.warningStock },
    cur.version,
    { action: "keep" },
    actorOf("山田"),
  );
}

// 直近の補充：警告在庫を下回っている商品は前日に補充しておく（警告は次の数件だけにして、一覧を見やすくする）
setTime(new Date(today.getTime() - 86_400_000), 17, 0);
for (const p of products) {
  const cur = fresh(p.id);
  if (cur.stock <= cur.warningStock) {
    service.changeStock(cur.id, "IN", cur.warningStock * 2 + int(2, 8) - cur.stock, actorOf("山田"), { reason: "購入", comment: "定期発注分" });
  }
}

// 最後に数件を警告在庫より下に（警告一覧の表示例）
clock.current = new Date();
for (const p of products.slice(0, 150).filter((_, i) => i % 23 === 5)) {
  const cur = fresh(p.id);
  if (cur.stock > cur.warningStock) {
    try {
      service.changeStock(cur.id, "OUT", cur.stock - cur.warningStock + 1, actorOf("佐藤"), { comment: "まとめて持ち出し" });
    } catch {
      // 範囲外は飛ばす
    }
  }
}

db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log(`デモデータを作成しました: ${outDir}`);
console.log(`  商品 ${products.length} 件、入出庫 約 ${ops} 件（取消 ${cancels} 件）、紐づけIDリスト ${orderLines.length} 件`);
