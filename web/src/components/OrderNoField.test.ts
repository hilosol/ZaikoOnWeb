import { describe, expect, it } from "vitest";
import { filterCandidates } from "./OrderNoField";

const c = (number: string, name = "", recent = false) => ({ number, name, recent });
const all = [c("YHO-26002", "京都大学_HMP-400"), c("YHO-26042", "キオクシア_高温プローバー"), c("AWO-26008", "湖北工業_AW610M"), c("TMP-1", "", true)];

describe("受注番号の候補の絞り込み", () => {
  it("空なら全件", () => {
    expect(filterCandidates(all, "")).toHaveLength(4);
  });
  it("番号の前方一致を先に、部分一致・案件名を後に（ハイフン・大小文字を無視）", () => {
    expect(filterCandidates(all, "yho2600").map((x) => x.number)).toEqual(["YHO-26002"]);
    expect(filterCandidates(all, "26008").map((x) => x.number)).toEqual(["AWO-26008"]);
    expect(filterCandidates(all, "awo").map((x) => x.number)).toEqual(["AWO-26008"]);
  });
  it("案件名でも探せる（ひらがな・カタカナを区別しない）", () => {
    expect(filterCandidates(all, "きおくしあ").map((x) => x.number)).toEqual(["YHO-26042"]);
    expect(filterCandidates(all, "京都").map((x) => x.number)).toEqual(["YHO-26002"]);
  });
  it("該当なしは空", () => {
    expect(filterCandidates(all, "ZZZ")).toEqual([]);
  });
});
