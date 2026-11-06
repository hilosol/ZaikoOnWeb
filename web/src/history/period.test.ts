import { describe, expect, it } from "vitest";
import { fiscalYearStartMonth } from "../../../shared/types";
import { fiscalYearOf, fiscalYearPeriod, lastMonths, matchPreset, presetPeriod } from "./period";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe("期間", () => {
  it("直近3か月：今日を含み、3か月前の翌日から", () => {
    expect(lastMonths(d(2026, 11, 6), 3)).toEqual({ from: "2026-08-07", to: "2026-11-06" });
  });
  it("月末の繰り上がり（5/31 の3か月前は 2/28 → 3/1 から）・年またぎ・うるう年", () => {
    expect(lastMonths(d(2026, 5, 31), 3)).toEqual({ from: "2026-03-01", to: "2026-05-31" });
    expect(lastMonths(d(2026, 2, 15), 6)).toEqual({ from: "2025-08-16", to: "2026-02-15" });
    expect(lastMonths(d(2028, 2, 29), 12)).toEqual({ from: "2027-03-01", to: "2028-02-29" });
  });
  it("全期間は制限なし", () => {
    expect(presetPeriod("all", d(2026, 11, 6))).toEqual({ from: "", to: "" });
  });
  it("年度（3月決算＝4月始まり）", () => {
    expect(fiscalYearOf(d(2026, 3, 31), 4)).toBe(2025);
    expect(fiscalYearOf(d(2026, 4, 1), 4)).toBe(2026);
    expect(fiscalYearPeriod(2026, 4)).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(fiscalYearPeriod(2027, 4)).toEqual({ from: "2027-04-01", to: "2028-03-31" });
  });
  it("12月決算（1月始まり）は暦年と同じ", () => {
    expect(fiscalYearStartMonth(12)).toBe(1);
    expect(fiscalYearOf(d(2026, 1, 1), 1)).toBe(2026);
    expect(fiscalYearOf(d(2026, 12, 31), 1)).toBe(2026);
    expect(fiscalYearPeriod(2026, 1)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });
  it("1月決算（2月始まり）：うるう年の2月末まで", () => {
    expect(fiscalYearStartMonth(1)).toBe(2);
    expect(fiscalYearOf(d(2027, 1, 31), 2)).toBe(2026);
    expect(fiscalYearPeriod(2027, 2)).toEqual({ from: "2027-02-01", to: "2028-01-31" });
    expect(fiscalYearPeriod(2026, 2)).toEqual({ from: "2026-02-01", to: "2027-01-31" });
  });
  it("9月決算（10月始まり）：年またぎ", () => {
    expect(fiscalYearStartMonth(9)).toBe(10);
    expect(fiscalYearOf(d(2026, 9, 30), 10)).toBe(2025);
    expect(fiscalYearOf(d(2026, 10, 1), 10)).toBe(2026);
    expect(fiscalYearPeriod(2026, 10)).toEqual({ from: "2026-10-01", to: "2027-09-30" });
  });
  it("今の期間に一致するボタン・年度", () => {
    const today = d(2026, 11, 6);
    expect(matchPreset(presetPeriod("6m", today), today, [2026], 4)).toEqual({ preset: "6m", fiscalYear: null });
    expect(matchPreset(fiscalYearPeriod(2025, 4), today, [2026, 2025], 4)).toEqual({ preset: null, fiscalYear: 2025 });
    expect(matchPreset(fiscalYearPeriod(2025, 4), today, [2026, 2025], 10)).toEqual({ preset: null, fiscalYear: null });
    expect(matchPreset({ from: "2026-01-01", to: "2026-01-31" }, today, [2026], 4)).toEqual({ preset: null, fiscalYear: null });
  });
});
