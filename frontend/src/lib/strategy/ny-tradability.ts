import { currenciesOf, pipSizeFor } from "@/lib/instruments/catalog";
import type { EconomicCalendarEvent } from "@/lib/oanda/calendar";
import { calculateAtrValues } from "@/lib/strategy/indicators";
import { classifyH1Structure } from "@/lib/strategy/market-structure";
import {
  getForexSessionStatus,
  localMinutes,
  LONDON_TIME_ZONE,
  NEW_YORK_TIME_ZONE,
  sessionHour,
} from "@/lib/strategy/session";
import { computeSupportResistanceLevels } from "@/lib/strategy/support-resistance";
import type { Candle } from "@/types/forex";

/**
 * Session tradability: which pairs are worth LOOKING AT in a session window.
 *
 * A pair-selection aid for the Chart pair picker and the Markets list. It
 * never picks a direction, an entry or a stop, and it does not feed Analyze or
 * any strategy. It scores how workable each pair's conditions are right now,
 * out of 100:
 *
 *   structure clarity   20  1H swing structure, and whether 15m agrees
 *   volatility          20  last 2h of 15m ranges vs the same clock slots on
 *                           prior days, per pair (so a quiet pair is judged
 *                           against itself, not against GBP/JPY)
 *   room to move        25  distance to the nearest mapped level on the side
 *                           the 1H structure points to (either side when it
 *                           has none), in 1H ATRs
 *   spread / cost       15  live bid/ask spread vs 15m ATR
 *   setup availability  20  a recognisable situation forming: a pullback in
 *                           a 1H trend, a hold beyond the London range, or a
 *                           sweep of a session high/low that came back
 *
 * Hard restrictions (high-impact news, a spread too wide for the movement)
 * make a pair BLOCKED; missing or stale candles/quotes make it UNAVAILABLE.
 * A factor the data cannot support scores 0 and is flagged unverified rather
 * than being awarded points. Only completed candles whose close is at or
 * before `now` are read, so nothing from the future can enter.
 *
 * Thresholds are provisional, configurable cut-offs, not validated
 * probabilities of a profitable trade. The window config is generic so London
 * or Asia detectors can reuse the engine later; V1 ships New York only.
 */

export type TradabilityStatus =
  | "HIGHLY_TRADABLE"
  | "MODERATELY_TRADABLE"
  | "LOW_TRADABILITY"
  | "BLOCKED"
  | "UNAVAILABLE"
  | "OUTSIDE_NY_WINDOW";

export type TradabilityPhase = "pre_session" | "active" | "outside";

export type TradabilityFactorKey = "structure" | "volatility" | "room" | "spread" | "setup";

export interface TradabilityFactor {
  key: TradabilityFactorKey;
  label: string;
  points: number;
  max: number;
  /** False when the data could not support this factor; it then scores 0. */
  verified: boolean;
  note: string;
}

export type TradabilityBlock = "news" | "news_settling" | "spread";

export interface TradabilityNews {
  /** "unavailable": the calendar could not be read, so news is NOT known to be clear. */
  state: "clear" | "blocked" | "settling" | "unavailable";
  /** The event behind a block, or the next high-impact event today. */
  event: { title: string; currency: string; at: string } | null;
}

export interface PairTradability {
  instrument: string;
  status: TradabilityStatus;
  phase: TradabilityPhase;
  /** 0–100 for scored statuses; null when blocked, unavailable or outside the window. */
  score: number | null;
  /** The sum the factors reached even when a block overrides it (for the breakdown). */
  rawScore: number | null;
  factors: TradabilityFactor[];
  block: TradabilityBlock | null;
  /** One short line on why this status. */
  summary: string;
  news: TradabilityNews;
  spreadPips: number | null;
  evaluatedAt: string;
  /** Close time of the last completed 15m candle read. */
  candlesAsOf: string | null;
  quoteAsOf: string | null;
}

export interface SessionTradabilityConfig {
  /** Status value outside the window, e.g. OUTSIDE_NY_WINDOW. */
  outsideStatus: TradabilityStatus;
  sessionLabel: string;
  timeZone: string;
  /** Minutes past local midnight. */
  preSessionStart: number;
  activeStart: number;
  activeEnd: number;
  thresholds: { high: number; moderate: number };
  news: { minImpact: number; blockBeforeMinutes: number; blockAfterMinutes: number; settleMinutes: number };
  freshness: { quoteMaxAgeMs: number; candleMaxLagMs: number };
  /** Spread as a fraction of 15m ATR: above `block` is a hard block; after news it must be back under `normal`. */
  spread: { blockAtrRatio: number; normalAtrRatio: number };
}

export const NY_TRADABILITY_CONFIG: SessionTradabilityConfig = {
  outsideStatus: "OUTSIDE_NY_WINDOW",
  sessionLabel: "New York",
  timeZone: NEW_YORK_TIME_ZONE,
  preSessionStart: 7 * 60 + 30,
  activeStart: 8 * 60,
  activeEnd: 11 * 60,
  thresholds: { high: 80, moderate: 60 },
  // ForexFactory impact 3 = high (see calendar/normalize.ts).
  news: { minImpact: 3, blockBeforeMinutes: 15, blockAfterMinutes: 15, settleMinutes: 15 },
  freshness: { quoteMaxAgeMs: 5 * 60_000, candleMaxLagMs: 20 * 60_000 },
  spread: { blockAtrRatio: 0.4, normalAtrRatio: 0.2 },
};

/** Candles the engine needs: ~5 days of 15m for same-slot baselines, ~5 days of 1H. */
export const TRADABILITY_M15_CANDLES = 500;
export const TRADABILITY_H1_CANDLES = 120;

export interface TradabilityQuote {
  bid: number;
  ask: number;
  /** Time of the quote itself (not of the request). */
  time: string;
  tradeable: boolean;
}

export interface TradabilityInput {
  instrument: string;
  now: Date;
  /** Null when the candles could not be read (or fell back to generated data). */
  m15: Candle[] | null;
  h1: Candle[] | null;
  quote: TradabilityQuote | null;
  /** Null when the economic calendar could not be read. */
  news: EconomicCalendarEvent[] | null;
}

const M15_MS = 15 * 60_000;
const H1_MS = 60 * 60_000;
const DAY_MS = 24 * H1_MS;
/** 8 × 15m = the last two hours. */
const RECENT_BARS = 8;

export function tradabilityPhase(now: Date, config: SessionTradabilityConfig = NY_TRADABILITY_CONFIG): TradabilityPhase {
  if (!getForexSessionStatus(now).marketOpen) return "outside";
  const minutes = localMinutes(now, config.timeZone);
  if (minutes >= config.activeStart && minutes < config.activeEnd) return "active";
  if (minutes >= config.preSessionStart && minutes < config.activeStart) return "pre_session";
  return "outside";
}

/** Only bars that finished at or before `now`: no forming bar, nothing ahead. */
function completedBefore(candles: Candle[], now: number, durationMs: number) {
  return candles.filter((candle) => {
    const open = Date.parse(candle.time);
    return candle.complete !== false && Number.isFinite(open) && open + durationMs <= now;
  });
}

function trueRanges(candles: Candle[]) {
  return candles.map((candle, index) => {
    const prior = candles[index - 1]?.close ?? candle.close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - prior), Math.abs(candle.low - prior));
  });
}

function lastAtr(candles: Candle[]) {
  const values = calculateAtrValues(candles, 14);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && value !== undefined && value > 0) return value;
  }
  return null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function rangeOf(candles: Candle[], start: number, end: number) {
  const bars = candles.filter((candle) => {
    const open = Date.parse(candle.time);
    return open >= start && open + M15_MS <= end;
  });
  if (!bars.length) return null;
  return { high: Math.max(...bars.map((bar) => bar.high)), low: Math.min(...bars.map((bar) => bar.low)) };
}

function etClock(iso: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function structureDirection(read: ReturnType<typeof classifyH1Structure>) {
  return read.intact && read.direction !== "mixed" ? read.direction : null;
}

function base(input: TradabilityInput, phase: TradabilityPhase, now: Date): PairTradability {
  return {
    instrument: input.instrument,
    status: "UNAVAILABLE",
    phase,
    score: null,
    rawScore: null,
    factors: [],
    block: null,
    summary: "",
    news: { state: input.news ? "clear" : "unavailable", event: null },
    spreadPips: null,
    evaluatedAt: now.toISOString(),
    candlesAsOf: null,
    quoteAsOf: input.quote?.time ?? null,
  };
}

export function computeSessionTradability(
  input: TradabilityInput,
  config: SessionTradabilityConfig = NY_TRADABILITY_CONFIG,
): PairTradability {
  const now = input.now;
  const nowMs = now.getTime();
  const phase = tradabilityPhase(now, config);
  const result = base(input, phase, now);

  if (phase === "outside") {
    return {
      ...result,
      status: config.outsideStatus,
      summary: `Scores run ${clock(config.preSessionStart)}–${clock(config.activeEnd)} ET on trading days.`,
    };
  }

  // ---- Data checks: missing or stale data is never scored.
  const m15 = input.m15 ? completedBefore(input.m15, nowMs, M15_MS) : [];
  const h1 = input.h1 ? completedBefore(input.h1, nowMs, H1_MS) : [];
  const lastM15 = m15.at(-1);
  const candlesAsOf = lastM15 ? new Date(Date.parse(lastM15.time) + M15_MS).toISOString() : null;
  result.candlesAsOf = candlesAsOf;
  if (!input.m15 || !input.h1 || m15.length < 120 || h1.length < 30) {
    return { ...result, summary: "Not enough live candle history to score this pair." };
  }
  if (!candlesAsOf || nowMs - Date.parse(candlesAsOf) > config.freshness.candleMaxLagMs) {
    return { ...result, summary: "The latest 15m candles are stale." };
  }
  const quote = input.quote;
  const quoteAge = quote ? nowMs - Date.parse(quote.time) : Number.POSITIVE_INFINITY;
  if (!quote || !quote.tradeable || !(quote.ask > quote.bid) || !(quoteAge <= config.freshness.quoteMaxAgeMs)) {
    return { ...result, summary: quote && !quote.tradeable ? "The broker shows this pair as not tradeable." : "No current bid/ask quote." };
  }

  const pip = pipSizeFor(input.instrument);
  const spread = quote.ask - quote.bid;
  const price = (quote.ask + quote.bid) / 2;
  result.spreadPips = spread / pip;
  const atrM15 = lastAtr(m15);
  const atrH1 = lastAtr(h1);
  if (!atrM15 || !atrH1) return { ...result, summary: "Not enough candles for ATR(14)." };

  // ---- Session ranges (the same windows the chart's AMD shading uses).
  const dayMs = nowMs - (nowMs % DAY_MS);
  const londonOpen = sessionHour(dayMs, 8, LONDON_TIME_ZONE);
  const newYorkOpen = sessionHour(dayMs, 8, NEW_YORK_TIME_ZONE);
  const asia = rangeOf(m15, dayMs, londonOpen);
  const london = rangeOf(m15, londonOpen, Math.min(newYorkOpen, nowMs));

  // ---- Structure clarity (20)
  const h1Read = classifyH1Structure(h1);
  const m15Read = classifyH1Structure(m15.slice(-64));
  const h1Direction = structureDirection(h1Read);
  const m15Direction = structureDirection(m15Read);
  const structurePoints = (h1Direction ? 10 : 0) + (m15Direction ? 6 : 0) + (h1Direction && m15Direction === h1Direction ? 4 : 0);
  const structure: TradabilityFactor = {
    key: "structure",
    label: "Structure",
    points: structurePoints,
    max: 20,
    verified: true,
    note: h1Direction
      ? `1H ${h1Direction}${m15Direction === h1Direction ? ", 15m agrees" : m15Direction ? ", 15m against it" : ", 15m mixed"}`
      : m15Direction ? `1H mixed, 15m ${m15Direction}` : "No clear 1H or 15m structure",
  };

  // ---- Volatility (20): the last 2h vs the same ET clock slots on prior days.
  const ranges = trueRanges(m15);
  const recent = m15.slice(-RECENT_BARS);
  const recentRanges = ranges.slice(-RECENT_BARS);
  const recentMean = recentRanges.reduce((sum, value) => sum + value, 0) / recentRanges.length;
  const slots = new Set(recent.map((bar) => localMinutes(new Date(Date.parse(bar.time)), config.timeZone)));
  const todayStart = Date.parse(recent[0]!.time) - 12 * H1_MS;
  const baselineRanges = m15.flatMap((bar, index) => {
    const open = Date.parse(bar.time);
    return open < todayStart && slots.has(localMinutes(new Date(open), config.timeZone)) ? [ranges[index]!] : [];
  });
  const baseline = baselineRanges.length >= RECENT_BARS * 2 ? median(baselineRanges) : null;
  const volatilityRatio = baseline ? recentMean / baseline : null;
  const volatility: TradabilityFactor = volatilityRatio === null
    ? { key: "volatility", label: "Volatility", points: 0, max: 20, verified: false, note: "No same-hour history to compare against" }
    : {
        key: "volatility",
        label: "Volatility",
        points: volatilityRatio < 0.5 ? 0 : volatilityRatio < 0.75 ? 7 : volatilityRatio < 0.9 ? 13 : volatilityRatio <= 2 ? 20 : volatilityRatio <= 3 ? 12 : 5,
        max: 20,
        verified: true,
        note: `${volatilityRatio.toFixed(2)}× its usual movement for this hour${volatilityRatio > 2 ? " (disorderly)" : ""}`,
      };

  // ---- Room to move (25), in 1H ATRs, before the nearest mapped level.
  const levels: number[] = [];
  const srM15 = computeSupportResistanceLevels(m15, input.instrument);
  const srH1 = computeSupportResistanceLevels(h1, input.instrument);
  for (const sr of [srM15, srH1]) {
    if (!sr) continue;
    levels.push(sr.rangeHigh, sr.rangeLow);
    if (sr.swingHigh !== null) levels.push(sr.swingHigh);
    if (sr.swingLow !== null) levels.push(sr.swingLow);
  }
  for (const range of [asia, london]) if (range) levels.push(range.high, range.low);
  const above = levels.filter((level) => level > price).map((level) => level - price);
  const below = levels.filter((level) => level < price).map((level) => price - level);
  const roomUp = above.length ? Math.min(...above) / atrH1 : null;
  const roomDown = below.length ? Math.min(...below) / atrH1 : null;
  const roomPoints = (atrs: number | null) => (atrs === null ? 25 : atrs >= 1.5 ? 25 : atrs >= 1 ? 18 : atrs >= 0.6 ? 10 : atrs >= 0.3 ? 4 : 0);
  const describeRoom = (atrs: number | null, side: string) => (atrs === null ? `no mapped level ${side}` : `${atrs.toFixed(1)} 1H ATR ${side}`);
  const room: TradabilityFactor = !srM15 && !srH1
    ? { key: "room", label: "Room", points: 0, max: 25, verified: false, note: "Support/resistance could not be read" }
    : h1Direction
      ? (() => {
          const atrs = h1Direction === "bullish" ? roomUp : roomDown;
          return { key: "room", label: "Room", points: roomPoints(atrs), max: 25, verified: true, note: describeRoom(atrs, h1Direction === "bullish" ? "above" : "below") };
        })()
      : (() => {
          const upPoints = roomPoints(roomUp);
          const downPoints = roomPoints(roomDown);
          const up = upPoints >= downPoints;
          return { key: "room", label: "Room", points: Math.max(upPoints, downPoints), max: 25, verified: true, note: `${describeRoom(up ? roomUp : roomDown, up ? "above" : "below")} (no 1H direction)` };
        })();

  // ---- Spread / cost (15): the live spread against current 15m movement.
  const spreadRatio = spread / atrM15;
  const spreadFactor: TradabilityFactor = {
    key: "spread",
    label: "Spread",
    points: spreadRatio <= 0.08 ? 15 : spreadRatio <= 0.12 ? 12 : spreadRatio <= 0.18 ? 8 : spreadRatio <= 0.25 ? 4 : 0,
    max: 15,
    verified: true,
    note: `${(spread / pip).toFixed(1)} pips = ${Math.round(spreadRatio * 100)}% of 15m ATR`,
  };

  // ---- Setup availability (20): a situation forming, never an entry.
  const close = m15.at(-1)!.close;
  const recentHigh = Math.max(...recent.map((bar) => bar.high));
  const recentLow = Math.min(...recent.map((bar) => bar.low));
  const recentMove = close - recent[0]!.open;
  const situations: string[] = [];
  if (h1Direction === "bullish" && recentMove <= -0.5 * atrM15) situations.push("pullback in a 1H uptrend");
  if (h1Direction === "bearish" && recentMove >= 0.5 * atrM15) situations.push("pullback in a 1H downtrend");
  for (const [name, range] of [["London", london], ["Asian", asia]] as const) {
    if (!range) continue;
    if (name === "London" && close > range.high && recent.some((bar) => bar.close > range.high)) situations.push("holding above the London high");
    if (name === "London" && close < range.low && recent.some((bar) => bar.close < range.low)) situations.push("holding below the London low");
    if (recentHigh > range.high && close < range.high - 0.1 * atrM15) situations.push(`swept the ${name} high and came back`);
    if (recentLow < range.low && close > range.low + 0.1 * atrM15) situations.push(`swept the ${name} low and came back`);
  }
  const nearSessionLevel = [asia, london].some((range) => range && (Math.abs(price - range.high) <= 0.5 * atrM15 || Math.abs(price - range.low) <= 0.5 * atrM15));
  const setup: TradabilityFactor = situations.length
    ? { key: "setup", label: "Setup", points: 20, max: 20, verified: true, note: situations[0]! }
    : nearSessionLevel
      ? { key: "setup", label: "Setup", points: 8, max: 20, verified: true, note: "Price near a session high/low" }
      : !asia && !london
        ? { key: "setup", label: "Setup", points: 0, max: 20, verified: false, note: "No Asian or London range to read" }
        : { key: "setup", label: "Setup", points: 0, max: 20, verified: true, note: "Nothing forming yet" };

  const factors = [structure, volatility, room, spreadFactor, setup];
  const rawScore = factors.reduce((sum, factor) => sum + factor.points, 0);
  const scored = { ...result, factors, rawScore };

  // ---- News: block from 15 min before to 15 min after a high-impact release
  // for either currency; then let it settle until spread and movement are normal.
  const { base: baseCurrency, quote: quoteCurrency } = currenciesOf(input.instrument);
  const highImpact = (input.news ?? [])
    .filter((event) => event.impact >= config.news.minImpact && (event.currency === baseCurrency || event.currency === quoteCurrency))
    .map((event) => ({ event, at: Date.parse(event.timestamp) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((left, right) => left.at - right.at);
  const toNews = (event: EconomicCalendarEvent) => ({ title: event.title, currency: event.currency, at: event.timestamp });
  const blocking = highImpact.find(({ at }) => nowMs >= at - config.news.blockBeforeMinutes * 60_000 && nowMs <= at + config.news.blockAfterMinutes * 60_000);
  if (blocking) {
    return {
      ...scored,
      status: "BLOCKED",
      block: "news",
      news: { state: "blocked", event: toNews(blocking.event) },
      summary: `High-impact ${blocking.event.currency} news: ${blocking.event.title} at ${etClock(blocking.event.timestamp)} ET.`,
    };
  }
  const settling = highImpact.find(({ at }) => nowMs > at + config.news.blockAfterMinutes * 60_000 && nowMs <= at + (config.news.blockAfterMinutes + config.news.settleMinutes) * 60_000);
  const settled = spreadRatio <= config.spread.normalAtrRatio && (volatilityRatio === null || volatilityRatio <= 2);
  if (settling && !settled) {
    return {
      ...scored,
      status: "BLOCKED",
      block: "news_settling",
      news: { state: "settling", event: toNews(settling.event) },
      summary: `Settling after ${settling.event.currency} ${settling.event.title}: spread or movement not back to normal yet.`,
    };
  }
  const upcoming = highImpact.find(({ at }) => at > nowMs && at - nowMs <= 6 * H1_MS);
  const news: TradabilityNews = input.news
    ? { state: "clear", event: upcoming ? toNews(upcoming.event) : null }
    : { state: "unavailable", event: null };

  // ---- Spread too wide for the movement: a hard restriction.
  if (spreadRatio > config.spread.blockAtrRatio) {
    return {
      ...scored,
      status: "BLOCKED",
      block: "spread",
      news,
      summary: `Spread ${(spread / pip).toFixed(1)} pips is too wide for current movement.`,
    };
  }

  // Unchecked news can never read as highly tradable.
  const capped = input.news ? rawScore : Math.min(rawScore, config.thresholds.high - 1);
  const status: TradabilityStatus = capped >= config.thresholds.high
    ? "HIGHLY_TRADABLE"
    : capped >= config.thresholds.moderate ? "MODERATELY_TRADABLE" : "LOW_TRADABILITY";
  const unverified = factors.filter((factor) => !factor.verified).map((factor) => factor.label.toLowerCase());
  return {
    ...scored,
    status,
    score: rawScore,
    news,
    summary: [
      input.news ? null : "News calendar unavailable, so news is unchecked.",
      unverified.length ? `Unverified: ${unverified.join(", ")}.` : null,
      upcoming ? `High-impact ${upcoming.event.currency} news at ${etClock(upcoming.event.timestamp)} ET.` : null,
    ].filter(Boolean).join(" ") || "Conditions read from live candles and quotes.",
  };
}

function clock(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour > 12 ? hour - 12 : hour}:${String(minute).padStart(2, "0")}`;
}

export interface TradabilitySnapshot {
  evaluatedAt: string;
  phase: TradabilityPhase;
  session: string;
  /** Calendar read state shared by every pair in this snapshot. */
  newsAvailable: boolean;
  pairs: PairTradability[];
}

/** Sort rank for "Most tradable": scored pairs by score, then blocked, then the rest. */
export function tradabilitySortKey(item: PairTradability | undefined) {
  if (!item) return { group: 4, score: 0 };
  if (item.score !== null) return { group: 0, score: item.score };
  if (item.status === "BLOCKED") return { group: 1, score: item.rawScore ?? 0 };
  if (item.status === "UNAVAILABLE") return { group: 2, score: 0 };
  return { group: 3, score: 0 };
}
