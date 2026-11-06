import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { UpdateStatus } from "../../shared/types.js";
import type { Clock } from "./clock.js";
import { ConflictError, ValidationError } from "./errors.js";

/**
 * プログラムの更新（GitHub から最新を取得 → ビルド → 再起動）を画面から行う。
 *
 * - 更新の確認：このサーバーが git fetch して、取得元（origin/main）に新しいコミットがあるかを見る
 * - 更新の実行：タスクスケジューラーの「ZaikoWebUpdate」（register-autostart.bat が登録）を起動する。
 *   実際の処理は update-task.bat → scripts/update.mjs が行う（サーバー自身を止めて再起動するため、
 *   サーバーの子プロセスではなく別のタスクとして動かす）。結果は update-result.json に書かれる。
 * - GitHub の認証：サーバーは SYSTEM で動くため、利用者の Windows に保存されたサインイン情報は使えない。
 *   読み取り専用のトークンを data フォルダに保存し、このリポジトリの git 設定（credential.helper）から使う。
 *
 * 呼び出し元（API）で「このPCからの操作か」を確認すること（他の端末からは更新させない）。
 */

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** コマンドの実行（テストで差し替える） */
export type CommandRunner = (cmd: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<CommandResult>;

export const UPDATE_TASK = "ZaikoWebUpdate";
const FETCH_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** 更新を開始してから、結果が書かれないまま「実行中」とみなす上限 */
const RUNNING_LIMIT_MS = 30 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;

/** git をこのサーバー（SYSTEM）から使うための環境変数。認証画面を出さず、所有者の違うフォルダでも動かす */
export const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
};

export const defaultRunner: CommandRunner = (cmd, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          status: error ? (typeof code === "number" ? code : -1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (error?.message ?? ""),
        });
      },
    );
  });

interface ResultFile {
  state: "running" | "done" | "failed";
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** git の失敗を、何を直せばよいか分かる日本語にする */
export function describeGitError(output: string): string {
  const text = output.toLowerCase();
  if (/authentication failed|could not read username|terminal prompts disabled|403|401|repository not found/.test(text)) {
    return "GitHub の認証に失敗しました。「読み取り用トークン」を設定し直してください。";
  }
  if (/certificate|ssl|schannel|sec_e_/.test(text)) {
    return "GitHub に接続できません（証明書のエラー）。このPCで update.bat を一度実行すると、接続の設定が引き継がれます。";
  }
  if (/could not resolve host|timed out|unable to access|connection/.test(text)) {
    return "GitHub に接続できません（ネットワーク）。このPCがインターネットに出られるか確認してください。";
  }
  if (/dubious ownership/.test(text)) {
    return "フォルダの所有者の確認で止まりました。update.bat を一度実行してください。";
  }
  const first = output.trim().split(/\r?\n/).find((l) => l.trim() !== "");
  return `GitHub からの取得に失敗しました${first ? `（${first.trim().slice(0, 200)}）` : ""}。`;
}

export class Updater {
  private checkedAt: string | null = null;
  private checkError: string | null = null;
  private available = false;
  private commits: string[] = [];
  private current = "";
  private checking: Promise<UpdateStatus> | null = null;
  private startedAt: number | null = null;

  constructor(
    private readonly o: {
      /** プログラムのフォルダ（.git がある場所） */
      root: string;
      dataDir: string;
      clock: Clock;
      runner?: CommandRunner;
      platform?: NodeJS.Platform;
    },
  ) {}

  private get runner(): CommandRunner {
    return this.o.runner ?? defaultRunner;
  }

  private get resultFile(): string {
    return path.join(this.o.dataDir, "update-result.json");
  }

  private get credentialFile(): string {
    return path.join(this.o.dataDir, "github-credentials");
  }

  private isGitRepo(): boolean {
    return fs.existsSync(path.join(this.o.root, ".git"));
  }

  private git(args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
    return this.runner("git", args, { cwd: this.o.root, timeoutMs });
  }

  private readResult(): ResultFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.resultFile, "utf8")) as ResultFile;
      return raw && typeof raw === "object" && typeof raw.state === "string" ? raw : null;
    } catch {
      return null;
    }
  }

  /** 更新を実行中か（開始の直後、または結果ファイルが「実行中」で上限時間内） */
  private isRunning(): boolean {
    const now = this.o.clock.now().getTime();
    if (this.startedAt !== null && now - this.startedAt < RUNNING_LIMIT_MS) {
      const r = this.readResult();
      // 開始後に結果が書かれたら終わり
      if (r?.finishedAt && Date.parse(r.finishedAt) >= this.startedAt) return false;
      return true;
    }
    const r = this.readResult();
    return r?.state === "running" && !!r.startedAt && now - Date.parse(r.startedAt) < RUNNING_LIMIT_MS;
  }

  status(): UpdateStatus {
    const r = this.readResult();
    return {
      supported: this.isGitRepo(),
      current: this.current,
      available: this.available,
      commits: this.commits,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      running: this.isRunning(),
      lastResult: r && r.state !== "running" ? { ok: r.state === "done", message: r.message ?? "", finishedAt: r.finishedAt ?? "" } : null,
      tokenConfigured: fs.existsSync(this.credentialFile),
    };
  }

  /** 新しい版があるか確認する（同時に呼ばれたら1回にまとめる） */
  check(): Promise<UpdateStatus> {
    this.checking ??= this.doCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async doCheck(): Promise<UpdateStatus> {
    this.checkedAt = this.o.clock.now().toISOString();
    if (!this.isGitRepo()) {
      this.checkError = "このフォルダは GitHub とつながっていません。最初に setup-github.bat を実行してください。";
      return this.status();
    }
    const fetch = await this.git(["fetch", "--prune", "--quiet"], FETCH_TIMEOUT_MS);
    if (fetch.status !== 0) {
      this.checkError = describeGitError(`${fetch.stderr}\n${fetch.stdout}`);
      return this.status();
    }
    const head = await this.git(["rev-parse", "--short", "HEAD"]);
    const log = await this.git(["log", "--format=%h %s", "--max-count=50", "HEAD..@{u}"]);
    if (head.status !== 0 || log.status !== 0) {
      this.checkError = "今の版と GitHub の版を比べられませんでした。このPCで update.bat を一度実行してください。";
      return this.status();
    }
    this.checkError = null;
    this.current = head.stdout.trim();
    this.commits = log.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
    this.available = this.commits.length > 0;
    return this.status();
  }

  /** 更新を始める（自動起動の更新用タスクを起動する）。終わるとサーバーが再起動する */
  async start(): Promise<UpdateStatus> {
    if ((this.o.platform ?? process.platform) !== "win32") {
      throw new ValidationError("画面からの更新は Windows（サーバーPC）でのみ使えます。");
    }
    if (!this.isGitRepo()) {
      throw new ValidationError("このフォルダは GitHub とつながっていません。最初に setup-github.bat を実行してください。");
    }
    if (this.isRunning()) throw new ConflictError("更新はすでに実行中です。終わるまでお待ちください。");
    const query = await this.runner("schtasks", ["/Query", "/TN", UPDATE_TASK], { cwd: this.o.root, timeoutMs: COMMAND_TIMEOUT_MS });
    if (query.status !== 0) {
      throw new ValidationError(
        "更新用のタスクが登録されていません。register-autostart.bat を右クリック →「管理者として実行」で登録し直してください。",
      );
    }
    const run = await this.runner("schtasks", ["/Run", "/TN", UPDATE_TASK], { cwd: this.o.root, timeoutMs: COMMAND_TIMEOUT_MS });
    if (run.status !== 0) {
      throw new ValidationError(`更新を開始できませんでした（${(run.stderr || run.stdout).trim().slice(0, 200)}）。`);
    }
    this.startedAt = this.o.clock.now().getTime();
    return this.status();
  }

  /**
   * GitHub の読み取り用トークンを保存する（空なら削除）。
   * data フォルダのファイルに保存し、このリポジトリの git 設定で「そのファイルだけ」を認証に使う。
   * トークンは画面に返さない。
   */
  async saveToken(raw: unknown): Promise<UpdateStatus> {
    if (typeof raw !== "string") throw new ValidationError("トークンを入力してください。");
    const token = raw.trim();
    if (!this.isGitRepo()) {
      throw new ValidationError("このフォルダは GitHub とつながっていません。最初に setup-github.bat を実行してください。");
    }
    if (token === "") {
      fs.rmSync(this.credentialFile, { force: true });
      await this.git(["config", "--local", "--unset-all", "credential.helper"]);
      return this.status();
    }
    if (!TOKEN_PATTERN.test(token)) {
      throw new ValidationError("トークンの形式が正しくありません（github_pat_ で始まる英数字。前後の空白や改行を含めずに貼り付けてください）。");
    }
    fs.mkdirSync(this.o.dataDir, { recursive: true });
    fs.writeFileSync(this.credentialFile, `https://x-access-token:${token}@github.com\n`, { encoding: "utf8", mode: 0o600 });
    const file = this.credentialFile.replace(/\\/g, "/");
    // 空の値で、それまでの認証方法（利用者の Windows に保存されたもの）を使わないようにしてから追加する
    await this.git(["config", "--local", "--unset-all", "credential.helper"]);
    const steps = [
      ["config", "--local", "--add", "credential.helper", ""],
      ["config", "--local", "--add", "credential.helper", `store --file="${file}"`],
    ];
    for (const args of steps) {
      const r = await this.git(args);
      if (r.status !== 0) throw new ValidationError(`git の設定を保存できませんでした（${(r.stderr || r.stdout).trim().slice(0, 200)}）。`);
    }
    return this.status();
  }
}
