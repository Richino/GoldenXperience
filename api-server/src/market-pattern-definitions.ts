import type { Candle } from "../../frontend/src/types/forex.js";
import { confirmedPivots, meaningfulSwings } from "../../frontend/src/lib/strategy/market-regime.js";

export const PATTERN_RULES_VERSION = "quote-pattern-observer@1";
export const PATTERN_INTERVALS: Record<string, number> = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 };
export interface Boundary { price: number; at: string; slopePerMs?: number }
export interface PatternGeometry {
  key: string;
  kind: string;
  family: "candle" | "structure";
  direction: "up" | "down" | "neutral";
  anchors: Array<{ time: string; price: number; role: string }>;
  endTime: string;
  upper?: Boundary;
  lower?: Boundary;
  invalidAbove?: number;
  invalidBelow?: number;
  expiresAfterBars: number;
  evidence: Record<string, number | string>;
}
export function boundaryAt(boundary: Boundary, time: string) {
  return boundary.price + (boundary.slopePerMs ?? 0) * (Date.parse(time) - Date.parse(boundary.at));
}
function atr(candles: Candle[], pip: number) {
  const tail = candles.slice(-14);
  return tail.length ? Math.max(pip, tail.reduce((sum, c, i) => sum + Math.max(c.high - c.low, i ? Math.abs(c.high - tail[i - 1].close) : 0, i ? Math.abs(c.low - tail[i - 1].close) : 0), 0) / tail.length) : pip;
}

/** Only the last candle is examined; callers feed completed prefixes and forming previews separately. */
export function candlePatterns(candles: Candle[], pip: number): PatternGeometry[] {
  const c = candles.at(-1); if (!c) return [];
  const p = candles.at(-2), a = candles.at(-3);
  const range = c.high - c.low, body = Math.abs(c.close - c.open);
  if (range < pip) return [];
  const lower = Math.min(c.open, c.close) - c.low, upper = c.high - Math.max(c.open, c.close);
  const result: PatternGeometry[] = [];
  const add = (kind: string, direction: PatternGeometry["direction"], bars = 1) => {
    const selected = candles.slice(-bars);
    result.push({ key: `${kind}:${c.time}`, kind, family: "candle", direction, endTime: c.time,
      anchors: selected.map(x => ({ time: x.time, price: x.close, role: "candle_close" })),
      invalidAbove: direction === "down" ? Math.max(...selected.map(x => x.high)) + pip : undefined,
      invalidBelow: direction === "up" ? Math.min(...selected.map(x => x.low)) - pip : undefined,
      expiresAfterBars: 6, evidence: { bodyRatio: body / range, upperWickRatio: upper / range, lowerWickRatio: lower / range, rangePips: range / pip },
    });
  };
  if (body / range <= 0.1) add("doji", "neutral");
  // A rejection shape describes the wick, without assuming a preceding reversal trend.
  if (lower / range >= 0.6 && upper / range <= 0.15 && body / range <= 0.35) add("lower_wick_rejection", "up");
  if (upper / range >= 0.6 && lower / range <= 0.15 && body / range <= 0.35) add("upper_wick_rejection", "down");
  if (body / range >= 0.8) add("large_body", c.close > c.open ? "up" : "down");
  if (p) {
    const previousBody = Math.abs(p.close - p.open);
    if (previousBody >= pip * 0.1 && body > previousBody && c.close > c.open && p.close < p.open && c.open <= p.close && c.close >= p.open) add("bullish_engulfing", "up", 2);
    if (previousBody >= pip * 0.1 && body > previousBody && c.close < c.open && p.close > p.open && c.open >= p.close && c.close <= p.open) add("bearish_engulfing", "down", 2);
    if (c.high < p.high && c.low > p.low) add("inside_bar", "neutral", 2);
    if (c.high > p.high && c.low < p.low) add("outside_bar", "neutral", 2);
  }
  // FX star-like sequences do not require exchange-session gaps. The name makes that explicit.
  if (p && a && Math.abs(a.close - a.open) >= (a.high - a.low) * 0.6 && Math.abs(p.close - p.open) <= (a.high - a.low) * 0.3) {
    if (a.close < a.open && p.low <= a.close && c.close > c.open && c.close > (a.open + a.close) / 2) add("morning_star_like", "up", 3);
    if (a.close > a.open && p.high >= a.close && c.close < c.open && c.close < (a.open + a.close) / 2) add("evening_star_like", "down", 3);
  }
  return result;
}

/** Geometry comes from already-confirmed pivots, never from future candles. */
export function structurePatterns(completed: Candle[], pip: number): PatternGeometry[] {
  if (completed.length < 7) return [];
  const scale = atr(completed, pip), tolerance = Math.max(pip, scale * 0.25), buffer = Math.max(pip * 0.1, scale * 0.1);
  const swings = meaningfulSwings(confirmedPivots(completed, 2), scale * 0.5).slice(-12);
  const result: PatternGeometry[] = [];
  const boundary = (x: { price: number; time: string }, adjustment = 0): Boundary => ({ price: x.price + adjustment, at: x.time });
  const line = (x: { price: number; time: string }, y: { price: number; time: string }, adjustment = 0): Boundary => ({ ...boundary(y, adjustment), slopePerMs: (y.price - x.price) / (Date.parse(y.time) - Date.parse(x.time)) });
  const add = (kind: string, points: typeof swings, direction: PatternGeometry["direction"], levels: Partial<PatternGeometry>, evidence: PatternGeometry["evidence"] = {}) => {
    result.push({ key: `${kind}:${points.map(x => x.time).join(":")}`, kind, family: "structure", direction,
      anchors: points.map(x => ({ time: x.time, price: x.price, role: x.type })), endTime: points.at(-1)!.time,
      expiresAfterBars: 20, evidence: { atrPips: scale / pip, tolerancePips: tolerance / pip, bufferPips: buffer / pip, pivotReach: 2, ...evidence }, ...levels });
  };
  // Use recent triples/quintuples, with stable anchor IDs as later pivots arrive.
  for (let end = Math.max(3, swings.length - 3); end <= swings.length; end++) {
    const points = swings.slice(end - 3, end), [a, b, c] = points;
    if (a.type === c.type && a.type !== b.type && c.index - a.index >= 4 && Math.abs(a.price - c.price) <= tolerance && Math.min(Math.abs(a.price - b.price), Math.abs(c.price - b.price)) >= scale) {
      if (a.type === "high") add("double_top", points, "down", { lower: boundary(b, -buffer), invalidAbove: Math.max(a.price, c.price) + buffer });
      else add("double_bottom", points, "up", { upper: boundary(b, buffer), invalidBelow: Math.min(a.price, c.price) - buffer });
    }
    if (end < 5) continue;
    const five = swings.slice(end - 5, end), [left, neck1, head, neck2, right] = five;
    if (left.type !== head.type || head.type !== right.type || neck1.type === head.type || neck2.type === head.type || Math.abs(left.price - right.price) > tolerance) continue;
    if (head.type === "high" && head.price - Math.max(left.price, right.price) >= scale * 0.5 && Math.min(left.price - neck1.price, right.price - neck2.price) >= scale * 0.5) add("head_shoulders", five, "down", { lower: line(neck1, neck2, -buffer), invalidAbove: head.price + buffer });
    if (head.type === "low" && Math.min(left.price, right.price) - head.price >= scale * 0.5 && Math.min(neck1.price - left.price, neck2.price - right.price) >= scale * 0.5) add("inverse_head_shoulders", five, "up", { upper: line(neck1, neck2, buffer), invalidBelow: head.price - buffer });
  }
  const six = swings.slice(-6), highs = six.filter(x => x.type === "high"), lows = six.filter(x => x.type === "low");
  if (highs.length === 3 && lows.length === 3) {
    const top = line(highs[0], highs[2]), bottom = line(lows[0], lows[2]);
    const topFlat = Math.abs(highs[2].price - highs[0].price) <= tolerance, bottomFlat = Math.abs(lows[2].price - lows[0].price) <= tolerance;
    const topFalling = highs[2].price < highs[0].price - tolerance, bottomRising = lows[2].price > lows[0].price + tolerance;
    const fits = Math.abs(boundaryAt(top, highs[1].time) - highs[1].price) <= tolerance && Math.abs(boundaryAt(bottom, lows[1].time) - lows[1].price) <= tolerance;
    const endTime = six.at(-1)!.time, width = boundaryAt(top, endTime) - boundaryAt(bottom, endTime);
    const closingSpeed = (bottom.slopePerMs ?? 0) - (top.slopePerMs ?? 0);
    const spanMs = Date.parse(endTime) - Date.parse(six[0].time);
    if (fits && width >= scale * 0.5 && closingSpeed > 0 && width / closingSpeed <= spanMs * 3) {
      const kind = topFlat && bottomRising ? "ascending_triangle" : bottomFlat && topFalling ? "descending_triangle" : topFalling && bottomRising ? "symmetric_triangle" : null;
      if (kind) add(kind, six, "neutral", { upper: { ...top, price: top.price + buffer }, lower: { ...bottom, price: bottom.price - buffer } }, { apexTime: new Date(Date.parse(endTime) + width / closingSpeed).toISOString() });
    }
  }
  return result;
}

/** Completed closes beyond a prior 20-bar box; wick reclaim uses a prior extreme, not assumed liquidity. */
export function levelPatterns(candles: Candle[], pip: number): PatternGeometry[] {
  if (candles.length < 21) return [];
  const c = candles.at(-1)!, prior = candles.slice(-21, -1), high = Math.max(...prior.map(x => x.high)), low = Math.min(...prior.map(x => x.low));
  const scale = atr(prior, pip), tolerance = Math.max(pip, scale * 0.25), buffer = Math.max(pip * 0.1, scale * 0.1);
  const result: PatternGeometry[] = [];
  const add = (kind: string, direction: "up" | "down", level: number) => result.push({ key: `${kind}:${c.time}`, kind, family: "candle", direction, endTime: c.time,
    anchors: [{ time: prior[0].time, price: level, role: "prior_20_bar_level" }, { time: c.time, price: c.close, role: "reclaim_or_break_close" }],
    invalidAbove: direction === "down" ? c.high + buffer : undefined, invalidBelow: direction === "up" ? c.low - buffer : undefined,
    expiresAfterBars: 6, evidence: { level, lookbackBars: 20, bufferPips: buffer / pip },
  });
  if (c.high > high + buffer && c.close < high) add("high_sweep_reclaim", "down", high);
  if (c.low < low - buffer && c.close > low) add("low_sweep_reclaim", "up", low);
  const box = high - low >= scale * 2 && prior.filter(x => high - x.high <= tolerance).length >= 2 && prior.filter(x => x.low - low <= tolerance).length >= 2;
  if (box && c.close > high + buffer) add("range_break_up", "up", high);
  if (box && c.close < low - buffer) add("range_break_down", "down", low);
  return result;
}
