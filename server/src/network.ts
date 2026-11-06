import { BlockList, isIPv4, isIPv6 } from "node:net";
import os from "node:os";

/**
 * ローカルネットワーク（プライベートアドレス）からの接続だけを許可する。
 * ルーターやファイアウォールの設定ミスで外部に公開されてしまった場合の二重の防御。
 * X-Forwarded-For などのヘッダーは偽装できるため使わず、TCP 接続元のアドレスだけで判定する。
 */
const allowed = new BlockList();
allowed.addSubnet("127.0.0.0", 8, "ipv4"); // 自分自身
allowed.addSubnet("10.0.0.0", 8, "ipv4");
allowed.addSubnet("172.16.0.0", 12, "ipv4");
allowed.addSubnet("192.168.0.0", 16, "ipv4");
allowed.addSubnet("169.254.0.0", 16, "ipv4"); // リンクローカル
allowed.addAddress("::1", "ipv6");
allowed.addSubnet("fc00::", 7, "ipv6"); // ユニークローカル
allowed.addSubnet("fe80::", 10, "ipv6"); // リンクローカル

/** "::ffff:192.168.1.5" → "192.168.1.5"、IPv6 のゾーンID（%eth0）を除去 */
export function normalizeIp(address: string | undefined | null): string {
  if (!address) return "";
  let ip = address.trim();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

export function isLanAddress(address: string | undefined | null): boolean {
  const ip = normalizeIp(address);
  if (isIPv4(ip)) return allowed.check(ip, "ipv4");
  if (isIPv6(ip)) return allowed.check(ip, "ipv6");
  return false;
}

/** 起動時の案内用：このPCの社内向け IPv4 アドレス一覧 */
export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal && isLanAddress(info.address)) result.push(info.address);
    }
  }
  return result;
}

/**
 * このPC自身からの接続か（自分自身 127.0.0.1 / ::1、またはこのPCに割り当てられたアドレス）。
 * サーバーPCの画面でだけ許す操作（プログラムの更新）の判定に使う。
 */
export function isSelfAddress(address: string | undefined | null, own: () => string[] = ownAddresses): boolean {
  const ip = normalizeIp(address);
  if (ip === "") return false;
  if (ip === "::1" || (isIPv4(ip) && ip.startsWith("127."))) return true;
  return own().includes(ip);
}

/** このPCに割り当てられたすべてのアドレス */
export function ownAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((i) => normalizeIp(i.address)));
}
