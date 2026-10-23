import type { TrendDirection } from "@/lib/strategy/analyze-v2/structure";
import { weeklySwingStatus } from "@/lib/swing-trend-status";
import { MAJOR_INSTRUMENTS } from "@/types/forex";

export type PairTrendRow = { instrument: string; w1: TrendDirection; d1: TrendDirection; h4: TrendDirection };
export type PairTrendsSnapshot = { checkedAt: string; pairs: PairTrendRow[]; scanStatus?: "warming" | "unavailable"; refreshing?: boolean };
const featured = new Set<string>(MAJOR_INSTRUMENTS);

/** Timing describes observed structure, not an executable entry or probability. */
export function weeklyTiming(pair: PairTrendRow) {
  if (pair.h4 === pair.d1) return { rank: 0, label: "4H aligned" };
  if (pair.h4 === "RANGE") return { rank: 1, label: "4H consolidating" };
  if (pair.h4 === "TRANSITION") return { rank: 2, label: "4H changing" };
  if (pair.h4 === "UNCLEAR") return { rank: 3, label: "4H unclear" };
  return { rank: 4, label: "4H opposing move" };
}

/** Weekly + Daily alignment is required; H4 confirms timing, never supplies the weekly bias. */
export function compareWeeklyTrends(a: PairTrendRow, b: PairTrendRow) {
  const aRank = weeklySwingStatus(a.w1 ?? null, a.d1 ?? null).rank;
  const bRank = weeklySwingStatus(b.w1 ?? null, b.d1 ?? null).rank;
  return aRank - bRank
    || (aRank === 0 ? weeklyTiming(a).rank - weeklyTiming(b).rank
      || Number(featured.has(b.instrument)) - Number(featured.has(a.instrument)) : 0)
    || a.instrument.localeCompare(b.instrument);
}

export function rankWeeklyTrends(pairs: readonly PairTrendRow[]) {
  return pairs.filter(pair => weeklySwingStatus(pair.w1 ?? null, pair.d1 ?? null).rank === 0)
    .sort(compareWeeklyTrends);
}
