import { randomUUID } from "node:crypto";
import { precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { ANALYZE_V2 } from "../../frontend/src/lib/strategy/analyze-v2/config.js";
import { checkTimeframe } from "../../frontend/src/lib/strategy/analyze-v2/data-quality.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import { readMarketFoundation, type MarketFoundation } from "../../frontend/src/lib/strategy/analyze-v2/foundation.js";
import type { Quote } from "../../frontend/src/lib/strategy/analyze-v2/instrument-math.js";
import { assessNews, assessVolatility, type NewsItem, type NewsRisk } from "../../frontend/src/lib/strategy/analyze-v2/risk.js";
import { readTrend, type TrendDirection } from "../../frontend/src/lib/strategy/analyze-v2/structure.js";
import type { SrZone } from "../../frontend/src/lib/strategy/analyze-v2/zones.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { TradePlanDirection, TradePlanInput, TradePlanSetupType } from "./trade-plans.js";

/**
 * Trade plan generator — SWING ONLY (2–5 day holds). Reads D1 / H4 / H1 and
 * proposes CONDITIONAL BUY and SELL plans — a breakout-and-retest and a
 * support/resistance reversal per side — or NO_VALID_SETUP. A plan describes
 * what has to happen before an entry, never an entry itself: the monitor
 * confirms it on later completed candles.
 *
 * Structure and zones come from Analyze V2 (SWING: H4 structure, D1
 * context). Breakouts are judged on H4 closes; retests, rejections and the
 * structure turn on H1 closes. Every distance is a multiple of the H4 ATR
 * (targets: the D1 ATR), never a fixed pip count, so stops sit outside
 * multi-day noise and targets are sized for days, not hours.
 *
 * Pure: the same candles, quote, news and clock always give the same plans.
 */

export const TRADE_PLAN_STRATEGY_VERSION = "trade-plans-swing-v1";

/** Initial operating choices, not fitted values. Change them here. "ATR" means the H4 ATR. */
export const TRADE_PLAN_CONFIG = {
  style: "SWING",
  /** The ATR every distance below is measured in. */
  atrTimeframe: "H4",
  /** Zones further than this many H4 ATRs from price are not planned for. */
  maxZoneDistanceAtr: 4,
  breakoutRetest: {
    /** Timeframe whose completed close confirms the breakout. */
    breakoutTimeframe: "H4",
    /** The breakout close must clear the zone edge by this many ATRs (noise filter). */
    breakoutCloseAtr: 0.25,
    /** Timeframe on which the retest, its hold and the continuation are judged. */
    retestTimeframe: "H1",
    /** A retest reaches back to within this many ATRs of the broken edge... */
    retestToleranceAtr: 0.3,
    /** ...and fails if a close goes this far back through it. */
    retestFailAtr: 0.3,
    /** Stop sits this many ATRs past the zone. */
    stopBufferAtr: 0.2,
    /** After the breakout close, the retest must come within this many retest-timeframe candles, or the plan is MISSED. */
    retestWindowBars: 24,
    /** After the retest, the continuation close must come within this many candles, or the attempt fails. */
    continuationWindowBars: 12,
    /** Breakout attempts the plan allows before it is invalidated (1 = no retry). */
    maxBreakoutAttempts: 1,
    /** The entry may be at most this many ATRs past the entry zone; further is MISSED, never chased. */
    maxEntryDeviationAtr: 0.5,
  },
  reversal: {
    /** Timeframe on which rejection, reclaim and the structure turn are judged. */
    confirmTimeframe: "H1",
    /** A wick past the zone by up to this many ATRs that closes back inside is a sweep... */
    maxSweepAtr: 0.5,
    /** ...and a close further than this through the zone invalidates the reversal. */
    invalidateCloseAtr: 0.3,
    stopBufferAtr: 0.2,
    /** A sweep that closed outside the zone must be reclaimed within this many candles. */
    reclaimBars: 3,
    /** A rejection candle's wick on the zone side is at least this share of its range. */
    rejectionWickShare: 0.5,
    /** The local high (low) to break is the extreme of this many candles before the turn... */
    structureLookbackBars: 12,
    /** ...and it must break within this many candles, or the turn counts as a failed attempt. */
    structureBreakBars: 24,
    /** Rejections or sweeps that may fail before the plan is invalidated. */
    maxAttempts: 2,
    /** The entry may be at most this many ATRs past the entry zone; further is MISSED, never chased. */
    maxEntryDeviationAtr: 0.5,
  },
  /** Targets stop this many ATRs short of the opposing zone. */
  targetBufferAtr: 0.1,
  /** A stop closer than this many ATRs to the entry is inside multi-day noise... */
  minStopAtr: 1,
  /** ...and one further than this many ATRs is too far for the setup. */
  maxStopAtr: 3,
  /** A target further than this many D1 ATRs is beyond a 2–5 day hold; it is capped there. */
  maxTargetD1Atr: 3,
  /** A confirmation older than this that still could not pass the safety checks is dropped. */
  confirmationValidMinutes: 240,
  /** Minimum estimated reward/risk for a plan to be offered (not a proven threshold). */
  minRewardRisk: 1.5,
  /** Open-market hours a plan has to trigger (the weekend close does not count). */
  triggerTradingHours: 72,
  /** Planned holding time once in the trade. */
  maxHoldTradingDays: 5,
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
  atr: { D1: number; H4: number; H1: number };
  trend: Record<"D1" | "H4" | "H1", TrendDirection | null>;
  marketBias: "Bullish" | "Bearish" | "Neutral";
  h4Evidence: string[];
  d1Evidence: string[];
  consolidation: boolean;
  volatility: string;
  news: NewsRisk;
  candleTimes: Record<string, string | null>;
  /** Nearest live support/resistance zones (for summaries; plans pick from these). */
  zones: Array<{ low: number; high: number; type: string; relevance: string; distanceAtr: number }>;
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
  const cfg = TRADE_PLAN_CONFIG;

  const foundation: MarketFoundation = readMarketFoundation({
    instrument: input.instrument,
    mode: "SWING",
    candles: { H4: input.candles.H4, D1: input.candles.D1 },
    quote: input.quote,
    now: input.now,
  });
  // H4/D1 are checked by the foundation; H1 drives the confirmation, so it must be fresh too.
  const h1Checks = checkTimeframe("H1", input.candles.H1, "H1", input.now, ANALYZE_V2.SWING, true).checks
    .filter((check) => !check.id.endsWith("-history"));
  const failedData = [...foundation.data.checks, ...h1Checks].filter((check) => check.id !== "quote"
    && (check.status === "FAIL" || (check.status === "UNKNOWN" && /freshness|candles/.test(check.id))));
  if (failedData.length) return none(`Market data is not usable: ${failedData.map((check) => check.reason).join(" ")}`);
  const h4 = foundation.primary;
  if (!h4 || !h4.sufficient || !(h4.atr > 0)) return none("Not enough H4 history to read structure.");
  const h4Closed = closedOf(input.candles.H4);

  const h1Closed = closedOf(input.candles.H1);
  if (h1Closed.length < 60) return none("Not enough closed H1 candles to plan a setup.");
  const h1 = readTrend(input.instrument, "H1", h1Closed, ANALYZE_V2.NORMAL.regime);
  const atr = h4.atr;
  // The D1 ATR sizes the target; without D1 history, five H4 candles stand in for a day.
  const atrD1 = foundation.higher?.atr && foundation.higher.atr > 0 ? foundation.higher.atr : 5 * atr;

  const quote = foundation.data.quote.executable;
  const price = foundation.referencePrice ?? h4.close;
  const digits = precisionFor(input.instrument);
  const fmt = (value: number) => value.toFixed(digits);
  const round = (value: number) => Number(value.toFixed(digits));
  const news = assessNews(input.instrument, input.news, input.now, "SWING");
  const volatility = assessVolatility(h4Closed, atr);
  const consolidation = h4.direction === "RANGE";
  const context: PlanContext = {
    price,
    priceSource: quote ? "quote" : "last close",
    spreadPrice: quote ? quote.ask - quote.bid : null,
    atr: { D1: atrD1, H4: atr, H1: h1.atr },
    trend: { D1: foundation.higher?.direction ?? null, H4: h4.direction, H1: h1.direction },
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
      quote: input.quote?.time ?? null,
    },
    zones: foundation.zones
      .filter((zone) => zone.status === "ACTIVE" || zone.flipped)
      .sort((a, b) => a.distanceAtr - b.distanceAtr)
      .slice(0, 10)
      .map((zone) => ({ low: round(zone.low), high: round(zone.high), type: zone.type, relevance: zone.relevance, distanceAtr: Number(zone.distanceAtr.toFixed(2)) })),
  };
  if (volatility.status === "FAIL") return none(volatility.reason, context);

  const zones = foundation.zones.filter((zone) => {
    const distance = price > zone.high ? price - zone.high : price < zone.low ? zone.low - price : 0;
    return distance <= cfg.maxZoneDistanceAtr * atr;
  });
  const limits = input.limits ?? {
    maxSpreadStopFraction: cfg.maxSpreadStopFraction,
    maxSlippageStopFraction: cfg.maxSlippageStopFraction,
    newsBlackoutBeforeMinutes: 30,
    newsBlackoutAfterMinutes: 30,
  };
  const plans: TradePlanInput[] = [];
  const rejected: RejectedCandidate[] = [];
  const trendNote = (direction: TradePlanDirection) => {
    const want = direction === "BUY" ? "UPTREND" : "DOWNTREND";
    const against = direction === "BUY" ? "DOWNTREND" : "UPTREND";
    if (h4.direction === want && foundation.higher?.direction === want) return "With the H4 and D1 trend.";
    if (h4.direction === against || foundation.higher?.direction === against) return `Against the ${h4.direction === against ? "H4" : "D1"} trend: a counter-trend plan, judged on its own confirmation.`;
    return `H4 is ${h4.direction.toLowerCase()}: no trend support either way.`;
  };

  /** Shared tail for both setup types: stop, target, reward/risk, plan body. */
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
    const entryMid = (candidate.entryZoneLow + candidate.entryZoneHigh) / 2;
    const buffer = cfg.targetBufferAtr * atr;
    const zoneTarget = direction === "BUY" ? target.low - buffer : target.high + buffer;
    const cap = entryMid + (direction === "BUY" ? 1 : -1) * cfg.maxTargetD1Atr * atrD1;
    const capped = direction === "BUY" ? zoneTarget > cap : zoneTarget < cap;
    const takeProfit = round(capped ? cap : zoneTarget);
    // A structural stop inside multi-day noise is pushed out to the minimum
    // distance (decided here, before approval — never widened afterwards).
    const minStop = cfg.minStopAtr * atr;
    const stop = direction === "BUY"
      ? Math.min(candidate.stop, entryMid - minStop, candidate.entryZoneLow - 0.1 * atr)
      : Math.max(candidate.stop, entryMid + minStop, candidate.entryZoneHigh + 0.1 * atr);
    const risk = Math.abs(entryMid - stop);
    const reward = direction === "BUY" ? takeProfit - entryMid : entryMid - takeProfit;
    if (!(risk > 0) || !(reward > 0)) {
      rejected.push({ direction, setupType, reason: "The next opposing zone leaves no room for a target." });
      return;
    }
    if (risk > cfg.maxStopAtr * atr) {
      rejected.push({ direction, setupType, reason: `The structural stop is ${(risk / atr).toFixed(1)} H4 ATR away, over the ${cfg.maxStopAtr} ATR limit.` });
      return;
    }
    const spread = context.spreadPrice ?? 0;
    if (spread > limits.maxSpreadStopFraction * risk) {
      rejected.push({ direction, setupType, reason: `The spread is ${Math.round((spread / risk) * 100)}% of the stop distance, over the ${Math.round(limits.maxSpreadStopFraction * 100)}% limit.` });
      return;
    }
    const rewardRisk = (reward - spread) / (risk + spread);
    if (rewardRisk < cfg.minRewardRisk) {
      rejected.push({
        direction, setupType,
        reason: `Estimated reward/risk ${rewardRisk.toFixed(2)} is under ${cfg.minRewardRisk}: the ${direction === "BUY" ? "resistance" : "support"} at ${fmt(direction === "BUY" ? target.low : target.high)} is too close for a swing.`,
      });
      return;
    }
    const expiresAt = new Date(addTradingHours(input.now, cfg.triggerTradingHours)).toISOString();
    const upcoming = news.events.filter((event) => event.impact >= 3 && event.minutesUntil >= 0
      && Date.parse(event.at) <= Date.parse(expiresAt));
    plans.push({
      analysisId,
      instrument: input.instrument,
      direction,
      setupType,
      timeframe: "H4",
      marketBias: context.marketBias,
      trendClassification: `D1 ${context.trend.D1?.toLowerCase() ?? "unknown"} · H4 ${h4.direction.toLowerCase()} · H1 ${h1.direction.toLowerCase()}`,
      entryZoneLow: round(candidate.entryZoneLow),
      entryZoneHigh: round(candidate.entryZoneHigh),
      stopLoss: round(stop),
      takeProfit,
      rewardRisk: Number(rewardRisk.toFixed(2)),
      maxRiskPercent: input.maxRiskPercent,
      expiresAt,
      strategyVersion: TRADE_PLAN_STRATEGY_VERSION,
      marketDataAt: context.candleTimes.H1,
      conditions: candidate.conditions,
      plan: {
        style: "SWING",
        zone: { low: round(candidate.zone.low), high: round(candidate.zone.high), type: candidate.zone.type, relevance: candidate.zone.relevance, reactions: candidate.zone.reactions, sources: candidate.zone.sources, flipped: candidate.zone.flipped },
        entryTrigger: candidate.trigger,
        confirmation: candidate.confirmation,
        stopLossRule: candidate.stopRule(fmt(stop)),
        takeProfitRule: capped
          ? `The next ${direction === "BUY" ? "resistance" : "support"} zone ${fmt(target.low)}–${fmt(target.high)} is beyond ${cfg.maxTargetD1Atr} daily ranges, so the target is capped there.`
          : `Short of the next ${direction === "BUY" ? "resistance" : "support"} zone ${fmt(target.low)}–${fmt(target.high)}.`,
        targetZone: { low: round(target.low), high: round(target.high) },
        targetCapped: capped,
        holdRule: `A swing: plan to hold up to ${cfg.maxHoldTradingDays} trading days. If neither the stop nor the target is hit by then, close it.`,
        maxHoldTradingDays: cfg.maxHoldTradingDays,
        // Frozen inputs the confirmation engine judges this plan with; later config changes do not reach approved plans.
        rules: {
          atr,
          atrTimeframe: cfg.atrTimeframe,
          minRewardRisk: cfg.minRewardRisk,
          confirmationValidMinutes: cfg.confirmationValidMinutes,
          ...(setupType === "BREAKOUT_RETEST" ? cfg.breakoutRetest : cfg.reversal),
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
        expiryRule: `Has ${cfg.triggerTradingHours} hours of open market to trigger (the weekend close does not count).`,
        explanation: [...candidate.why, trendNote(direction), context.consolidation ? "H4 is ranging: breakouts fail more often in ranges." : null, news.reason]
          .filter((line): line is string => Boolean(line)),
        ...candidate.extra,
      },
      analysisInputs: {
        config: cfg,
        analyzeV2Version: foundation.version,
        context,
        zones: foundation.zones.map((zone) => ({ low: zone.low, high: zone.high, type: zone.type, status: zone.status, flipped: zone.flipped, relevance: zone.relevance })),
      },
    });
  };

  for (const direction of ["BUY", "SELL"] as const) {
    const up = direction === "BUY";
    const word = up ? "above" : "below";
    const back = up ? "below" : "above";
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
      rejected.push({ direction, setupType: "BREAKOUT_RETEST", reason: `No ${up ? "resistance" : "support"} within ${cfg.maxZoneDistanceAtr} H4 ATR to break.` });
    } else {
      const br = cfg.breakoutRetest;
      const level = edge(breakoutZone);
      const tolerance = br.retestToleranceAtr * atr;
      const farEdge = up ? breakoutZone.low : breakoutZone.high;
      const failLevel = level - sign * br.retestFailAtr * atr;
      const already = breakoutZone === broken;
      finish({
        direction,
        setupType: "BREAKOUT_RETEST",
        zone: breakoutZone,
        entryZoneLow: level - tolerance,
        entryZoneHigh: level + tolerance,
        stop: farEdge - sign * br.stopBufferAtr * atr,
        targetFrom: level,
        trigger: `${up ? "Bullish" : "Bearish"} ${br.retestTimeframe} continuation after price retests ${fmt(level)} and holds.`,
        confirmation: [
          `A completed ${br.breakoutTimeframe} candle closes ${word} ${fmt(level)} by at least ${br.breakoutCloseAtr} H4 ATR (${fmt(level + sign * br.breakoutCloseAtr * atr)}).`,
          `Price comes back to within ${br.retestToleranceAtr} H4 ATR of ${fmt(level)}.`,
          `No ${br.retestTimeframe} close goes back ${back} ${fmt(failLevel)} during the retest.`,
          `A completed ${br.retestTimeframe} candle closes ${up ? "above the retest candle's high" : "below the retest candle's low"} (continuation).`,
          `Limits: the retest within ${br.retestWindowBars} ${br.retestTimeframe} candles of the breakout, the continuation within ${br.continuationWindowBars} candles of the retest, ${br.maxBreakoutAttempts === 1 ? "one breakout attempt" : `up to ${br.maxBreakoutAttempts} breakout attempts`}. Price more than ${br.maxEntryDeviationAtr} H4 ATR past the entry zone is missed, not chased.`,
          `Reward/risk from the executable entry stays at least ${cfg.minRewardRisk}.`,
          "News blackout, spread and account-risk checks pass.",
        ],
        conditions: [
          { key: "breakout_close", label: `${br.breakoutTimeframe} close ${word} the zone` },
          { key: "breakout_size", label: "Breakout clears the noise threshold" },
          { key: "retest", label: "Price retests the broken level" },
          { key: "retest_holds", label: "The retest holds" },
          { key: "continuation", label: `${br.retestTimeframe} ${up ? "bullish" : "bearish"} continuation` },
          { key: "reward_risk", label: "Reward/risk still adequate" },
          { key: "execution_safety", label: "News, spread and risk checks" },
        ],
        stopRule: (final) => `Fixed at ${final} when approved: ${br.stopBufferAtr} H4 ATR ${back} the zone, at least ${cfg.minStopAtr} H4 ATR from the entry. A retest that trades through it invalidates the plan; it is never moved further away.`,
        invalidation: {
          rules: [
            `A completed ${br.retestTimeframe} close back ${back} ${fmt(failLevel)} after the breakout (failed breakout).`,
            `A completed ${br.breakoutTimeframe} close ${back} ${fmt(farEdge)} before any breakout.`,
            "The plan runs out of time before confirming.",
          ],
          failLevel: round(failLevel),
          zoneFarEdge: round(farEdge),
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
      rejected.push({ direction, setupType: "SR_REVERSAL", reason: `No ${up ? "support below" : "resistance above"} price within ${cfg.maxZoneDistanceAtr} H4 ATR.` });
    } else {
      const rv = cfg.reversal;
      const tf = rv.confirmTimeframe;
      const farEdge = up ? reversalZone.low : reversalZone.high;
      const sweepLimit = farEdge - sign * rv.maxSweepAtr * atr;
      const failLevel = farEdge - sign * rv.invalidateCloseAtr * atr;
      finish({
        direction,
        setupType: "SR_REVERSAL",
        zone: reversalZone,
        entryZoneLow: reversalZone.low,
        entryZoneHigh: reversalZone.high,
        stop: sweepLimit - sign * rv.stopBufferAtr * atr,
        targetFrom: up ? reversalZone.high : reversalZone.low,
        trigger: `A ${up ? "bullish" : "bearish"} ${tf} structure break after price rejects ${fmt(reversalZone.low)}–${fmt(reversalZone.high)}.`,
        confirmation: [
          `Price reaches the ${up ? "support" : "resistance"} zone ${fmt(reversalZone.low)}–${fmt(reversalZone.high)}.`,
          `A completed ${tf} candle rejects it (${up ? "long lower wick, close back up" : "long upper wick, close back down"}), or sweeps ${back} ${fmt(farEdge)} by at most ${rv.maxSweepAtr} H4 ATR and closes back inside.`,
          "If it swept, price reclaims the zone on a completed close — a sweep alone never triggers.",
          `${tf} breaks its last ${up ? "lower high" : "higher low"} (local structure turns ${up ? "up" : "down"}).`,
          `Limits: the structure break within ${rv.structureBreakBars} ${tf} candles of the turn; ${rv.maxAttempts} failed turns end the plan. Price more than ${rv.maxEntryDeviationAtr} H4 ATR past the zone is missed, not chased.`,
          `Reward/risk from the executable entry stays at least ${cfg.minRewardRisk}.`,
          "News blackout, spread and account-risk checks pass.",
        ],
        conditions: [
          { key: "approach", label: `Price reaches the ${up ? "support" : "resistance"} zone` },
          { key: "rejection_or_sweep", label: "Rejection or liquidity sweep" },
          { key: "reclaim", label: "Zone reclaimed (if swept)" },
          { key: "local_structure", label: `${tf} structure turns ${up ? "up" : "down"}` },
          { key: "stop_placement", label: "Stop beyond the rejection" },
          { key: "reward_risk", label: "Reward/risk still adequate" },
          { key: "execution_safety", label: "News, spread and risk checks" },
        ],
        stopRule: (final) => `Fixed at ${final} when approved: beyond the deepest allowed sweep (${rv.maxSweepAtr} H4 ATR past the zone) plus ${rv.stopBufferAtr} H4 ATR, at least ${cfg.minStopAtr} H4 ATR from the entry. A sweep that reaches it invalidates the plan; it is never moved further away.`,
        invalidation: {
          rules: [
            `A completed ${tf} close ${back} ${fmt(failLevel)} (the zone gave way).`,
            `A sweep further than ${rv.maxSweepAtr} H4 ATR past ${fmt(farEdge)}.`,
            "The plan runs out of time before confirming.",
          ],
          failLevel: round(failLevel),
          sweepLimit: round(sweepLimit),
        },
        why: [
          `${up ? "Support" : "Resistance"} at ${fmt(reversalZone.low)}–${fmt(reversalZone.high)} (${reversalZone.reactions} swing reaction${reversalZone.reactions === 1 ? "" : "s"}, ${reversalZone.relevance.toLowerCase().replace("_", " ")}${reversalZone.flipped ? ", old " + (up ? "resistance" : "support") + " that flipped" : ""}), ${reversalZone.distanceAtr.toFixed(1)} H4 ATR from price.`,
          `Reaching the zone is not a signal: the plan needs a rejection and an ${tf} structure turn.`,
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
