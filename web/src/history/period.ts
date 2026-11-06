
/** 期間（YYYY-MM-DD。両端を含む。"" = 制限なし） */
export interface Period {
  from: string;
  to: string;
}

export type PeriodPreset = "3m" | "6m" | "1y" | "all";

export const PresetLabels: Record<PeriodPreset, string> = {
  "3m": "直近3か月",
  "6m": "半年",
  "1y": "1年",
  all: "全期間",
};

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * 「直近Nか月」：今日を含み、Nか月前の翌日から。月末の繰り上がりは月末にそろえる
 * （例: 5/31 の3か月前 → 2/28 の翌日 = 3/1 から 5/31 まで）。
 */
export function lastMonths(today: Date, months: number): Period {
  const y = today.getFullYear();
  const m = today.getMonth() - months;
  const lastDayOfTarget = new Date(y, m + 1, 0).getDate();
  const start = new Date(y, m, Math.min(today.getDate(), lastDayOfTarget) + 1);
  return { from: ymd(start), to: ymd(today) };
}

export function presetPeriod(preset: PeriodPreset, today: Date): Period {
  switch (preset) {
    case "3m":
      return lastMonths(today, 3);
    case "6m":
      return lastMonths(today, 6);
    case "1y":
      return lastMonths(today, 12);
    default:
      return { from: "", to: "" };
  }
}

/*
 * 年度は「始まった年」で呼ぶ（3月決算＝4月始まりなら 2026年度 = 2026/4/1〜2027/3/31）。
 * startMonth は年度の始まりの月（1〜12）。決算月からは fiscalYearStartMonth() で求める。
 * 12月決算（1月始まり）なら年度 = 暦年。
 */

/** その日が属する年度（4月始まりなら 2026/3/31 → 2025年度、2026/4/1 → 2026年度） */
export function fiscalYearOf(date: Date, startMonth: number): number {
  return date.getMonth() + 1 >= startMonth ? date.getFullYear() : date.getFullYear() - 1;
}

/** 年度の期間（4月始まりなら 2026年度 = 2026-04-01〜2027-03-31） */
export function fiscalYearPeriod(year: number, startMonth: number): Period {
  const start = new Date(year, startMonth - 1, 1);
  const end = new Date(year, startMonth - 1 + 12, 0); // 12か月後の前日（月末）
  return { from: ymd(start), to: ymd(end) };
}

/** 今の期間がどのボタン・年度と一致するか（押したボタンを強調表示するため） */
export function matchPreset(
  period: Period,
  today: Date,
  fiscalYears: number[],
  startMonth: number,
): { preset: PeriodPreset | null; fiscalYear: number | null } {
  for (const p of Object.keys(PresetLabels) as PeriodPreset[]) {
    const pp = presetPeriod(p, today);
    if (pp.from === period.from && pp.to === period.to) return { preset: p, fiscalYear: null };
  }
  for (const y of fiscalYears) {
    const fp = fiscalYearPeriod(y, startMonth);
    if (fp.from === period.from && fp.to === period.to) return { preset: null, fiscalYear: y };
  }
  return { preset: null, fiscalYear: null };
}
