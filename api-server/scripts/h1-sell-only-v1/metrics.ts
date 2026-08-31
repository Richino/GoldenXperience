/**
 * h1-sell-only-v1 — Wilson CI and outcome helpers.
 */
export type Outcome = "WIN" | "LOSS" | "TIE";

export type CountStats = {
  n: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  ciLower: number;
  ciUpper: number;
  fiftyInCi: boolean;
};

export function wilsonInterval(wins: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (!n) return { lower: 0, upper: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { lower: (center - margin) / denom, upper: (center + margin) / denom };
}

export function summarize(outcomes: Outcome[]): CountStats {
  const wins = outcomes.filter((o) => o === "WIN").length;
  const losses = outcomes.filter((o) => o === "LOSS").length;
  const ties = outcomes.filter((o) => o === "TIE").length;
  const n = wins + losses + ties;
  const ci = wilsonInterval(wins, n);
  return {
    n,
    wins,
    losses,
    ties,
    winRate: n ? wins / n : 0,
    ciLower: ci.lower,
    ciUpper: ci.upper,
    fiftyInCi: ci.lower <= 0.5 && ci.upper >= 0.5,
  };
}

export function sellOpenClose(open: number, close: number): Outcome {
  if (close < open) return "WIN";
  if (close > open) return "LOSS";
  return "TIE";
}

export function sellForward(entry: number, future: number): Outcome {
  if (future < entry) return "WIN";
  if (future > entry) return "LOSS";
  return "TIE";
}

export function invertOutcome(o: Outcome): Outcome {
  if (o === "WIN") return "LOSS";
  if (o === "LOSS") return "WIN";
  return "TIE";
}

export type PairBias = "SELL_BIAS" | "NO_CLEAR_BIAS" | "BUY_BIAS";

export function classifyPairBias(stats: CountStats, minN = 500): PairBias {
  if (stats.n < minN) return "NO_CLEAR_BIAS";
  if (stats.ciLower > 0.5) return "SELL_BIAS";
  if (stats.ciUpper < 0.5) return "BUY_BIAS";
  return "NO_CLEAR_BIAS";
}

export function fmtPct(x: number, d = 2): string {
  return (x * 100).toFixed(d) + "%";
}

export function sessionUtc(hourUtc: number): string {
  if (hourUtc >= 12 && hourUtc < 16) return "London/NY overlap";
  if (hourUtc >= 7 && hourUtc < 12) return "London";
  if (hourUtc >= 16 && hourUtc < 21) return "New York";
  if (hourUtc >= 21 || hourUtc < 7) return "Asia";
  return "Off-hours";
}

export function hourNewYork(iso: string): number {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")!.value);
}
