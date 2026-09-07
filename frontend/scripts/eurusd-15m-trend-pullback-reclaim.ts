import { calculateAtrValues, calculateEmaValues } from "../src/lib/strategy/indicators";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

/**
 * Frozen research evaluator for eurusd_15m_trend_pullback_reclaim_v1.
 * Not registered in production. Do not deploy.
 */
export const STRATEGY_ID = "eurusd_15m_trend_pullback_reclaim_v1" as const;
export const STRATEGY_NAME = "EUR/USD 15m Trend Pullback Reclaim" as const;
export const STRATEGY_VERSION = "v1" as const;
export const SYMBOL = "EUR_USD" as const;
export const TIMEFRAME = "M15" as const;
export const BAR_MS = 15 * 60_000;
export const PIP = 0.0001;

export const CONFIG = Object.freeze({
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  atrPeriod: 14,
  minimumBodyAtr: 0.35,
  stopAtr: 1.0,
  rewardR: 2.0,
});

export type Direction = "long" | "short";
export type ExitReason = "TP" | "SL";
export type ReplayMode = "midpoint" | "executable";
export type AmbiguityPolicy = "stop_first" | "tradingview_path";
export type TargetGapPolicy = "no_improvement" | "fill_open";

export type PriceBar = { open: number; high: number; low: number; close: number };

export type FrozenSignal = {
  strategyId: typeof STRATEGY_ID;
  signalTimestamp: string;
  decisionTime: string;
  direction: Direction;
  midEntry: number;
  atr: number;
  midStop: number;
  midTarget: number;
  ema20: number;
  ema50: number;
  dailyClose: number;
  dailyEma20: number;
  dailyEma50: number;
};

export type ResolvedTrade = {
  exitTimestamp: string;
  exitPrice: number;
  exitReason: ExitReason;
  resultR: number;
  ambiguousSameBar: boolean;
  gappedStop: boolean;
  gappedTarget: boolean;
};

export type SignalTraceRow = {
  timestamp: string;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  dailyClose: number | null;
  dailyEma20: number | null;
  dailyEma50: number | null;
  dailyLongBias: boolean;
  dailyShortBias: boolean;
  localLongTrend: boolean;
  localShortTrend: boolean;
  longPullback: boolean;
  shortPullback: boolean;
  longReclaim: boolean;
  shortReclaim: boolean;
  longStructure: boolean;
  shortStructure: boolean;
  body: number;
  strongBody: boolean;
  longSetup: boolean;
  shortSetup: boolean;
};

type Normalized = { candles: ResearchCandle[]; error: string | null };

function finite(value: number) {
  return Number.isFinite(value);
}

function validPrice(bar: PriceBar) {
  return finite(bar.open) && finite(bar.high) && finite(bar.low) && finite(bar.close)
    && bar.high >= Math.max(bar.open, bar.close)
    && bar.low <= Math.min(bar.open, bar.close)
    && bar.high >= bar.low;
}

function validMba(candle: ResearchCandle) {
  return finite(Date.parse(candle.time)) && validPrice(candle.mid) && validPrice(candle.bid) && validPrice(candle.ask)
    && candle.ask.close >= candle.bid.close;
}

function sameMid(left: ResearchCandle, right: ResearchCandle) {
  return left.mid.open === right.mid.open && left.mid.high === right.mid.high
    && left.mid.low === right.mid.low && left.mid.close === right.mid.close;
}

export function midCandle(candle: ResearchCandle): Candle {
  return { time: candle.time, volume: candle.volume, complete: candle.complete, ...candle.mid };
}

export function normalizeMbaCandles(candles: readonly ResearchCandle[]): Normalized {
  const completed = candles.filter((candle) => candle.complete);
  if (!completed.length) return { candles: [], error: null };
  if (completed.some((candle) => !validMba(candle))) {
    return { candles: [], error: "Completed history contains a malformed MBA candle." };
  }
  const sorted = [...completed].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const unique: ResearchCandle[] = [];
  for (const candle of sorted) {
    const previous = unique.at(-1);
    if (!previous || Date.parse(previous.time) !== Date.parse(candle.time)) {
      unique.push(candle);
      continue;
    }
    if (!sameMid(previous, candle)) {
      return { candles: [], error: `Conflicting candles share timestamp ${candle.time}.` };
    }
  }
  return { candles: unique, error: null };
}

function lastIndexAtOrBefore(times: readonly number[], time: number) {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function evaluateTrace(
  m15Candles: readonly ResearchCandle[],
  dailyCandles: readonly ResearchCandle[],
): { rows: SignalTraceRow[]; error: string | null } {
  const m15 = normalizeMbaCandles(m15Candles);
  const daily = normalizeMbaCandles(dailyCandles);
  if (m15.error) return { rows: [], error: m15.error };
  if (daily.error) return { rows: [], error: daily.error };

  const mids = m15.candles.map(midCandle);
  const dailyMids = daily.candles.map(midCandle);
  const ema20Values = calculateEmaValues(mids.map((candle) => candle.close), CONFIG.emaFastPeriod);
  const ema50Values = calculateEmaValues(mids.map((candle) => candle.close), CONFIG.emaSlowPeriod);
  const atr14Values = calculateAtrValues(mids, CONFIG.atrPeriod);
  const dailyEma20Values = calculateEmaValues(dailyMids.map((candle) => candle.close), CONFIG.emaFastPeriod);
  const dailyEma50Values = calculateEmaValues(dailyMids.map((candle) => candle.close), CONFIG.emaSlowPeriod);
  const dailyTimes = daily.candles.map((candle) => Date.parse(candle.time));
  const rows: SignalTraceRow[] = [];

  for (let index = 0; index < m15.candles.length; index += 1) {
    const candle = mids[index]!;
    const previous = mids[index - 1];
    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const atr14 = atr14Values[index] ?? null;
    const previousEma20 = index > 0 ? ema20Values[index - 1] ?? null : null;
    const previousEma50 = index > 0 ? ema50Values[index - 1] ?? null : null;
    const dailyIndex = lastIndexAtOrBefore(dailyTimes, Date.parse(candle.time));
    const dailyClose = dailyIndex >= 0 ? dailyMids[dailyIndex]!.close : null;
    const dailyEma20 = dailyIndex >= 0 ? dailyEma20Values[dailyIndex] ?? null : null;
    const dailyEma50 = dailyIndex >= 0 ? dailyEma50Values[dailyIndex] ?? null : null;
    const dailyReady = dailyIndex >= CONFIG.emaSlowPeriod - 1
      && dailyClose !== null && dailyEma20 !== null && dailyEma50 !== null;
    const dailyLongBias = Boolean(dailyReady && dailyEma20! > dailyEma50! && dailyClose! > dailyEma20!);
    const dailyShortBias = Boolean(dailyReady && dailyEma20! < dailyEma50! && dailyClose! < dailyEma20!);
    const localReady = ema20 !== null && ema50 !== null && atr14 !== null && atr14 > 0
      && previousEma20 !== null && previousEma50 !== null && previous !== undefined;
    const localLongTrend = Boolean(localReady && ema20! > ema50!);
    const localShortTrend = Boolean(localReady && ema20! < ema50!);
    const longPullback = Boolean(localReady
      && previous!.low <= previousEma20!
      && previous!.close <= previousEma20!
      && previous!.close > previousEma50!);
    const shortPullback = Boolean(localReady
      && previous!.high >= previousEma20!
      && previous!.close >= previousEma20!
      && previous!.close < previousEma50!);
    const longReclaim = Boolean(localReady && candle.close > ema20! && candle.close > candle.open);
    const shortReclaim = Boolean(localReady && candle.close < ema20! && candle.close < candle.open);
    const longStructure = Boolean(previous && candle.high > previous.high && candle.low > previous.low);
    const shortStructure = Boolean(previous && candle.high < previous.high && candle.low < previous.low);
    const body = Math.abs(candle.close - candle.open);
    const strongBody = Boolean(localReady && body >= CONFIG.minimumBodyAtr * atr14!);
    const longSetup = dailyLongBias && localLongTrend && longPullback && longReclaim && longStructure && strongBody;
    const shortSetup = dailyShortBias && localShortTrend && shortPullback && shortReclaim && shortStructure && strongBody;
    rows.push({
      timestamp: candle.time, ema20, ema50, atr14, dailyClose, dailyEma20, dailyEma50,
      dailyLongBias, dailyShortBias, localLongTrend, localShortTrend,
      longPullback, shortPullback, longReclaim, shortReclaim, longStructure, shortStructure,
      body, strongBody, longSetup, shortSetup,
    });
  }
  return { rows, error: null };
}

export function signalsFromTrace(
  candles: readonly ResearchCandle[],
  rows: readonly SignalTraceRow[],
): FrozenSignal[] {
  const out: FrozenSignal[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const candle = candles[index]!;
    const direction: Direction | null = row.longSetup === row.shortSetup ? null : row.longSetup ? "long" : "short";
    if (!direction || row.atr14 === null || row.ema20 === null || row.ema50 === null
      || row.dailyClose === null || row.dailyEma20 === null || row.dailyEma50 === null) continue;
    const midEntry = candle.mid.close;
    const atr = row.atr14;
    if (!(atr > 0) || !finite(midEntry)) continue;
    const midStop = direction === "long" ? midEntry - CONFIG.stopAtr * atr : midEntry + CONFIG.stopAtr * atr;
    const midTarget = direction === "long" ? midEntry + CONFIG.rewardR * atr : midEntry - CONFIG.rewardR * atr;
    if (direction === "long" ? !(midStop < midEntry && midEntry < midTarget) : !(midTarget < midEntry && midEntry < midStop)) {
      continue;
    }
    out.push({
      strategyId: STRATEGY_ID,
      signalTimestamp: row.timestamp,
      decisionTime: new Date(Date.parse(row.timestamp) + BAR_MS).toISOString(),
      direction, midEntry, atr, midStop, midTarget,
      ema20: row.ema20, ema50: row.ema50,
      dailyClose: row.dailyClose, dailyEma20: row.dailyEma20, dailyEma50: row.dailyEma50,
    });
  }
  return out;
}

function executableBar(candle: ResearchCandle, direction: Direction): PriceBar {
  switch (direction) {
    case "long": return candle.bid;
    case "short": return candle.ask;
    default: {
      const exhaustive: never = direction;
      throw new Error(`Unhandled direction ${String(exhaustive)}`);
    }
  }
}

function closerToOpenIsTarget(bar: PriceBar, direction: Direction) {
  switch (direction) {
    case "long": return bar.high - bar.open < bar.open - bar.low;
    case "short": return bar.open - bar.low <= bar.high - bar.open;
    default: {
      const exhaustive: never = direction;
      throw new Error(`Unhandled direction ${String(exhaustive)}`);
    }
  }
}

export function levelsFor(signal: FrozenSignal, signalBar: ResearchCandle, mode: ReplayMode) {
  if (mode === "midpoint") {
    return { entry: signal.midEntry, stop: signal.midStop, target: signal.midTarget };
  }
  const entry = signal.direction === "long" ? signalBar.ask.close : signalBar.bid.close;
  const stop = signal.direction === "long" ? entry - CONFIG.stopAtr * signal.atr : entry + CONFIG.stopAtr * signal.atr;
  const target = signal.direction === "long"
    ? entry + CONFIG.rewardR * signal.atr
    : entry - CONFIG.rewardR * signal.atr;
  return { entry, stop, target };
}

export function resolveTrade(
  signal: FrozenSignal,
  candles: readonly ResearchCandle[],
  mode: ReplayMode,
  options: { ambiguityPolicy?: AmbiguityPolicy; targetGapPolicy?: TargetGapPolicy } = {},
): ResolvedTrade | null {
  const ambiguityPolicy = options.ambiguityPolicy ?? "stop_first";
  const targetGapPolicy = options.targetGapPolicy ?? "no_improvement";
  const signalIndex = candles.findIndex((candle) => candle.time === signal.signalTimestamp);
  if (signalIndex < 0) return null;
  const signalBar = candles[signalIndex]!;
  if (mode === "executable" && !(signalBar.ask.close >= signalBar.bid.close)) return null;
  const { entry, stop, target } = levelsFor(signal, signalBar, mode);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !finite(entry) || !finite(stop) || !finite(target)) return null;

  for (const candle of candles.slice(signalIndex + 1)) {
    if (mode === "executable" && !(finite(candle.bid.open) && finite(candle.ask.open))) return null;
    const price = mode === "midpoint" ? candle.mid : executableBar(candle, signal.direction);
    const stopHit = signal.direction === "long" ? price.low <= stop : price.high >= stop;
    const targetHit = signal.direction === "long" ? price.high >= target : price.low <= target;
    const gappedStop = signal.direction === "long" ? price.open <= stop : price.open >= stop;
    const gappedTarget = signal.direction === "long" ? price.open >= target : price.open <= target;
    const exitTimestamp = new Date(Date.parse(candle.time) + BAR_MS).toISOString();
    const targetFirst = stopHit && targetHit && ambiguityPolicy === "tradingview_path"
      && closerToOpenIsTarget(price, signal.direction);
    if (stopHit && !targetFirst) {
      const fill = gappedStop
        ? (signal.direction === "long" ? Math.min(stop, price.open) : Math.max(stop, price.open))
        : stop;
      const resultR = signal.direction === "long" ? (fill - entry) / risk : (entry - fill) / risk;
      return { exitTimestamp, exitPrice: fill, exitReason: "SL", resultR, ambiguousSameBar: targetHit, gappedStop, gappedTarget };
    }
    if (targetHit) {
      const fill = gappedTarget && targetGapPolicy === "fill_open" ? price.open : target;
      const resultR = signal.direction === "long" ? (fill - entry) / risk : (entry - fill) / risk;
      return { exitTimestamp, exitPrice: fill, exitReason: "TP", resultR, ambiguousSameBar: stopHit, gappedStop, gappedTarget };
    }
  }
  return null;
}

export function freezeCohort(
  signals: readonly FrozenSignal[],
  candles: readonly ResearchCandle[],
  mode: ReplayMode = "midpoint",
  options: { ambiguityPolicy?: AmbiguityPolicy; targetGapPolicy?: TargetGapPolicy } = {},
) {
  const accepted: FrozenSignal[] = [];
  const skipped: FrozenSignal[] = [];
  let occupiedUntil = -Infinity;
  let unresolvedBlock = false;
  for (const signal of signals) {
    if (unresolvedBlock || Date.parse(signal.decisionTime) < occupiedUntil) {
      skipped.push(signal);
      continue;
    }
    const resolved = resolveTrade(signal, candles, mode, options);
    accepted.push(signal);
    if (resolved) occupiedUntil = Date.parse(resolved.exitTimestamp);
    else unresolvedBlock = true;
  }
  return { accepted, skipped, unresolvedBlock };
}
