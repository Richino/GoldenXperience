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
 * reports a directional bias, never an entry or a stop, and it does not feed Analyze or
 * any strategy. It scores how workable each pair's conditions are right now,
 * out of 100:
 *
 *   structure clarity   20  confirmed M15 swing structure, with H1 context
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
 * Normal qualification and ranking below reuse these factor readings, with
 * explicit hard gates and caution states. Thresholds are provisional, configurable cut-offs, not validated
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
  selection?: MarketQualification;
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
  preSessionStart: 6 * 60 + 30,
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
  }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
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

function readSessionFactors(
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
  if ([...m15, ...h1].some(b => ![b.open, b.high, b.low, b.close].every(v => Number.isFinite(v) && v > 0) || b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close))) {
    return { ...result, summary: "Invalid broker candle values." };
  }
  const lastH1 = h1.at(-1);
  if (!candlesAsOf || nowMs - Date.parse(candlesAsOf) > config.freshness.candleMaxLagMs
    || !lastH1 || nowMs - Date.parse(lastH1.time) - H1_MS > H1_MS + config.freshness.candleMaxLagMs) {
    return { ...result, summary: "The latest 15m candles are stale." };
  }
  const quote = input.quote;
  const quoteAge = quote ? nowMs - Date.parse(quote.time) : Number.POSITIVE_INFINITY;
  if (!quote || !quote.tradeable || !(quote.bid > 0) || !(quote.ask > quote.bid) || !(quoteAge >= -5_000 && quoteAge <= config.freshness.quoteMaxAgeMs)) {
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
  const structurePoints = (h1Direction ? 4 : 0) + (m15Direction ? 12 : 0) + (h1Direction && m15Direction === h1Direction ? 4 : 0);
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
  const roomPoints = (atrs: number | null) => (atrs === null ? 10 : atrs >= 1.5 ? 25 : atrs >= 1 ? 18 : atrs >= 0.6 ? 10 : atrs >= 0.3 ? 4 : 0);
  const describeRoom = (atrs: number | null, side: string) => (atrs === null ? `no mapped level ${side}` : `${atrs.toFixed(1)} 1H ATR ${side}`);
  const room: TradabilityFactor = !srM15 && !srH1
    ? { key: "room", label: "Room", points: 0, max: 25, verified: false, note: "Support/resistance could not be read" }
    : m15Direction
      ? (() => {
          const atrs = m15Direction === "bullish" ? roomUp : roomDown;
          return { key: "room", label: "Room", points: roomPoints(atrs), max: 25, verified: true, note: describeRoom(atrs, m15Direction === "bullish" ? "above" : "below") };
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
  const priorLondon = rangeOf(m15, londonOpen, Math.min(newYorkOpen, Date.parse(recent[0]!.time)));
  for (const [name, range] of [["London", priorLondon], ["Asian", asia]] as const) {
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
  if (item.selection) return { group: item.selection.status === "QUALIFIED" ? 0 : item.selection.status === "CAUTION" ? 1 : 2, score: item.selection.rankScore };
  if (item.score !== null) return { group: 0, score: item.score };
  if (item.status === "BLOCKED") return { group: 1, score: item.rawScore ?? 0 };
  if (item.status === "UNAVAILABLE") return { group: 2, score: 0 };
  return { group: 3, score: 0 };
}

export const MARKET_SELECTION_VERSION = "normal-morning-v1";
export type MarketDirection = "UPTREND" | "DOWNTREND" | "RANGE" | "TRANSITION" | "UNCLEAR";
export interface MarketSelectionPolicy {
  objectivePips: number;
  minAtrObjectiveRatio: number;
  minRecentRangeObjectiveRatio: number;
  maxVolatilityRatio: number;
  maxSpreadObjectiveRatio: number;
  cautionSpreadAtrRatio: number;
  minOpposingRoomObjectiveRatio: number;
  requireNews: boolean;
  cautionNewsMinutes: number;
  minRankScore: number;
  weights: Record<TradabilityFactorKey, number>;
}
export const MARKET_SELECTION_POLICY: MarketSelectionPolicy = {
  objectivePips: 15,
  minAtrObjectiveRatio: 0.15,
  minRecentRangeObjectiveRatio: 0.6,
  maxVolatilityRatio: 3,
  maxSpreadObjectiveRatio: 0.15,
  cautionSpreadAtrRatio: 0.2,
  minOpposingRoomObjectiveRatio: 0.5,
  requireNews: true,
  cautionNewsMinutes: 60,
  minRankScore: 55,
  // One weight per existing factor; correlated volatility measurements are
  // gates/context, not additional independent points.
  weights: { structure: 30, volatility: 20, room: 25, spread: 20, setup: 5 },
};
export interface MarketLevel {
  name: string;
  price: number;
  context: "approaching" | "swept/rejected" | "accepted beyond" | "reference";
}
export interface MarketQualification {
  referencePrice: number | null;
  status: "QUALIFIED" | "CAUTION" | "REJECTED";
  dataFailure: boolean;
  direction: MarketDirection;
  h1Direction: MarketDirection;
  primaryTimeframe: "M15";
  rankScore: number;
  reasons: string[];
  cautions: string[];
  atrPips: number | null;
  recentRangePips: number | null;
  realizedVolatilityPips: number | null;
  sessionRangePips: number | null;
  opposingRoomPips: number | null;
  levels: MarketLevel[];
  h1AsOf: string | null;
  news: { state: "KNOWN" | "UNKNOWN"; events: Array<{ title: string; currency: string; impact: number; at: string; minutesAway: number; overlapsWindow: boolean }> };
  explanation: string;
  policy: MarketSelectionPolicy;
}

export function classifySelectionStructure(candles: Candle[]): MarketDirection {
  const read = classifyH1Structure(candles);
  if (read.intact && read.direction === "bullish") return "UPTREND";
  if (read.intact && read.direction === "bearish") return "DOWNTREND";
  const highs = read.swings.highs.slice(-2);
  const lows = read.swings.lows.slice(-2);
  if (highs.length < 2 || lows.length < 2) return "UNCLEAR";
  const close = candles.at(-1)?.close ?? 0;
  return highs[1]!.price <= highs[0]!.price && lows[1]!.price >= lows[0]!.price && close <= highs[1]!.price && close >= lows[1]!.price ? "RANGE" : "TRANSITION";
}

/** Shared by Home, Markets and the pair picker. Normal uses M15, with H1 context. */
export function computeSessionTradability(
  input: TradabilityInput,
  config: SessionTradabilityConfig = NY_TRADABILITY_CONFIG,
  policy: MarketSelectionPolicy = MARKET_SELECTION_POLICY,
): PairTradability {
  const read = readSessionFactors(input, config);
  const now = input.now.getTime();
  const m15 = completedBefore(input.m15 ?? [], now, M15_MS).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const h1 = completedBefore(input.h1 ?? [], now, H1_MS).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const direction = classifySelectionStructure(m15.slice(-64));
  const h1Direction = classifySelectionStructure(h1);
  const pip = pipSizeFor(input.instrument);
  const atr = lastAtr(m15);
  const recent = m15.slice(-RECENT_BARS);
  const recentRange = recent.length ? Math.max(...recent.map(b => b.high)) - Math.min(...recent.map(b => b.low)) : null;
  const realized = recent.length > 1 ? Math.sqrt(recent.slice(1).reduce((sum, b, i) => sum + (b.close - recent[i]!.close) ** 2, 0)) / pip : null;
  const levels: MarketLevel[] = [];
  const price = input.quote ? (input.quote.bid + input.quote.ask) / 2 : m15.at(-1)?.close ?? 0;
  const day = now - now % DAY_MS;
  const londonOpen = sessionHour(day, 8, LONDON_TIME_ZONE);
  const asia = rangeOf(m15, day, Math.min(londonOpen, now));
  const london = rangeOf(m15, londonOpen, Math.min(sessionHour(day, 8, NEW_YORK_TIME_ZONE), now));
  const previous = rangeOf(m15, day - DAY_MS, day);
  for (const [name, range] of [["Asia", asia], ["London so far", london], ["Previous UTC day", previous]] as const) {
    if (range) for (const [side, level] of [["high", range.high], ["low", range.low]] as const) levels.push({ name: `${name} ${side}`, price: level, context: "reference" });
  }
  for (const [tf, bars] of [["M15", m15], ["H1", h1]] as const) {
    const sr = computeSupportResistanceLevels(bars, input.instrument);
    if (sr) for (const [name, level] of Object.entries(sr)) if (name !== "current" && level !== null) levels.push({ name: `${tf} ${name}`, price: level, context: "reference" });
  }
  const swings = classifyH1Structure(m15.slice(-64)).swings;
  for (const [side, points] of [["highs", swings.highs], ["lows", swings.lows]] as const) {
    const last = points.at(-1);
    if (last && points.slice(0, -1).some(p => Math.abs(p.price - last.price) <= (atr ?? pip) * 0.1)) levels.push({ name: `Equal ${side} (0.1 ATR tolerance)`, price: last.price, context: "reference" });
  }
  // Event tests compare the last completed bar to PRE-EXISTING levels. A London
  // extreme including that same bar cannot count as its own sweep/breakout.
  const last = m15.at(-1);
  if (last && atr) for (const level of levels) {
    if (level.name.startsWith("London")) continue;
    const upper = /high|High/.test(level.name);
    if (upper && last.high > level.price && last.close < level.price || !upper && last.low < level.price && last.close > level.price) level.context = "swept/rejected";
    else if (upper && last.close > level.price + atr * 0.1 && (m15.at(-2)?.close ?? 0) > level.price || !upper && last.close < level.price - atr * 0.1 && (m15.at(-2)?.close ?? Infinity) < level.price) level.context = "accepted beyond";
    else if (Math.abs(price - level.price) <= atr * 0.5) level.context = "approaching";
  }
  const opposing = levels.filter(l => direction === "UPTREND" ? l.price > price : direction === "DOWNTREND" ? l.price < price : false).map(l => Math.abs(l.price - price) / pip);
  const room = opposing.length ? Math.min(...opposing) : null;
  const currencies = Object.values(currenciesOf(input.instrument));
  const events = (input.news ?? []).filter(e => e.impact >= config.news.minImpact && currencies.includes(e.currency) && Number.isFinite(Date.parse(e.timestamp)))
    .map(e => ({ title: e.title, currency: e.currency, impact: e.impact, at: e.timestamp, minutesAway: (Date.parse(e.timestamp) - now) / 60_000,
      overlapsWindow: Date.parse(e.timestamp) >= sessionHour(day, 8, NEW_YORK_TIME_ZONE) && Date.parse(e.timestamp) < sessionHour(day, 11, NEW_YORK_TIME_ZONE) }))
    .filter(e => e.minutesAway >= -30 && e.minutesAway <= 6 * 60).sort((a, b) => a.minutesAway - b.minutesAway);
  const reasons: string[] = [];
  const cautions: string[] = [];
  const dataFailure = read.status === "UNAVAILABLE" || (input.news === null && policy.requireNews);
  if (read.status === "UNAVAILABLE" || read.status === "BLOCKED" || read.phase === "outside") reasons.push(read.summary);
  if (input.news === null && policy.requireNews) reasons.push("Required news risk data is UNKNOWN.");
  if (input.news === null && !policy.requireNews) cautions.push("News risk is UNKNOWN under the configured optional-calendar policy.");
  if (!reasons.length || read.factors.length) {
    if (direction === "UNCLEAR" || direction === "RANGE") reasons.push(`Normal trend mode requires confirmed M15 swings; structure is ${direction}.`);
    if (direction === "TRANSITION") cautions.push("M15 structure is transitioning.");
    if ((direction === "UPTREND" && h1Direction === "DOWNTREND") || (direction === "DOWNTREND" && h1Direction === "UPTREND")) cautions.push("H1 structure opposes M15.");
    if (!atr || atr / pip < policy.objectivePips * policy.minAtrObjectiveRatio || recentRange === null || recentRange / pip < policy.objectivePips * policy.minRecentRangeObjectiveRatio) reasons.push("Insufficient observed movement relative to the 15-pip objective.");
    const volatility = read.factors.find(f => f.key === "volatility");
    if (volatility && !volatility.verified) reasons.push("Same-hour volatility baseline is unavailable.");
    const volRatio = volatility ? Number.parseFloat(volatility.note) : NaN;
    if (volRatio > policy.maxVolatilityRatio) cautions.push("Movement is unusually unstable relative to this instrument's history.");
    if (read.spreadPips !== null && read.spreadPips > policy.objectivePips * policy.maxSpreadObjectiveRatio) reasons.push("Execution cost exceeds the configured fraction of the objective.");
    if (read.spreadPips !== null && atr && read.spreadPips / (atr / pip) > policy.cautionSpreadAtrRatio) cautions.push("Spread consumes a large share of current M15 movement.");
    if (room !== null && room < policy.objectivePips * policy.minOpposingRoomObjectiveRatio) cautions.push("Nearby opposing structure leaves limited measured room.");
    if (room === null) cautions.push("No opposing level is mapped; available room is unverified.");
    if (events.some(e => e.minutesAway > config.news.blockBeforeMinutes && e.minutesAway <= policy.cautionNewsMinutes)) cautions.push("Upcoming high-impact news within the caution window.");
  }
  const rankScore = Math.round(read.factors.reduce((sum, f) => sum + (f.verified ? f.points / f.max * policy.weights[f.key] : 0), 0) * 100) / 100;
  if (!reasons.length && rankScore < policy.minRankScore) cautions.push("Suitability score is below the configured shortlist minimum.");
  const status = reasons.length ? "REJECTED" : cautions.length ? "CAUTION" : "QUALIFIED";
  const explanation = reasons[0] ?? cautions[0] ?? `M15 ${direction === "UPTREND" ? "higher highs / higher lows" : "lower highs / lower lows"}; H1 ${h1Direction.toLowerCase()}. Movement and costs pass.`;
  return { ...read, selection: { referencePrice: input.quote ? price : null, status, dataFailure, direction, h1Direction, primaryTimeframe: "M15", rankScore, reasons, cautions,
    atrPips: atr ? atr / pip : null, recentRangePips: recentRange === null ? null : recentRange / pip, realizedVolatilityPips: realized,
    sessionRangePips: london ? (london.high - london.low) / pip : null, opposingRoomPips: room, levels,
    h1AsOf: h1.at(-1) ? new Date(Date.parse(h1.at(-1)!.time) + H1_MS).toISOString() : null,
    news: { state: input.news === null ? "UNKNOWN" : "KNOWN", events }, explanation, policy } };
}

export function rankQualifiedMarkets(pairs: PairTradability[], limit = 5) {
  return [...new Map(pairs.map(p => [p.instrument, p])).values()].filter(p => p.selection?.status === "QUALIFIED")
    .sort((a, b) => b.selection!.rankScore - a.selection!.rankScore || a.instrument.localeCompare(b.instrument)).slice(0, Math.min(5, Math.max(0, limit)));
}
