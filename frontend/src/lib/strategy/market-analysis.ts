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
 * Entries, stops and targets come from detected structure. A trade is
 * refused when price is extended away from the pullback, when the next
 * structure leaves too little room, or when the spread eats the stop.
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

export const MARKET_ANALYSIS = {
  /** Minimum reward to risk for a trade to be offered. */
  minRewardRisk: 1.5,
  /** Stop buffer past structure, in primary-timeframe ATRs (spread added on top). */
  stopBufferAtr: 0.25,
  /** Never a stop tighter than this many primary-timeframe ATRs from the entry. */
  minStopAtr: 0.75,
  /** Distance from the pullback zone, in ATRs: up to this is low chase risk... */
  lowChaseAtr: 1,
  /** ...up to this medium; beyond it price is extended and no trade is offered. */
  maxChaseAtr: 2.5,
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
  /** ...and above this the trade is refused. */
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
  } | null;
  risk: { spread: string; news: string; invalidation: string; main: string };
  /** Hold the order until after imminent high-impact news (ISO), else null. */
  activateAfter: string | null;
  reason: string;
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
    risk: { spread: spreadPips === null ? "Unknown (no live quote)" : `${spreadPips.toFixed(1)} pips`, news: "No high-impact news found", invalidation: "—", main: "—" },
    activateAfter: null,
    reason: read.interpretation,
  };

  const news = input.newsEvents?.length ? newsCheck(input.instrument, input.newsEvents, input.now ?? Date.now(), 0) : null;
  if (news) {
    result.risk.news = news.warning.replace(/: a news candle can run past a 0-pip stop\. Consider closing before it\./, ": elevated volatility risk around the release.");
    result.activateAfter = news.activateAfter;
  }

  if (!(atr > 0)) {
    result.reason = "Not enough completed candles to read structure.";
    return result;
  }

  const buffer = settings.stopBufferAtr * atr + (spreadPips ?? 0) * pip;
  /** Builds the trade, refusing when the reward to the best structural target is too small or costs too high. */
  const finishTrade = (direction: "LONG" | "SHORT", entry: number, structureStop: number, targets: number[], setup: SetupType, invalidation: string) => {
    const long = direction === "LONG";
    // Past structure, and never inside normal noise for the timeframe.
    const risk = Math.max(Math.abs(entry - structureStop), settings.minStopAtr * atr);
    const stop = long ? entry - risk : entry + risk;
    if (!(risk > 0)) return "The stop would sit on the entry.";
    const candidates = targets
      .filter((target) => long ? target > entry : target < entry)
      .sort((a, b) => long ? a - b : b - a);
    const target = candidates.find((candidate) => Math.abs(candidate - entry) / risk >= settings.minRewardRisk);
    if (target === undefined) {
      return `Not enough room: the next structure gives under ${settings.minRewardRisk}R.`;
    }
    const stopPips = risk / pip;
    if (spreadPips !== null && spreadPips > settings.spreadRejectShare * stopPips) {
      return `Spread (${spreadPips.toFixed(1)} pips) is ${Math.round((spreadPips / stopPips) * 100)}% of the ${stopPips.toFixed(1)}-pip stop; too costly.`;
    }
    const atEntry = Math.abs(price - entry) <= 0.1 * atr || (long ? price < entry : price > entry);
    result.decision = direction;
    result.setupType = setup;
    result.trade = {
      entry: round(atEntry ? price : entry),
      stopLoss: round(stop),
      takeProfit: round(target),
      riskReward: Number((Math.abs(target - entry) / risk).toFixed(2)),
      stopPips: Number(stopPips.toFixed(1)),
      targetPips: Number((Math.abs(target - entry) / pip).toFixed(1)),
      orderType: atEntry ? "MARKET" : long ? "BUY_LIMIT" : "SELL_LIMIT",
      holding: config.holding,
    };
    result.risk.invalidation = invalidation;
    const spreadShare = spreadPips === null ? null : spreadPips / stopPips;
    result.risk.spread = spreadPips === null
      ? result.risk.spread
      : `${spreadPips.toFixed(1)} pips (${Math.round(spreadShare! * 100)}% of stop, ${Math.round((spreadPips / (Math.abs(target - entry) / pip)) * 100)}% of target)${spreadShare! > settings.spreadWarnShare ? " — high" : ""}`;
    return null;
  };

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
    if (chaseRisk === "HIGH") {
      result.reason = `${read.regime === "UPTREND" ? "Uptrend" : "Downtrend"}, but price is ${distanceAtr.toFixed(1)} ATR past the pullback zone ${zoneText(zone, digits)}. Do not chase; wait for the pullback.`;
      result.risk.main = "Extended price: entering now would chase the move.";
      return result;
    }
    // Pullback already beyond the zone toward the structure: still valid while
    // the structure holds; the entry is then price itself.
    const entry = up ? Math.min(entryEdge, Math.max(price, legLow)) : Math.max(entryEdge, Math.min(price, legHigh));
    const stop = zone.tested
      ? (up ? Math.min(zone.low, structureLevel) : Math.max(zone.high, structureLevel)) - (up ? buffer : -buffer)
      : structureLevel - (up ? buffer : -buffer);
    const opposite = read.zones.filter((candidate) => candidate.touches >= 2).map((candidate) => up ? candidate.low : candidate.high);
    const measuredMove = entry + (up ? 1 : -1) * (legHigh - legLow);
    const refusal = finishTrade(up ? "LONG" : "SHORT", entry, stop, [impulse.to.price, ...opposite, measuredMove], "TREND_PULLBACK",
      `${up ? "Close below" : "Close above"} ${structureLevel.toFixed(digits)} (the ${up ? "higher low" : "lower high"}) ends the trend.`);
    if (refusal) {
      result.reason = `${read.regime === "UPTREND" ? "Uptrend" : "Downtrend"} pullback into ${zoneText(zone, digits)}, but: ${refusal}`;
      result.risk.main = refusal;
      return result;
    }
    result.risk.main = contextAgrees === false
      ? `${config.context} is ${contextRead!.regime}: this trade runs against the higher timeframe.`
      : chaseRisk === "MEDIUM" ? "Price may not pull back far enough to fill." : "Structure failure through the invalidation level.";
    result.reason = `${read.interpretation} ${up ? "Buy" : "Sell"} the pullback at ${zone.kind}, ${zoneText(zone, digits)}.`;
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
    if (location !== "MIDDLE" && read.confidence !== settings.rangeTradeMinConfidence) {
      result.reason = `Range ${range.low.toFixed(digits)}–${range.high.toFixed(digits)}, price ${location === "NEAR SUPPORT" ? "near support" : "near resistance"}, but the range is not established enough to trade (${read.confidence.toLowerCase()} confidence; needs 5+ boundary touches).`;
      result.risk.main = "Weak range: young ranges usually break instead of holding.";
      return result;
    }
    if (location === "MIDDLE") {
      result.reason = `Range ${range.low.toFixed(digits)}–${range.high.toFixed(digits)}; price is in the middle (${Math.round(share * 100)}%), a poor location. Wait for a boundary.`;
      result.risk.main = "Poor location: no edge in the middle of a range.";
      return result;
    }
    const long = location === "NEAR SUPPORT";
    const entry = long ? Math.min(price, range.lowZone.high) : Math.max(price, range.highZone.low);
    const stop = long ? range.low - buffer : range.high + buffer;
    const refusal = finishTrade(long ? "LONG" : "SHORT", entry, stop, [long ? range.highZone.low : range.lowZone.high, range.mid], long ? "RANGE_SUPPORT" : "RANGE_RESISTANCE",
      `A close ${long ? "below" : "above"} ${(long ? range.low : range.high).toFixed(digits)} breaks the range.`);
    if (refusal) {
      result.reason = `Range ${long ? "support" : "resistance"} trade, but: ${refusal}`;
      result.risk.main = refusal;
      return result;
    }
    result.risk.main = "Boundary failure: a confirmed break turns the range into a transition.";
    result.reason = `${read.interpretation} Price is near ${long ? "support" : "resistance"}; ${long ? "buy" : "sell"} toward the opposite side.`;
    return result;
  }

  // TRANSITION: no pullback trade is manufactured.
  result.reason = `${read.interpretation} Reassess once a new regime is confirmed.`;
  result.risk.main = "No confirmed regime.";
  return result;
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
    `- Stop Loss: ${price(analysis.trade?.stopLoss)}${analysis.trade ? ` (${analysis.trade.stopPips} pips)` : ""}`,
    `- Take Profit: ${price(analysis.trade?.takeProfit)}${analysis.trade ? ` (${analysis.trade.targetPips} pips)` : ""}`,
    `- Risk/Reward: ${analysis.trade ? `${analysis.trade.riskReward}:1` : "—"}`,
    `- Expected holding style: ${analysis.trade?.holding ?? "—"}`,
    "", "RISK:",
    `- Spread: ${analysis.risk.spread}`,
    `- News: ${analysis.risk.news}`,
    `- Structure invalidation: ${analysis.risk.invalidation}`,
    `- Main setup risk: ${analysis.risk.main}`,
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
      activateAfter: analysis.activateAfter,
      reason: analysis.reason,
    },
  };
}
