import { calculateAtrValues, calculateEmaValues } from "../src/lib/strategy/indicators";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

/**
 * Frozen research evaluator for eurusd_h4_breakout_retest_rejection_v1.
 * Long only. Not registered in production. Do not deploy.
 */
export const STRATEGY_ID = "eurusd_h4_breakout_retest_rejection_v1" as const;
export const STRATEGY_NAME = "EUR/USD H4 Breakout Retest Rejection" as const;
export const STRATEGY_VERSION = "v1" as const;
export const SYMBOL = "EUR_USD" as const;
export const TIMEFRAME = "H4" as const;
export const BAR_MS = 4 * 60 * 60_000;
export const PIP = 0.0001;

export const CONFIG = Object.freeze({
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  atrPeriod: 14,
  retestBars: 3,
  retestCloseBufferAtr: 0.10,
  minBodyAtr: 0.25,
  closeInTopRange: 0.30,
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
  breakoutTimestamp: string;
  direction: Direction;
  frozenLevel: number;
  retestOffset: number;
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
  holdBars: number;
  ambiguousSameBar: boolean;
  gappedStop: boolean;
  gappedTarget: boolean;
};

export type SignalTraceRow = {
  timestamp: string;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  dailyHigh: number | null;
  dailyClose: number | null;
  dailyEma20: number | null;
  dailyEma50: number | null;
  dailyBull: boolean;
  localLong: boolean;
  longBreakout: boolean;
  armed: boolean;
  frozenLevel: number | null;
  barsSinceBreakout: number | null;
  breakoutTimestamp: string | null;
  longRetest: boolean;
};

type Arm = { level: number; barsSince: number; breakoutTimestamp: string };
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

function closeInTopRange(candle: Candle, fraction: number) {
  const range = candle.high - candle.low;
  return range > 0 && (candle.high - candle.close) / range <= fraction;
}

export function validLongRetest(candle: Candle, level: number, atr: number) {
  const body = candle.close - candle.open;
  return candle.low <= level
    && candle.close > level
    && candle.close >= level + CONFIG.retestCloseBufferAtr * atr
    && candle.close > candle.open
    && body >= CONFIG.minBodyAtr * atr
    && closeInTopRange(candle, CONFIG.closeInTopRange);
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
  let arm: Arm | null = null;

  for (let index = 0; index < h4.candles.length; index += 1) {
    const candle = mids[index]!;
    const previous = mids[index - 1];
    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const atr14 = atr14Values[index] ?? null;
    const startedDailyIndex = lastIndexAtOrBefore(dailyTimes, Date.parse(candle.time));
    const dailyIndex = startedDailyIndex - 1;
    const dailyBar = dailyIndex >= 0 ? dailyMids[dailyIndex] : null;
    const dailyHigh = dailyBar?.high ?? null;
    const dailyClose = dailyBar?.close ?? null;
    const dailyEma20 = dailyIndex >= 0 ? dailyEma20Values[dailyIndex] ?? null : null;
    const dailyEma50 = dailyIndex >= 0 ? dailyEma50Values[dailyIndex] ?? null : null;
    const dailyReady = dailyIndex >= CONFIG.emaSlowPeriod - 1
      && dailyClose !== null && dailyEma20 !== null && dailyEma50 !== null && dailyHigh !== null;
    const dailyBull = Boolean(dailyReady && dailyEma20! > dailyEma50! && dailyClose! > dailyEma20!);
    const localReady = ema20 !== null && ema50 !== null && atr14 !== null && atr14 > 0 && previous !== undefined;
    const localLong = Boolean(localReady && ema20! > ema50!);
    const longBreakout = Boolean(localReady && dailyHigh !== null && candle.close > dailyHigh && previous!.close <= dailyHigh);

    if (arm) {
      arm = { ...arm, barsSince: arm.barsSince + 1 };
      if (arm.barsSince > CONFIG.retestBars) arm = null;
    }

    const longRetest = Boolean(arm && arm.barsSince >= 1 && arm.barsSince <= CONFIG.retestBars
      && atr14 !== null && atr14 > 0
      && validLongRetest(candle, arm.level, atr14)
      && dailyBull && localLong);
    const signalArm = longRetest ? arm : null;
    if (signalArm) arm = null;

    if (longBreakout && dailyHigh !== null) {
      arm = { level: dailyHigh, barsSince: 0, breakoutTimestamp: candle.time };
    }

    const display = signalArm ?? arm;
    rows.push({
      timestamp: candle.time, ema20, ema50, atr14, dailyHigh, dailyClose, dailyEma20, dailyEma50,
      dailyBull, localLong, longBreakout, armed: display != null,
      frozenLevel: display?.level ?? null,
      barsSinceBreakout: display?.barsSince ?? null,
      breakoutTimestamp: signalArm?.breakoutTimestamp ?? display?.breakoutTimestamp ?? null,
      longRetest,
    });
  }
  return { rows, error: null };
}

export function signalsFromTrace(
  candles: readonly ResearchCandle[],
  rows: readonly SignalTraceRow[],
): FrozenSignal[] {
  const byTime = new Map(candles.map((candle) => [candle.time, candle]));
  const out: FrozenSignal[] = [];
  for (const row of rows) {
    if (!row.longRetest || row.atr14 === null || row.ema20 === null || row.ema50 === null
      || row.frozenLevel === null || row.barsSinceBreakout === null || row.breakoutTimestamp === null
      || row.dailyClose === null || row.dailyEma20 === null || row.dailyEma50 === null) continue;
    const bar = byTime.get(row.timestamp);
    if (!bar) continue;
    const midEntry = bar.mid.close;
    const atr = row.atr14;
    if (!(atr > 0) || !finite(midEntry)) continue;
    const midStop = midEntry - CONFIG.stopAtr * atr;
    const midTarget = midEntry + CONFIG.targetAtr * atr;
    if (!(midStop < midEntry && midEntry < midTarget)) continue;
    out.push({
      strategyId: STRATEGY_ID,
      signalTimestamp: row.timestamp,
      decisionTime: new Date(Date.parse(row.timestamp) + BAR_MS).toISOString(),
      breakoutTimestamp: row.breakoutTimestamp,
      direction: "long",
      frozenLevel: row.frozenLevel,
      retestOffset: row.barsSinceBreakout,
      midEntry, atr, midStop, midTarget,
      ema20: row.ema20, ema50: row.ema50,
      dailyClose: row.dailyClose, dailyEma20: row.dailyEma20, dailyEma50: row.dailyEma50,
    });
  }
  return out;
}

export function levelsFor(signal: FrozenSignal, signalBar: ResearchCandle, mode: ReplayMode) {
  if (mode === "midpoint") {
    return { entry: signal.midEntry, stop: signal.midStop, target: signal.midTarget };
  }
  switch (signal.direction) {
    case "long": {
      const entry = signalBar.ask.close;
      return { entry, stop: entry - CONFIG.stopAtr * signal.atr, target: entry + CONFIG.targetAtr * signal.atr };
    }
    default: {
      const exhaustive: never = signal.direction;
      throw new Error(`Unhandled direction ${String(exhaustive)}`);
    }
  }
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
    if (mode === "executable" && !(finite(candle.bid.open) && finite(candle.ask.open))) return null;
    const price = mode === "midpoint" ? candle.mid : candle.bid;
    const stopHit = price.low <= stop;
    const targetHit = price.high >= target;
    const gappedStop = price.open <= stop;
    const gappedTarget = price.open >= target;
    const exitTimestamp = new Date(Date.parse(candle.time) + BAR_MS).toISOString();
    const targetFirst = stopHit && targetHit && ambiguityPolicy === "tradingview_path"
      && price.high - price.open < price.open - price.low;
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
