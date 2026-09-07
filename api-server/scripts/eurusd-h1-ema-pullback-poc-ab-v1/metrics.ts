import type { ClosedTrade, Direction, RawOpportunity } from "./engine.js";

export type MetricPack = {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancyUsd: number | null;
  expectancyR: number | null;
  averageR: number | null;
  medianR: number | null;
  totalR: number;
  netProfitUsd: number;
  averageWinnerUsd: number | null;
  averageLoserUsd: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  maxDrawdownR: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  averageHoldHours: number | null;
  medianHoldHours: number | null;
  timeExitCount: number;
  weekendExitCount: number;
  startingBalance: number;
  endingBalance: number;
  netReturnPct: number;
  tradesPerYear: number | null;
};

export type Classification =
  | "POC_HELPFUL"
  | "POC_NEUTRAL"
  | "POC_HARMFUL"
  | "INSUFFICIENT_DATA"
  | "IMPLEMENTATION_FAILED";

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function maxDrawdownUsd(balances: readonly number[]): { dollars: number; pct: number } {
  let peak = balances[0] ?? 0;
  let dollars = 0;
  let pct = 0;
  for (const balance of balances) {
    peak = Math.max(peak, balance);
    const dd = peak - balance;
    if (dd > dollars) {
      dollars = dd;
      pct = peak > 0 ? dd / peak : 0;
    }
  }
  return { dollars, pct };
}

export function maxDrawdownR(results: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const result of results) {
    equity += result;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return dd;
}

function streak(trades: readonly ClosedTrade[], win: boolean): number {
  let best = 0;
  let current = 0;
  for (const trade of trades) {
    const isWin = trade.resultR > 0;
    if (isWin === win) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

export function packMetrics(trades: readonly ClosedTrade[], startingBalance: number, years: number): MetricPack {
  const wins = trades.filter((trade) => trade.resultR > 0);
  const losses = trades.filter((trade) => trade.resultR < 0);
  const rs = trades.map((trade) => trade.resultR);
  const pnls = trades.map((trade) => trade.pnlUsd);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const grossProfitR = wins.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLossR = Math.abs(losses.reduce((sum, trade) => sum + trade.resultR, 0));
  const ending = startingBalance + pnls.reduce((sum, value) => sum + value, 0);
  let running = startingBalance;
  const curve = [startingBalance];
  for (const trade of trades) {
    running += trade.pnlUsd;
    curve.push(running);
  }
  const dd = maxDrawdownUsd(curve);
  const holds = trades.map((trade) => trade.holdMs);
  const pfUsd = grossLossAbs > 0 ? grossProfit / grossLossAbs : null;
  const pfR = grossLossR > 0 ? grossProfitR / grossLossR : null;
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: pfUsd ?? pfR,
    expectancyUsd: trades.length ? mean(pnls) : null,
    expectancyR: trades.length ? mean(rs) : null,
    averageR: mean(rs),
    medianR: median(rs),
    totalR: rs.reduce((sum, value) => sum + value, 0),
    netProfitUsd: ending - startingBalance,
    averageWinnerUsd: mean(wins.map((trade) => trade.pnlUsd)),
    averageLoserUsd: mean(losses.map((trade) => trade.pnlUsd)),
    maxDrawdownUsd: dd.dollars,
    maxDrawdownPct: dd.pct,
    maxDrawdownR: maxDrawdownR(rs),
    maxConsecutiveWins: streak(trades, true),
    maxConsecutiveLosses: streak(trades, false),
    averageHoldHours: mean(holds.map((value) => value / 3_600_000)),
    medianHoldHours: median(holds.map((value) => value / 3_600_000)),
    timeExitCount: trades.filter((trade) => trade.exitReason === "TIME_EXIT_48H").length,
    weekendExitCount: trades.filter((trade) => trade.exitReason === "WEEKEND_EXIT").length,
    startingBalance,
    endingBalance: ending,
    netReturnPct: startingBalance > 0 ? (ending - startingBalance) / startingBalance : 0,
    tradesPerYear: years > 0 ? trades.length / years : null,
  };
}

export function wilsonInterval(wins: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = wins / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom;
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

export function bootstrapMeanDiff(
  a: readonly number[],
  b: readonly number[],
  draws = 4000,
  seed = 1,
): { low: number; high: number; mean: number } | null {
  if (!a.length || !b.length) return null;
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const pick = (values: readonly number[]) => values[Math.floor(rand() * values.length)]!;
  const samples: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < a.length; i += 1) meanA += pick(a);
    for (let i = 0; i < b.length; i += 1) meanB += pick(b);
    samples.push(meanB / b.length - meanA / a.length);
  }
  samples.sort((left, right) => left - right);
  const meanDiff = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const low = samples[Math.floor(0.025 * samples.length)]!;
  const high = samples[Math.min(samples.length - 1, Math.floor(0.975 * samples.length))]!;
  return { low, high, mean: meanDiff };
}

export function pairedBootstrapDiff(
  pairs: readonly number[],
  draws = 4000,
  seed = 2,
): { low: number; high: number; mean: number } | null {
  if (!pairs.length) return null;
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const samples: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0;
    for (let i = 0; i < pairs.length; i += 1) {
      sum += pairs[Math.floor(rand() * pairs.length)]!;
    }
    samples.push(sum / pairs.length);
  }
  samples.sort((left, right) => left - right);
  return {
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    low: samples[Math.floor(0.025 * samples.length)]!,
    high: samples[Math.min(samples.length - 1, Math.floor(0.975 * samples.length))]!,
  };
}

export function byDirection(trades: readonly ClosedTrade[]): Record<Direction, ClosedTrade[]> {
  return {
    long: trades.filter((trade) => trade.direction === "long"),
    short: trades.filter((trade) => trade.direction === "short"),
  };
}

export function classifyPoc(input: {
  implementationFailed: boolean;
  a: MetricPack;
  b: MetricPack;
  freshA: MetricPack;
  freshB: MetricPack;
  freshOpportunityCount: number;
}): { classification: Classification; reason: string } {
  if (input.implementationFailed) {
    return { classification: "IMPLEMENTATION_FAILED", reason: "Causality, data, or A/B isolation failed." };
  }
  const freshUsable = input.freshA.n >= 30 && input.freshB.n >= 30 && input.freshOpportunityCount >= 80;
  const evalA = freshUsable ? input.freshA : input.a;
  const evalB = freshUsable ? input.freshB : input.b;
  if (evalA.n < 20 || evalB.n < 20) {
    return { classification: "INSUFFICIENT_DATA", reason: `Too few trades for a causal claim (A n=${evalA.n}, B n=${evalB.n}).` };
  }
  const expA = evalA.expectancyR ?? 0;
  const expB = evalB.expectancyR ?? 0;
  const pfA = evalA.profitFactor ?? 0;
  const pfB = evalB.profitFactor ?? 0;
  const expLift = expB - expA;
  if (!freshUsable && input.freshOpportunityCount < 80) {
    if (Math.abs(expLift) < 0.05) {
      return { classification: "INSUFFICIENT_DATA", reason: "Fresh window is small and the expectancy gap is not economically large." };
    }
  }
  if (expLift >= 0.05 && pfB >= pfA && (evalB.winRate == null || evalA.winRate == null || !(evalB.winRate > evalA.winRate && expLift < 0))) {
    if (freshUsable && ((input.freshB.expectancyR ?? 0) - (input.freshA.expectancyR ?? 0) < 0)) {
      return { classification: "POC_NEUTRAL", reason: "Full-sample quality lift did not survive fresh validation." };
    }
    return { classification: "POC_HELPFUL", reason: "B improved expectancy R and did not worsen profit factor after costs." };
  }
  if (expLift <= -0.05 || (pfB > 0 && pfA > 0 && pfB < pfA && expLift < 0)) {
    return { classification: "POC_HARMFUL", reason: "B worsened after-cost expectancy and/or profit factor." };
  }
  return { classification: "POC_NEUTRAL", reason: "POC changed trade count more than it changed trade quality." };
}

export function opportunitySplit(opportunities: readonly RawOpportunity[], count: number): {
  dev: RawOpportunity[];
  fresh: RawOpportunity[];
} {
  return {
    dev: opportunities.slice(0, count),
    fresh: opportunities.slice(count),
  };
}

export function round(value: number | null | undefined, digits = 6): number | null {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}
