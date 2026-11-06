// 画面とサーバーをビルドする。ビルド日時（日本時間）をバージョンとして両方に埋め込む
import { build as viteBuild } from "vite";

const parts = Object.fromEntries(
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .map((p) => [p.type, p.value]),
);
process.env.ZAIKO_VERSION = `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
console.log(`バージョン: ${process.env.ZAIKO_VERSION}`);

await viteBuild();
await import("./build-server.mjs");
