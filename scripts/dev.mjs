// 開発用：API サーバー（変更を監視して自動再起動）と画面の開発サーバーを同時に起動する
import { spawn } from "node:child_process";

const env = { ...process.env, ZAIKO_DATA_DIR: process.env.ZAIKO_DATA_DIR ?? "dev-data" };
const procs = [
  spawn("npx", ["tsx", "watch", "server/src/main.ts"], { stdio: "inherit", env, shell: true }),
  spawn("npx", ["vite", "--host"], { stdio: "inherit", env, shell: true }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
