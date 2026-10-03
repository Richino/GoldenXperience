/**
 * Shared M15 event generation for outer-S/R 10-pip study + M1 validation.
 * Exact same setup as research-eurusd-sr-outer-10pip-reversal-time.ts
 * (production computeSupportResistanceLevels — no redesign).
 */
import type { Candle, MajorInstrument } from "../src/types/forex";
import { computeSupportResistanceLevels } from "../src/lib/strategy/support-resistance";

export const INSTRUMENT: MajorInstrument = "EUR_USD";
export const PIP = 0.0001;
export const PIVOT_REACH = 5;
export const RANGE_LOOKBACK = 60;
export const VISIBLE_LOOKBACK = 160;
export const DEPTHS_P = [1, 3, 5, 7.5, 10, 15, 20] as const;
export const HORIZON_BARS_M15 = 96; // 24h

export type Dir = "UP" | "DOWN";

export type OuterTouchEvent = {
  id: string;
  uniqueKey: string;
  depthP: number;
  dir: Dir;
  breakIdx: number;
  breakTime: string;
  oldLevel: number;
  outerLevel: number;
  touchIdx: number;
  touchTime: string;
  touchPrice: number;
};

export type StudyGenerationResult = {
  lookaheadViolations: number;
  totalBreakoutTriggers: number;
  uniqueBreakoutExcursions: number;
  outerLevelsFound: number;
  outerLevelsReached: number;
  depthEvents: OuterTouchEvent[];
  uniqueEvents: OuterTouchEvent[];
  duplicateEventIds: number;
};

function collectSwingPivots(visible: Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = PIVOT_REACH; index < visible.length - PIVOT_REACH; index += 1) {
    const candle = visible[index]!;
    const window = visible.slice(index - PIVOT_REACH, index + PIVOT_REACH + 1);
    if (window.every((other) => other === candle || other.high <= candle.high)) {
      highs.push(candle.high);
    }
    if (window.every((other) => other === candle || other.low >= candle.low)) {
      lows.push(candle.low);
    }
  }
  return { highs, lows };
}

function windowFor(candles: Candle[], endExclusive: number): Candle[] {
  const start = Math.max(0, endExclusive - VISIBLE_LOOKBACK);
  return candles.slice(start, endExclusive);
}

function findNewOuter(
  candles: Candle[],
  breakIdx: number,
  dir: Dir,
  oldLevel: number,
): number | null {
  const visible = windowFor(candles, breakIdx + 1);
  const { highs, lows } = collectSwingPivots(visible);
  const eps = PIP * 0.25;
  if (dir === "UP") {
    const above = highs.filter((h) => h > oldLevel + eps);
    if (!above.length) return null;
    return Math.min(...above);
  }
  const below = lows.filter((l) => l < oldLevel - eps);
  if (!below.length) return null;
  return Math.max(...below);
}

export function generateOuterTouchEvents(candles: Candle[]): StudyGenerationResult {
  const n = candles.length;
  let lookaheadViolations = 0;
  let totalBreakoutTriggers = 0;
  let uniqueBreakoutExcursions = 0;
  let outerLevelsFound = 0;
  let outerLevelsReached = 0;
  const depthEvents: OuterTouchEvent[] = [];

  type Exc = {
    dir: Dir;
    oldLevel: number;
    startIdx: number;
    depthsFired: Set<number>;
    outerByDepth: Map<number, number | null>;
  };
  let openUp: Exc | null = null;
  let openDown: Exc | null = null;

  for (let i = VISIBLE_LOOKBACK; i < n; i++) {
    const bar = candles[i]!;
    const prior = windowFor(candles, i);
    if (prior.length < 20) continue;
    const levels = computeSupportResistanceLevels(prior, INSTRUMENT);
    if (!levels) continue;
    if (Math.abs(levels.current - prior[prior.length - 1]!.close) > 1e-12) lookaheadViolations++;

    const oldRes = levels.rangeHigh;
    const oldSup = levels.rangeLow;

    const tryRecord = (exc: Exc, depthP: number, breakIdx: number, breakTime: string) => {
      if (exc.depthsFired.has(depthP)) return;
      const barX = candles[breakIdx]!;
      if (exc.dir === "UP") {
        if (barX.high < exc.oldLevel + depthP * PIP) return;
      } else {
        if (barX.low > exc.oldLevel - depthP * PIP) return;
      }
      exc.depthsFired.add(depthP);
      totalBreakoutTriggers++;
      const outer = findNewOuter(candles, breakIdx, exc.dir, exc.oldLevel);
      exc.outerByDepth.set(depthP, outer);
      if (outer == null) return;
      outerLevelsFound++;
      let touchIdx = -1;
      const limit = Math.min(n - 1, breakIdx + HORIZON_BARS_M15 * 5);
      for (let j = breakIdx; j <= limit; j++) {
        if (exc.dir === "UP" ? candles[j]!.high >= outer : candles[j]!.low <= outer) {
          touchIdx = j;
          break;
        }
      }
      if (touchIdx < 0) return;
      outerLevelsReached++;
      const id = `${exc.dir}|d${depthP}|br${breakIdx}|t${touchIdx}|o${outer.toFixed(5)}`;
      const uniqueKey = `${exc.dir}|${outer.toFixed(5)}|${touchIdx}`;
      depthEvents.push({
        id,
        uniqueKey,
        depthP,
        dir: exc.dir,
        breakIdx,
        breakTime,
        oldLevel: exc.oldLevel,
        outerLevel: outer,
        touchIdx,
        touchTime: candles[touchIdx]!.time,
        touchPrice: outer,
      });
    };

    if (openUp && bar.close < openUp.oldLevel) openUp = null;
    if (openDown && bar.close > openDown.oldLevel) openDown = null;

    if (!openUp && bar.high >= oldRes + 1 * PIP) {
      openUp = { dir: "UP", oldLevel: oldRes, startIdx: i, depthsFired: new Set(), outerByDepth: new Map() };
      uniqueBreakoutExcursions++;
    }
    if (openUp) {
      for (const depthP of DEPTHS_P) tryRecord(openUp, depthP, i, bar.time);
    }

    if (!openDown && bar.low <= oldSup - 1 * PIP) {
      openDown = { dir: "DOWN", oldLevel: oldSup, startIdx: i, depthsFired: new Set(), outerByDepth: new Map() };
      uniqueBreakoutExcursions++;
    }
    if (openDown) {
      for (const depthP of DEPTHS_P) tryRecord(openDown, depthP, i, bar.time);
    }
  }

  const uniqueMap = new Map<string, OuterTouchEvent>();
  for (const e of depthEvents) {
    const prev = uniqueMap.get(e.uniqueKey);
    if (!prev || e.touchIdx < prev.touchIdx || (e.touchIdx === prev.touchIdx && e.depthP < prev.depthP)) {
      uniqueMap.set(e.uniqueKey, e);
    }
  }
  const uniqueEvents = [...uniqueMap.values()].sort((a, b) => a.touchIdx - b.touchIdx);
  const ids = depthEvents.map((e) => e.id);
  const duplicateEventIds = ids.length - new Set(ids).size;

  return {
    lookaheadViolations,
    totalBreakoutTriggers,
    uniqueBreakoutExcursions,
    outerLevelsFound,
    outerLevelsReached,
    depthEvents,
    uniqueEvents,
    duplicateEventIds,
  };
}
