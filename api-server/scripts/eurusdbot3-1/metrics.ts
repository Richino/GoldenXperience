/**
 * eurusdbot3-1 — performance metrics, confidence buckets, account simulation.
 */
export type Trade = {
  time: string;
  direction: "long" | "short";
  r: number;
  cls: "win" | "loss" | "timeout" | "ambiguous";
  holdMs: number;
  conf: number;
};

export type Summary = {
  trades: number; wins: number; losses: number; timeouts: number; ambiguous: number;
  winRate: number;            // wins / trades
  winRateExclTimeout: number; // wins / (wins+losses+ambiguous)
  expectancy: number;         // mean R
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
  longestLossStreak: number;
  longestWinStreak: number;
  avgHoldH: number;
  medianHoldH: number;
  tpRate: number; slRate: number; timeoutRate: number; ambiguousRate: number;
};

export function summarize(trades: Trade[]): Summary {
  const n = trades.length;
  if (!n) {
    return { trades: 0, wins: 0, losses: 0, timeouts: 0, ambiguous: 0, winRate: 0, winRateExclTimeout: 0, expectancy: 0, totalR: 0, profitFactor: 0, maxDrawdownR: 0, longestLossStreak: 0, longestWinStreak: 0, avgHoldH: 0, medianHoldH: 0, tpRate: 0, slRate: 0, timeoutRate: 0, ambiguousRate: 0 };
  }
  const wins = trades.filter((t) => t.cls === "win").length;
  const losses = trades.filter((t) => t.cls === "loss").length;
  const timeouts = trades.filter((t) => t.cls === "timeout").length;
  const ambiguous = trades.filter((t) => t.cls === "ambiguous").length;
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const grossWin = trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const grossLoss = -trades.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0);

  // equity curve in R for drawdown
  let peak = 0, cum = 0, maxDD = 0;
  for (const t of trades) { cum += t.r; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }

  // streaks (win vs non-win)
  let ls = 0, lsMax = 0, ws = 0, wsMax = 0;
  for (const t of trades) {
    if (t.cls === "win") { ws++; wsMax = Math.max(wsMax, ws); ls = 0; }
    else { ls++; lsMax = Math.max(lsMax, ls); ws = 0; }
  }

  const holdsH = trades.map((t) => t.holdMs / 3_600_000).sort((a, b) => a - b);
  const avgHoldH = holdsH.reduce((s, x) => s + x, 0) / n;
  const medianHoldH = holdsH[Math.floor(n / 2)]!;
  const decided = wins + losses + ambiguous;

  return {
    trades: n, wins, losses, timeouts, ambiguous,
    winRate: wins / n,
    winRateExclTimeout: decided ? wins / decided : 0,
    expectancy: totalR / n,
    totalR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDrawdownR: maxDD,
    longestLossStreak: lsMax, longestWinStreak: wsMax,
    avgHoldH, medianHoldH,
    tpRate: wins / n, slRate: losses / n, timeoutRate: timeouts / n, ambiguousRate: ambiguous / n,
  };
}

/** Confidence buckets: top-X% by confidence. */
export function confidenceBuckets(trades: Trade[], coverages: number[]): Record<string, Summary> {
  const sorted = [...trades].sort((a, b) => b.conf - a.conf);
  const out: Record<string, Summary> = {};
  for (const cov of coverages) {
    const k = Math.max(1, Math.round(sorted.length * cov));
    out[`${Math.round(cov * 100)}%`] = summarize(sorted.slice(0, k));
  }
  return out;
}

export type AccountResult = {
  start: number; ending: number; totalReturnPct: number;
  maxDrawdownDollar: number; maxDrawdownPct: number;
  longestLossStreak: number; longestWinStreak: number;
  lowestBalance: number; highestBalance: number;
};

/** $ account sim: risk 1% of current equity per trade; equity *= (1 + 0.01*r). */
export function simulateAccount(trades: Trade[], start = 100, riskPct = 0.01): AccountResult {
  let equity = start, peak = start, low = start, high = start, maxDD$ = 0, maxDDpct = 0;
  let ls = 0, lsMax = 0, ws = 0, wsMax = 0;
  for (const t of trades) {
    equity *= 1 + riskPct * t.r;
    peak = Math.max(peak, equity);
    low = Math.min(low, equity); high = Math.max(high, equity);
    maxDD$ = Math.max(maxDD$, peak - equity);
    maxDDpct = Math.max(maxDDpct, (peak - equity) / peak);
    if (t.cls === "win") { ws++; wsMax = Math.max(wsMax, ws); ls = 0; }
    else { ls++; lsMax = Math.max(lsMax, ls); ws = 0; }
  }
  return {
    start, ending: equity, totalReturnPct: (equity / start - 1) * 100,
    maxDrawdownDollar: maxDD$, maxDrawdownPct: maxDDpct * 100,
    longestLossStreak: lsMax, longestWinStreak: wsMax,
    lowestBalance: low, highestBalance: high,
  };
}

/** Wilson lower bound (95%) on win rate — sanity on small-sample WR. */
export function wilsonLower(wins: number, n: number): number {
  if (!n) return 0;
  const z = 1.96, p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (center - margin) / denom;
}
