import { pipSizeFor } from "@/lib/instruments/catalog";
import type { Candle, MajorInstrument } from "@/types/forex";

/** Deliberately fixed V1 research settings; none are execution inputs. */
export const ADAPTIVE_SWING_TRENDLINES_V1 = {
  timeframe: "M15",
  majorLookbackMs: 2 * 24 * 60 * 60 * 1_000,
  pivotRadius: 3,
  touchTolerancePips: 2,
} as const;

export type AdaptiveTrendDirection = "bullish" | "bearish";
export type AdaptiveTrendType = "major" | "current";
export type AdaptiveTrendStatus = "candidate" | "confirmed" | "broken";

export type ConfirmedSwing = {
  index: number;
  time: string;
  price: number;
  type: "high" | "low";
  confirmationIndex: number;
  confirmationTime: string;
};

export type AdaptiveTrendline = {
  id: string;
  type: AdaptiveTrendType;
  direction: AdaptiveTrendDirection;
  pointA: ConfirmedSwing;
  pointB: ConfirmedSwing;
  createdAt: string;
  touches: number;
  slopePerBar: number;
  status: AdaptiveTrendStatus;
  breakAt: string | null;
  currentDistancePips: number;
};

export type AdaptiveSwingTrendlineRead = {
  majorDirection: AdaptiveTrendDirection | null;
  currentDirection: AdaptiveTrendDirection | null;
  major: AdaptiveTrendline | null;
  current: AdaptiveTrendline | null;
  previous: AdaptiveTrendline | null;
  swings: ConfirmedSwing[];
};

function project(line: Pick<AdaptiveTrendline, "pointA" | "slopePerBar">, index: number) {
  return line.pointA.price + line.slopePerBar * (index - line.pointA.index);
}

/**
 * A pivot becomes visible only on the close of its third completed right-side
 * candle. Every caller receives only completed OANDA candles, but this second
 * guard makes the no-lookahead boundary explicit in the indicator itself.
 */
export function confirmedSwings(candles: Candle[]): ConfirmedSwing[] {
  const completed = candles.filter((candle) => candle.complete !== false);
  const { pivotRadius } = ADAPTIVE_SWING_TRENDLINES_V1;
  const swings: ConfirmedSwing[] = [];
  for (let index = pivotRadius; index < completed.length - pivotRadius; index += 1) {
    const pivot = completed[index]!;
    const window = completed.slice(index - pivotRadius, index + pivotRadius + 1);
    const confirmation = completed[index + pivotRadius]!;
    if (window.every((candle) => candle === pivot || candle.high <= pivot.high)) {
      swings.push({ index, time: pivot.time, price: pivot.high, type: "high", confirmationIndex: index + pivotRadius, confirmationTime: confirmation.time });
    }
    if (window.every((candle) => candle === pivot || candle.low >= pivot.low)) {
      swings.push({ index, time: pivot.time, price: pivot.low, type: "low", confirmationIndex: index + pivotRadius, confirmationTime: confirmation.time });
    }
  }
  return swings.sort((left, right) => left.confirmationIndex - right.confirmationIndex || left.index - right.index);
}

function directionFor(a: ConfirmedSwing, b: ConfirmedSwing): AdaptiveTrendDirection | null {
  if (a.type !== b.type || a.index >= b.index) return null;
  if (a.type === "low" && b.price > a.price) return "bullish";
  if (a.type === "high" && b.price < a.price) return "bearish";
  return null;
}

/** Reject anchor pairs whose own segment was already repeatedly invalidated. */
function cleanAnchorSegment(candles: Candle[], a: ConfirmedSwing, b: ConfirmedSwing, direction: AdaptiveTrendDirection) {
  const slope = (b.price - a.price) / (b.index - a.index);
  for (let index = a.index + 1; index < b.index; index += 1) {
    const close = candles[index]!.close;
    const linePrice = a.price + slope * (index - a.index);
    if (direction === "bullish" ? close < linePrice : close > linePrice) return false;
  }
  return true;
}

function buildLine(type: AdaptiveTrendType, a: ConfirmedSwing, b: ConfirmedSwing, direction: AdaptiveTrendDirection): AdaptiveTrendline {
  return {
    id: `${type}:${direction}:${a.time}:${b.time}`,
    type,
    direction,
    pointA: a,
    pointB: b,
    createdAt: b.confirmationTime,
    touches: 2,
    slopePerBar: (b.price - a.price) / (b.index - a.index),
    status: "candidate",
    breakAt: null,
    currentDistancePips: 0,
  };
}

function updateLine(line: AdaptiveTrendline, candle: Candle, index: number, pipSize: number) {
  if (index <= line.pointB.confirmationIndex) return;
  const linePrice = project(line, index);
  const tolerance = ADAPTIVE_SWING_TRENDLINES_V1.touchTolerancePips * pipSize;
  const interaction = line.direction === "bullish" ? candle.low : candle.high;
  if (Math.abs(interaction - linePrice) <= tolerance) {
    line.touches += 1;
    if (line.touches >= 3 && line.status === "candidate") line.status = "confirmed";
  }
  const broken = line.direction === "bullish" ? candle.close < linePrice : candle.close > linePrice;
  if (broken && line.status !== "broken") {
    line.status = "broken";
    line.breakAt = candle.time;
  }
}

/**
 * Builds the newest valid chain one confirmed pivot at a time. B is never
 * selected until B's confirmation candle has closed; a new B creates a new
 * line instead of editing a historical A/B line.
 */
function replayCurrentLines(candles: Candle[], swings: ConfirmedSwing[]) {
  const lines: AdaptiveTrendline[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < candles.length; index += 1) {
    for (const b of swings.filter((swing) => swing.confirmationIndex === index)) {
      const candidates = swings
        .filter((a) => a.confirmationIndex <= index && a.index < b.index)
        .map((a) => ({ a, direction: directionFor(a, b) }))
        .filter((candidate): candidate is { a: ConfirmedSwing; direction: AdaptiveTrendDirection } => candidate.direction !== null)
        .filter(({ a, direction }) => cleanAnchorSegment(candles, a, b, direction));
      // Nearest legitimate A is the chaining rule: this favours B1/A2 -> B2
      // without pretending an unrelated old pivot is the current move.
      const selected = candidates.at(-1);
      if (selected) {
        const line = buildLine("current", selected.a, b, selected.direction);
        if (!seen.has(line.id)) {
          lines.push(line);
          seen.add(line.id);
        }
      }
    }
  }
  return lines;
}

function selectMajorLine(candles: Candle[], swings: ConfirmedSwing[]) {
  const last = candles.at(-1);
  if (!last) return null;
  const cutoff = Date.parse(last.time) - ADAPTIVE_SWING_TRENDLINES_V1.majorLookbackMs;
  const inWindow = swings.filter((swing) => Date.parse(swing.time) >= cutoff && swing.confirmationIndex < candles.length);
  const candidates = inWindow.flatMap((b) => inWindow
    .filter((a) => a.index < b.index)
    .map((a) => ({ a, b, direction: directionFor(a, b) }))
    .filter((candidate): candidate is { a: ConfirmedSwing; b: ConfirmedSwing; direction: AdaptiveTrendDirection } => candidate.direction !== null)
    .filter(({ a, b, direction }) => cleanAnchorSegment(candles, a, b, direction)));
  if (!candidates.length) return null;
  // The widest clean A/B span is the broader structure, not merely the last
  // two pivots. Price change breaks a span tie.
  candidates.sort((left, right) => {
    const span = right.b.index - right.a.index - (left.b.index - left.a.index);
    if (span) return span;
    return Math.abs(right.b.price - right.a.price) - Math.abs(left.b.price - left.a.price);
  });
  const selected = candidates[0]!;
  return buildLine("major", selected.a, selected.b, selected.direction);
}

export function analyzeAdaptiveSwingTrendlines(candles: Candle[], instrument: MajorInstrument): AdaptiveSwingTrendlineRead {
  const completed = candles.filter((candle) => candle.complete !== false);
  if (completed.length < ADAPTIVE_SWING_TRENDLINES_V1.pivotRadius * 2 + 2) {
    return { majorDirection: null, currentDirection: null, major: null, current: null, previous: null, swings: [] };
  }
  const pipSize = pipSizeFor(instrument);
  const swings = confirmedSwings(completed);
  const currentLines = replayCurrentLines(completed, swings);
  const major = selectMajorLine(completed, swings);
  const allLines = major ? [...currentLines, major] : currentLines;
  for (const line of allLines) {
    for (let index = line.pointB.confirmationIndex + 1; index < completed.length; index += 1) updateLine(line, completed[index]!, index, pipSize);
    line.currentDistancePips = (completed.at(-1)!.close - project(line, completed.length - 1)) / pipSize;
  }
  const viable = currentLines.filter((line) => line.status !== "broken");
  const current = viable.at(-1) ?? null;
  const previous = currentLines.filter((line) => line !== current).at(-1) ?? null;
  return { majorDirection: major?.direction ?? null, currentDirection: current?.direction ?? null, major, current, previous, swings };
}
