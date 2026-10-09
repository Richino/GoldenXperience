import { precisionFor } from "@/lib/instruments/catalog";
import type { AnalyzeMode, V2Timeframe } from "@/lib/strategy/analyze-v2/config";
import { TIMEFRAME_MS } from "@/lib/strategy/analyze-v2/config";
import { toPips, type Side } from "@/lib/strategy/analyze-v2/instrument-math";
import type { TrendRead } from "@/lib/strategy/analyze-v2/structure";
import { confirmedPivots } from "@/lib/strategy/market-regime";
import { LONDON_TIME_ZONE, NEW_YORK_TIME_ZONE, sessionHour } from "@/lib/strategy/session";
import type { Candle } from "@/types/forex";

/**
 * Liquidity reference levels and what price has done at them, as entry-risk
 * context. These are price-action proxies: candle data cannot show where
 * stop orders actually rest, and a sweep is not proof of anyone's intent.
 * No level is assumed to be visited, and no sweep is assumed to carry an
 * edge (that needs out-of-sample testing; see the Phase 7 replay).
 *
 * Levels (each with price, timeframe, the time it formed and its source):
 *   previous trading day high/low (17:00 New York roll; DST-aware)
 *   Asia and London session high/low (the chart overlay's windows: Asia
 *     00:00 UTC to London 08:00, London to New York 08:00; NORMAL only)
 *   previous week high/low (SWING)
 *   equal highs/lows: two confirmed pivots within tolerance
 *   recent meaningful swing highs/lows, and range boundaries
 *
 * Status, from closed candles after the level formed. "Beyond" means past
 * the level by the cross buffer (the spread, at least `crossBufferAtr`):
 *   UNTESTED             never traded beyond
 *   SWEEP_CANDIDATE      traded beyond; no closed-candle verdict yet
 *   SWEPT_AND_RECLAIMED  closed back inside, and the next closed candle did not close beyond again
 *   BREAKOUT_ACCEPTED    two consecutive closes beyond (or one decisive close) and still holding
 *   INCONCLUSIVE         accepted then failed, or reclaimed then re-broken
 */

export type LiquiditySource =
  | "PREVIOUS_DAY" | "PREVIOUS_WEEK" | "ASIA" | "LONDON" | "EQUAL" | "SWING" | "RANGE";
export type LiquidityStatus = "UNTESTED" | "SWEEP_CANDIDATE" | "SWEPT_AND_RECLAIMED" | "BREAKOUT_ACCEPTED" | "INCONCLUSIVE";
export type LiquidityRisk = "CLEAR" | "CAUTION" | "BLOCK" | "UNKNOWN";

export interface LiquidityLevel {
  price: number;
  /** HIGH: a high (resting orders above it); LOW: a low. */
  kind: "HIGH" | "LOW";
  sources: LiquiditySource[];
  /** Plain names, e.g. "Asia high", "previous day low". */
  labels: string[];
  timeframe: string;
  /** When the level became knowable. */
  formedAt: string;
  status: LiquidityStatus;
  /** First candle that traded beyond it. */
  crossedAt: string | null;
  /** Candle that closed back inside (reclaim) or confirmed the breakout. */
  resolvedAt: string | null;
}

export const LIQUIDITY_POLICY = {
  /** Beyond a level by at least this many ATRs (and at least the spread). */
  crossBufferAtr: 0.05,
  /** One close this far beyond counts as an accepted breakout. */
  decisiveAtr: 0.5,
  /** Pivots this close (ATRs) are equal highs/lows... */
  equalToleranceAtr: 0.1,
  /** ...and at least this many candles apart. */
  equalMinBars: 5,
  /** Levels from the same price within this many ATRs merge into one. */
  mergeAtr: 0.1,
  /** Only levels within this many ATRs of price are assessed. */
  maxDistanceAtr: 6,
  /** A stop within this many ATRs beyond a resting level sits in its sweep path. */
  stopExposureAtr: 0.3,
  /** A resting level this close behind the stop invites a run through it. */
  behindStopAtr: 1,
} as const;

// ---------------------------------------------------------------- levels

const DAY = 24 * 60 * 60_000;

/** Completed windows only: the window must have ended by the last closed candle. */
function windowExtremes(candles: Candle[], start: number, end: number, step: number, minBars: number) {
  const inside = candles.filter((candle) => {
    const at = Date.parse(candle.time);
    return at >= start && at + step <= end;
  });
  if (inside.length < minBars) return null;
  return {
    high: Math.max(...inside.map((candle) => candle.high)),
    low: Math.min(...inside.map((candle) => candle.low)),
  };
}

/** Session windows for a UTC day: Asia (00:00 UTC to London 08:00) and London (to New York 08:00). */
const hourCache = new Map<string, number>();
/** sessionHour, memoised: the same few days are asked for on every replay step. */
function cachedSessionHour(dayMs: number, hour: number, timeZone: string) {
  const key = `${dayMs}|${hour}|${timeZone}`;
  let value = hourCache.get(key);
  if (value === undefined) {
    if (hourCache.size > 20_000) hourCache.clear();
    value = sessionHour(dayMs, hour, timeZone);
    hourCache.set(key, value);
  }
  return value;
}

export function sessionWindows(dayMs: number) {
  const london = cachedSessionHour(dayMs, 8, LONDON_TIME_ZONE);
  const newYork = cachedSessionHour(dayMs, 8, NEW_YORK_TIME_ZONE);
  return { asia: { start: dayMs, end: london }, london: { start: london, end: newYork } };
}

/** The trading day ending at 17:00 New York on `dayMs`'s date. */
export function tradingDay(dayMs: number) {
  return { start: cachedSessionHour(dayMs - DAY, 17, NEW_YORK_TIME_ZONE), end: cachedSessionHour(dayMs, 17, NEW_YORK_TIME_ZONE) };
}

export interface RawLevel { price: number; kind: "HIGH" | "LOW"; source: LiquiditySource; label: string; timeframe: string; formedAt: number }

function intradayLevels(candles: Candle[], timeframe: V2Timeframe, lastClosedEnd: number): RawLevel[] {
  const step = TIMEFRAME_MS[timeframe];
  const levels: RawLevel[] = [];
  const latestDay = Math.floor(lastClosedEnd / DAY) * DAY;
  let asiaFound = false;
  let londonFound = false;
  let dayFound = false;
  for (let day = latestDay; day >= latestDay - 6 * DAY && (!asiaFound || !londonFound || !dayFound); day -= DAY) {
    const windows = sessionWindows(day);
    if (!asiaFound && windows.asia.end <= lastClosedEnd) {
      const range = windowExtremes(candles, windows.asia.start, windows.asia.end, step, Math.ceil((windows.asia.end - windows.asia.start) / step / 2));
      if (range) {
        levels.push({ price: range.high, kind: "HIGH", source: "ASIA", label: "Asia high", timeframe, formedAt: windows.asia.end });
        levels.push({ price: range.low, kind: "LOW", source: "ASIA", label: "Asia low", timeframe, formedAt: windows.asia.end });
        asiaFound = true;
      }
    }
    if (!londonFound && windows.london.end <= lastClosedEnd) {
      const range = windowExtremes(candles, windows.london.start, windows.london.end, step, Math.ceil((windows.london.end - windows.london.start) / step / 2));
      if (range) {
        levels.push({ price: range.high, kind: "HIGH", source: "LONDON", label: "London high", timeframe, formedAt: windows.london.end });
        levels.push({ price: range.low, kind: "LOW", source: "LONDON", label: "London low", timeframe, formedAt: windows.london.end });
        londonFound = true;
      }
    }
    const trading = tradingDay(day);
    if (!dayFound && trading.end <= lastClosedEnd) {
      const range = windowExtremes(candles, trading.start, trading.end, step, Math.ceil(DAY / step / 2));
      if (range) {
        levels.push({ price: range.high, kind: "HIGH", source: "PREVIOUS_DAY", label: "previous day high", timeframe, formedAt: trading.end });
        levels.push({ price: range.low, kind: "LOW", source: "PREVIOUS_DAY", label: "previous day low", timeframe, formedAt: trading.end });
        dayFound = true;
      }
    }
  }
  return levels;
}

/** Previous complete day and week from daily candles (SWING). */
function dailyLevels(daily: Candle[]): RawLevel[] {
  const closed = daily.filter((candle) => candle.complete !== false);
  const levels: RawLevel[] = [];
  const last = closed.at(-1);
  if (last) {
    const formedAt = Date.parse(last.time) + DAY;
    levels.push({ price: last.high, kind: "HIGH", source: "PREVIOUS_DAY", label: "previous day high", timeframe: "D1", formedAt });
    levels.push({ price: last.low, kind: "LOW", source: "PREVIOUS_DAY", label: "previous day low", timeframe: "D1", formedAt });
  }
  const week = closed.slice(-6, -1);
  if (week.length >= 4) {
    const formedAt = Date.parse(week.at(-1)!.time) + DAY;
    levels.push({ price: Math.max(...week.map((candle) => candle.high)), kind: "HIGH", source: "PREVIOUS_WEEK", label: "prior 5-day high", timeframe: "D1", formedAt });
    levels.push({ price: Math.min(...week.map((candle) => candle.low)), kind: "LOW", source: "PREVIOUS_WEEK", label: "prior 5-day low", timeframe: "D1", formedAt });
  }
  return levels;
}

function equalLevels(candles: Candle[], timeframe: string, reach: number, tolerance: number): RawLevel[] {
  const pivots = confirmedPivots(candles, reach);
  const levels: RawLevel[] = [];
  for (const kind of ["high", "low"] as const) {
    const sameKind = pivots.filter((pivot) => pivot.type === kind);
    for (let i = sameKind.length - 1; i > 0 && levels.filter((level) => level.kind === (kind === "high" ? "HIGH" : "LOW")).length < 2; i -= 1) {
      const later = sameKind[i]!;
      const earlier = sameKind.slice(0, i).reverse().find((pivot) => Math.abs(pivot.price - later.price) <= tolerance && later.index - pivot.index >= LIQUIDITY_POLICY.equalMinBars);
      if (!earlier) continue;
      // Nothing in between may have traded clearly beyond the pair.
      const between = candles.slice(earlier.index + 1, later.index);
      const top = Math.max(earlier.price, later.price);
      const bottom = Math.min(earlier.price, later.price);
      const clean = kind === "high" ? between.every((candle) => candle.high <= top + tolerance) : between.every((candle) => candle.low >= bottom - tolerance);
      if (!clean) continue;
      levels.push({
        price: kind === "high" ? top : bottom,
        kind: kind === "high" ? "HIGH" : "LOW",
        source: "EQUAL",
        label: kind === "high" ? "equal highs" : "equal lows",
        timeframe,
        formedAt: Date.parse(later.confirmedAt),
      });
    }
  }
  return levels;
}

// ---------------------------------------------------------------- status

export function classifyLevel(level: RawLevel, candles: Candle[], buffer: number, decisive: number) {
  const high = level.kind === "HIGH";
  const after = candles.filter((candle) => Date.parse(candle.time) >= level.formedAt);
  const beyondWick = (candle: Candle) => (high ? candle.high >= level.price + buffer : candle.low <= level.price - buffer);
  const beyondClose = (candle: Candle) => (high ? candle.close > level.price + buffer : candle.close < level.price - buffer);
  const inside = (candle: Candle) => (high ? candle.close < level.price : candle.close > level.price);
  const decisiveClose = (candle: Candle) => (high ? candle.close > level.price + decisive : candle.close < level.price - decisive);
  const crossIndex = after.findIndex(beyondWick);
  if (crossIndex < 0) return { status: "UNTESTED" as const, crossedAt: null, resolvedAt: null };
  const crossedAt = after[crossIndex]!.time;
  for (let index = crossIndex; index < after.length; index += 1) {
    const candle = after[index]!;
    const accepted = decisiveClose(candle) || (beyondClose(candle) && index > crossIndex && beyondClose(after[index - 1]!));
    if (accepted) {
      const failed = after.slice(index + 1).some(inside);
      return { status: failed ? "INCONCLUSIVE" as const : "BREAKOUT_ACCEPTED" as const, crossedAt, resolvedAt: candle.time };
    }
    if (inside(candle)) {
      const next = after[index + 1];
      // A reclaim needs a closed follow-up candle that does not close beyond again.
      if (!next) return { status: "SWEEP_CANDIDATE" as const, crossedAt, resolvedAt: null };
      return { status: beyondClose(next) ? "INCONCLUSIVE" as const : "SWEPT_AND_RECLAIMED" as const, crossedAt, resolvedAt: candle.time };
    }
  }
  return { status: "SWEEP_CANDIDATE" as const, crossedAt, resolvedAt: null };
}

export interface LiquidityInput {
  instrument: string;
  mode: AnalyzeMode;
  /** Closed primary candles (M15 NORMAL, H4 SWING). */
  candles: Candle[];
  timeframe: V2Timeframe;
  /** Closed daily candles (used by SWING). */
  daily?: Candle[];
  trend: TrendRead;
  spread: number | null;
  reach: number;
}

export function buildLiquidityLevels(input: LiquidityInput): LiquidityLevel[] {
  const { candles, trend, timeframe } = input;
  const atr = trend.atr;
  const last = candles.at(-1);
  if (!last || !(atr > 0)) return [];
  const policy = LIQUIDITY_POLICY;
  const lastClosedEnd = Date.parse(last.time) + TIMEFRAME_MS[timeframe];
  const raw: RawLevel[] = [
    ...(input.mode === "NORMAL" ? intradayLevels(candles, timeframe, lastClosedEnd) : dailyLevels(input.daily ?? [])),
    ...equalLevels(candles, timeframe, input.reach, Math.max(policy.equalToleranceAtr * atr, input.spread ?? 0)),
    ...trend.raw.swings.slice(-4).map((swing) => ({
      price: swing.price,
      kind: swing.type === "high" ? "HIGH" as const : "LOW" as const,
      source: "SWING" as const,
      label: swing.type === "high" ? "swing high" : "swing low",
      timeframe,
      formedAt: Date.parse(swing.confirmedAt),
    })),
    ...(trend.range
      ? [
          { price: trend.range.high, kind: "HIGH" as const, source: "RANGE" as const, label: "range high", timeframe, formedAt: Date.parse(trend.raw.latestSwingHigh?.confirmedAt ?? last.time) },
          { price: trend.range.low, kind: "LOW" as const, source: "RANGE" as const, label: "range low", timeframe, formedAt: Date.parse(trend.raw.latestSwingLow?.confirmedAt ?? last.time) },
        ]
      : []),
  ];

  // Merge same-kind levels that sit together; the earliest formation wins.
  const merged: RawLevel[][] = [];
  for (const level of [...raw].sort((a, b) => a.price - b.price)) {
    const group = merged.find((items) => items[0]!.kind === level.kind && Math.abs(items[0]!.price - level.price) <= policy.mergeAtr * atr);
    if (group) group.push(level);
    else merged.push([level]);
  }
  const buffer = Math.max(policy.crossBufferAtr * atr, input.spread ?? 0);
  return merged.map((group) => {
    const kind = group[0]!.kind;
    const price = kind === "HIGH" ? Math.max(...group.map((item) => item.price)) : Math.min(...group.map((item) => item.price));
    const formedAt = Math.min(...group.map((item) => item.formedAt));
    const base: RawLevel = { ...group[0]!, price, formedAt };
    const verdict = classifyLevel(base, candles, buffer, policy.decisiveAtr * atr);
    return {
      price,
      kind,
      sources: [...new Set(group.map((item) => item.source))],
      labels: [...new Set(group.map((item) => item.label))],
      timeframe: [...new Set(group.map((item) => item.timeframe))].join("+"),
      formedAt: new Date(formedAt).toISOString(),
      ...verdict,
    };
  });
}

// ---------------------------------------------------------------- assessment

export interface NearestLevel {
  level: LiquidityLevel;
  distancePips: number;
}

export interface LiquidityAssessment {
  risk: LiquidityRisk;
  /** The specific findings behind the risk, worst first. */
  findings: string[];
  /** A sweep-and-reclaim in the trade's favour during the pullback (context, not an edge). */
  confirmation: string | null;
  nearestAbove: NearestLevel | null;
  nearestBelow: NearestLevel | null;
  /** The stop sits in the path of an identifiable resting level. */
  stopExposed: boolean;
}

export interface AssessInput {
  instrument: string;
  levels: LiquidityLevel[];
  atr: number;
  price: number;
  side: Side | null;
  plan: { entry: number; stop: number; target: number } | null;
  /** When the pullback started (the impulse extreme), for confirmation timing. */
  pullbackStart: string | null;
}

const resting = (level: LiquidityLevel) => level.status === "UNTESTED" || level.status === "SWEEP_CANDIDATE";
const name = (level: LiquidityLevel, digits: number) => `${level.labels.join(" / ")} ${level.price.toFixed(digits)}`;

export function assessLiquidity({ instrument, levels, atr, price, side, plan, pullbackStart }: AssessInput): LiquidityAssessment {
  const digits = precisionFor(instrument);
  const pips = (distance: number) => toPips(instrument, distance);
  const policy = LIQUIDITY_POLICY;
  const near = levels.filter((level) => Math.abs(level.price - price) <= policy.maxDistanceAtr * atr);
  const nearestOf = (above: boolean): NearestLevel | null => {
    const candidates = near
      .filter((level) => (above ? level.price > price : level.price < price))
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    return candidates[0] ? { level: candidates[0], distancePips: pips(candidates[0].price - price) } : null;
  };
  const nearestAbove = nearestOf(true);
  const nearestBelow = nearestOf(false);
  if (!levels.length || !(atr > 0)) {
    return { risk: "UNKNOWN", findings: ["No liquidity levels could be read."], confirmation: null, nearestAbove, nearestBelow, stopExposed: false };
  }
  if (!side) {
    return { risk: "CLEAR", findings: ["No trade direction to assess against."], confirmation: null, nearestAbove, nearestBelow, stopExposed: false };
  }

  const long = side === "LONG";
  const blocks: string[] = [];
  const cautions: string[] = [];
  // Conflicting breakout: price accepted beyond a level against the trade and still holds there.
  for (const level of near.filter((item) => item.status === "BREAKOUT_ACCEPTED")) {
    if (long && level.kind === "LOW" && price < level.price) blocks.push(`Conflicting breakout: price closed and held below the ${name(level, digits)}; a long would fight an accepted breakdown.`);
    if (!long && level.kind === "HIGH" && price > level.price) blocks.push(`Conflicting breakout: price closed and held above the ${name(level, digits)}; a short would fight an accepted breakout.`);
  }

  let stopExposed = false;
  if (plan) {
    const exposure = policy.stopExposureAtr * atr;
    const behind = policy.behindStopAtr * atr;
    for (const level of near.filter(resting)) {
      // Long: lows below the entry; short: highs above it.
      if (long && level.kind === "LOW") {
        if (level.price > plan.stop && level.price - plan.stop <= exposure) {
          stopExposed = true;
          cautions.push(`The stop sits ${pips(level.price - plan.stop).toFixed(1)} pips below the untouched ${name(level, digits)}; a sweep of it could reach the stop.`);
        } else if (level.price < plan.stop && plan.stop - level.price <= behind) {
          stopExposed = true;
          cautions.push(`The untouched ${name(level, digits)} sits ${pips(plan.stop - level.price).toFixed(1)} pips below the stop; a run for it would stop the trade out.`);
        }
      }
      if (!long && level.kind === "HIGH") {
        if (level.price < plan.stop && plan.stop - level.price <= exposure) {
          stopExposed = true;
          cautions.push(`The stop sits ${pips(plan.stop - level.price).toFixed(1)} pips above the untouched ${name(level, digits)}; a sweep of it could reach the stop.`);
        } else if (level.price > plan.stop && level.price - plan.stop <= behind) {
          stopExposed = true;
          cautions.push(`The untouched ${name(level, digits)} sits ${pips(level.price - plan.stop).toFixed(1)} pips above the stop; a run for it would stop the trade out.`);
        }
      }
      // Resting liquidity between entry and target can stall the move.
      const opposing = long ? level.kind === "HIGH" && level.price > plan.entry && level.price < plan.target
        : level.kind === "LOW" && level.price < plan.entry && level.price > plan.target;
      if (opposing) cautions.push(`The untouched ${name(level, digits)} lies ${pips(level.price - plan.entry).toFixed(1)} pips away, before the target; price may stall there.`);
    }
  }

  // A sweep of the opposite side during the pullback, then reclaimed (in the trade's favour).
  const since = pullbackStart ? Date.parse(pullbackStart) : Number.NEGATIVE_INFINITY;
  const swept = near
    .filter((level) => level.status === "SWEPT_AND_RECLAIMED" && level.kind === (long ? "LOW" : "HIGH") && level.crossedAt && Date.parse(level.crossedAt) >= since)
    .sort((a, b) => Date.parse(b.crossedAt!) - Date.parse(a.crossedAt!))[0];
  const confirmation = swept
    ? `The pullback traded ${long ? "below" : "above"} the ${name(swept, digits)} and closed back ${long ? "above" : "below"} it: a sweep-and-reclaim in the trade's favour (price-action context, not proof of stop orders, not a measured edge).`
    : null;

  const risk: LiquidityRisk = blocks.length ? "BLOCK" : cautions.length ? "CAUTION" : "CLEAR";
  const findings = blocks.length || cautions.length
    ? [...blocks, ...cautions]
    : [plan ? "No specific liquidity concern identified near the entry, stop or target." : "Levels mapped; there is no qualified entry to assess them against."];
  return { risk, findings, confirmation, nearestAbove, nearestBelow, stopExposed };
}
