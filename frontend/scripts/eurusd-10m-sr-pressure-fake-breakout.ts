import { calculateAtrValues, calculateEmaValues } from "../src/lib/strategy/indicators";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

/**
 * Frozen research evaluator for eurusd_10m_sr_pressure_fake_breakout_v2_long_only.
 * Not registered in production. Do not deploy.
 */
export const STRATEGY_ID = "eurusd_10m_sr_pressure_fake_breakout_v2_long_only" as const;
export const STRATEGY_NAME = "EUR/USD 10m S/R Pressure Fake Breakout V2 Long Only" as const;
export const STRATEGY_VERSION = "v2" as const;
export const SYMBOL = "EUR_USD" as const;
export const TIMEFRAME = "M10" as const;
export const BAR_MS = 10 * 60_000;
export const PIP = 0.0001;

export const CONFIG = Object.freeze({
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  atrPeriod: 14,
  pressureBars: 30,
  minTouches: 2,
  touchAtrBuffer: 0.15,
  breakoutBodyAtr: 0.35,
  stopAtr: 1.0,
  rewardR: 2.0,
  asiaStartHourUtc: 0,
  asiaEndHourUtc: 6,
  londonStartHourUtc: 6,
  londonEndHourUtc: 11,
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
  frozenResistance: number;
  touches: number;
  midEntry: number;
  atr: number;
  midStop: number;
  midTarget: number;
  ema20: number;
  ema50: number;
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
  utcHour: number;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  asiaHigh: number | null;
  inAsia: boolean;
  inLondon: boolean;
  emaBull: boolean;
  structureBull: boolean;
  touches: number;
  longBreakout: boolean;
  pendingConfirmation: boolean;
  realBreakout: boolean;
  fakeBreakout: boolean;
};

type Pending = { breakoutTimestamp: string; resistance: number; atr: number; touches: number; ema20: number; ema50: number };
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

export function utcHour(timestamp: string) {
  return new Date(timestamp).getUTCHours();
}

export function utcDateKey(timestamp: string) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function inAsiaSession(timestamp: string) {
  const hour = utcHour(timestamp);
  return hour >= CONFIG.asiaStartHourUtc && hour < CONFIG.asiaEndHourUtc;
}

export function inLondonWindow(timestamp: string) {
  const hour = utcHour(timestamp);
  return hour >= CONFIG.londonStartHourUtc && hour < CONFIG.londonEndHourUtc;
}

export function countResistanceTouches(
  bars: readonly Candle[],
  endIndexExclusive: number,
  asiaHigh: number,
  atr: number,
) {
  const start = Math.max(0, endIndexExclusive - CONFIG.pressureBars);
  let touches = 0;
  const threshold = asiaHigh - CONFIG.touchAtrBuffer * atr;
  for (let index = start; index < endIndexExclusive; index += 1) {
    const bar = bars[index]!;
    if (bar.high >= threshold && bar.close <= asiaHigh) touches += 1;
  }
  return touches;
}

export function evaluateTrace(candles: readonly ResearchCandle[]): { rows: SignalTraceRow[]; error: string | null } {
  const normalized = normalizeMbaCandles(candles);
  if (normalized.error) return { rows: [], error: normalized.error };
  const mids = normalized.candles.map(midCandle);
  const ema20Values = calculateEmaValues(mids.map((candle) => candle.close), CONFIG.emaFastPeriod);
  const ema50Values = calculateEmaValues(mids.map((candle) => candle.close), CONFIG.emaSlowPeriod);
  const atr14Values = calculateAtrValues(mids, CONFIG.atrPeriod);
  const rows: SignalTraceRow[] = [];
  let asiaDate = "";
  let asiaHigh: number | null = null;
  let pending: Pending | null = null;

  for (let index = 0; index < mids.length; index += 1) {
    const candle = mids[index]!;
    const previous = mids[index - 1];
    const prior = mids[index - 2];
    const dateKey = utcDateKey(candle.time);
    if (dateKey !== asiaDate) {
      asiaDate = dateKey;
      asiaHigh = null;
    }
    if (inAsiaSession(candle.time)) {
      asiaHigh = asiaHigh == null ? candle.high : Math.max(asiaHigh, candle.high);
    }

    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const atr14 = atr14Values[index] ?? null;
    const emaBull = Boolean(ema20 !== null && ema50 !== null && ema20 > ema50);
    const structureBull = Boolean(previous && prior && previous.high > prior.high && previous.low > prior.low);
    const london = inLondonWindow(candle.time);
    const asia = inAsiaSession(candle.time);
    const ready = emaBull && structureBull && atr14 !== null && atr14 > 0 && asiaHigh !== null && previous !== undefined;
    const touches = ready ? countResistanceTouches(mids, index, asiaHigh!, atr14!) : 0;

    let realBreakout = false;
    let fakeBreakout = false;
    if (pending) {
      if (candle.close > pending.resistance) realBreakout = true;
      else fakeBreakout = true;
      pending = null;
    }

    const body = candle.close - candle.open;
    const longBreakout = Boolean(!realBreakout && !fakeBreakout && london && ready
      && touches >= CONFIG.minTouches
      && body >= CONFIG.breakoutBodyAtr * atr14!
      && candle.close > asiaHigh!
      && previous!.close <= asiaHigh!);

    const pendingConfirmation = longBreakout;
    const armed = longBreakout
      ? { breakoutTimestamp: candle.time, resistance: asiaHigh!, atr: atr14!, touches, ema20: ema20!, ema50: ema50! }
      : null;
    if (armed) pending = armed;

    rows.push({
      timestamp: candle.time,
      utcHour: utcHour(candle.time),
      ema20, ema50, atr14, asiaHigh, inAsia: asia, inLondon: london,
      emaBull, structureBull, touches, longBreakout, pendingConfirmation, realBreakout, fakeBreakout,
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
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!row.realBreakout || index === 0) continue;
    const breakoutRow = rows[index - 1]!;
    if (!breakoutRow.longBreakout || breakoutRow.atr14 == null || breakoutRow.asiaHigh == null
      || breakoutRow.ema20 == null || breakoutRow.ema50 == null) continue;
    const bar = byTime.get(row.timestamp);
    if (!bar) continue;
    const midEntry = bar.mid.close;
    const atr = breakoutRow.atr14;
    if (!(atr > 0) || !finite(midEntry)) continue;
    const midStop = midEntry - CONFIG.stopAtr * atr;
    const midTarget = midEntry + CONFIG.rewardR * atr;
    if (!(midStop < midEntry && midEntry < midTarget)) continue;
    out.push({
      strategyId: STRATEGY_ID,
      signalTimestamp: row.timestamp,
      decisionTime: new Date(Date.parse(row.timestamp) + BAR_MS).toISOString(),
      breakoutTimestamp: breakoutRow.timestamp,
      direction: "long",
      frozenResistance: breakoutRow.asiaHigh,
      touches: breakoutRow.touches,
      midEntry, atr, midStop, midTarget,
      ema20: breakoutRow.ema20, ema50: breakoutRow.ema50,
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
      return { entry, stop: entry - CONFIG.stopAtr * signal.atr, target: entry + CONFIG.rewardR * signal.atr };
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

  for (let slot = 1; signalIndex + slot < candles.length; slot += 1) {
    const candle = candles[signalIndex + slot]!;
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

export function breakoutStats(rows: readonly SignalTraceRow[]) {
  const breakouts = rows.filter((row) => row.longBreakout).length;
  const real = rows.filter((row) => row.realBreakout).length;
  const fake = rows.filter((row) => row.fakeBreakout).length;
  return {
    breakoutCandidates: breakouts,
    realBreakouts: real,
    fakeBreakouts: fake,
    fakeBreakoutRate: breakouts ? fake / breakouts : null,
  };
}
