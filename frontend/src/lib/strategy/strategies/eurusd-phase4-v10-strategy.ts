import { calculateAtrValues, calculateEmaValues } from "@/lib/strategy/indicators";
import type { Candle } from "@/types/forex";

/**
 * GX EURUSD Phase 4 V10 - Frozen Confirmation Strategy - 1 to 1 (LONG only, H1).
 *
 * Three confirmation families, each evaluated only on the completed candle at
 * its own UTC origin hour. Reproduces the frozen TradingView cohort; validated
 * to 197/197 exact entries against OANDA. The supplied Pine arrived empty, so
 * cohort parity is the reference. RESEARCH module — not wired into execution.
 *
 * Geometry: SL = 1 ATR14, TP = 1 ATR14 (1:1), max hold = 6 H1 bars, entry at
 * the origin candle close. LONG only (family 10 inverts a bearish setup).
 */
export const EURUSD_V10_ID = "eurusd_phase4_v10" as const;
export const EURUSD_V10_NAME = "GX EURUSD Phase 4 V10 - Frozen Confirmation Strategy - 1 to 1" as const;
export const EURUSD_V10_SYMBOL = "EUR_USD" as const;
export const EURUSD_V10_CONFIG = Object.freeze({
  symbol: EURUSD_V10_SYMBOL, timeframe: "H1", direction: "LONG_ONLY", startTimeUtc: "2023-01-01T00:00:00.000Z",
  families: { "07_EXTREME_LONG": 7, "08_BODY_LONG": 8, "10_BODY_INV_LONG": 10 },
  emaFastPeriod: 20, emaSlowPeriod: 50, atrPeriod: 14, stopAtr: 1, targetAtr: 1, maxHoldBars: 6,
  bodyAtrMin: 0.4, closeLocationMin: 0.75, invBelowEmaAtr: 0.5, executionEnabled: false,
});

export type EurusdV10Setup = "07_EXTREME_LONG" | "08_BODY_LONG" | "10_BODY_INV_LONG";

export interface EurusdV10Evaluation {
  originTime: string | null;
  setup: EurusdV10Setup | null;
  strategySignalQualified: boolean;
  signalMidClose: number | null;
  frozenAtr14: number | null;
  pineReferenceStop: number | null;
  pineReferenceTarget: number | null;
  ema20: number | null; ema50: number | null; closeThreeBarsAgo: number | null;
  bullish: boolean; bearish: boolean; higherHigh: boolean; higherLow: boolean; lowerHigh: boolean; lowerLow: boolean;
  closeLocation: number | null; bodyAtr: number | null; prior3High: number | null; prior3Low: number | null; belowEmaAtr: number | null;
}

const START = Date.parse(EURUSD_V10_CONFIG.startTimeUtc);
const exactH1 = (d: Date) => d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
const finite = (v: number | null) => v !== null && Number.isFinite(v);

function clean(input: readonly Candle[]) {
  const m = new Map<string, Candle>();
  for (const c of input) if (c.complete && Number.isFinite(Date.parse(c.time)) && !m.has(c.time)) m.set(c.time, c);
  return [...m.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

/** Literal frozen implementation over completed H1 candles (midpoint geometry). */
export function evaluateEurusdPhase4V10(input: readonly Candle[]): EurusdV10Evaluation {
  const cs = clean(input);
  const i = cs.length - 1, c = cs.at(-1), p1 = cs.at(-2), p2 = cs.at(-3), p3 = cs.at(-4);
  const closes = cs.map((x) => x.close);
  const e20s = calculateEmaValues(closes, 20), e50s = calculateEmaValues(closes, 50), atrs = calculateAtrValues(cs, 14);
  const ema20 = e20s[i] ?? null, ema50 = e50s[i] ?? null, atr14 = atrs[i] ?? null;
  const hour = c ? new Date(c.time).getUTCHours() : -1;
  const ready = Boolean(c && p1 && p2 && p3 && finite(ema20) && finite(ema50) && finite(atr14) && atr14! > 0 && Date.parse(c.time) >= START && exactH1(new Date(c.time)));

  const empty: EurusdV10Evaluation = {
    originTime: c?.time ?? null, setup: null, strategySignalQualified: false, signalMidClose: null, frozenAtr14: atr14,
    pineReferenceStop: null, pineReferenceTarget: null, ema20, ema50, closeThreeBarsAgo: p3?.close ?? null,
    bullish: false, bearish: false, higherHigh: false, higherLow: false, lowerHigh: false, lowerLow: false,
    closeLocation: null, bodyAtr: null, prior3High: null, prior3Low: null, belowEmaAtr: null,
  };
  if (!ready) return empty;

  const bullish = c!.close > c!.open, bearish = c!.close < c!.open;
  const higherHigh = c!.high > p1!.high, higherLow = c!.low > p1!.low;
  const lowerHigh = c!.high < p1!.high, lowerLow = c!.low < p1!.low;
  const prior3High = Math.max(p1!.high, p2!.high, p3!.high), prior3Low = Math.min(p1!.low, p2!.low, p3!.low);
  const range = c!.high - c!.low;
  const closeLocation = range > 0 ? (c!.close - c!.low) / range : 0;
  const bodyAtr = Math.abs(c!.close - c!.open) / atr14!;
  const belowEmaAtr = (ema20! - c!.close) / atr14!;
  const closeGtClose3 = c!.close > p3!.close, closeLtClose3 = c!.close < p3!.close;

  let setup: EurusdV10Setup | null = null;
  if (hour === 7) {
    if (bullish && closeGtClose3 && ema20! > ema50! && higherHigh && higherLow && closeLocation >= EURUSD_V10_CONFIG.closeLocationMin) setup = "07_EXTREME_LONG";
  } else if (hour === 8) {
    if (bullish && closeGtClose3 && ema20! > ema50! && c!.close > prior3High && higherHigh && higherLow && bodyAtr >= EURUSD_V10_CONFIG.bodyAtrMin) setup = "08_BODY_LONG";
  } else if (hour === 10) {
    if (bearish && closeLtClose3 && ema20! < ema50! && c!.close < prior3Low && lowerHigh && lowerLow && belowEmaAtr >= EURUSD_V10_CONFIG.invBelowEmaAtr && bodyAtr >= EURUSD_V10_CONFIG.bodyAtrMin) setup = "10_BODY_INV_LONG";
  }

  const qualified = setup !== null;
  const signalMidClose = qualified ? c!.close : null;
  return {
    originTime: c!.time, setup, strategySignalQualified: qualified, signalMidClose, frozenAtr14: atr14,
    pineReferenceStop: qualified ? c!.close - atr14! : null, pineReferenceTarget: qualified ? c!.close + atr14! : null,
    ema20, ema50, closeThreeBarsAgo: p3!.close, bullish, bearish, higherHigh, higherLow, lowerHigh, lowerLow,
    closeLocation, bodyAtr, prior3High, prior3Low, belowEmaAtr,
  };
}
