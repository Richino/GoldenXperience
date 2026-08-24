import { pipSizeFor } from "../../../src/data.js";
import { mean } from "../../../src/math.js";
import {
  CURRENCIES,
  FINANCING_DAILY_SCALE,
  REBALANCE,
  SLIPPAGE_PIPS,
  type MomHorizon,
  type PortfolioK,
  type RebalanceFreq,
} from "../config.js";
import { type D1Panel, splitPair } from "../d1/aggregate.js";
import { pairCarryDifferential } from "../pairs.js";
import { yieldAsOf, type YieldObs } from "../yields/store.js";
import type { Currency } from "../types.js";
import {
  buildRanks,
  selectPortfolio,
  zoneOf,
  type Position,
} from "./signals.js";
import { statsFromReturns, type PeriodReturn, type PortfolioStats } from "./metrics.js";

export type BacktestSpec = {
  signal: "carry" | "momentum" | "combined";
  carryWeight: number;
  momWeight: number;
  k: PortfolioK;
  rebalance: RebalanceFreq;
  momHorizon: MomHorizon;
  volScaled: boolean;
  costMult: number;
  zone: "train" | "dev" | "sealed";
  allowSealed: boolean;
};

export type BacktestResult = {
  spec: BacktestSpec;
  returns: PeriodReturn[];
  stats: PortfolioStats;
  turnover: number;
  avgHoldDays: number;
  rebalanceCount: number;
  exposureByCcy: Record<Currency, number>;
  byYear: Record<string, { ret: number; n: number }>;
  agreement: { both: number; carryOnly: number; momOnly: number; conflict: number };
};

function periodReturn(
  positions: Position[],
  panels: Map<string, D1Panel>,
  dateFrom: string,
  dateTo: string,
  yields: YieldObs[],
  costMult: number,
): { ret: number; gross: number; cost: number; financing: number } | null {
  let gross = 0;
  let cost = 0;
  let financing = 0;
  let n = 0;

  for (const pos of positions) {
    const panel = panels.get(pos.instrument);
    if (!panel) continue;
    const i = panel.dateIndex.get(dateFrom);
    const j = panel.dateIndex.get(dateTo);
    if (i == null || j == null) continue;
    const b0 = panel.bars[i]!;
    const b1 = panel.bars[j]!;
    if (b0.bidClose == null || b0.askClose == null || b1.bidClose == null || b1.askClose == null) continue;

    const slip = SLIPPAGE_PIPS * pipSizeFor(pos.instrument) * costMult;
    const w = pos.weight;
    const entry = pos.direction === "long" ? b0.askClose + slip : b0.bidClose - slip;
    const exit = pos.direction === "long" ? b1.bidClose - slip : b1.askClose + slip;
    const pxRet = pos.direction === "long" ? exit / entry - 1 : entry / exit - 1;
    const spread = ((b0.askClose - b0.bidClose) + (b1.askClose - b1.bidClose)) / b0.close;
    const days = Math.max(1, j - i);

    const rates = new Map<Currency, number>();
    for (const c of ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as Currency[]) {
      const v = yieldAsOf(yields, c, b0.closeTime);
      if (v != null) rates.set(c, v);
    }
    const carryDiff = pairCarryDifferential(pos.instrument, rates) ?? 0;
    const signedCarry = pos.direction === "long" ? carryDiff : -carryDiff;
    const fin = signedCarry * days * FINANCING_DAILY_SCALE;

    gross += w * pxRet;
    cost += w * spread * costMult;
    financing += w * fin;
    n += 1;
  }

  if (n === 0) return null;
  const ret = gross - cost + financing;
  return { ret, gross, cost, financing };
}

export function runBacktest(args: {
  panels: Map<string, D1Panel>;
  instruments: readonly string[];
  dates: string[];
  yields: YieldObs[];
  spec: BacktestSpec;
}): BacktestResult {
  const { panels, instruments, dates, yields, spec } = args;
  const stride = REBALANCE[spec.rebalance];
  const periodsPerYear = Math.round(252 / stride);

  const returns: PeriodReturn[] = [];
  let prevPositions: Position[] = [];
  let turnoverSum = 0;
  let rebalanceCount = 0;
  const exposure = new Map<Currency, number>();
  const byYear: Record<string, { ret: number; n: number }> = {};
  const agreement = { both: 0, carryOnly: 0, momOnly: 0, conflict: 0 };

  for (let di = 252; di < dates.length - stride; di += stride) {
    const date = dates[di]!;
    const p0 = panels.get(instruments[0]!);
    if (!p0) continue;
    const bar = p0.bars[p0.dateIndex.get(date)!]!;
    const z = zoneOf(bar.closeTime);
    if (z === "other") continue;
    if (z === "sealed" && !spec.allowSealed) continue;
    if (spec.zone !== z && !(spec.zone === "dev" && z === "train")) {
      // Only evaluate requested zone (dev backtest = dev only)
      if (z !== spec.zone) continue;
    }

    const ranks = buildRanks({
      yields,
      panels,
      instruments,
      date,
      closeTime: bar.closeTime,
      carryWeight: spec.carryWeight,
      momWeight: spec.momWeight,
      momHorizon: spec.momHorizon,
    });

    // Agreement tracking
    const carryTop = [...CURRENCIES].sort((a, b) => (ranks.carryRank.get(a) ?? 99) - (ranks.carryRank.get(b) ?? 99)).slice(0, 2);
    const momTop = [...CURRENCIES].sort((a, b) => (ranks.momRank.get(a) ?? 99) - (ranks.momRank.get(b) ?? 99)).slice(0, 2);
    const overlap = carryTop.filter((c) => momTop.includes(c)).length;
    if (overlap >= 2) agreement.both += 1;
    else if (overlap === 1) agreement.carryOnly += 0.5;
    else agreement.conflict += 1;

    const positions = selectPortfolio({
      ranks,
      k: spec.k,
      universe: instruments,
      signal: spec.signal,
      maxPerCurrency: spec.k,
    });

    if (positions.length === 0) continue;

    // Turnover vs previous
    if (prevPositions.length > 0) {
      const prevSet = new Set(prevPositions.map((p) => `${p.instrument}:${p.direction}`));
      const newSet = new Set(positions.map((p) => `${p.instrument}:${p.direction}`));
      let changed = 0;
      for (const k of newSet) if (!prevSet.has(k)) changed += 1;
      for (const k of prevSet) if (!newSet.has(k)) changed += 1;
      turnoverSum += changed / Math.max(1, prevSet.size + newSet.size);
    }
    prevPositions = positions;
    rebalanceCount += 1;

    for (const pos of positions) {
      const { base, quote } = splitPair(pos.instrument);
      const sign = pos.direction === "long" ? 1 : -1;
      exposure.set(base, (exposure.get(base) ?? 0) + sign * pos.weight);
      exposure.set(quote, (exposure.get(quote) ?? 0) - sign * pos.weight);
    }

    const dateTo = dates[di + stride]!;
    const pr = periodReturn(positions, panels, date, dateTo, yields, spec.costMult);
    if (!pr) continue;

    returns.push({ date, ret: pr.ret, gross: pr.gross, cost: pr.cost, financing: pr.financing });
    const y = date.slice(0, 4);
    const yr = byYear[y] ?? { ret: 0, n: 0 };
    yr.ret += pr.ret;
    yr.n += 1;
    byYear[y] = yr;
  }

  const stats = statsFromReturns(returns, periodsPerYear);
  const exposureByCcy = Object.fromEntries(
    [...exposure.entries()].map(([k, v]) => [k, v / Math.max(1, rebalanceCount)]),
  ) as Record<Currency, number>;

  return {
    spec,
    returns,
    stats,
    turnover: rebalanceCount > 1 ? turnoverSum / (rebalanceCount - 1) : 0,
    avgHoldDays: stride,
    rebalanceCount,
    exposureByCcy,
    byYear,
    agreement,
  };
}
