/**
 * h1-next-candle-v1 — stats helpers.
 */
export type Outcome = "WIN" | "LOSS" | "TIE";
export type PredictDirection = "BUY" | "SELL" | "WAIT";

export function wilsonInterval(wins: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (!n) return { lower: 0, upper: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { lower: (center - margin) / denom, upper: (center + margin) / denom };
}

export function wrStats(wins: number, losses: number, ties = 0) {
  const decided = wins + losses;
  const n = wins + losses + ties;
  const ci = wilsonInterval(wins, decided);
  return {
    n,
    wins,
    losses,
    ties,
    decided,
    winRate: decided ? wins / decided : 0,
    ciLower: ci.lower,
    ciUpper: ci.upper,
    fiftyInCi: ci.lower <= 0.5 && ci.upper >= 0.5,
  };
}

export function scoreOutcome(pred: PredictDirection, open: number, close: number): Outcome {
  if (pred === "WAIT") return "TIE";
  if (close === open) return "TIE";
  if (pred === "BUY") return close > open ? "WIN" : "LOSS";
  return close < open ? "WIN" : "LOSS";
}

export function fmtPct(x: number, d = 2): string {
  return (x * 100).toFixed(d) + "%";
}

export function sessionUtc(hourUtc: number): string {
  if (hourUtc >= 12 && hourUtc < 16) return "London/NY overlap";
  if (hourUtc >= 7 && hourUtc < 12) return "London";
  if (hourUtc >= 16 && hourUtc < 21) return "New York";
  return "Asia";
}
