import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { isSelfAddress } from "../src/network.js";
import { describeGitError, Updater, UPDATE_TASK, type CommandResult, type CommandRunner } from "../src/updater.js";
import { createFixture, FakeClock, type Fixture } from "./helpers.js";

/** 呼ばれたコマンドを記録し、決めた結果を返す偽の実行 */
function fakeRunner(responses: Record<string, Partial<CommandResult>>) {
  const calls: string[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    calls.push(key);
    const hit = Object.entries(responses).find(([prefix]) => key.startsWith(prefix))?.[1] ?? {};
    return { status: 0, stdout: "", stderr: "", ...hit };
  };
  return { runner, calls };
}

describe("プログラムの更新", () => {
  let root: string;
  let dataDir: string;
  let clock: FakeClock;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zaiko-upd-"));
    dataDir = path.join(root, "data");
    fs.mkdirSync(path.join(root, ".git"));
    clock = new FakeClock();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const make = (responses: Record<string, Partial<CommandResult>> = {}, platform: NodeJS.Platform = "win32") => {
    const f = fakeRunner(responses);
    return { updater: new Updater({ root, dataDir, clock, runner: f.runner, platform }), calls: f.calls };
  };

  it("新しい版があれば変更内容を返す", async () => {
    const { updater } = make({
      "git rev-parse": { stdout: "abc1234\n" },
      "git log": { stdout: "def5678 移管ボタンを追加\n0123abc 決算月を選べるように\n" },
    });
    const s = await updater.check();
    expect(s).toMatchObject({ supported: true, available: true, current: "abc1234", checkError: null });
    expect(s.commits).toEqual(["def5678 移管ボタンを追加", "0123abc 決算月を選べるように"]);
    expect(s.checkedAt).not.toBeNull();
  });

  it("最新なら available: false", async () => {
    const { updater } = make({ "git rev-parse": { stdout: "abc1234\n" }, "git log": { stdout: "" } });
    expect(await updater.check()).toMatchObject({ available: false, commits: [], checkError: null });
  });

  it("取得に失敗したら理由を日本語で返し、前回の結果は残す", async () => {
    const { updater } = make({ "git fetch": { status: 128, stderr: "fatal: Authentication failed for 'https://github.com/x'" } });
    const s = await updater.check();
    expect(s.checkError).toMatch(/認証に失敗/);
    expect(s.available).toBe(false);
  });

  it("GitHub とつながっていないフォルダでは git を呼ばない", async () => {
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    const { updater, calls } = make();
    const s = await updater.check();
    expect(s.supported).toBe(false);
    expect(s.checkError).toMatch(/setup-github\.bat/);
    expect(calls).toEqual([]);
  });

  it("同時に確認しても git fetch は1回", async () => {
    const { updater, calls } = make();
    await Promise.all([updater.check(), updater.check()]);
    expect(calls.filter((c) => c.startsWith("git fetch"))).toHaveLength(1);
  });

  it("更新：更新用タスクを起動し、実行中になる。二重には始めない", async () => {
    const { updater, calls } = make();
    const s = await updater.start();
    expect(calls).toContain(`schtasks /Run /TN ${UPDATE_TASK}`);
    expect(s.running).toBe(true);
    await expect(updater.start()).rejects.toThrow(/すでに実行中/);
  });

  it("更新：結果ファイルが書かれたら実行中でなくなり、結果を返す", async () => {
    const { updater } = make();
    await updater.start();
    clock.advance(3);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "update-result.json"),
      JSON.stringify({ state: "failed", message: "ビルドに失敗しました", startedAt: clock.now().toISOString(), finishedAt: clock.now().toISOString() }),
    );
    expect(updater.status()).toMatchObject({ running: false, lastResult: { ok: false, message: "ビルドに失敗しました" } });
  });

  it("更新：結果ファイルが「実行中」のまま上限時間を過ぎたら実行中とみなさない", () => {
    const { updater } = make();
    fs.mkdirSync(dataDir, { recursive: true });
    const write = (startedAt: Date) =>
      fs.writeFileSync(path.join(dataDir, "update-result.json"), JSON.stringify({ state: "running", startedAt: startedAt.toISOString() }));
    write(clock.now());
    expect(updater.status().running).toBe(true);
    clock.advance(31);
    expect(updater.status().running).toBe(false);
    fs.writeFileSync(path.join(dataDir, "update-result.json"), "{壊れた");
    expect(updater.status()).toMatchObject({ running: false, lastResult: null });
  });

  it("更新：更新用タスクが無ければ登録し直すよう案内する", async () => {
    const { updater, calls } = make({ "schtasks /Query": { status: 1 } });
    await expect(updater.start()).rejects.toThrow(/register-autostart\.bat/);
    expect(calls.some((c) => c.startsWith("schtasks /Run"))).toBe(false);
  });

  it("更新：Windows 以外・GitHub とつながっていないフォルダでは使えない", async () => {
    await expect(make({}, "linux").updater.start()).rejects.toThrow(/Windows/);
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    await expect(make().updater.start()).rejects.toThrow(/setup-github\.bat/);
  });

  it("トークン：保存すると data のファイルとこのフォルダの git 設定を使う。トークンは返さない", async () => {
    const { updater, calls } = make();
    const token = `github_pat_${"A1b2".repeat(10)}`;
    const s = await updater.saveToken(`  ${token}\n`);
    expect(s.tokenConfigured).toBe(true);
    expect(JSON.stringify(s)).not.toContain(token);
    expect(fs.readFileSync(path.join(dataDir, "github-credentials"), "utf8")).toBe(`https://x-access-token:${token}@github.com\n`);
    expect(calls).toContain("git config --local --add credential.helper ");
    expect(calls.some((c) => c.startsWith('git config --local --add credential.helper store --file="') && c.includes("github-credentials"))).toBe(true);
  });

  it.each(["", "  "])("トークン：空なら削除する: %o", async (v) => {
    const { updater } = make();
    await updater.saveToken(`github_pat_${"x".repeat(30)}`);
    expect((await updater.saveToken(v)).tokenConfigured).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "github-credentials"))).toBe(false);
  });

  it.each(["短い", "github_pat_ abc def ghi jkl mno pqr", "x".repeat(256), 123, null])("トークン：形式が正しくなければ拒否: %o", async (v) => {
    const { updater } = make();
    await expect(updater.saveToken(v)).rejects.toThrow(/トークン/);
    expect(fs.existsSync(path.join(dataDir, "github-credentials"))).toBe(false);
  });

  it("git のエラーを何を直せばよいか分かる文にする", () => {
    expect(describeGitError("schannel: SEC_E_UNTRUSTED_ROOT")).toMatch(/証明書/);
    expect(describeGitError("fatal: could not read Username: terminal prompts disabled")).toMatch(/トークン/);
    expect(describeGitError("Could not resolve host: github.com")).toMatch(/ネットワーク/);
    expect(describeGitError("fatal: detected dubious ownership in repository")).toMatch(/update\.bat/);
    expect(describeGitError("fatal: something else\nmore")).toBe("GitHub からの取得に失敗しました（fatal: something else）。");
  });
});

describe("このPC自身からの接続の判定", () => {
  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["192.168.0.210", true],
    ["::ffff:192.168.0.210", true],
    ["192.168.0.45", false],
    ["", false],
  ])("%s → %s", (ip, expected) => {
    expect(isSelfAddress(ip, () => ["192.168.0.210", "fe80::1"])).toBe(expected);
  });
});

describe("更新の API", () => {
  let f: Fixture;
  let root: string;
  beforeEach(() => {
    f = createFixture();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zaiko-upd-api-"));
    fs.mkdirSync(path.join(root, ".git"));
  });
  afterEach(() => {
    f.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const appWith = (self: boolean) => {
    const { runner, calls } = fakeRunner({ "git rev-parse": { stdout: "abc1234\n" }, "git log": { stdout: "def5678 新機能\n" } });
    const updater = new Updater({ root, dataDir: path.join(root, "data"), clock: f.clock, runner, platform: "win32" });
    return { app: buildApp({ service: f.service, images: f.images, updater, isAllowedAddress: () => true, isSelfAddress: () => self }), calls };
  };

  it("このPC以外には更新の存在を見せず、操作も拒否する（git も schtasks も呼ばない）", async () => {
    const { app, calls } = appWith(false);
    try {
      expect((await app.inject({ method: "GET", url: "/api/update/status" })).json()).toEqual({ local: false });
      for (const [method, url, payload] of [
        ["POST", "/api/update/check", undefined],
        ["POST", "/api/update/run", {}],
        ["PUT", "/api/update/token", { token: "x" }],
      ] as const) {
        const res = await app.inject({ method, url, payload });
        expect(res.statusCode).toBe(403);
      }
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("このPCからは確認・更新できる", async () => {
    const { app, calls } = appWith(true);
    try {
      const checked = (await app.inject({ method: "POST", url: "/api/update/check" })).json();
      expect(checked).toMatchObject({ local: true, available: true, commits: ["def5678 新機能"] });
      const run = await app.inject({ method: "POST", url: "/api/update/run", payload: {} });
      expect(run.statusCode).toBe(200);
      expect(run.json()).toMatchObject({ local: true, running: true });
      expect(calls).toContain(`schtasks /Run /TN ${UPDATE_TASK}`);
    } finally {
      await app.close();
    }
  });

  it("更新の仕組みが無い環境（デモなど）では status は local: false", async () => {
    const app = buildApp({ service: f.service, images: f.images, isAllowedAddress: () => true, isSelfAddress: () => true });
    try {
      expect((await app.inject({ method: "GET", url: "/api/update/status" })).json()).toEqual({ local: false });
    } finally {
      await app.close();
    }
  });
});
