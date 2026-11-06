import { describe, expect, it } from "vitest";
import { extractCode, productUrl } from "../../shared/text.js";

describe("QR の内容から ID を取り出す", () => {
  it.each([
    ["http://192.168.0.210:8080/m?id=AP-00001", "AP-00001"],
    ["https://zaiko.example/m?id=A%2F1", "A/1"],
    ["HTTP://192.168.0.210:8080/m?x=1&id=%20B-2%20", "B-2"],
    ["AP-00001", "AP-00001"],
    ["  4901234567894 ", "4901234567894"],
    ["http://192.168.0.210:8080/", "http://192.168.0.210:8080/"], // id が無い URL はそのまま（見つからない表示になる）
    ["", ""],
  ])("%j → %j", (raw, expected) => {
    expect(extractCode(raw)).toBe(expected);
  });

  it("URL を作り、取り出すと元の ID に戻る", () => {
    for (const code of ["AP-00001", "72A-C4/035", "Ａ＆Ｂ 1"]) {
      expect(extractCode(productUrl("http://192.168.0.210:8080/", code))).toBe(code);
    }
    expect(productUrl("http://192.168.0.210:8080/", "A 1")).toBe("http://192.168.0.210:8080/m?id=A%201");
  });
});
