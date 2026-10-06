import { calculateAtr } from "@/lib/chart-utils";
import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { classifyMarketRegime, DEFAULT_REGIME_SETTINGS, type Confidence, type Regime, type RegimeRead } from "@/lib/strategy/market-regime";
import { rolesFor, type AnalysisMode, type NormalHierarchy, type RoleTimeframe, type TimeframeRoles } from "@/lib/strategy/timeframe-roles";
import { newsCheck, type NewsEvent } from "@/lib/strategy/trend-pullback-v1";
import type { Candle, MajorInstrument } from "@/types/forex";

/**
 * Analyze: regime first, entry second. Each mode runs the same framework
 * (market-regime.ts) on the timeframes timeframe-roles.ts assigns it:
 *
 *   NORMAL  H4 context · H1 primary regime · M15 setup · M5 execution
 *   SWING   D1 context · H4 primary regime · H1 setup  · M15 execution
 *
 * The primary timeframe alone decides the regime. Context is reported, and
 * its alignment flagged, but never overrides it. The setup timeframe finds
 * where to enter inside that regime: a setup move against the primary trend
 * is read as a pullback, not a new direction. Execution is reported for entry
 * timing only and does not move the levels.
 *
 *   UPTREND    → wait for a pullback into support → LONG
 *   DOWNTREND  → wait for a pullback into resistance → SHORT
 *   RANGE      → support = LONG area, resistance = SHORT area, middle = avoid
 *   TRANSITION → no trade; reassess once a new regime is confirmed
 *
 * When the read finds no proper setup (transition, mid-range, weak range,
 * too few candles) the decision is NO TRADE (user's choice, 2026-10-06: the
 * "lean anyway" orders were most of the Oct 5 losses). A limit entry sits at
 * its structural level when that fills often enough, otherwise at the
 * deepest point that still fills about 70% of the time (`minFillChancePct`):
 * a nearer support bounces no more often than any other price, so going
 * deeper only costs fills.
 *
 * Both modes are 1:2. The stop starts at a share of the average daily range
 * (about a third of a day in Normal, a full day in Swing), then moves to just
 * past the swing or tested zone nearest that distance, so it does not sit
 * inside structure; the target stays twice the stop. `warnings` flags open
 * trades on the same side of a currency. (Obstacle-before-target and
 * day-range-used warnings were tried and dropped: in a 2-year replay the
 * flagged trades did no worse.)
 */

export type { AnalysisMode, NormalHierarchy } from "@/lib/strategy/timeframe-roles";
export type Decision = "LONG" | "SHORT" | "NO TRADE";
export type SetupType = "TREND_PULLBACK" | "RANGE_SUPPORT" | "RANGE_RESISTANCE" | "NONE";
export type ChaseRisk = "LOW" | "MEDIUM" | "HIGH";
/** How the primary regime and the context regime relate. */
export type Alignment = "ALIGNED" | "CONFLICTING" | "MIXED" | "UNKNOWN";
/** Which way a lower timeframe has moved since its latest confirmed swing. */
export type Movement = "UP" | "DOWN" | "FLAT";
/** The setup timeframe's move, read relative to the primary regime. */
export type SetupState = "PULLBACK" | "CONTINUATION" | "ROTATION" | "UNCLEAR";

/** `risk.news` when nothing is due; anything else is shown as a caution. */
export const NO_NEWS = "No high-impact news found";

export const MARKET_ANALYSIS = {
  /**
   * 1:2 in both modes (user's choice, 2026-10-05; both were 4:2 before): the
   * stop is the base distance from the entry and the target twice that.
   * Replaying the user's 36 manual trades of Sep 21-Oct 5 with a one-day-range
   * stop, 1:2 and 4:2 banked about the same on closed trades (+7R vs +8R); 1:2
   * led only on open trades. The old 4:2 won 63-65% over five years yet lost
   * -0.03R/trade; swing-width 1:2 ran -0.01 to -0.04R. No edge either way.
   */
  stopMultiple: { NORMAL: 1, SWING: 1 },
  targetMultiple: { NORMAL: 2, SWING: 2 },
  /**
   * The stop as a share of the pair's average daily range. Normal keeps the
   * stop it had under 4:2 (a third of the day; the old target was half that),
   * so only the target moved out. Swing's stop clears a full day's range.
   */
  stopShareOfDailyRange: { NORMAL: 0.34, SWING: 1 },
  /** Days averaged for that range, from the H1 candles Analyze already reads. */
  dailyRangeDays: 10,
  /**
   * Base distance otherwise, and the fallback when there are too few days:
   * average 1-hour candles (H1 ATR14) with a pip floor on the stop. Swing's
   * fallback is about a day's range (a day spans roughly 4-5 average 1-hour
   * candles).
   */
  baseH1Atr: { NORMAL: 2, SWING: 4.5 },
  baseMinPips: { NORMAL: 20, SWING: 25 },
  /**
   * A limit entry is never placed where it would fill less often than this
   * within the order's lifetime (4h normal, 48h swing), per FILL_CURVE: about
   * 0.44 average 1-hour candles from price in Normal, 1.4 in Swing (user's
   * choice, 2026-10-06). The structural level is used when it is closer.
   * Supports, fib levels and zones bounce no more often than other prices, so
   * a deeper entry buys no better hold, only fewer fills.
   */
  minFillChancePct: 70,
  /** Distance from the pullback zone, in ATRs: up to this is low chase risk... */
  lowChaseAtr: 1,
  /** ...up to this medium; beyond it HIGH (the limit still rests at the zone). */
  maxChaseAtr: 2.5,
  /**
   * Structure stop: a swing or tested-zone edge between these shares of the
   * daily-range stop distance (behind the entry) may carry the stop; the one
   * nearest the default distance wins, and the stop goes past it by
   * `structureStopBuffer` of the default distance plus the spread.
   */
  structureStopBand: [0.6, 1.4] as const,
  structureStopBuffer: 0.1,
  /** Range thirds: the outer third on each side is a boundary, the middle is avoided. */
  rangeEdgeShare: 1 / 3,
  /**
   * Trend pullback levels are judged by how far back through the impulse they
   * sit (0 = the impulse extreme, 1 = where it started). A broken swing
   * (role reversal) counts inside this wider band...
   */
  roleReversalBand: [0.25, 0.75] as const,
  /** ...a tested zone must overlap the usual 38-62% retracement... */
  testedZoneBand: [0.382, 0.618] as const,
  /** ...and with neither, the entry is the impulse's midpoint. */
  fallbackRetracement: 0.5,
  /** Half-width of a single-price level's zone, in primary ATRs. */
  levelHalfWidthAtr: 0.15,
  /**
   * Range-boundary trades need a well-established range. In a causal replay
   * (69 days of M15, 3 years of H4, six majors) range reads held only ~21% of
   * the time and medium-confidence range trades lost (-21.6R over 79 swing
   * trades), while trend pullbacks were mildly positive.
   */
  rangeTradeMinConfidence: "HIGH" as Confidence,
  /** Spread above this share of the stop is flagged... */
  spreadWarnShare: 0.1,
  /** ...and above this it is flagged as too costly (never refused: Analyze always trades). */
  spreadRejectShare: 0.25,
} as const;

export interface MarketAnalysisInput {
  instrument: MajorInstrument;
  mode: AnalysisMode;
  /** Keyed by timeframe; timeframe-roles.ts says which ones each mode reads. */
  candles: Partial<Record<RoleTimeframe, Candle[]>>;
  /** NORMAL only: LEGACY runs the old M15-primary hierarchy, for comparison. */
  normalHierarchy?: NormalHierarchy;
  currentPrice?: number | null;
  spreadPips?: number | null;
  newsEvents?: NewsEvent[];
  /** The moment of the analysis in ms (replays pass the candle time). */
  now?: number;
  /** The trader's open trades and resting orders, for the same-currency warning. */
  exposure?: Array<{ instrument: string; direction: "long" | "short" }>;
}

export interface MarketAnalysis {
  mode: AnalysisMode;
  pair: MajorInstrument;
  primaryTimeframe: string;
  regime: Regime;
  regimeConfidence: Confidence;
  context: { timeframe: string; regime: Regime; agrees: boolean | null; alignment: Alignment };
  /** The timeframe hierarchy this read ran, role by role. */
  hierarchy: {
    version: NormalHierarchy;
    roles: TimeframeRoles;
    setup: { timeframe: string; regime: Regime; movement: Movement; state: SetupState; label: string } | null;
    execution: { timeframe: string; regime: Regime; movement: Movement; role: "ENTRY REFINEMENT" } | null;
    interpretation: string;
    strategy: string;
  };
  decision: Decision;
  setupType: SetupType;
  currentPrice: number;
  structure: { latestSwingHigh: number | null; latestSwingLow: number | null; interpretation: string };
  trend: { impulse: string; pullbackZone: { low: number; high: number } | null; entry: number | null; chaseRisk: ChaseRisk; distanceToPullbackPips: number | null } | null;
  range: { high: number; low: number; mid: number; location: "NEAR SUPPORT" | "NEAR RESISTANCE" | "MIDDLE"; preferredSide: "LONG" | "SHORT" | "NONE" } | null;
  transition: { previous: Regime; broken: string; potential: string } | null;
  trade: {
    entry: number;
    stopLoss: number;
    takeProfit: number;
    riskReward: number;
    stopPips: number;
    targetPips: number;
    /** LIMIT waits for price; MARKET is available now. */
    orderType: "BUY_LIMIT" | "SELL_LIMIT" | "MARKET";
    holding: string;
    /** Estimated chance a limit entry fills before the order expires (100 for market). */
    fillChancePct: number;
    /** What the stop sits behind: a structure level, or the daily-range distance alone. */
    stopBasis: string;
  } | null;
  risk: { spread: string; news: string; invalidation: string; main: string };
  /** Cautions the plan itself cannot fix; empty when there are none. */
  warnings: string[];
  /** Hold the order until after imminent high-impact news (ISO), else null. */
  activateAfter: string | null;
  reason: string;
}

/**
 * Share of limit orders this many average 1-hour candles from price that filled
 * within the Analyze lifetime (normal 4h, swing 48h), interpolated from the
 * 14-major, 5-year measurement (14 majors, 2021-10..2026-10, M5 bid/ask).
 */
const FILL_CURVE: Record<AnalysisMode, Array<[number, number]>> = {
  NORMAL: [[0, 100], [0.1, 93], [0.25, 83], [0.5, 66], [0.75, 52], [1, 40], [1.5, 24], [2, 14], [3, 5]],
  SWING: [[0, 100], [0.1, 97], [0.25, 94], [0.5, 88], [0.75, 82], [1, 77], [1.5, 68], [2, 59], [3, 45]],
};

/**
 * Average high-low range of the last `days` complete trading days, built from
 * H1 candles. Days roll at 17:00 New York (21:00 UTC in summer; the 3h shift
 * is an hour early in winter, which barely moves a 10-day average). Short
 * stubs such as the Sunday open are skipped. Null with fewer than 3 days.
 */
function averageDailyRange(candles: Candle[], days: number): number | null {
  const byDay = new Map<number, { high: number; low: number; count: number }>();
  for (const candle of candles) {
    if (candle.complete === false) continue;
    const day = Math.floor((Date.parse(candle.time) + 3 * 3_600_000) / 86_400_000);
    const entry = byDay.get(day);
    if (entry) {
      entry.high = Math.max(entry.high, candle.high);
      entry.low = Math.min(entry.low, candle.low);
      entry.count += 1;
    } else byDay.set(day, { high: candle.high, low: candle.low, count: 1 });
  }
  const ordered = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  // The latest day is still forming.
  const complete = ordered.slice(0, -1).map(([, day]) => day).filter((day) => day.count >= 18).slice(-days);
  if (complete.length < 3) return null;
  return complete.reduce((sum, day) => sum + (day.high - day.low), 0) / complete.length;
}

/** A structure level a read found, with where it came from for the plan's wording. */
type Level = { price: number; label: string };

/**
 * Swings and tested-zone edges of one read that still hold: no completed close
 * has gone through them since they formed, and price is still on their side.
 * `side` "below" gives supports (swing lows, zone lows), "above" resistances.
 */
function intactLevels(read: RegimeRead | null, candles: Candle[] | undefined, timeframe: string, side: "below" | "above", price: number): Level[] {
  if (!read || !candles?.length) return [];
  const complete = candles.filter((candle) => candle.complete !== false);
  const below = side === "below";
  const holds = (level: number, after: (candle: Candle, index: number) => boolean) =>
    (below ? price > level : price < level) && complete.every((candle, index) => !after(candle, index) || (below ? candle.close >= level : candle.close <= level));
  const swings = read.swings
    .filter((swing) => swing.type === (below ? "low" : "high"))
    .filter((swing) => holds(swing.price, (_, index) => index > swing.index))
    .map((swing) => ({ price: swing.price, label: `${timeframe} swing ${swing.type}` }));
  const zones = read.zones
    .filter((zone) => zone.touches >= 2)
    .map((zone) => ({ edge: below ? zone.low : zone.high, zone }))
    .filter(({ edge, zone }) => holds(edge, (candle) => candle.time > zone.lastTime))
    .map(({ edge, zone }) => ({ price: edge, label: `${timeframe} ${below ? "support" : "resistance"} (${zone.touches} touches)` }));
  return [...swings, ...zones];
}

/** +1 for each currency the trade buys, -1 for each it sells. */
function currencyLegs(instrument: string, direction: "long" | "short") {
  const [base, quote] = instrument.split("_");
  const sign = direction === "long" ? 1 : -1;
  return base && quote ? [{ currency: base, sign }, { currency: quote, sign: -sign }] : [];
}

/** The furthest distance from price, in average 1-hour candles, that still fills `pct`% of the time. */
function distanceForFill(mode: AnalysisMode, pct: number) {
  const curve = FILL_CURVE[mode];
  for (let i = 1; i < curve.length; i += 1) {
    const [x1, y1] = curve[i]!;
    const [x0, y0] = curve[i - 1]!;
    if (pct >= y1) return x0 + ((x1 - x0) * (y0 - pct)) / (y0 - y1);
  }
  return curve.at(-1)![0];
}

function fillChance(mode: AnalysisMode, distanceH1Atr: number) {
  const curve = FILL_CURVE[mode];
  for (let i = 1; i < curve.length; i += 1) {
    const [x1, y1] = curve[i]!;
    const [x0, y0] = curve[i - 1]!;
    if (distanceH1Atr <= x1) return Math.round(y0 + ((y1 - y0) * (distanceH1Atr - x0)) / (x1 - x0));
  }
  return curve.at(-1)![1];
}

function zoneText(zone: { low: number; high: number }, digits: number) {
  return `${zone.low.toFixed(digits)}–${zone.high.toFixed(digits)}`;
}

/**
 * Direction since the latest confirmed swing: away from a swing high is down,
 * away from a swing low is up. Reads movement rather than regime, so a
 * pullback that has not yet broken lower-timeframe structure still shows.
 */
function movementOf(read: RegimeRead): Movement {
  const last = read.swings.at(-1);
  if (!last) return "FLAT";
  if (last.type === "high") return read.close < last.price ? "DOWN" : "FLAT";
  return read.close > last.price ? "UP" : "FLAT";
}

function alignmentOf(primary: Regime, context: Regime | null): Alignment {
  if (context === null) return "UNKNOWN";
  const trend = (regime: Regime) => regime === "UPTREND" || regime === "DOWNTREND";
  if (trend(primary) && trend(context)) return primary === context ? "ALIGNED" : "CONFLICTING";
  return "MIXED";
}

/** Plain-English hierarchy read: what the primary regime is and where the setup sits in it. */
function describeHierarchy(roles: TimeframeRoles, regime: Regime, setupState: SetupState, contextRegime: Regime | null, alignment: Alignment) {
  const contextNote = alignment === "CONFLICTING" ? ` ${roles.context} reads ${contextRegime!.toLowerCase()}, against it: counter-context risk.`
    : alignment === "MIXED" ? ` ${roles.context} reads ${contextRegime!.toLowerCase()}: context is mixed.` : "";
  const setupTf = roles.setup ?? roles.primary;
  if (regime === "UPTREND" || regime === "DOWNTREND") {
    const setupNote = !roles.setup ? ""
      : setupState === "PULLBACK" ? ` with an ${roles.setup} pullback`
        : setupState === "CONTINUATION" ? `; ${roles.setup} is still moving with it` : `; no clear ${roles.setup} move`;
    return {
      interpretation: `${roles.primary} ${regime.toLowerCase()}${setupNote}.${contextNote}`,
      strategy: `Look for ${regime === "UPTREND" ? "LONG" : "SHORT"} from a meaningful ${setupTf} pullback area. Do not chase the ${roles.primary} trend.`,
    };
  }
  if (regime === "RANGE") {
    return {
      interpretation: `${roles.primary} range.${contextNote}`,
      strategy: `LONG near ${roles.primary} range support, SHORT near resistance; the middle is no trade.`,
    };
  }
  return {
    interpretation: `${roles.primary} transition: the previous structure broke and no new regime is confirmed.${contextNote}`,
    strategy: "No trade until a new regime is confirmed.",
  };
}

export function analyzeMarket(input: MarketAnalysisInput): MarketAnalysis {
  const version: NormalHierarchy = input.mode === "NORMAL" ? input.normalHierarchy ?? "ROLES" : "ROLES";
  const config = rolesFor(input.mode, version);
  const pip = pipSizeFor(input.instrument);
  const digits = precisionFor(input.instrument);
  const round = (value: number) => Number(value.toFixed(digits));
  const regimeOf = (timeframe: RoleTimeframe | null) => {
    const candles = timeframe === null ? [] : input.candles[timeframe] ?? [];
    return candles.length ? classifyMarketRegime(candles, DEFAULT_REGIME_SETTINGS) : null;
  };
  const read = classifyMarketRegime(input.candles[config.primary] ?? [], DEFAULT_REGIME_SETTINGS);
  const contextRead = regimeOf(config.context);
  const setupRead = regimeOf(config.setup);
  const executionRead = regimeOf(config.execution);
  const price = typeof input.currentPrice === "number" && input.currentPrice > 0 ? input.currentPrice : read.close;
  const atr = read.atr;
  const spreadPips = input.spreadPips ?? null;
  const settings = MARKET_ANALYSIS;

  const contextAgrees = contextRead === null || contextRead.regime === "TRANSITION" || contextRead.regime === "RANGE"
    ? null
    : (read.regime === "UPTREND" && contextRead.regime === "UPTREND") || (read.regime === "DOWNTREND" && contextRead.regime === "DOWNTREND")
      ? true
      : read.regime === "UPTREND" || read.regime === "DOWNTREND" ? false : null;
  const alignment = alignmentOf(read.regime, contextRead?.regime ?? null);

  // A setup move against the primary trend is a pullback, not a new direction.
  const setupMovement = setupRead ? movementOf(setupRead) : null;
  const trendMove: Movement | null = read.regime === "UPTREND" ? "UP" : read.regime === "DOWNTREND" ? "DOWN" : null;
  const setupState: SetupState = setupMovement === null || setupMovement === "FLAT" ? "UNCLEAR"
    : trendMove ? (setupMovement === trendMove ? "CONTINUATION" : "PULLBACK")
      : read.regime === "RANGE" ? "ROTATION" : "UNCLEAR";
  const moveWord = setupMovement === "UP" ? "bullish" : "bearish";
  const setupLabel = setupState === "PULLBACK" ? `${moveWord} pullback`
    : setupState === "CONTINUATION" ? `${moveWord} continuation`
      : setupState === "ROTATION" ? `${moveWord} rotation inside the range` : "no clear move";

  const result: MarketAnalysis = {
    mode: input.mode,
    pair: input.instrument,
    primaryTimeframe: config.primary,
    regime: read.regime,
    regimeConfidence: read.confidence,
    context: { timeframe: config.context, regime: contextRead?.regime ?? "TRANSITION", agrees: contextAgrees, alignment },
    hierarchy: {
      version,
      roles: config,
      setup: config.setup && setupRead
        ? { timeframe: config.setup, regime: setupRead.regime, movement: setupMovement!, state: setupState, label: setupLabel }
        : null,
      execution: config.execution && executionRead
        ? { timeframe: config.execution, regime: executionRead.regime, movement: movementOf(executionRead), role: "ENTRY REFINEMENT" }
        : null,
      ...describeHierarchy(config, read.regime, setupState, contextRead?.regime ?? null, alignment),
    },
    decision: "NO TRADE",
    setupType: "NONE",
    currentPrice: round(price),
    structure: {
      latestSwingHigh: read.latestSwingHigh ? round(read.latestSwingHigh.price) : null,
      latestSwingLow: read.latestSwingLow ? round(read.latestSwingLow.price) : null,
      interpretation: read.interpretation,
    },
    trend: null,
    range: null,
    transition: read.transition,
    trade: null,
    risk: { spread: spreadPips === null ? "Unknown (no live quote)" : `${spreadPips.toFixed(1)} pips`, news: NO_NEWS, invalidation: "—", main: "—" },
    warnings: [],
    activateAfter: null,
    reason: read.interpretation,
  };

  const news = input.newsEvents?.length ? newsCheck(input.instrument, input.newsEvents, input.now ?? Date.now(), 0) : null;
  if (news) {
    result.risk.news = news.warning.replace(/: a news candle can run past a 0-pip stop\. Consider closing before it\./, ": elevated volatility risk around the release.");
    result.activateAfter = news.activateAfter;
  }

  const h1Atr = calculateAtr((input.candles.H1 ?? []).filter((candle) => candle.complete !== false), 14).at(-1) ?? null;
  if (h1Atr === null || !(h1Atr > 0)) {
    result.reason = "Not enough completed 1-hour candles to size a trade.";
    return result;
  }

  // Both modes size the stop from the day's range.
  const dailyRange = averageDailyRange(input.candles.H1 ?? [], settings.dailyRangeDays);
  const stopMultiple = settings.stopMultiple[input.mode];
  const targetMultiple = settings.targetMultiple[input.mode];
  const rangeBase = dailyRange === null ? null : (settings.stopShareOfDailyRange[input.mode] * dailyRange) / stopMultiple;

  /** Supports ("below") or resistances ("above") on the primary and setup timeframes. */
  const levels = (side: "below" | "above") => [
    ...intactLevels(read, input.candles[config.primary], config.primary, side, price),
    ...(config.setup ? intactLevels(setupRead, input.candles[config.setup], config.setup, side, price) : []),
  ];

  /**
   * Builds the 1:2 trade. A costly spread is flagged, never refused. A
   * structural entry further away than the 70%-fill distance is pulled in to
   * that distance; it still waits for a dip (or rise), never chases.
   */
  const finishTrade = (direction: "LONG" | "SHORT", structuralEntry: number, setup: SetupType, invalidation: string) => {
    const long = direction === "LONG";
    const maxDistance = distanceForFill(input.mode, settings.minFillChancePct) * h1Atr;
    const capped = long ? Math.max(structuralEntry, price - maxDistance) : Math.min(structuralEntry, price + maxDistance);
    const atEntry = Math.abs(price - capped) <= 0.1 * (atr > 0 ? atr : h1Atr) || (long ? price < capped : price > capped);
    const entry = atEntry ? price : capped;
    const base = Math.max(
      rangeBase ?? settings.baseH1Atr[input.mode] * h1Atr,
      settings.baseMinPips[input.mode] * pip,
    );
    const defaultRisk = stopMultiple * base;
    // Move the stop just past the structure nearest the default distance, so
    // a retest of that level does not take it out.
    const [bandNear, bandFar] = settings.structureStopBand;
    const behind = levels(long ? "below" : "above")
      .map((level) => ({ ...level, distance: long ? entry - level.price : level.price - entry }))
      .filter((level) => level.distance >= bandNear * defaultRisk && level.distance <= bandFar * defaultRisk)
      .sort((a, b) => Math.abs(a.distance - defaultRisk) - Math.abs(b.distance - defaultRisk))[0] ?? null;
    const buffer = settings.structureStopBuffer * defaultRisk + (spreadPips ?? 0) * pip;
    const risk = behind ? behind.distance + buffer : defaultRisk;
    const stop = long ? entry - risk : entry + risk;
    const target = long ? entry + targetMultiple * risk : entry - targetMultiple * risk;
    const stopPips = risk / pip;
    const targetPips = Math.abs(target - entry) / pip;
    result.decision = direction;
    result.setupType = setup;
    result.trade = {
      entry: round(entry),
      stopLoss: round(stop),
      takeProfit: round(target),
      riskReward: Number((Math.abs(target - entry) / risk).toFixed(2)),
      stopPips: Number(stopPips.toFixed(1)),
      targetPips: Number(targetPips.toFixed(1)),
      orderType: atEntry ? "MARKET" : long ? "BUY_LIMIT" : "SELL_LIMIT",
      holding: config.holding,
      fillChancePct: atEntry ? 100 : fillChance(input.mode, Math.abs(price - entry) / h1Atr),
      stopBasis: behind
        ? `${long ? "Below" : "Above"} ${behind.label} ${behind.price.toFixed(digits)}`
        : `${settings.stopShareOfDailyRange[input.mode] === 1 ? "One average daily range" : `${settings.stopShareOfDailyRange[input.mode]} of the average daily range`}; no structure near it`,
    };
    result.risk.invalidation = invalidation;
    const spreadShare = spreadPips === null ? null : spreadPips / stopPips;
    result.risk.spread = spreadPips === null
      ? result.risk.spread
      : `${spreadPips.toFixed(1)} pips (${Math.round(spreadShare! * 100)}% of stop, ${Math.round((spreadPips / targetPips) * 100)}% of target)${spreadShare! > settings.spreadRejectShare ? " — too costly" : spreadShare! > settings.spreadWarnShare ? " — high" : ""}`;

    // Open trades and orders betting the same way on a currency.
    const legs = currencyLegs(input.instrument, long ? "long" : "short");
    for (const leg of legs) {
      const same = (input.exposure ?? []).filter((open) => currencyLegs(open.instrument, open.direction).some((other) => other.currency === leg.currency && other.sign === leg.sign));
      if (!same.length) continue;
      const list = same.map((open) => `${open.direction} ${open.instrument.replace("_", "/")}`).join(", ");
      result.warnings.push(`Already ${leg.sign > 0 ? "long" : "short"} ${leg.currency} in ${same.length} open trade${same.length === 1 ? "" : "s"} or order${same.length === 1 ? "" : "s"} (${list}); this adds to the same bet.`);
    }
  };

  /** No proper setup: `why` is what the read objected to. */
  const noTrade = (why: string, risk: string) => {
    result.reason = `${why} No trade.`;
    result.risk.main = risk;
    return result;
  };

  if (!(atr > 0)) return noTrade("Not enough completed candles to read structure.", "No structure read.");

  if (read.regime === "UPTREND" || read.regime === "DOWNTREND") {
    const up = read.regime === "UPTREND";
    const impulse = read.impulse!;
    const legLow = Math.min(impulse.from.price, impulse.to.price);
    const legHigh = Math.max(impulse.from.price, impulse.to.price);
    // Pullback level, best first (not merely the nearest to price):
    //  1. role reversal - the latest swing the impulse broke (an old high in an
    //     uptrend, an old low in a downtrend), 25-75% back through the impulse;
    //  2. the strongest tested zone that held (most touches, then most recent)
    //     overlapping the 38-62% retracement;
    //  3. the impulse midpoint.
    const size = legHigh - legLow;
    const extreme = impulse.to.price;
    /** How far back through the impulse a price sits: 0 at the extreme, 1 at the start. */
    const retrace = (level: number) => Math.abs(extreme - level) / size;
    const halfWidth = settings.levelHalfWidthAtr * atr;
    const primaryCandles = (input.candles[config.primary] ?? []).filter((candle) => candle.complete !== false);
    /** A zone held if no close went through its far side after its last reaction. */
    const held = (candidate: { low: number; high: number; lastTime: string }) => primaryCandles
      .filter((candle) => candle.time > candidate.lastTime)
      .every((candle) => up ? candle.close >= candidate.low - halfWidth : candle.close <= candidate.high + halfWidth);
    const roleReversal = read.swings
      .filter((swing) => swing.type === (up ? "high" : "low") && swing.index < impulse.to.index && swing.index > impulse.from.index - 1)
      .filter((swing) => up ? swing.price < extreme && swing.price > impulse.from.price : swing.price > extreme && swing.price < impulse.from.price)
      .filter((swing) => retrace(swing.price) >= settings.roleReversalBand[0] && retrace(swing.price) <= settings.roleReversalBand[1])
      .filter((swing) => up ? price > swing.price - halfWidth : price < swing.price + halfWidth)
      .sort((a, b) => b.index - a.index)[0] ?? null;
    const [bandNear, bandFar] = settings.testedZoneBand;
    const testedZone = read.zones
      .filter((candidate) => candidate.touches >= 2)
      .filter((candidate) => {
        const near = retrace(up ? candidate.high : candidate.low);
        const far = retrace(up ? candidate.low : candidate.high);
        return far >= bandNear && near <= bandFar;
      })
      .filter(held)
      .sort((a, b) => b.touches - a.touches || b.lastTime.localeCompare(a.lastTime))[0] ?? null;
    let zone: { low: number; high: number; tested: boolean; kind: string };
    if (roleReversal) {
      zone = { low: roleReversal.price - halfWidth, high: roleReversal.price + halfWidth, tested: true, kind: `broken swing ${up ? "high" : "low"} ${roleReversal.price.toFixed(digits)}` };
    } else if (testedZone) {
      zone = { low: testedZone.low, high: testedZone.high, tested: true, kind: `tested ${up ? "support" : "resistance"} (${testedZone.touches} touches)` };
    } else {
      const mid = up ? extreme - settings.fallbackRetracement * size : extreme + settings.fallbackRetracement * size;
      zone = { low: mid - halfWidth, high: mid + halfWidth, tested: false, kind: "the impulse midpoint" };
    }
    // The setup timeframe narrows the entry to its tested zone inside the
    // primary pullback zone (NORMAL: M15 in H1, SWING: H1 in H4).
    if (setupRead) {
      const inside = setupRead.zones.filter((candidate) => candidate.touches >= 2 && candidate.high >= zone!.low && candidate.low <= zone!.high)
        .sort((a, b) => up ? b.high - a.high : a.low - b.low)[0];
      if (inside) zone = { ...zone, low: Math.max(zone.low, inside.low), high: Math.min(zone.high, inside.high), tested: true };
    }
    const entryEdge = up ? zone.high : zone.low;
    const distance = up ? price - zone.high : zone.low - price;
    const distanceAtr = distance / atr;
    const chaseRisk: ChaseRisk = distanceAtr <= settings.lowChaseAtr ? "LOW" : distanceAtr <= settings.maxChaseAtr ? "MEDIUM" : "HIGH";
    // The higher low (up) / lower high (down) the impulse started from.
    const structureLevel = impulse.from.price;
    result.trend = {
      impulse: `${up ? "Up" : "Down"} leg ${impulse.from.price.toFixed(digits)} → ${impulse.to.price.toFixed(digits)} (${(Math.abs(impulse.to.price - impulse.from.price) / atr).toFixed(1)} ATR)`,
      pullbackZone: { low: round(zone.low), high: round(zone.high) },
      entry: round(entryEdge),
      chaseRisk,
      distanceToPullbackPips: Number((Math.max(0, distance) / pip).toFixed(1)),
    };
    // Pullback already beyond the zone toward the structure: still valid while
    // the structure holds; the entry is then price itself.
    const entry = up ? Math.min(entryEdge, Math.max(price, legLow)) : Math.max(entryEdge, Math.min(price, legHigh));
    finishTrade(up ? "LONG" : "SHORT", entry, "TREND_PULLBACK",
      `${up ? "Close below" : "Close above"} ${structureLevel.toFixed(digits)} (the ${up ? "higher low" : "lower high"}) ends the trend.`);
    // The 70%-fill cap may have pulled the limit in from the zone.
    const shortOfZone = result.trade && result.trade.orderType !== "MARKET" ? Math.abs(result.trade.entry - entryEdge) / pip : 0;
    result.risk.main = contextAgrees === false
      ? `${config.context} is ${contextRead!.regime}: this trade runs against the higher timeframe.`
      : shortOfZone >= 1 ? `The entry sits ${shortOfZone.toFixed(0)} pips ${up ? "above" : "below"} the zone so it fills about ${settings.minFillChancePct}% of the time; it may fill before price reaches the zone.`
        : "Structure failure through the invalidation level.";
    // Price already pulled back through the zone (still short of the structure level).
    const pastZone = result.trade?.orderType === "MARKET" && (up ? price < zone.low : price > zone.high);
    result.reason = `${read.interpretation} ${up ? "Buy" : "Sell"} the pullback ${shortOfZone >= 1 ? "toward" : pastZone ? "past" : "at"} ${zone.kind}, ${zoneText(zone, digits)}${shortOfZone >= 1 ? `; the limit sits ${shortOfZone.toFixed(0)} pips ${up ? "above" : "below"} it, the deepest entry that still fills about ${settings.minFillChancePct}% of the time` : pastZone ? `; price is already through it, so the entry is now` : ""}.`;
    return result;
  }

  if (read.regime === "RANGE") {
    const range = read.range!;
    const height = range.high - range.low;
    const share = (price - range.low) / height;
    const location = share <= settings.rangeEdgeShare ? "NEAR SUPPORT" : share >= 1 - settings.rangeEdgeShare ? "NEAR RESISTANCE" : "MIDDLE";
    result.range = {
      high: round(range.high), low: round(range.low), mid: round(range.mid),
      location, preferredSide: location === "NEAR SUPPORT" ? "LONG" : location === "NEAR RESISTANCE" ? "SHORT" : "NONE",
    };
    if (location === "MIDDLE") {
      return noTrade(`Range ${range.low.toFixed(digits)}–${range.high.toFixed(digits)}; price is in the middle (${Math.round(share * 100)}%), a poor location.`,
        "Poor location: no edge in the middle of a range.");
    }
    const long = location === "NEAR SUPPORT";
    const entry = long ? Math.min(price, range.lowZone.high) : Math.max(price, range.highZone.low);
    if (read.confidence !== settings.rangeTradeMinConfidence) {
      return noTrade(`Range ${range.low.toFixed(digits)}–${range.high.toFixed(digits)}, price ${long ? "near support" : "near resistance"}, but the range is not established (${read.confidence.toLowerCase()} confidence; needs 5+ boundary touches).`,
        "Weak range: young ranges usually break instead of holding.");
    }
    finishTrade(long ? "LONG" : "SHORT", entry, long ? "RANGE_SUPPORT" : "RANGE_RESISTANCE",
      `A close ${long ? "below" : "above"} ${(long ? range.low : range.high).toFixed(digits)} breaks the range.`);
    result.risk.main = "Boundary failure: a confirmed break turns the range into a transition.";
    result.reason = `${read.interpretation} Price is near ${long ? "support" : "resistance"}; ${long ? "buy" : "sell"} toward the opposite side.`;
    return result;
  }

  // TRANSITION: no confirmed regime, so no trade until one is.
  return noTrade(read.interpretation, "No confirmed regime.");
}

/** The analysis as the plain-text report the spec describes. */
export function formatMarketAnalysis(analysis: MarketAnalysis) {
  const digits = precisionFor(analysis.pair);
  const price = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toFixed(digits);
  const roles = analysis.hierarchy.roles;
  const lines = [
    `MODE: ${analysis.mode}`,
    `PAIR: ${analysis.pair.replace("_", "/")}`,
    `HIERARCHY: ${analysis.hierarchy.version}`,
    "",
    `${roles.context} CONTEXT: ${analysis.context.regime}`,
    `${roles.primary} PRIMARY REGIME: ${analysis.regime} (${analysis.regimeConfidence} confidence)`,
    `${roles.setup ?? roles.primary} SETUP: ${roles.setup ? analysis.hierarchy.setup?.label.toUpperCase() ?? "UNAVAILABLE" : "SAME AS PRIMARY"}`,
    `${roles.execution ?? "—"} EXECUTION: ${roles.execution ? "ENTRY REFINEMENT" : "NONE"}`,
    `ALIGNMENT: ${analysis.context.alignment}`,
    "",
    `FINAL INTERPRETATION: ${analysis.hierarchy.interpretation}`,
    `STRATEGY: ${analysis.hierarchy.strategy}`,
    "",
    `DIRECTION: ${analysis.decision === "NO TRADE" ? "NONE" : analysis.decision}`,
    `SETUP TYPE: ${analysis.setupType}`,
    `CURRENT PRICE: ${price(analysis.currentPrice)}`,
    "",
    "TREND STRUCTURE:",
    `- Latest meaningful swing high: ${price(analysis.structure.latestSwingHigh)}`,
    `- Latest meaningful swing low: ${price(analysis.structure.latestSwingLow)}`,
    `- Structure interpretation: ${analysis.structure.interpretation}`,
  ];
  if (analysis.trend) {
    lines.push("", "IF TREND:",
      `- Impulse: ${analysis.trend.impulse}`,
      `- Pullback zone: ${analysis.trend.pullbackZone ? `${price(analysis.trend.pullbackZone.low)}–${price(analysis.trend.pullbackZone.high)}` : "—"}`,
      `- Entry: ${price(analysis.trend.entry)}`,
      `- Distance to pullback: ${analysis.trend.distanceToPullbackPips ?? "—"} pips`,
      `- Chase risk: ${analysis.trend.chaseRisk}`);
  }
  if (analysis.range) {
    lines.push("", "IF RANGE:",
      `- Range high: ${price(analysis.range.high)}`,
      `- Range low: ${price(analysis.range.low)}`,
      `- Range midpoint: ${price(analysis.range.mid)}`,
      `- Current range location: ${analysis.range.location}`,
      `- Preferred side: ${analysis.range.preferredSide}`);
  }
  if (analysis.transition && analysis.regime === "TRANSITION") {
    lines.push("", "IF TRANSITION:",
      `- Previous regime: ${analysis.transition.previous}`,
      `- Broken structure: ${analysis.transition.broken}`,
      `- Potential new regime: ${analysis.transition.potential}`);
  }
  lines.push("", "TRADE:",
    `- Entry: ${price(analysis.trade?.entry)}${analysis.trade ? ` (${analysis.trade.orderType === "MARKET" ? "available now" : analysis.trade.orderType.replace("_", " ").toLowerCase()})` : ""}`,
    `- Stop Loss: ${price(analysis.trade?.stopLoss)}${analysis.trade ? ` (${analysis.trade.stopPips} pips; ${analysis.trade.stopBasis})` : ""}`,
    `- Take Profit: ${price(analysis.trade?.takeProfit)}${analysis.trade ? ` (${analysis.trade.targetPips} pips)` : ""}`,
    `- Risk/Reward: ${analysis.trade ? `${analysis.trade.riskReward}:1` : "—"}`,
    `- Expected holding style: ${analysis.trade?.holding ?? "—"}`,
    "", "RISK:",
    `- Spread: ${analysis.risk.spread}`,
    `- News: ${analysis.risk.news}`,
    `- Structure invalidation: ${analysis.risk.invalidation}`,
    `- Main setup risk: ${analysis.risk.main}`,
    ...analysis.warnings.map((warning) => `- Warning: ${warning}`),
    "", `DECISION: ${analysis.decision}`,
    "", `REASON: ${analysis.reason}`);
  return lines.join("\n");
}

/** Setup tags for orders placed from an analysis; the server sets their lifetime. */
export const MARKET_ANALYSIS_SETUP: Record<AnalysisMode, string> = {
  NORMAL: "market-regime-normal-v1",
  SWING: "market-regime-swing-v1",
};

/**
 * The frozen record saved with an order placed from this analysis (the
 * backend keeps it as `frozenContext`), so forward-test trades can be scored
 * by mode, regime and setup later.
 */
export function marketAnalysisContext(analysis: MarketAnalysis) {
  return {
    version: 1,
    direction: analysis.decision === "LONG" ? "long" : "short",
    setup: MARKET_ANALYSIS_SETUP[analysis.mode],
    frozen: {
      mode: analysis.mode,
      primaryTimeframe: analysis.primaryTimeframe,
      regime: analysis.regime,
      regimeConfidence: analysis.regimeConfidence,
      context: analysis.context,
      hierarchy: analysis.hierarchy,
      setupType: analysis.setupType,
      structure: analysis.structure,
      trend: analysis.trend,
      range: analysis.range,
      planned: analysis.trade ? { ...analysis.trade, currentPrice: analysis.currentPrice } : null,
      risk: analysis.risk,
      warnings: analysis.warnings,
      activateAfter: analysis.activateAfter,
      reason: analysis.reason,
    },
  };
}
