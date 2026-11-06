import { productUrl } from "../../../shared/text.js";
import type { Product } from "../../../shared/types.js";
import type { MailMessage } from "./mailer.js";

const pad = (n: number) => String(n).padStart(2, "0");
const dateLabel = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
const num = (n: number) => n.toLocaleString("ja-JP");

/** 在庫警告メールの本文（プレーンテキスト。メーラーを問わず崩れないため HTML にしない） */
export function buildLowStockDigest(products: Product[], now: Date, siteUrl: string, version: string): MailMessage {
  const lines: string[] = [];
  lines.push(`在庫が警告在庫以下の商品が ${products.length} 件あります（${dateLabel(now)} ${pad(now.getHours())}:${pad(now.getMinutes())} 時点）。`);
  lines.push("");
  for (const p of products) {
    lines.push(`■ ${p.code}  ${p.name}${p.offBook ? "（簿外）" : ""}`);
    lines.push(`   在庫 ${num(p.stock)} ／ 警告 ${num(p.warningStock)}${p.stock === 0 ? "  ※在庫なし" : ""}`);
    if (p.location) lines.push(`   場所: ${p.location}`);
    for (const s of p.suppliers) lines.push(`   購入元: ${s.name}${s.url ? `  ${s.url}` : ""}`);
    if (siteUrl) lines.push(`   ${productUrl(siteUrl, p.code)}`);
    lines.push("");
  }
  lines.push("--");
  lines.push(`在庫管理（Ver. ${version}）からの自動送信です。`);
  if (siteUrl) lines.push(`在庫一覧: ${siteUrl}/`);
  lines.push("通知の設定は 在庫管理の「設定」→「メール通知」で変更できます。");

  return {
    subject: `【在庫管理】在庫警告 ${products.length}件（${dateLabel(now)}）`,
    text: lines.join("\n"),
  };
}

export function buildTestMessage(now: Date, version: string, siteUrl: string): MailMessage {
  return {
    subject: "【在庫管理】テストメール",
    text: [
      "在庫管理からのテストメールです。このメールが届いていれば、メール通知の設定は正しく動いています。",
      "",
      `送信日時: ${dateLabel(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      `バージョン: ${version}`,
      siteUrl ? `画面のアドレス: ${siteUrl}/` : "",
    ]
      .filter((l, i, a) => l !== "" || i < a.length - 1)
      .join("\n"),
  };
}
