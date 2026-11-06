// 共有PCでの更新：GitHub から最新を取得 → 依存パッケージを入れる → ビルド → サーバーを再起動
// update.bat から呼ぶ。手で実行する場合: node scripts/update.mjs [--force]
//   --force  更新が無くてもビルドし直す
//
// 失敗しても、動いていた版で使い続けられるようにする:
// - 手元でファイルを書き換えていたら中止（取得した内容と混ざらないように）
// - ビルドに失敗したら、前のビルド結果（dist）に戻してサーバーを起動し直す
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const TASK = "ZaikoWeb";
const force = process.argv.includes("--force");

/** コマンドを実行して結果を返す（画面に出力をそのまま出す場合は inherit） */
function run(cmd, args, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    // Windows の npm は npm.cmd のため shell 経由で起動する
    shell: isWindows && cmd === "npm",
  });
  if (r.error) {
    if (allowFail) return r;
    throw new Error(`${cmd} を実行できませんでした（${r.error.code ?? r.error.message}）。インストールされているか確認してください。`);
  }
  if (r.status !== 0 && !allowFail) {
    const detail = capture ? `\n${(r.stderr || r.stdout || "").trim()}` : "";
    throw new Error(`${cmd} ${args.join(" ")} が失敗しました（終了コード ${r.status}）。${detail}`);
  }
  return r;
}

const git = (...args) => run("git", args, { capture: true }).stdout.trim();

/** 自動起動（タスクスケジューラー）に登録されているか */
function taskExists() {
  if (!isWindows) return false;
  return run("schtasks", ["/Query", "/TN", TASK], { capture: true, allowFail: true }).status === 0;
}

function step(text) {
  console.log(`\n=== ${text}`);
}

function fail(message) {
  console.error(`\n[中止] ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 1. 事前確認

if (!fs.existsSync(path.join(root, ".git"))) {
  fail("このフォルダは Git で管理されていません。README の「GitHub から更新する（初回の準備）」を先に行ってください。");
}
const dirty = git("status", "--porcelain", "--untracked-files=no");
if (dirty) {
  fail(
    "このPCでプログラムのファイルが書き換えられています。取得した内容と混ざるため中止しました。\n" +
      `${dirty}\n` +
      "書き換えが不要なら「git checkout -- .」で元に戻してから、もう一度実行してください。",
  );
}

// ---------------------------------------------------------------- 2. 最新を取得

step("GitHub から最新を確認しています");
run("git", ["fetch", "--prune"]);
const local = git("rev-parse", "HEAD");
let remote;
try {
  remote = git("rev-parse", "@{u}");
} catch {
  fail("取得元（origin/main）が設定されていません。README の初回の準備を確認してください。");
}
if (local === remote && !force && fs.existsSync(path.join(root, "dist", "server.mjs"))) {
  console.log("すでに最新です。更新はありません。（ビルドし直す場合は --force を付けて実行）");
  process.exit(0);
}
if (local !== remote) {
  console.log(git("log", "--oneline", `${local}..${remote}`) || "(差分の一覧なし)");
  // 早送りできない（このPCで独自のコミットがある）場合は失敗して止まる
  run("git", ["merge", "--ff-only", "@{u}"]);
}

// ---------------------------------------------------------------- 3. 依存パッケージ

step("必要なパッケージを入れています（数分かかることがあります）");
run("npm", ["ci", "--no-audit", "--no-fund"]);

// ---------------------------------------------------------------- 4. サーバーを止めてビルド

const hasTask = taskExists();
if (hasTask) {
  step("サーバーを停止しています");
  run("schtasks", ["/End", "/TN", TASK], { capture: true, allowFail: true });
} else if (isWindows) {
  console.log("\n※ 自動起動は登録されていません。start.bat で起動している場合は、その画面を閉じてから続けてください。");
}

const dist = path.join(root, "dist");
const prev = path.join(root, "dist.prev");
fs.rmSync(prev, { recursive: true, force: true });
if (fs.existsSync(dist)) fs.renameSync(dist, prev);

step("ビルドしています");
const build = run("npm", ["run", "build"], { allowFail: true });
let ok = build.status === 0 && fs.existsSync(path.join(dist, "server.mjs"));
if (!ok) {
  console.error("\nビルドに失敗しました。前の版に戻します。");
  fs.rmSync(dist, { recursive: true, force: true });
  if (fs.existsSync(prev)) fs.renameSync(prev, dist);
} else {
  fs.rmSync(prev, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5. 起動

if (hasTask) {
  step("サーバーを起動しています");
  run("schtasks", ["/Run", "/TN", TASK], { capture: true, allowFail: true });
}

if (!ok) fail("ビルドに失敗したため、前の版で動かしています。上のエラーを確認してください。");
console.log(`\n更新が完了しました（${git("log", "-1", "--format=%h %s")}）。`);
if (!hasTask) console.log("start.bat でサーバーを起動してください。");
