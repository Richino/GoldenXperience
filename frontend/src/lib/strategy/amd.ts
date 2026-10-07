import type { Candle } from "@/types/forex";
import { pipSizeFor } from "@/lib/instruments/catalog";
import { firstDisplacement, firstFvg, type DisplacementCandle, type FvgZone } from "@/lib/strategy/fvg";

/**
 * Accumulation / Manipulation / Distribution (ICT "power of three") read on
 * M15 candles — visual only, never fed to an evaluator. Fixed UTC windows:
 *
 *   Accumulation   00:00–07:00 UTC  the Asian range (box). "Tight" when it is
 *                                   at most 60% of the average full-day range
 *                                   of the previous 5 days.
 *   Manipulation   07:00–13:00 UTC  London (up to the New York open) takes one
 *                                   side of the Asian range (by at least 2 pips
 *                                   / 10% of the range) and closes back inside
 *                                   it within 2 hours (a sweep). Any break that
 *                                   price later reverses all the way through
 *                                   the other side of the range (by 21:00) is
 *                                   manipulation too, however far it ran first.
 *   Distribution   until 21:00 UTC  after a sweep: price heads for the other
 *                                   side of the range. "Reached" once it trades
 *                                   through it; "failed" if the sweep extreme
 *                                   breaks first. Otherwise the day is read as a
 *                                   breakout (no manipulation) and the move away
 *                                   from the broken side is the distribution:
 *                                   a break that never comes back inside, a
 *                                   "sweep" price later runs straight through,
 *                                   or a first break after 13:00 UTC.
 *   FVG            the first fair value gap the move leaves in the
 *                                   distribution direction after the sweep or
 *                                   breakout (at least 1 pip / 5% of the range).
 */

const M15_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ASIA_END_H = 7;
const LONDON_END_H = 13;
const DAY_END_H = 21;
const RECLAIM_BARS = 8;
const TIGHT_RATIO = 0.6;
/** A sweep must trade at least this far past the level: 2 pips or 10% of the range. */
const MIN_SWEEP_PIPS = 2;
const MIN_SWEEP_RANGE = 0.1;

export type AmdPhase = "accumulation" | "manipulation" | "distribution" | "breakout" | "no-sweep";
export type AmdDistributionStatus = "running" | "reached" | "failed";

export interface AmdDay {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  asiaStart: string;
  asiaEnd: string;
  dayEnd: string;
  asiaHigh: number;
  asiaLow: number;
  rangePips: number;
  /** Asian range at most 60% of the recent average day range. */
  tight: boolean;
  phase: AmdPhase;
  manipulation: {
    side: "high" | "low";
    direction: "long" | "short";
    sweepTime: string;
    extremeTime: string;
    extreme: number;
    reclaimTime: string;
    /** High and low of every candle from the sweep to the reclaim. */
    high: number;
    low: number;
  } | null;
  distribution: {
    status: AmdDistributionStatus;
    direction: "long" | "short";
    /** Where the move starts: the reclaim after a sweep, or the broken edge. */
    startTime: string;
    from: number;
    /** Furthest point reached in the move's direction. */
    bestTime: string;
    best: number;
  } | null;
  fvg: FvgZone | null;
  /** First strong close well outside the Asian range: "a move has started". */
  displacement: DisplacementCandle | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface AmdOptions {
  /** Last UTC hour (exclusive) in which a sweep can start. */
  sweepEndHour?: number;
  /** Candles allowed after the sweep candle to close back inside. */
  reclaimBars?: number;
}

export function computeAmdDays(candles: Candle[], instrument: string, options: AmdOptions = {}): AmdDay[] {
  const sweepEndHour = options.sweepEndHour ?? LONDON_END_H;
  const reclaimBars = options.reclaimBars ?? RECLAIM_BARS;
  const pip = pipSizeFor(instrument);
  const bars = candles
    .map((candle) => ({ ...candle, ms: Date.parse(candle.time) }))
    .filter((candle) => Number.isFinite(candle.ms))
    .sort((a, b) => a.ms - b.ms);
  if (!bars.length) return [];

  const byDay = new Map<number, typeof bars>();
  for (const bar of bars) {
    const dayMs = bar.ms - (bar.ms % (24 * HOUR_MS));
    const list = byDay.get(dayMs);
    if (list) list.push(bar);
    else byDay.set(dayMs, [bar]);
  }

  const dayRanges: number[] = [];
  const days: AmdDay[] = [];
  for (const [dayMs, dayBars] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const inWindow = (fromH: number, toH: number) =>
      dayBars.filter((bar) => bar.ms >= dayMs + fromH * HOUR_MS && bar.ms < dayMs + toH * HOUR_MS);
    const asia = inWindow(0, ASIA_END_H);
    const session = inWindow(0, DAY_END_H);
    const recentAverage = dayRanges.length >= 3
      ? dayRanges.slice(-5).reduce((sum, range) => sum + range, 0) / Math.min(5, dayRanges.length)
      : null;
    // Weekend stubs (a few Sunday-evening bars) are neither a range nor a day.
    if (session.length >= 40) {
      dayRanges.push(Math.max(...session.map((bar) => bar.high)) - Math.min(...session.map((bar) => bar.low)));
    }
    // Need most of Asia to call it a range, except while today's Asia is
    // still forming: that box is drawn live as it accumulates.
    const asiaOpen = bars.at(-1)!.ms < dayMs + ASIA_END_H * HOUR_MS;
    if (asia.length < (asiaOpen ? 4 : 20)) continue;

    const asiaHigh = Math.max(...asia.map((bar) => bar.high));
    const asiaLow = Math.min(...asia.map((bar) => bar.low));
    const range = asiaHigh - asiaLow;
    const amd: AmdDay = {
      day: iso(dayMs).slice(0, 10),
      asiaStart: iso(asia[0]!.ms),
      asiaEnd: iso(dayMs + ASIA_END_H * HOUR_MS),
      dayEnd: iso(dayMs + DAY_END_H * HOUR_MS),
      asiaHigh,
      asiaLow,
      rangePips: range / pip,
      tight: recentAverage === null ? true : range <= TIGHT_RATIO * recentAverage,
      phase: "accumulation",
      manipulation: null,
      distribution: null,
      fvg: null,
      displacement: null,
    };
    days.push(amd);

    const after = dayBars.filter((bar) => bar.ms >= dayMs + ASIA_END_H * HOUR_MS && bar.ms < dayMs + DAY_END_H * HOUR_MS);
    if (!after.length) continue;
    const londonEnd = dayMs + sweepEndHour * HOUR_MS;
    amd.displacement = firstDisplacement(after, 0, after.length, asiaHigh, asiaLow, M15_MS);

    // First bar that trades clearly outside the Asian range decides the sweep.
    const poke = Math.max(MIN_SWEEP_PIPS * pip, MIN_SWEEP_RANGE * range);
    const minGap = Math.max(pip, 0.05 * range);
    const above = (bar: (typeof after)[number]) => bar.high >= asiaHigh + poke;
    const below = (bar: (typeof after)[number]) => bar.low <= asiaLow - poke;
    // Breakout read: the move away from the Asian range from `index` on, with
    // the first gap it leaves. Used when nothing was swept and reclaimed.
    // A break is confirmed by the 2-pip / 10% push, but it starts at the first
    // candle of that run already trading past the edge.
    const runStart = (index: number, up: boolean) => {
      let start = index;
      while (start > 0 && (up ? after[start - 1]!.high > asiaHigh : after[start - 1]!.low < asiaLow)) start -= 1;
      return start;
    };
    const breakout = (index: number, up: boolean) => {
      let bestIndex = index;
      for (let i = index + 1; i < after.length; i += 1) {
        const bar = after[i]!;
        if (up ? bar.high > after[bestIndex]!.high : bar.low < after[bestIndex]!.low) bestIndex = i;
      }
      const best = after[bestIndex]!;
      // A London break owns London from its open, so A and D sit back to back;
      // a later (New York) break starts where it broke.
      const start = after[index]!.ms < londonEnd ? 0 : runStart(index, up);
      const span = after.slice(start, bestIndex + 1);
      amd.phase = "breakout";
      amd.manipulation = null;
      amd.distribution = {
        status: "reached",
        direction: up ? "long" : "short",
        startTime: iso(after[start]!.ms),
        // The far edge of every candle in the box, so none stick out.
        from: up ? Math.min(...span.map((bar) => bar.low)) : Math.max(...span.map((bar) => bar.high)),
        bestTime: iso(best.ms),
        best: up ? best.high : best.low,
      };
      amd.fvg = firstFvg(after, index, after.length, up ? "long" : "short", minGap, M15_MS);
    };
    // A candle through both sides goes the way it closed.
    const breakSide = (bar: (typeof after)[number]): "high" | "low" | null => {
      if (above(bar) && below(bar)) return bar.close > asiaHigh ? "high" : bar.close < asiaLow ? "low" : null;
      return above(bar) ? "high" : below(bar) ? "low" : null;
    };

    const sweepIndex = after.findIndex((bar) => bar.ms < londonEnd && (above(bar) || below(bar)));
    if (sweepIndex < 0) {
      if (after.at(-1)!.ms + M15_MS < londonEnd) continue;
      // Nothing by the New York open: a later break is a plain breakout.
      const lateIndex = after.findIndex((bar) => bar.ms >= londonEnd && breakSide(bar) !== null);
      if (lateIndex < 0) { amd.phase = "no-sweep"; continue; }
      breakout(lateIndex, breakSide(after[lateIndex]!) === "high");
      continue;
    }
    const sweepBar = after[sweepIndex]!;
    const side = breakSide(sweepBar);
    if (!side) { amd.phase = "breakout"; continue; }
    // A candle through both sides is a range expansion, not a one-sided sweep.
    if (above(sweepBar) && below(sweepBar)) { breakout(sweepIndex, side === "high"); continue; }

    const reversalUp = side === "low";
    const pastExtreme = (bar: (typeof after)[number], level: number) => (side === "high" ? bar.high > level : bar.low < level);
    const throughOtherSide = (bar: (typeof after)[number]) => (reversalUp ? bar.high > asiaHigh : bar.low < asiaLow);
    const extremeOf = (from: number, to: number) => {
      let index = from;
      for (let i = from; i < to; i += 1) if (pastExtreme(after[i]!, side === "high" ? after[index]!.high : after[index]!.low)) index = i;
      return index;
    };
    // Manipulation from the break out to its furthest point, then the
    // distribution from where price closed back inside.
    const manipulate = (extremeIndex: number, reclaimIndex: number, status: AmdDistributionStatus) => {
      const extremeBar = after[extremeIndex]!;
      const extreme = side === "high" ? extremeBar.high : extremeBar.low;
      // Manipulation is London's job from its open: the run-up inside the
      // range belongs to it too, so A and M sit back to back.
      const start = 0;
      const span = after.slice(start, reclaimIndex + 1);
      amd.phase = "distribution";
      amd.manipulation = {
        side,
        direction: reversalUp ? "long" : "short",
        sweepTime: iso(after[start]!.ms),
        extremeTime: iso(extremeBar.ms),
        extreme,
        reclaimTime: iso(after[reclaimIndex]!.ms + M15_MS),
        high: Math.max(...span.map((bar) => bar.high)),
        low: Math.min(...span.map((bar) => bar.low)),
      };
      let best = after[reclaimIndex]!;
      let moveEnd = after.length;
      for (let i = reclaimIndex + 1; i < after.length; i += 1) {
        const bar = after[i]!;
        if (pastExtreme(bar, extreme)) { moveEnd = i; break; }
        if (reversalUp ? bar.high > best.high : bar.low < best.low) best = bar;
      }
      amd.distribution = {
        status,
        direction: amd.manipulation.direction,
        startTime: amd.manipulation.reclaimTime,
        from: extreme,
        bestTime: iso(best.ms),
        best: reversalUp ? best.high : best.low,
      };
      amd.fvg = firstFvg(after, extremeIndex, moveEnd, amd.manipulation.direction, minGap, M15_MS);
      // The break was the manipulation: tag the first strong candle of the
      // reversal instead of one on the fake move.
      const tag = firstDisplacement(after, extremeIndex + 1, moveEnd, asiaHigh, asiaLow, M15_MS);
      amd.displacement = tag && tag.direction === amd.manipulation.direction ? tag : null;
    };

    // Did price, at any point after the break, trade through the other side of
    // the range? Then the break was the manipulation — however long it ran
    // first, and even if it briefly came back and pushed on (London fakes one
    // way, New York delivers the other).
    const reachIndex = after.findIndex((bar, i) => i > sweepIndex && throughOtherSide(bar));
    if (reachIndex >= 0) {
      const extremeIndex = extremeOf(sweepIndex, reachIndex);
      let reclaimIndex = reachIndex;
      for (let i = extremeIndex; i <= reachIndex; i += 1) {
        if (side === "high" ? after[i]!.close < asiaHigh : after[i]!.close > asiaLow) { reclaimIndex = i; break; }
      }
      manipulate(extremeIndex, reclaimIndex, "reached");
      continue;
    }

    // Not reversed (yet). A quick close back inside with the sweep extreme
    // still intact is a sweep in progress; otherwise it is a breakout.
    let quickReclaim = -1;
    for (let i = sweepIndex; i < Math.min(after.length, sweepIndex + reclaimBars); i += 1) {
      if (side === "high" ? after[i]!.close < asiaHigh : after[i]!.close > asiaLow) { quickReclaim = i; break; }
    }
    if (quickReclaim >= 0) {
      const extremeIndex = extremeOf(sweepIndex, quickReclaim + 1);
      const extremeBar = after[extremeIndex]!;
      const extreme = side === "high" ? extremeBar.high : extremeBar.low;
      const intact = !after.slice(quickReclaim + 1).some((bar) => pastExtreme(bar, extreme));
      if (intact) { manipulate(extremeIndex, quickReclaim, "running"); continue; }
    } else if (after.length < sweepIndex + reclaimBars) {
      // Still inside the reclaim window on a live chart: the sweep is in play.
      amd.phase = "manipulation";
      continue;
    }
    breakout(sweepIndex, side === "high");
  }
  return days;
}

