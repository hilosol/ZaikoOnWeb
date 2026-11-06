// サーバーを依存ライブラリごと1ファイル（dist/server.mjs）にまとめる。
// 共有PCには node_modules を置かずに、dist フォルダと Node.js だけで動かせる。
import { copyFileSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["server/src/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  define: { __APP_VERSION__: JSON.stringify(process.env.ZAIKO_VERSION ?? "開発版") },
  // ESM で require を使うライブラリ向け
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
copyFileSync("scripts/check-node.cjs", "dist/check-node.cjs");
console.log("dist/server.mjs を作成しました");
