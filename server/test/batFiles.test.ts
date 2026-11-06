import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * サーバーPC用の .bat ファイルの約束事を確認する（Windows でしか実行できないので、中身の静的チェックのみ）。
 * - ASCII のみ・改行 CRLF（日本語や LF だとサーバーPCで文字化け・誤動作する）
 * - ポートの既定値 28003 は load-settings.bat と settings.example.bat だけに書く（変更箇所を1か所にする）
 */
const root = path.resolve(__dirname, "../..");
const batFiles = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith(".bat"));
const read = (f: string) => fs.readFileSync(path.join(root, f));

describe("サーバーPC用の bat ファイル", () => {
  it("bat ファイルがある", () => {
    expect(batFiles).toContain("load-settings.bat");
    expect(batFiles).toContain("settings.example.bat");
  });

  it.each(batFiles)("%s は ASCII のみ・改行 CRLF", (f) => {
    const buf = read(f);
    expect([...buf].every((b) => b < 0x80), "ASCII 以外の文字がある").toBe(true);
    const text = buf.toString("ascii");
    expect(text.replace(/\r\n/g, "").includes("\n"), "LF だけの改行がある").toBe(false);
  });

  it.each(["start.bat", "run-server.bat", "register-autostart.bat"])("%s は設定を load-settings.bat から読む", (f) => {
    const text = read(f).toString("ascii");
    expect(text).toMatch(/call load-settings\.bat/i);
    expect(text).not.toMatch(/^\s*set\s+ZAIKO_PORT\s*=/im);
    expect(text).not.toMatch(/^\s*set\s+PORT\s*=/im);
  });

  it("既定のポート 28003 は load-settings.bat と settings.example.bat、サーバーの既定値で一致する", () => {
    const def = /set ZAIKO_PORT=(\d+)/;
    expect(read("load-settings.bat").toString("ascii").match(def)?.[1]).toBe("28003");
    expect(read("settings.example.bat").toString("ascii").match(def)?.[1]).toBe("28003");
    expect(fs.readFileSync(path.join(root, "server/src/main.ts"), "utf8")).toContain("ZAIKO_PORT ?? 28003");
  });

  it("settings.bat（サーバーPCごとの設定）は GitHub で管理しない", () => {
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toMatch(/^\/settings\.bat$/m);
  });
});
