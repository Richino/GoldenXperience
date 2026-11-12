import type { TrendDirection } from "@/lib/news/surprise-hint";

/** How the chosen signal had scored on earlier releases when the call was made. */
export type SignalRecord = { n: number; hits: number; scope: "series" | "overall" };

export type GroupCall = {
  title: string;
  /** Calendar impact level (higher = more market-moving); undefined when unknown. */
  impact?: number;
  move: TrendDirection | null;
  record: SignalRecord | null;
  /**
   * Strength of the forecast-vs-previous change (forecastRead): weight 1–2,
   * then size within a weight. Undefined when the release has no read.
   */
  forecastStrength?: { weight: number; size: number };
};

export type GroupLeanReason = "forecast" | "record" | "impact" | "headline" | "weight" | "listed";

/** Smoothed hit rate, so a 1/1 record does not outrank 8/10. */
export const recordScore = (record: SignalRecord | null | undefined) => (record ? (record.hits + 1) / (record.n + 2) : 0);

/**
 * Quarterly and yearly prints are the headline of a release day (UK Prelim
 * GDP q/q over GDP m/m, CPI y/y over m/m); a monthly change is the sub-figure.
 */
function headlineRank(title: string) {
  if (/\b(q\/q|y\/y|qoq|yoy)\b/i.test(title)) return 2;
  if (/\b(m\/m|mom)\b/i.test(title)) return 0;
  return 1;
}

/**
 * Simultaneous releases move the currency once. When their calls disagree,
 * pick one side, in this order:
 *  1. forecast: the release with the strongest forecast-vs-previous change
 *     (a clear change over a slight one, then the bigger change) decides;
 *  2. record: one call's signal has a clearly better record (≥5 points, 8+ calls);
 *  3. impact: one side's releases carry a higher calendar impact;
 *  4. headline: one side holds the headline print (q/q or y/y over m/m);
 *  5. weight: the side whose summed record score is larger;
 *  6. listed: the first-listed release decides.
 * Returns null only when there is nothing to choose (no conflicting calls).
 */
export function groupLean(calls: GroupCall[]): { move: TrendDirection; leader: GroupCall; against: GroupCall; reason: GroupLeanReason } | null {
  const called = calls.filter((call): call is GroupCall & { move: TrendDirection } => call.move !== null);
  const up = called.filter((call) => call.move === "up");
  const down = called.filter((call) => call.move === "down");
  if (!up.length || !down.length) return null;

  const best = (side: typeof called, key: (call: GroupCall) => number) =>
    side.reduce((top, call) => (key(call) > key(top) ? call : top));
  const decide = (key: (call: GroupCall) => number, reason: GroupLeanReason, margin = 0) => {
    const u = best(up, key), d = best(down, key);
    if (key(u) - key(d) > margin) return { move: "up" as const, leader: u, against: d, reason };
    if (key(d) - key(u) > margin) return { move: "down" as const, leader: d, against: u, reason };
    return null;
  };

  // Weight dominates (a clear change beats any slight one); size breaks ties within it.
  const byForecast = decide((call) => (call.forecastStrength ? call.forecastStrength.weight * 1_000 + Math.min(call.forecastStrength.size, 999) : 0), "forecast");
  if (byForecast) return byForecast;
  const byRecord = decide((call) => recordScore(call.record), "record", 0.05 - 1e-9);
  if (byRecord && (byRecord.leader.record?.n ?? 0) >= 8) return byRecord;
  const byImpact = decide((call) => call.impact ?? 0, "impact");
  if (byImpact) return byImpact;
  const byHeadline = decide((call) => headlineRank(call.title), "headline");
  if (byHeadline) return byHeadline;
  const weight = (side: typeof called) => side.reduce((sum, call) => sum + recordScore(call.record), 0);
  if (weight(up) !== weight(down)) {
    const move = weight(up) > weight(down) ? "up" as const : "down" as const;
    const [leaderSide, otherSide] = move === "up" ? [up, down] : [down, up];
    return { move, leader: leaderSide[0]!, against: otherSide[0]!, reason: "weight" };
  }
  const leader = called[0]!;
  return { move: leader.move, leader, against: (leader.move === "up" ? down : up)[0]!, reason: "listed" };
}
