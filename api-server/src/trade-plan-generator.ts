import { randomUUID } from "node:crypto";
import { precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { ANALYZE_V2 } from "../../frontend/src/lib/strategy/analyze-v2/config.js";
import { checkTimeframe } from "../../frontend/src/lib/strategy/analyze-v2/data-quality.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import { readMarketFoundation, type MarketFoundation } from "../../frontend/src/lib/strategy/analyze-v2/foundation.js";
import type { Quote } from "../../frontend/src/lib/strategy/analyze-v2/instrument-math.js";
import { assessNews, assessVolatility, type NewsItem, type NewsRisk } from "../../frontend/src/lib/strategy/analyze-v2/risk.js";
import { readTrend, type TrendDirection, type TrendRead } from "../../frontend/src/lib/strategy/analyze-v2/structure.js";
import type { SrZone } from "../../frontend/src/lib/strategy/analyze-v2/zones.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { TradePlanDirection, TradePlanInput, TradePlanSetupType } from "./trade-plans.js";

/**
 * Trade plan generator: reads D1 / H4 / H1 / M15 and proposes CONDITIONAL
 * BUY and SELL plans — a breakout-and-retest and a support/resistance
 * reversal per side — or NO_VALID_SETUP. A plan is a description of what has
 * to happen before an entry, never an entry itself: the monitor (step 3)
 * confirms it on later completed candles.
 *
 * Structure and zones come from Analyze V2 (SWING: H4 structure, D1
 * context); H1 and M15 are read the same way for local structure. Closed
 * candles only. Every distance is an ATR multiple of the timeframe it is
 * measured on, never a fixed pip count.
 *
 * Pure: the same candles, quote, news and clock always give the same plans.
 */

export const TRADE_PLAN_STRATEGY_VERSION = "trade-plans-v1";

/** Initial operating choices, not fitted values. Change them here. */
export const TRADE_PLAN_CONFIG = {
  /** Zones further than this many H4 ATRs from price are not planned for. */
  maxZoneDistanceH4Atr: 3,
  breakoutRetest: {
    /** Timeframe whose completed close confirms the breakout. */
    breakoutTimeframe: "H1",
    /** The breakout close must clear the zone edge by this many H1 ATRs (noise filter). */
    breakoutCloseH1Atr: 0.25,
    /** Timeframe on which the retest and its hold are judged. */
    retestTimeframe: "M15",
    /** A retest reaches back to within this many H1 ATRs of the broken edge... */
    retestToleranceH1Atr: 0.3,
    /** ...and fails if an M15 close goes this far back through it. */
    retestFailH1Atr: 0.25,
    /** Stop sits this many H1 ATRs past the retest extreme. */
    stopBufferH1Atr: 0.15,
  },
  reversal: {
    /** Timeframe on which rejection and local structure are judged. */
    confirmTimeframe: "M15",
    /** A wick past the zone by up to this many H1 ATRs that closes back inside is a sweep... */
    maxSweepH1Atr: 0.6,
    /** ...and a close further than this through the zone invalidates the reversal. */
    invalidateCloseH1Atr: 0.25,
    stopBufferH1Atr: 0.15,
    /** A sweep that closed outside the zone must be reclaimed within this many M15 candles. */
    reclaimBars: 3,
    /** A rejection candle's wick on the zone side is at least this share of its range. */
    rejectionWickShare: 0.5,
    /** The local high (low) to break is the extreme of this many M15 candles before the turn... */
    structureLookbackBars: 8,
    /** ...and it must break within this many M15 candles, or the turn is dropped. */
    structureBreakBars: 16,
  },
  /** Targets stop this many H1 ATRs short of the opposing zone. */
  targetBufferH1Atr: 0.1,
  /** A stop closer than this many H1 ATRs to the entry is inside normal noise... */
  minStopH1Atr: 0.75,
  /** ...and one further than this many H4 ATRs is too far for the setup. */
  maxStopH4Atr: 3,
  /**
   * A target further than this many H4 ATRs from the entry is beyond what the
   * plan's lifetime can reasonably reach; the target is capped there instead.
   */
  maxTargetH4Atr: 4,
  /** A confirmation older than this that still could not pass the safety checks is dropped. */
  confirmationValidMinutes: 60,
  /** Minimum estimated reward/risk for a plan to be offered (not a proven threshold). */
  minRewardRisk: 1.5,
  /** Trading hours a plan stays valid if nothing confirms it (the weekend close does not count). */
  expiryHours: { BREAKOUT_RETEST: 48, SR_REVERSAL: 24 } as Record<TradePlanSetupType, number>,
  /** Default fractions of the stop distance, used when the user has no risk settings row. */
  maxSpreadStopFraction: 0.15,
  maxSlippageStopFraction: 0.1,
} as const;

export type GeneratorInput = {
  instrument: string;
  candles: { D1?: Candle[]; H4?: Candle[]; H1?: Candle[]; M15?: Candle[] };
  quote: Quote | null;
  /** null when the calendar could not be read. */
  news: NewsItem[] | null;
  now: number;
  maxRiskPercent: number;
  limits?: { maxSpreadStopFraction: number; maxSlippageStopFraction: number; newsBlackoutBeforeMinutes: number; newsBlackoutAfterMinutes: number };
};

export type RejectedCandidate = { direction: TradePlanDirection; setupType: TradePlanSetupType; reason: string };

export type GeneratorResult = {
  analysisId: string;
  instrument: string;
  generatedAt: string;
  strategyVersion: string;
  result: "PLANS" | "NO_VALID_SETUP";
  /** Why there are no plans, when there are none. */
  reason: string | null;
  context: PlanContext | null;
  plans: TradePlanInput[];
  rejected: RejectedCandidate[];
};

type PlanContext = {
  price: number;
  priceSource: "quote" | "last close";
  spreadPrice: number | null;
  atr: { H4: number; H1: number; M15: number | null };
  trend: Record<"D1" | "H4" | "H1" | "M15", TrendDirection | null>;
  marketBias: "Bullish" | "Bearish" | "Neutral";
  h4Evidence: string[];
  d1Evidence: string[];
  consolidation: boolean;
  volatility: string;
  news: NewsRisk;
  candleTimes: Record<string, string | null>;
};

const HOUR = 3_600_000;
const STEP = 15 * 60_000;

/**
 * `hours` of open forex market after `start` (ms). Time while the market is
 * closed (Friday 17:00 to Sunday 17:00 New York) does not count, so a plan
 * made on Friday morning is still alive when the market reopens.
 */
export function addTradingHours(start: number, hours: number) {
  let remaining = hours * HOUR;
  let t = start;
  for (let guard = 0; remaining > 0 && guard < 10_000; guard += 1) {
    if (getForexSessionStatus(new Date(t)).marketOpen) {
      // Never step past an hour boundary: that is where open/closed can change.
      const step = Math.min(STEP, remaining, HOUR - (t % HOUR));
      t += step;
      remaining -= step;
    } else {
      // Closed: jump to the next whole hour (the open is on the hour in New York, and offsets are whole hours).
      t = Math.floor(t / HOUR) * HOUR + HOUR;
    }
  }
  return t;
}

const closedOf = (candles: Candle[] | undefined) => (candles ?? []).filter((candle) => candle.complete !== false);
const trending = (direction: TrendDirection | null) => direction === "UPTREND" || direction === "DOWNTREND";
const biasOf = (direction: TrendDirection | null): PlanContext["marketBias"] =>
  direction === "UPTREND" ? "Bullish" : direction === "DOWNTREND" ? "Bearish" : "Neutral";

/** Zones that still act as resistance for a BUY (above price) or support for a SELL (below). */
function opposingZones(zones: SrZone[], direction: TradePlanDirection, from: number) {
  return zones
    .filter((zone) => zone.status === "ACTIVE" || zone.flipped)
    .filter((zone) => (direction === "BUY" ? zone.low > from : zone.high < from))
    .sort((a, b) => (direction === "BUY" ? a.low - b.low : b.high - a.high));
}

export function generateTradePlans(input: GeneratorInput): GeneratorResult {
  const analysisId = randomUUID();
  const base = {
    analysisId,
    instrument: input.instrument,
    generatedAt: new Date(input.now).toISOString(),
    strategyVersion: TRADE_PLAN_STRATEGY_VERSION,
  };
  const none = (reason: string, context: PlanContext | null = null, rejected: RejectedCandidate[] = []): GeneratorResult =>
    ({ ...base, result: "NO_VALID_SETUP", reason, context, plans: [], rejected });

  const config = ANALYZE_V2.SWING;
  const foundation: MarketFoundation = readMarketFoundation({
    instrument: input.instrument,
    mode: "SWING",
    candles: { H4: input.candles.H4, D1: input.candles.D1 },
    quote: input.quote,
    now: input.now,
  });
  // H4/D1 are checked by the foundation; H1 and M15 drive the setup, so they must be fresh too.
  const finer = [
    ...checkTimeframe("H1", input.candles.H1, "H1", input.now, ANALYZE_V2.NORMAL, true).checks,
    ...checkTimeframe("M15", input.candles.M15, "M15", input.now, ANALYZE_V2.NORMAL, true).checks,
  ].filter((check) => !check.id.endsWith("-history"));
  const failedData = [...foundation.data.checks, ...finer].filter((check) => check.id !== "quote"
    && (check.status === "FAIL" || (check.status === "UNKNOWN" && /freshness|candles/.test(check.id))));
  if (failedData.length) return none(`Market data is not usable: ${failedData.map((check) => check.reason).join(" ")}`);
  const h4 = foundation.primary;
  if (!h4 || !h4.sufficient || !(h4.atr > 0)) return none("Not enough H4 history to read structure.");

  const h1Closed = closedOf(input.candles.H1);
  const m15Closed = closedOf(input.candles.M15);
  if (h1Closed.length < 60) return none("Not enough closed H1 candles to plan a setup.");
  const regime = ANALYZE_V2.NORMAL.regime;
  const h1 = readTrend(input.instrument, "H1", h1Closed, regime);
  const m15: TrendRead | null = m15Closed.length >= 60 ? readTrend(input.instrument, "M15", m15Closed, regime) : null;
  if (!(h1.atr > 0)) return none("H1 volatility could not be measured.");

  const quote = foundation.data.quote.executable;
  const price = foundation.referencePrice ?? h1.close;
  const digits = precisionFor(input.instrument);
  const fmt = (value: number) => value.toFixed(digits);
  const round = (value: number) => Number(value.toFixed(digits));
  const news = assessNews(input.instrument, input.news, input.now, "SWING");
  const volatility = assessVolatility(h1Closed, h1.atr);
  const consolidation = h4.direction === "RANGE" || h1.direction === "RANGE";
  const context: PlanContext = {
    price,
    priceSource: quote ? "quote" : "last close",
    spreadPrice: quote ? quote.ask - quote.bid : null,
    atr: { H4: h4.atr, H1: h1.atr, M15: m15?.atr ?? null },
    trend: { D1: foundation.higher?.direction ?? null, H4: h4.direction, H1: h1.direction, M15: m15?.direction ?? null },
    marketBias: biasOf(foundation.higher?.direction ?? null),
    h4Evidence: h4.evidence,
    d1Evidence: foundation.higher?.evidence ?? [],
    consolidation,
    volatility: volatility.reason,
    news,
    candleTimes: {
      D1: closedOf(input.candles.D1).at(-1)?.time ?? null,
      H4: h4.closeTime,
      H1: h1.closeTime,
      M15: m15?.closeTime ?? null,
      quote: input.quote?.time ?? null,
    },
  };
  if (volatility.status === "FAIL") return none(volatility.reason, context);

  const zones = foundation.zones.filter((zone) => {
    const distance = price > zone.high ? price - zone.high : price < zone.low ? zone.low - price : 0;
    return distance <= TRADE_PLAN_CONFIG.maxZoneDistanceH4Atr * h4.atr;
  });
  const limits = input.limits ?? {
    maxSpreadStopFraction: TRADE_PLAN_CONFIG.maxSpreadStopFraction,
    maxSlippageStopFraction: TRADE_PLAN_CONFIG.maxSlippageStopFraction,
    newsBlackoutBeforeMinutes: 30,
    newsBlackoutAfterMinutes: 30,
  };
  const plans: TradePlanInput[] = [];
  const rejected: RejectedCandidate[] = [];
  const atrH1 = h1.atr;
  const trendNote = (direction: TradePlanDirection) => {
    const want = direction === "BUY" ? "UPTREND" : "DOWNTREND";
    const against = direction === "BUY" ? "DOWNTREND" : "UPTREND";
    if (h4.direction === want && foundation.higher?.direction === want) return "With the H4 and D1 trend.";
    if (h4.direction === against || foundation.higher?.direction === against) return `Against the ${h4.direction === against ? "H4" : "D1"} trend: a counter-trend plan, judged on its own confirmation.`;
    return `H4 is ${h4.direction.toLowerCase()}: no trend support either way.`;
  };

  /** Shared tail for both setup types: target, reward/risk, plan body. */
  const finish = (candidate: {
    direction: TradePlanDirection;
    setupType: TradePlanSetupType;
    zone: SrZone;
    entryZoneLow: number;
    entryZoneHigh: number;
    stop: number;
    targetFrom: number;
    trigger: string;
    confirmation: string[];
    conditions: Array<{ key: string; label: string }>;
    /** Describes the stop, given its final (formatted) price. */
    stopRule: (stop: string) => string;
    invalidation: Record<string, unknown>;
    why: string[];
    extra?: Record<string, unknown>;
  }) => {
    const { direction, setupType } = candidate;
    const target = opposingZones(foundation.zones, direction, candidate.targetFrom)[0];
    if (!target) {
      rejected.push({ direction, setupType, reason: `No ${direction === "BUY" ? "resistance above" : "support below"} the setup to aim for.` });
      return;
    }
    const buffer = TRADE_PLAN_CONFIG.targetBufferH1Atr * atrH1;
    const entryMid = (candidate.entryZoneLow + candidate.entryZoneHigh) / 2;
    const zoneTarget = direction === "BUY" ? target.low - buffer : target.high + buffer;
    const cap = entryMid + (direction === "BUY" ? 1 : -1) * TRADE_PLAN_CONFIG.maxTargetH4Atr * h4.atr;
    const capped = direction === "BUY" ? zoneTarget > cap : zoneTarget < cap;
    const takeProfit = round(capped ? cap : zoneTarget);
    // A structural stop inside normal H1 noise is pushed out to the minimum
    // distance (decided here, before approval — never widened afterwards).
    const minStop = TRADE_PLAN_CONFIG.minStopH1Atr * atrH1;
    const stop = direction === "BUY"
      ? Math.min(candidate.stop, entryMid - minStop, candidate.entryZoneLow - 0.1 * atrH1)
      : Math.max(candidate.stop, entryMid + minStop, candidate.entryZoneHigh + 0.1 * atrH1);
    candidate.stop = stop;
    const risk = Math.abs(entryMid - stop);
    const reward = direction === "BUY" ? takeProfit - entryMid : entryMid - takeProfit;
    if (!(risk > 0) || !(reward > 0)) {
      rejected.push({ direction, setupType, reason: "The next opposing zone leaves no room for a target." });
      return;
    }
    if (risk > TRADE_PLAN_CONFIG.maxStopH4Atr * h4.atr) {
      rejected.push({ direction, setupType, reason: `The structural stop is ${(risk / h4.atr).toFixed(1)} H4 ATR away, over the ${TRADE_PLAN_CONFIG.maxStopH4Atr} ATR limit.` });
      return;
    }
    const spread = context.spreadPrice ?? 0;
    if (spread > limits.maxSpreadStopFraction * risk) {
      rejected.push({ direction, setupType, reason: `The spread is ${Math.round((spread / risk) * 100)}% of the stop distance, over the ${Math.round(limits.maxSpreadStopFraction * 100)}% limit.` });
      return;
    }
    const rewardRisk = (reward - spread) / (risk + spread);
    if (rewardRisk < TRADE_PLAN_CONFIG.minRewardRisk) {
      rejected.push({
        direction, setupType,
        reason: `Estimated reward/risk ${rewardRisk.toFixed(2)} is under ${TRADE_PLAN_CONFIG.minRewardRisk}: the ${direction === "BUY" ? "resistance" : "support"} at ${fmt(direction === "BUY" ? target.low : target.high)} is too close.`,
      });
      return;
    }
    const expiresAt = new Date(addTradingHours(input.now, TRADE_PLAN_CONFIG.expiryHours[setupType])).toISOString();
    const upcoming = news.events.filter((event) => event.impact >= 3 && event.minutesUntil >= 0
      && Date.parse(event.at) <= Date.parse(expiresAt));
    plans.push({
      analysisId,
      instrument: input.instrument,
      direction,
      setupType,
      timeframe: "H1",
      marketBias: context.marketBias,
      trendClassification: `D1 ${context.trend.D1?.toLowerCase() ?? "unknown"} · H4 ${h4.direction.toLowerCase()} · H1 ${h1.direction.toLowerCase()}`,
      entryZoneLow: round(candidate.entryZoneLow),
      entryZoneHigh: round(candidate.entryZoneHigh),
      stopLoss: round(candidate.stop),
      takeProfit,
      rewardRisk: Number(rewardRisk.toFixed(2)),
      maxRiskPercent: input.maxRiskPercent,
      expiresAt,
      strategyVersion: TRADE_PLAN_STRATEGY_VERSION,
      marketDataAt: context.candleTimes.M15 ?? context.candleTimes.H1,
      conditions: candidate.conditions,
      plan: {
        zone: { low: round(candidate.zone.low), high: round(candidate.zone.high), type: candidate.zone.type, relevance: candidate.zone.relevance, reactions: candidate.zone.reactions, sources: candidate.zone.sources, flipped: candidate.zone.flipped },
        entryTrigger: candidate.trigger,
        confirmation: candidate.confirmation,
        stopLossRule: candidate.stopRule(fmt(stop)),
        takeProfitRule: capped
          ? `The next ${direction === "BUY" ? "resistance" : "support"} zone ${fmt(target.low)}–${fmt(target.high)} is beyond ${TRADE_PLAN_CONFIG.maxTargetH4Atr} H4 ATR, so the target is capped there.`
          : `Short of the next ${direction === "BUY" ? "resistance" : "support"} zone ${fmt(target.low)}–${fmt(target.high)} by ${TRADE_PLAN_CONFIG.targetBufferH1Atr} H1 ATR.`,
        targetZone: { low: round(target.low), high: round(target.high) },
        targetCapped: capped,
        // Frozen inputs the confirmation engine judges this plan with; later config changes do not reach approved plans.
        rules: {
          atrH1: atrH1,
          minRewardRisk: TRADE_PLAN_CONFIG.minRewardRisk,
          confirmationValidMinutes: TRADE_PLAN_CONFIG.confirmationValidMinutes,
          ...(setupType === "BREAKOUT_RETEST" ? TRADE_PLAN_CONFIG.breakoutRetest : TRADE_PLAN_CONFIG.reversal),
        },
        positionSizingRule: `Risk ${input.maxRiskPercent}% of equity on the distance from the executable entry to the protective stop; recalculated at confirmation from fresh prices.`,
        spreadSlippage: {
          maxSpreadStopFraction: limits.maxSpreadStopFraction,
          maxSlippageStopFraction: limits.maxSlippageStopFraction,
          rule: `No entry while the spread is over ${Math.round(limits.maxSpreadStopFraction * 100)}% of the stop distance, or if the expected fill slips more than ${Math.round(limits.maxSlippageStopFraction * 100)}% of it.`,
        },
        newsRestrictions: {
          blackoutBeforeMinutes: limits.newsBlackoutBeforeMinutes,
          blackoutAfterMinutes: limits.newsBlackoutAfterMinutes,
          calendar: news.state,
          upcomingHighImpact: upcoming.map((event) => ({ title: event.title, currency: event.currency, at: event.at })),
          rule: news.state === "NEWS_UNKNOWN"
            ? "The calendar could not be read: no entry until it can be."
            : `No new entry from ${limits.newsBlackoutBeforeMinutes} min before to ${limits.newsBlackoutAfterMinutes} min after high-impact ${input.instrument.replace("_", "/")} news.`,
        },
        invalidation: candidate.invalidation,
        expiryRule: `Expires after ${TRADE_PLAN_CONFIG.expiryHours[setupType]} hours of open market if it has not confirmed (the weekend close does not count).`,
        explanation: [...candidate.why, trendNote(direction), context.consolidation ? "Market is ranging on H4 or H1: breakouts fail more often in ranges." : null, news.reason]
          .filter((line): line is string => Boolean(line)),
        ...candidate.extra,
      },
      analysisInputs: {
        config: TRADE_PLAN_CONFIG,
        analyzeV2Version: foundation.version,
        context,
        zones: foundation.zones.map((zone) => ({ low: zone.low, high: zone.high, type: zone.type, status: zone.status, flipped: zone.flipped, relevance: zone.relevance })),
      },
    });
  };

  for (const direction of ["BUY", "SELL"] as const) {
    const up = direction === "BUY";
    const word = up ? "above" : "below";
    const edge = (zone: SrZone) => (up ? zone.high : zone.low);
    const sign = up ? 1 : -1;

    // ── Breakout and retest: an unbroken zone beyond price, or one already broken behind it.
    const ahead = zones
      .filter((zone) => zone.status === "ACTIVE" && (up ? zone.type === "RESISTANCE" : zone.type === "SUPPORT"))
      .sort((a, b) => (up ? a.low - b.low : b.high - a.high))[0];
    const broken = zones
      .filter((zone) => zone.flipped && (up ? zone.high < price : zone.low > price))
      .sort((a, b) => (up ? b.high - a.high : a.low - b.low))[0];
    const breakoutZone = ahead ?? broken;
    if (!breakoutZone) {
      rejected.push({ direction, setupType: "BREAKOUT_RETEST", reason: `No ${up ? "resistance" : "support"} within ${TRADE_PLAN_CONFIG.maxZoneDistanceH4Atr} H4 ATR to break.` });
    } else {
      const br = TRADE_PLAN_CONFIG.breakoutRetest;
      const level = edge(breakoutZone);
      const tolerance = br.retestToleranceH1Atr * atrH1;
      const stop = up
        ? breakoutZone.low - br.stopBufferH1Atr * atrH1
        : breakoutZone.high + br.stopBufferH1Atr * atrH1;
      const already = breakoutZone === broken;
      finish({
        direction,
        setupType: "BREAKOUT_RETEST",
        zone: breakoutZone,
        entryZoneLow: level - tolerance,
        entryZoneHigh: level + tolerance,
        stop,
        targetFrom: up ? breakoutZone.high : breakoutZone.low,
        trigger: `${up ? "Bullish" : "Bearish"} M15 continuation after price retests ${fmt(level)} and holds.`,
        confirmation: [
          `A completed ${br.breakoutTimeframe} candle closes ${word} ${fmt(level)} by at least ${br.breakoutCloseH1Atr} H1 ATR (${fmt(level + sign * br.breakoutCloseH1Atr * atrH1)}).`,
          `Price comes back to within ${br.retestToleranceH1Atr} H1 ATR of ${fmt(level)}.`,
          `No ${br.retestTimeframe} close goes back ${up ? "below" : "above"} ${fmt(level - sign * br.retestFailH1Atr * atrH1)} during the retest.`,
          `A completed M15 candle closes ${up ? "above the retest candle's high" : "below the retest candle's low"} (continuation).`,
          `Reward/risk from the executable entry stays at least ${TRADE_PLAN_CONFIG.minRewardRisk}.`,
          "News blackout, spread and account-risk checks pass.",
        ],
        conditions: [
          { key: "breakout_close", label: `${br.breakoutTimeframe} close ${word} the zone` },
          { key: "breakout_size", label: "Breakout clears the noise threshold" },
          { key: "retest", label: "Price retests the broken level" },
          { key: "retest_holds", label: "The retest holds" },
          { key: "continuation", label: `${up ? "Bullish" : "Bearish"} continuation` },
          { key: "reward_risk", label: "Reward/risk still adequate" },
          { key: "execution_safety", label: "News, spread and risk checks" },
        ],
        stopRule: (final) => `Fixed at ${final} when approved: ${br.stopBufferH1Atr} H1 ATR ${up ? "below" : "above"} the zone, at least ${TRADE_PLAN_CONFIG.minStopH1Atr} H1 ATR from the entry. A retest that trades through it invalidates the plan; it is never moved further away.`,
        invalidation: {
          rules: [
            `A completed ${br.retestTimeframe} close back ${up ? "below" : "above"} ${fmt(level - sign * br.retestFailH1Atr * atrH1)} after the breakout (failed breakout).`,
            `A completed H1 close ${up ? "below" : "above"} ${fmt(up ? breakoutZone.low : breakoutZone.high)} before any breakout.`,
            "The plan expires before confirming.",
          ],
          failLevel: round(level - sign * br.retestFailH1Atr * atrH1),
          zoneFarEdge: round(up ? breakoutZone.low : breakoutZone.high),
        },
        why: [
          already
            ? `${fmt(breakoutZone.low)}–${fmt(breakoutZone.high)} was ${up ? "resistance" : "support"} and price has already closed through it; the plan waits for a retest from the other side.`
            : `${up ? "Resistance" : "Support"} at ${fmt(breakoutZone.low)}–${fmt(breakoutZone.high)} (${breakoutZone.reactions} swing reaction${breakoutZone.reactions === 1 ? "" : "s"}, ${breakoutZone.relevance.toLowerCase().replace("_", " ")}), ${breakoutZone.distanceAtr.toFixed(1)} H4 ATR from price.`,
          "A breakout alone is not a signal: the plan needs the retest to hold and a continuation candle.",
        ],
        extra: { breakoutLevel: round(level), breakoutAlreadyClosed: already },
      });
    }

    // ── Support/resistance reversal: the nearest zone price would bounce from.
    const reversalZone = zones
      .filter((zone) => (zone.status === "ACTIVE" || zone.flipped) && (up ? zone.type === "SUPPORT" : zone.type === "RESISTANCE"))
      .sort((a, b) => (up ? b.high - a.high : a.low - b.low))[0];
    if (!reversalZone) {
      rejected.push({ direction, setupType: "SR_REVERSAL", reason: `No ${up ? "support below" : "resistance above"} price within ${TRADE_PLAN_CONFIG.maxZoneDistanceH4Atr} H4 ATR.` });
    } else {
      const rv = TRADE_PLAN_CONFIG.reversal;
      const farEdge = up ? reversalZone.low : reversalZone.high;
      const sweepLimit = farEdge - sign * rv.maxSweepH1Atr * atrH1;
      const stop = sweepLimit - sign * rv.stopBufferH1Atr * atrH1;
      finish({
        direction,
        setupType: "SR_REVERSAL",
        zone: reversalZone,
        entryZoneLow: reversalZone.low,
        entryZoneHigh: reversalZone.high,
        stop,
        targetFrom: up ? reversalZone.high : reversalZone.low,
        trigger: `A ${up ? "bullish" : "bearish"} M15 structure break after price rejects ${fmt(reversalZone.low)}–${fmt(reversalZone.high)}.`,
        confirmation: [
          `Price reaches the ${up ? "support" : "resistance"} zone ${fmt(reversalZone.low)}–${fmt(reversalZone.high)}.`,
          `A completed ${rv.confirmTimeframe} candle rejects it (${up ? "long lower wick, close back up" : "long upper wick, close back down"}), or sweeps ${up ? "below" : "above"} ${fmt(farEdge)} by at most ${rv.maxSweepH1Atr} H1 ATR and closes back inside.`,
          "If it swept, price reclaims the zone on a completed close — a sweep alone never triggers.",
          `M15 breaks its last ${up ? "lower high" : "higher low"} (local structure turns ${up ? "up" : "down"}).`,
          `Reward/risk from the executable entry stays at least ${TRADE_PLAN_CONFIG.minRewardRisk}.`,
          "News blackout, spread and account-risk checks pass.",
        ],
        conditions: [
          { key: "approach", label: `Price reaches the ${up ? "support" : "resistance"} zone` },
          { key: "rejection_or_sweep", label: "Rejection or liquidity sweep" },
          { key: "reclaim", label: "Zone reclaimed (if swept)" },
          { key: "local_structure", label: `M15 structure turns ${up ? "up" : "down"}` },
          { key: "stop_placement", label: "Stop beyond the rejection" },
          { key: "reward_risk", label: "Reward/risk still adequate" },
          { key: "execution_safety", label: "News, spread and risk checks" },
        ],
        stopRule: (final) => `Fixed at ${final} when approved: beyond the deepest allowed sweep (${rv.maxSweepH1Atr} H1 ATR past the zone) plus ${rv.stopBufferH1Atr} H1 ATR. A sweep that reaches it invalidates the plan; it is never moved further away.`,
        invalidation: {
          rules: [
            `A completed M15 close ${up ? "below" : "above"} ${fmt(farEdge - sign * rv.invalidateCloseH1Atr * atrH1)} (the zone gave way).`,
            `A sweep further than ${rv.maxSweepH1Atr} H1 ATR past ${fmt(farEdge)}.`,
            "The plan expires before confirming.",
          ],
          failLevel: round(farEdge - sign * rv.invalidateCloseH1Atr * atrH1),
          sweepLimit: round(sweepLimit),
        },
        why: [
          `${up ? "Support" : "Resistance"} at ${fmt(reversalZone.low)}–${fmt(reversalZone.high)} (${reversalZone.reactions} swing reaction${reversalZone.reactions === 1 ? "" : "s"}, ${reversalZone.relevance.toLowerCase().replace("_", " ")}${reversalZone.flipped ? ", old " + (up ? "resistance" : "support") + " that flipped" : ""}), ${reversalZone.distanceAtr.toFixed(1)} H4 ATR from price.`,
          "Reaching the zone is not a signal: the plan needs a rejection and an M15 structure turn.",
        ],
      });
    }
  }

  if (!plans.length) return none(`No setup qualified. ${rejected.map((item) => `${item.direction} ${item.setupType.replace("_", " ").toLowerCase()}: ${item.reason}`).join(" ")}`, context, rejected);
  // At most one plan per direction: the higher estimated reward/risk.
  const best = (["BUY", "SELL"] as const)
    .map((direction) => plans.filter((plan) => plan.direction === direction).sort((a, b) => (b.rewardRisk ?? 0) - (a.rewardRisk ?? 0)))
    .flatMap((group) => {
      for (const extra of group.slice(1)) rejected.push({ direction: extra.direction, setupType: extra.setupType, reason: "A stronger plan in the same direction was kept." });
      return group.slice(0, 1);
    });
  return { ...base, result: "PLANS", reason: null, context, plans: best, rejected };
}
