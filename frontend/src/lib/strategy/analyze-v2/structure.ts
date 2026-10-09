import { precisionFor } from "@/lib/instruments/catalog";
import { classifyMarketRegime, type RegimeRead, type RegimeSettings, type Swing } from "@/lib/strategy/market-regime";
import type { Candle } from "@/types/forex";

/**
 * The one authoritative trend read: confirmed swing structure from
 * market-regime.ts, nothing else. EMAs, regression slope and R² are not
 * consulted, so correlated indicators cannot outvote structure.
 *
 *   higher highs + higher lows                → UPTREND
 *   lower highs + lower lows                  → DOWNTREND
 *   repeating highs and lows in a box         → RANGE
 *   structure broke, no new direction yet     → TRANSITION
 *   swings conflict, or too little data       → UNCLEAR
 */

export type TrendDirection = "UPTREND" | "DOWNTREND" | "RANGE" | "TRANSITION" | "UNCLEAR";

/**
 * How the primary trend relates to the higher timeframe:
 *   ALIGNED              both trend the same way
 *   OPPOSED              both trend, in opposite directions (a deep pullback
 *                        of the higher trend, or a reversal starting; not settled)
 *   HIGHER_NOT_TRENDING  primary trends inside a higher range/transition/unclear read
 *   PRIMARY_NOT_TRENDING the primary timeframe is not trending
 *   UNKNOWN              no usable higher-timeframe read
 */
export type Alignment = "ALIGNED" | "OPPOSED" | "HIGHER_NOT_TRENDING" | "PRIMARY_NOT_TRENDING" | "UNKNOWN";

export interface SwingPoint {
  price: number;
  /** Open time of the pivot candle. */
  time: string;
  /** When the pivot became knowable (the confirming candle's open time). */
  confirmedAt: string;
}

export interface TrendRead {
  timeframe: string;
  direction: TrendDirection;
  /** False when there was not enough data to read structure. */
  sufficient: boolean;
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
  /**
   * The price whose close-through ends the current read: the latest higher
   * low (UPTREND), lower high (DOWNTREND); null otherwise.
   */
  structureLevel: number | null;
  /** The swing that sets `structureLevel`. */
  structureSwing: SwingPoint | null;
  /** For RANGE: the box. */
  range: { high: number; low: number } | null;
  /** For TRANSITION: what broke. */
  broken: string | null;
  /** The latest leg in the trend's direction (trend reads only). */
  impulse: { from: SwingPoint & { index: number }; to: SwingPoint & { index: number }; sizeAtr: number } | null;
  atr: number;
  /** Last closed candle the read was made on. */
  close: number;
  closeTime: string | null;
  /** Plain statements the classification rests on. */
  evidence: string[];
  /** The underlying swing read, for zones and pullbacks. */
  raw: RegimeRead;
}

const point = (swing: Swing | null): SwingPoint | null =>
  swing ? { price: swing.price, time: swing.time, confirmedAt: swing.confirmedAt } : null;

function compare(newer: number, older: number, tolerance: number) {
  return newer > older + tolerance ? "higher" : newer < older - tolerance ? "lower" : "equal";
}

/** Read one timeframe's structure from closed candles. */
export function readTrend(instrument: string, timeframe: string, candles: Candle[], settings: RegimeSettings): TrendRead {
  const digits = precisionFor(instrument);
  const closed = candles.filter((candle) => candle.complete !== false);
  const raw = classifyMarketRegime(closed, settings, digits);
  const fmt = (value: number) => value.toFixed(digits);
  const highs = raw.swings.filter((swing) => swing.type === "high").slice(-2);
  const lows = raw.swings.filter((swing) => swing.type === "low").slice(-2);
  const tolerance = settings.boundaryToleranceAtr * raw.atr * 0.25;
  const evidence: string[] = [];
  if (highs.length === 2) evidence.push(`Swing highs ${fmt(highs[0]!.price)} → ${fmt(highs[1]!.price)} (${compare(highs[1]!.price, highs[0]!.price, tolerance)})`);
  if (lows.length === 2) evidence.push(`Swing lows ${fmt(lows[0]!.price)} → ${fmt(lows[1]!.price)} (${compare(lows[1]!.price, lows[0]!.price, tolerance)})`);

  let direction: TrendDirection;
  if (!raw.sufficient) direction = "UNCLEAR";
  else if (raw.regime === "TRANSITION") direction = raw.transitionKind === "BREAK" ? "TRANSITION" : "UNCLEAR";
  else direction = raw.regime;

  const up = direction === "UPTREND";
  // The same level market-regime breaks the trend on: the latest swing low
  // in an uptrend (a higher low), the latest swing high in a downtrend.
  const structureSwing = direction === "UPTREND" ? point(raw.latestSwingLow) : direction === "DOWNTREND" ? point(raw.latestSwingHigh) : null;
  const structureLevel = structureSwing?.price ?? null;
  const impulse = (direction === "UPTREND" || direction === "DOWNTREND") && raw.impulse
    ? {
        from: { ...point(raw.impulse.from)!, index: raw.impulse.from.index },
        to: { ...point(raw.impulse.to)!, index: raw.impulse.to.index },
        sizeAtr: raw.atr > 0 ? Math.abs(raw.impulse.to.price - raw.impulse.from.price) / raw.atr : 0,
      }
    : null;
  if (impulse) evidence.push(`Latest ${up ? "up" : "down"} leg ${fmt(impulse.from.price)} → ${fmt(impulse.to.price)} (${impulse.sizeAtr.toFixed(1)} ATR)`);
  if (structureLevel !== null) evidence.push(`Structure holds while closes stay ${up ? "above" : "below"} ${fmt(structureLevel)} (the ${up ? "higher low" : "lower high"})`);
  if (direction === "RANGE" && raw.range) evidence.push(`Box ${fmt(raw.range.low)}–${fmt(raw.range.high)}`);
  if (direction === "TRANSITION" && raw.transition) evidence.push(raw.transition.broken);
  if (direction === "UNCLEAR") evidence.push(raw.sufficient ? (raw.transition?.broken ?? "Swings conflict") : raw.interpretation);

  return {
    timeframe,
    direction,
    sufficient: raw.sufficient,
    lastSwingHigh: point(raw.latestSwingHigh),
    lastSwingLow: point(raw.latestSwingLow),
    structureLevel,
    structureSwing,
    range: direction === "RANGE" && raw.range ? { high: raw.range.high, low: raw.range.low } : null,
    broken: direction === "TRANSITION" ? raw.transition?.broken ?? null : null,
    impulse,
    atr: raw.atr,
    close: raw.close,
    closeTime: closed.at(-1)?.time ?? null,
    evidence,
    raw,
  };
}

const trending = (direction: TrendDirection) => direction === "UPTREND" || direction === "DOWNTREND";

export function alignmentOf(primary: TrendRead, higher: TrendRead | null): Alignment {
  if (!trending(primary.direction)) return "PRIMARY_NOT_TRENDING";
  if (!higher || !higher.sufficient) return "UNKNOWN";
  if (!trending(higher.direction)) return "HIGHER_NOT_TRENDING";
  return primary.direction === higher.direction ? "ALIGNED" : "OPPOSED";
}

/** One sentence on how the two timeframes relate. */
export function describeAlignment(primary: TrendRead, higher: TrendRead | null, alignment: Alignment) {
  const p = `${primary.timeframe} ${primary.direction.toLowerCase()}`;
  const h = higher ? `${higher.timeframe} ${higher.direction.toLowerCase()}` : "higher timeframe unavailable";
  switch (alignment) {
    case "ALIGNED": return `${p}, in line with ${h}.`;
    case "OPPOSED": return `${p} against ${h}: either a deep pullback of the ${higher!.timeframe} trend or a reversal starting; not settled.`;
    case "HIGHER_NOT_TRENDING": return `${p} inside ${h}: a local move without higher-timeframe trend support.`;
    case "PRIMARY_NOT_TRENDING": return `${p}; ${h}. No trend to trade with.`;
    default: return `${p}; ${h}.`;
  }
}
