import { calculateAtrValues, calculateEmaValues } from "../src/lib/strategy/indicators";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

/**
 * Frozen research evaluator for eurusd_h4_bull_trend_breakout_v1.
 * Not registered in production. Do not deploy.
 */
export const STRATEGY_ID = "eurusd_h4_bull_trend_breakout_v1" as const;
export const STRATEGY_NAME = "EUR/USD H4 Bull Trend Breakout" as const;
export const STRATEGY_VERSION = "v1" as const;
export const SYMBOL = "EUR_USD" as const;
export const TIMEFRAME = "H4" as const;
export const BAR_MS = 4 * 60 * 60_000;
export const PIP = 0.0001;

export const CONFIG = Object.freeze({
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  atrPeriod: 14,
  emaSlopeBars: 3,
  rangeBars: 12,
  minimumBodyAtr: 0.35,
  stopAtr: 1.5,
  rewardR: 2.0,
  targetAtr: 3.0,
  maxHoldBars: 30,
});

export type Direction = "long";
export type ExitReason = "TP" | "SL" | "TIME_EXIT";
export type ReplayMode = "midpoint" | "executable";
export type AmbiguityPolicy = "stop_first" | "tradingview_path";
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
  ema20Slope: number;
  rangeHigh: number;
  dailyClose: number;
  dailyEma20: number;
  dailyEma50: number;
};

export type ResolvedTrade = {
  exitTimestamp: string;
  exitPrice: number;
  exitReason: ExitReason;
  resultR: number;
  holdBars: number;
  ambiguousSameBar: boolean;
  gappedStop: boolean;
  gappedTarget: boolean;
};

export type SignalTraceRow = {
  timestamp: string;
  ema20: number | null;
  ema50: number | null;
  ema20Prior: number | null;
  atr14: number | null;
  rangeHigh: number | null;
  dailyClose: number | null;
  dailyEma20: number | null;
  dailyEma50: number | null;
  dailyBull: boolean;
  localTrend: boolean;
  emaRising: boolean;
  breakout: boolean;
  structure: boolean;
  bullishClose: boolean;
  body: number;
  strongBody: boolean;
  longSetup: boolean;
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

function priorRangeHigh(mids: readonly Candle[], index: number) {
  if (index < CONFIG.rangeBars) return null;
  let high = -Infinity;
  for (let lookback = index - CONFIG.rangeBars; lookback < index; lookback += 1) {
    high = Math.max(high, mids[lookback]!.high);
  }
  return Number.isFinite(high) ? high : null;
}

export function evaluateTrace(
  h4Candles: readonly ResearchCandle[],
  dailyCandles: readonly ResearchCandle[],
): { rows: SignalTraceRow[]; error: string | null } {
  const h4 = normalizeMbaCandles(h4Candles);
  const daily = normalizeMbaCandles(dailyCandles);
  if (h4.error) return { rows: [], error: h4.error };
  if (daily.error) return { rows: [], error: daily.error };

  const mids = h4.candles.map(midCandle);
  const dailyMids = daily.candles.map(midCandle);
  const ema20Values = calculateEmaValues(mids.map((candle) => candle.close), CONFIG.emaFastPeriod);
  const ema50Values = calculateEmaValues(mids.map((candle) => candle.close), CONFIG.emaSlowPeriod);
  const atr14Values = calculateAtrValues(mids, CONFIG.atrPeriod);
  const dailyEma20Values = calculateEmaValues(dailyMids.map((candle) => candle.close), CONFIG.emaFastPeriod);
  const dailyEma50Values = calculateEmaValues(dailyMids.map((candle) => candle.close), CONFIG.emaSlowPeriod);
  const dailyTimes = daily.candles.map((candle) => Date.parse(candle.time));
  const rows: SignalTraceRow[] = [];

  for (let index = 0; index < h4.candles.length; index += 1) {
    const candle = mids[index]!;
    const previous = mids[index - 1];
    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const ema20Prior = index >= CONFIG.emaSlopeBars ? ema20Values[index - CONFIG.emaSlopeBars] ?? null : null;
    const atr14 = atr14Values[index] ?? null;
    const rangeHigh = priorRangeHigh(mids, index);
    const dailyIndex = lastIndexAtOrBefore(dailyTimes, Date.parse(candle.time));
    const dailyClose = dailyIndex >= 0 ? dailyMids[dailyIndex]!.close : null;
    const dailyEma20 = dailyIndex >= 0 ? dailyEma20Values[dailyIndex] ?? null : null;
    const dailyEma50 = dailyIndex >= 0 ? dailyEma50Values[dailyIndex] ?? null : null;
    const dailyReady = dailyIndex >= CONFIG.emaSlowPeriod - 1
      && dailyClose !== null && dailyEma20 !== null && dailyEma50 !== null;
    const dailyBull = Boolean(dailyReady && dailyEma20! > dailyEma50! && dailyClose! > dailyEma20!);
    const localReady = ema20 !== null && ema50 !== null && atr14 !== null && atr14 > 0
      && ema20Prior !== null && rangeHigh !== null && previous !== undefined;
    const localTrend = Boolean(localReady && ema20! > ema50!);
    const emaRising = Boolean(localReady && ema20! > ema20Prior!);
    const breakout = Boolean(localReady && candle.close > rangeHigh! && previous!.close <= rangeHigh!);
    const structure = Boolean(previous && candle.high > previous.high && candle.low > previous.low);
    const bullishClose = candle.close > candle.open;
    const body = Math.abs(candle.close - candle.open);
    const strongBody = Boolean(localReady && body >= CONFIG.minimumBodyAtr * atr14!);
    const longSetup = dailyBull && localTrend && emaRising && breakout && structure && bullishClose && strongBody;
    rows.push({
      timestamp: candle.time, ema20, ema50, ema20Prior, atr14, rangeHigh,
      dailyClose, dailyEma20, dailyEma50, dailyBull, localTrend, emaRising,
      breakout, structure, bullishClose, body, strongBody, longSetup,
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
    if (!row.longSetup || row.atr14 === null || row.ema20 === null || row.ema50 === null
      || row.ema20Prior === null || row.rangeHigh === null
      || row.dailyClose === null || row.dailyEma20 === null || row.dailyEma50 === null) continue;
    const midEntry = candles[index]!.mid.close;
    const atr = row.atr14;
    if (!(atr > 0) || !finite(midEntry)) continue;
    const midStop = midEntry - CONFIG.stopAtr * atr;
    const midTarget = midEntry + CONFIG.targetAtr * atr;
    if (!(midStop < midEntry && midEntry < midTarget)) continue;
    out.push({
      strategyId: STRATEGY_ID,
      signalTimestamp: row.timestamp,
      decisionTime: new Date(Date.parse(row.timestamp) + BAR_MS).toISOString(),
      direction: "long",
      midEntry, atr, midStop, midTarget,
      ema20: row.ema20, ema50: row.ema50, ema20Slope: row.ema20 - row.ema20Prior,
      rangeHigh: row.rangeHigh,
      dailyClose: row.dailyClose, dailyEma20: row.dailyEma20, dailyEma50: row.dailyEma50,
    });
  }
  return out;
}

export function levelsFor(signal: FrozenSignal, signalBar: ResearchCandle, mode: ReplayMode) {
  if (mode === "midpoint") {
    return { entry: signal.midEntry, stop: signal.midStop, target: signal.midTarget };
  }
  const entry = signalBar.ask.close;
  return {
    entry,
    stop: entry - CONFIG.stopAtr * signal.atr,
    target: entry + CONFIG.targetAtr * signal.atr,
  };
}

function closerToOpenIsTarget(bar: PriceBar) {
  return bar.high - bar.open < bar.open - bar.low;
}

export function resolveTrade(
  signal: FrozenSignal,
  candles: readonly ResearchCandle[],
  mode: ReplayMode,
  options: { ambiguityPolicy?: AmbiguityPolicy } = {},
): ResolvedTrade | null {
  const ambiguityPolicy = options.ambiguityPolicy ?? "stop_first";
  const signalIndex = candles.findIndex((candle) => candle.time === signal.signalTimestamp);
  if (signalIndex < 0) return null;
  const signalBar = candles[signalIndex]!;
  if (mode === "executable" && !(signalBar.ask.close >= signalBar.bid.close)) return null;
  const { entry, stop, target } = levelsFor(signal, signalBar, mode);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !finite(entry) || !finite(stop) || !finite(target)) return null;

  for (let slot = 1; slot <= CONFIG.maxHoldBars; slot += 1) {
    const candle = candles[signalIndex + slot];
    if (!candle) return null;
    if (mode === "executable" && !(finite(candle.bid.open) && finite(candle.bid.close))) return null;
    const price = mode === "midpoint" ? candle.mid : candle.bid;
    const stopHit = price.low <= stop;
    const targetHit = price.high >= target;
    const gappedStop = price.open <= stop;
    const gappedTarget = price.open >= target;
    const exitTimestamp = new Date(Date.parse(candle.time) + BAR_MS).toISOString();
    const targetFirst = stopHit && targetHit && ambiguityPolicy === "tradingview_path" && closerToOpenIsTarget(price);
    if (stopHit && !targetFirst) {
      const fill = gappedStop ? Math.min(stop, price.open) : stop;
      return {
        exitTimestamp, exitPrice: fill, exitReason: "SL", resultR: (fill - entry) / risk,
        holdBars: slot, ambiguousSameBar: targetHit, gappedStop, gappedTarget,
      };
    }
    if (targetHit) {
      return {
        exitTimestamp, exitPrice: target, exitReason: "TP", resultR: (target - entry) / risk,
        holdBars: slot, ambiguousSameBar: stopHit, gappedStop, gappedTarget,
      };
    }
    if (slot === CONFIG.maxHoldBars) {
      return {
        exitTimestamp, exitPrice: price.close, exitReason: "TIME_EXIT", resultR: (price.close - entry) / risk,
        holdBars: slot, ambiguousSameBar: false, gappedStop, gappedTarget,
      };
    }
  }
  return null;
}

export function freezeCohort(
  signals: readonly FrozenSignal[],
  candles: readonly ResearchCandle[],
  mode: ReplayMode = "midpoint",
  options: { ambiguityPolicy?: AmbiguityPolicy } = {},
) {
  const accepted: FrozenSignal[] = [];
  const skipped: FrozenSignal[] = [];
  let occupiedUntil = -Infinity;
  let unresolvedBlock = false;
  for (const signal of signals) {
    if (unresolvedBlock || Date.parse(signal.decisionTime) <= occupiedUntil) {
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
