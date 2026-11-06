import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  // ビルド日時（scripts/build.mjs が設定）。開発サーバーでは "開発版"
  define: { __APP_VERSION__: JSON.stringify(process.env.ZAIKO_VERSION ?? "開発版") },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    // 開発時は API を開発用サーバー（scripts/dev.mjs が起動）へ中継する
    proxy: { "/api": "http://localhost:28003" },
  },
});
