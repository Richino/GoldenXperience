import { calculateAtrValues, calculateEmaValues } from "../src/lib/strategy/indicators";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

/**
 * Frozen research evaluator for GX POC SWING LONG ONLY V1.
 * Not registered in production. Do not deploy.
 */
export const STRATEGY_ID = "usdjpy_poc_swing_long_v1" as const;
export const STRATEGY_NAME = "GX POC SWING LONG ONLY V1" as const;
export const STRATEGY_VERSION = "v1" as const;
export const SYMBOL = "USD_JPY" as const;
export const TIMEFRAME = "H1" as const;
export const HTF_TIMEFRAME = "H4" as const;
export const BAR_MS = 60 * 60_000;
export const HTF_BAR_MS = 4 * 60 * 60_000;
export const PIP = 0.01;

export const CONFIG = Object.freeze({
  atrPeriod: 14,
  consolidationLookback: 24,
  maxConsolidationAtr: 4.0,
  pocBins: 24,
  pocToleranceAtr: 0.25,
  minBreakoutDistanceAtr: 0.10,
  minBreakoutBodyAtr: 0.25,
  maxRetestBars: 48,
  directionalConfirmation: true,
  h4FastEma: 50,
  h4SlowEma: 200,
  h4BiasFilter: true,
  stopAtr: 1.5,
  rewardR: 2.0,
  targetAtr: 3.0,
});

export type Direction = "long";
export type ExitReason = "TP" | "SL";
export type ReplayMode = "midpoint" | "executable";
export type AmbiguityPolicy = "stop_first" | "tradingview_path";
export type PriceBar = { open: number; high: number; low: number; close: number };

export type FrozenSignal = {
  strategyId: typeof STRATEGY_ID;
  signalTimestamp: string;
  decisionTime: string;
  breakoutTimestamp: string;
  direction: Direction;
  lockedPoc: number;
  lockedRangeHigh: number;
  lockedRangeLow: number;
  barsSinceBreakout: number;
  midEntry: number;
  atr: number;
  midStop: number;
  midTarget: number;
  h4Close: number;
  h4Ema50: number;
  h4Ema200: number;
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
  atr14: number | null;
  prevAtr: number | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  rangeWidth: number | null;
  inConsolidation: boolean;
  poc: number | null;
  h4Close: number | null;
  h4Ema50: number | null;
  h4Ema200: number | null;
  h4Bull: boolean;
  strongBody: boolean;
  bullBreakout: boolean;
  lockedPoc: number | null;
  lockedRangeHigh: number | null;
  lockedRangeLow: number | null;
  barsSinceBreakout: number | null;
  breakoutTimestamp: string | null;
  pocRetest: boolean;
  bullConfirm: boolean;
  longSignal: boolean;
};

type Setup = {
  lockedPoc: number;
  lockedRangeHigh: number;
  lockedRangeLow: number;
  breakoutIndex: number;
  breakoutTimestamp: string;
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

export function lastIndexAtOrBefore(times: readonly number[], time: number) {
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

/** Pine request.security(..., close[1]) / ema[1] with lookahead_off. */
export function previousCompletedHtfIndex(htfOpenTimes: readonly number[], barOpenTime: number) {
  return lastIndexAtOrBefore(htfOpenTimes, barOpenTime) - 1;
}

export function computePoc(
  bars: readonly Pick<Candle, "high" | "low" | "close" | "volume">[],
  rangeLow: number,
  rangeHigh: number,
  bins = CONFIG.pocBins,
): number | null {
  const width = rangeHigh - rangeLow;
  if (!(width > 0) || bins < 1) return null;
  const binSize = width / bins;
  const volumes = Array.from({ length: bins }, () => 0);
  for (const bar of bars) {
    const hlc3 = (bar.high + bar.low + bar.close) / 3;
    if (!finite(hlc3) || !finite(bar.volume)) continue;
    let bin = Math.floor((hlc3 - rangeLow) / binSize);
    if (bin < 0) bin = 0;
    if (bin >= bins) bin = bins - 1;
    volumes[bin]! += bar.volume;
  }
  let maxBin = 0;
  for (let bin = 1; bin < bins; bin += 1) {
    if (volumes[bin]! > volumes[maxBin]!) maxBin = bin;
  }
  return rangeLow + binSize * (maxBin + 0.5);
}

function windowRange(mids: readonly Candle[], index: number, lookback: number) {
  if (index < lookback) return null;
  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  const bars: Candle[] = [];
  for (let slot = index - lookback; slot < index; slot += 1) {
    const bar = mids[slot]!;
    bars.push(bar);
    rangeHigh = Math.max(rangeHigh, bar.high);
    rangeLow = Math.min(rangeLow, bar.low);
  }
  if (!finite(rangeHigh) || !finite(rangeLow)) return null;
  return { rangeHigh, rangeLow, rangeWidth: rangeHigh - rangeLow, bars };
}

export function evaluateTrace(
  h1Candles: readonly ResearchCandle[],
  h4Candles: readonly ResearchCandle[],
): { rows: SignalTraceRow[]; error: string | null } {
  const h1 = normalizeMbaCandles(h1Candles);
  const h4 = normalizeMbaCandles(h4Candles);
  if (h1.error) return { rows: [], error: h1.error };
  if (h4.error) return { rows: [], error: h4.error };

  const mids = h1.candles.map(midCandle);
  const h4Mids = h4.candles.map(midCandle);
  const atrValues = calculateAtrValues(mids, CONFIG.atrPeriod);
  const h4Ema50Values = calculateEmaValues(h4Mids.map((candle) => candle.close), CONFIG.h4FastEma);
  const h4Ema200Values = calculateEmaValues(h4Mids.map((candle) => candle.close), CONFIG.h4SlowEma);
  const h4Times = h4.candles.map((candle) => Date.parse(candle.time));
  const rows: SignalTraceRow[] = [];
  let setup: Setup | null = null;
  let occupiedUntil = -Infinity;

  for (let index = 0; index < h1.candles.length; index += 1) {
    const candle = mids[index]!;
    const atr = atrValues[index] ?? null;
    const prevAtr = index > 0 ? atrValues[index - 1] ?? null : null;
    const window = windowRange(mids, index, CONFIG.consolidationLookback);
    const rangeHigh = window?.rangeHigh ?? null;
    const rangeLow = window?.rangeLow ?? null;
    const rangeWidth = window?.rangeWidth ?? null;
    const inConsolidation = Boolean(
      window && prevAtr != null && prevAtr > 0 && window.rangeWidth <= prevAtr * CONFIG.maxConsolidationAtr,
    );
    const poc = window ? computePoc(window.bars, window.rangeLow, window.rangeHigh) : null;
    const h4Index = previousCompletedHtfIndex(h4Times, Date.parse(candle.time));
    const h4Bar = h4Index >= 0 ? h4Mids[h4Index] : null;
    const h4Close = h4Bar?.close ?? null;
    const h4Ema50 = h4Index >= 0 ? h4Ema50Values[h4Index] ?? null : null;
    const h4Ema200 = h4Index >= 0 ? h4Ema200Values[h4Index] ?? null : null;
    const h4Ready = h4Index >= CONFIG.h4SlowEma - 1
      && h4Close !== null && h4Ema50 !== null && h4Ema200 !== null;
    const h4Bull = Boolean(
      CONFIG.h4BiasFilter
      && h4Ready
      && h4Close! > h4Ema50!
      && h4Ema50! > h4Ema200!,
    );
    const body = Math.abs(candle.close - candle.open);
    const strongBody = Boolean(atr != null && atr > 0 && body >= atr * CONFIG.minBreakoutBodyAtr);
    const bullBreakout = Boolean(
      inConsolidation
      && strongBody
      && atr != null
      && atr > 0
      && rangeHigh !== null
      && poc != null
      && h4Bull
      && candle.close > rangeHigh + atr * CONFIG.minBreakoutDistanceAtr,
    );

    if (setup && index - setup.breakoutIndex > CONFIG.maxRetestBars) setup = null;
    if (setup && candle.close < setup.lockedRangeLow) setup = null;
    if (bullBreakout && poc != null && rangeHigh !== null && rangeLow !== null) {
      setup = {
        lockedPoc: poc,
        lockedRangeHigh: rangeHigh,
        lockedRangeLow: rangeLow,
        breakoutIndex: index,
        breakoutTimestamp: candle.time,
      };
    }

    const barsSinceBreakout = setup ? index - setup.breakoutIndex : null;
    const pocTolerance = atr != null && atr > 0 ? atr * CONFIG.pocToleranceAtr : null;
    const pocRetest = Boolean(
      setup
      && pocTolerance != null
      && candle.low <= setup.lockedPoc + pocTolerance
      && candle.high >= setup.lockedPoc - pocTolerance,
    );
    const bullConfirm = Boolean(
      setup
      && (!CONFIG.directionalConfirmation || (candle.close > setup.lockedPoc && candle.close > candle.open)),
    );
    const decisionTimeMs = Date.parse(candle.time) + BAR_MS;
    const candidate = Boolean(
      setup
      && barsSinceBreakout != null
      && barsSinceBreakout > 0
      && pocRetest
      && bullConfirm
      && h4Bull
      && atr != null
      && atr > 0,
    );
    const longSignal = candidate && decisionTimeMs > occupiedUntil;

    rows.push({
      timestamp: candle.time,
      atr14: atr,
      prevAtr,
      rangeHigh,
      rangeLow,
      rangeWidth,
      inConsolidation,
      poc,
      h4Close,
      h4Ema50,
      h4Ema200,
      h4Bull,
      strongBody,
      bullBreakout,
      lockedPoc: setup?.lockedPoc ?? null,
      lockedRangeHigh: setup?.lockedRangeHigh ?? null,
      lockedRangeLow: setup?.lockedRangeLow ?? null,
      barsSinceBreakout,
      breakoutTimestamp: setup?.breakoutTimestamp ?? null,
      pocRetest,
      bullConfirm,
      longSignal,
    });

    if (longSignal && setup && atr != null && atr > 0) {
      const midEntry = candle.close;
      const signal: FrozenSignal = {
        strategyId: STRATEGY_ID,
        signalTimestamp: candle.time,
        decisionTime: new Date(decisionTimeMs).toISOString(),
        breakoutTimestamp: setup.breakoutTimestamp,
        direction: "long",
        lockedPoc: setup.lockedPoc,
        lockedRangeHigh: setup.lockedRangeHigh,
        lockedRangeLow: setup.lockedRangeLow,
        barsSinceBreakout: barsSinceBreakout!,
        midEntry,
        atr,
        midStop: midEntry - CONFIG.stopAtr * atr,
        midTarget: midEntry + CONFIG.targetAtr * atr,
        h4Close: h4Close!,
        h4Ema50: h4Ema50!,
        h4Ema200: h4Ema200!,
      };
      const resolved = resolveTrade(signal, h1.candles, "midpoint");
      occupiedUntil = resolved ? Date.parse(resolved.exitTimestamp) : Infinity;
      setup = null;
    }
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
    if (!row.longSignal) continue;
    if (row.atr14 == null || !(row.atr14 > 0)) continue;
    if (row.lockedPoc == null || row.lockedRangeHigh == null || row.lockedRangeLow == null) continue;
    if (row.barsSinceBreakout == null || row.breakoutTimestamp == null) continue;
    if (row.h4Close == null || row.h4Ema50 == null || row.h4Ema200 == null) continue;
    const midEntry = candles[index]!.mid.close;
    if (!finite(midEntry)) continue;
    const atr = row.atr14;
    const midStop = midEntry - CONFIG.stopAtr * atr;
    const midTarget = midEntry + CONFIG.targetAtr * atr;
    if (!(midStop < midEntry && midEntry < midTarget)) continue;
    out.push({
      strategyId: STRATEGY_ID,
      signalTimestamp: row.timestamp,
      decisionTime: new Date(Date.parse(row.timestamp) + BAR_MS).toISOString(),
      breakoutTimestamp: row.breakoutTimestamp,
      direction: "long",
      lockedPoc: row.lockedPoc,
      lockedRangeHigh: row.lockedRangeHigh,
      lockedRangeLow: row.lockedRangeLow,
      barsSinceBreakout: row.barsSinceBreakout,
      midEntry,
      atr,
      midStop,
      midTarget,
      h4Close: row.h4Close,
      h4Ema50: row.h4Ema50,
      h4Ema200: row.h4Ema200,
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

function executableBar(candle: ResearchCandle, direction: Direction): PriceBar {
  switch (direction) {
    case "long": return candle.bid;
    default: {
      const exhaustive: never = direction;
      throw new Error(`Unhandled direction ${String(exhaustive)}`);
    }
  }
}

function closerToOpenIsTarget(bar: PriceBar, direction: Direction) {
  switch (direction) {
    case "long": return bar.high - bar.open < bar.open - bar.low;
    default: {
      const exhaustive: never = direction;
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

  for (let slot = 1; slot < candles.length - signalIndex; slot += 1) {
    const candle = candles[signalIndex + slot];
    if (!candle) return null;
    if (mode === "executable" && !(finite(candle.bid.open) && finite(candle.ask.open))) return null;
    const price = mode === "midpoint" ? candle.mid : executableBar(candle, signal.direction);
    const stopHit = price.low <= stop;
    const targetHit = price.high >= target;
    const gappedStop = price.open <= stop;
    const gappedTarget = price.open >= target;
    const exitTimestamp = new Date(Date.parse(candle.time) + BAR_MS).toISOString();
    const targetFirst = stopHit && targetHit && ambiguityPolicy === "tradingview_path"
      && closerToOpenIsTarget(price, signal.direction);
    if (stopHit && !targetFirst) {
      const fill = gappedStop ? Math.min(stop, price.open) : stop;
      const resultR = (fill - entry) / risk;
      return {
        exitTimestamp, exitPrice: fill, exitReason: "SL", resultR, holdBars: slot,
        ambiguousSameBar: targetHit, gappedStop, gappedTarget,
      };
    }
    if (targetHit) {
      const resultR = (target - entry) / risk;
      return {
        exitTimestamp, exitPrice: target, exitReason: "TP", resultR, holdBars: slot,
        ambiguousSameBar: stopHit, gappedStop, gappedTarget,
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
