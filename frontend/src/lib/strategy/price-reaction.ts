import type { Candle, MajorInstrument } from "@/types/forex";
import { pipSizeFor } from "@/lib/instruments/catalog";
import { computeSupportResistanceLevels } from "@/lib/strategy/support-resistance";
import type { SrStructureAssessment } from "@/lib/strategy/sr-structure";
import type { MarketCondition, PriceLocation, TrendDirection } from "@/lib/strategy/market-condition";
import type { OverallMigration } from "@/lib/strategy/sr-structure";

/**
 * Stage 3 price-action + S/R reaction engine.
 *
 * candles → impulse → approach → S/R interaction → fakeout vs acceptance →
 * rejection evidence → structure shift → confirmation state. Deterministic and
 * UI-free so it can be reused for active-trade monitoring later. No AI, no
 * entry/SL/TP (that is Stage 4).
 *
 * Frozen S/R (item 10): penetration, fakeout and acceptance are measured
 * against a FROZEN reference boundary — the outer range as it stood BEFORE the
 * recent probe (the range computed on candles excluding the last `reactionBars`),
 * or an explicit frozen level supplied by a monitor. A live recalculation of
 * Support/Resistance must never be allowed to erase a failed breakout, so the
 * reference is held fixed while the recent candles are judged against it.
 */

export type ImpulseDirection = "BULLISH_IMPULSE" | "BEARISH_IMPULSE" | "NO_IMPULSE";
export type ApproachClass = "AGGRESSIVE" | "CONTROLLED" | "WEAK" | "CHOPPY" | "NONE";
export type InteractionState =
  | "APPROACHING"
  | "TOUCHING"
  | "PENETRATING"
  | "REJECTING"
  | "RECLAIMED"
  | "ACCEPTED_BREAKOUT"
  | "NO_INTERACTION";
export type FakeoutState = "SUPPORT_FALSE_BREAK" | "RESISTANCE_FALSE_BREAK" | "NONE";
export type AcceptanceState = "NOT_ACCEPTED" | "POSSIBLE_ACCEPTANCE" | "ACCEPTED";
export type RejectionStrength = "NONE" | "WEAK" | "MODERATE" | "STRONG";
export type StructureShift = "BULLISH" | "BEARISH" | "NONE";
export type ConfirmationState = "ENTER_CONDITION_MET" | "WAIT" | "INVALIDATED";
export type ReactionSide = "support" | "resistance";

/** ---- Centralized, tunable thresholds (documented, not overfit). ---- */
export const PRICE_REACTION_THRESHOLDS = {
  // Impulse
  impulseMaxBars: 5,
  impulseMinBars: 2,
  /** Net displacement across the impulse window, in ATR14 units. */
  impulseMinDisplacementAtr: 1.2,
  /** Share of window candles whose body agrees with the net direction. */
  impulseMinConsistency: 0.6,
  /** Average overlap of adjacent candles must stay below this. */
  impulseMaxOverlap: 0.5,
  /** Largest counter-move / net move must stay below this. */
  impulseMaxRetrace: 0.5,

  // Approach
  /** Price must be within this many ATRs of an outer level to be "approaching". */
  approachMaxAtr: 1.5,

  // Interaction / probe
  /** Candles inspected for penetration and bars-outside. */
  outsideLookback: 5,
  /** Recent candles treated as "the reaction" (and excluded from the frozen ref). */
  reactionBars: 3,
  /** A level touch tolerance in ATR (wick/close within this counts as touching). */
  touchAtr: 0.1,
  /** Distance in ATR under which an un-touched level counts as APPROACHING. */
  approachStateAtr: 0.75,
  /** Minimum penetration (ATR) for a poke to count as a real penetration. */
  minPenetrationAtr: 0.05,

  // Fakeout
  /** A false break must have penetrated at least this far (ATR)... */
  fakeoutMinPenetrationAtr: 0.1,
  /** ...and reclaimed within this many completed candles. */
  fakeoutMaxBarsOutside: 3,

  // Rejection evidence (weights sum to 1.0)
  rejWickAtr: 0.5,
  rejBodyAtr: 0.5,
  rejWeightWick: 0.3,
  rejWeightCloseInside: 0.25,
  rejWeightStrongBody: 0.2,
  rejWeightFollowThrough: 0.15,
  rejWeightFailedContinuation: 0.1,
  rejStrongScore: 0.7,
  rejModerateScore: 0.45,

  // Accepted breakout
  /** A meaningful close beyond the level (ATR). */
  acceptMinCloseAtr: 0.25,
  /** Completed candles closing beyond the level to accept. */
  acceptMinBars: 2,
  /** Distance beyond the level (ATR) to accept. */
  acceptMinDistanceAtr: 0.4,

  // Structure shift
  structureLookback: 12,
  structurePivotReach: 1,

  // Confirmation
  maxConfirmationBars: 3,
  /** Rejection score at/above this can confirm on candle 1. */
  confirmStrongScore: 0.6,
} as const;

export type PriceReactionThresholds = { -readonly [K in keyof typeof PRICE_REACTION_THRESHOLDS]: number };

export interface ImpulseRead {
  direction: ImpulseDirection;
  /** Deterministic 0..1 strength (never an AI probability). */
  strength: number;
  candleCount: number;
  displacementPips: number;
  displacementAtr: number;
  overlap: number;
  retrace: number;
  consistency: number;
}

export interface SideReaction {
  side: ReactionSide;
  /** The FROZEN reference boundary this side was judged against. */
  frozenLevel: number;
  /** The latest live level for the same boundary (may differ). */
  liveLevel: number;
  penetrationPips: number;
  penetrationAtr: number;
  maximumPenetrationPips: number;
  maximumPenetrationAtr: number;
  barsOutside: number;
  currentlyBeyond: boolean;
  reclaimed: boolean;
  reclaimTimestamp: string | null;
  fakeout: FakeoutState;
  acceptanceState: AcceptanceState;
  barsBeyondLevel: number;
  distanceBeyondPips: number;
  distanceBeyondAtr: number;
  rejectionScore: number;
  rejectionStrength: RejectionStrength;
  rejectionEvidence: string[];
  interactionState: InteractionState;
}

export interface PriceReactionDebug {
  pair: string;
  timeframe: string;
  marketCondition: MarketCondition | null;
  srMigration: OverallMigration | null;
  nearestOuterSide: ReactionSide | null;
  nearestOuterFrozen: number | null;
  nearestOuterLive: number | null;
  impulseDirection: ImpulseDirection;
  impulseStrength: number;
  impulseCandleCount: number;
  approach: ApproachClass;
  interactionState: InteractionState;
  penetrationPips: number | null;
  penetrationAtr: number | null;
  barsBeyond: number | null;
  fakeoutState: FakeoutState;
  rejectionScore: number | null;
  rejectionStrength: RejectionStrength;
  reclaimed: boolean;
  acceptanceState: AcceptanceState;
  structureShift: StructureShift;
  confirmationState: ConfirmationState;
  maxConfirmationCandles: number;
  currentConfirmationCandleCount: number;
  atrPips: number;
}

export interface PriceReactionContext {
  marketCondition: MarketCondition;
  trendDirection: TrendDirection;
  location: PriceLocation;
  migration: OverallMigration;
}

export interface PriceReactionAssessment {
  instrument: MajorInstrument;
  timeframe: string;
  impulse: ImpulseRead;
  approach: ApproachClass;
  /** The side price is interacting with, if any. */
  primarySide: ReactionSide | null;
  support: SideReaction;
  resistance: SideReaction;
  structureShift: StructureShift;
  structureShiftLevel: number | null;
  confirmationState: ConfirmationState;
  /** support→long, resistance→short; the side confirmation is watching. */
  confirmationBias: "long" | "short" | null;
  maxConfirmationCandles: number;
  currentConfirmationCandleCount: number;
  debug: PriceReactionDebug;
}

const round = (value: number, places = 3) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const bodySign = (candle: Candle) => Math.sign(candle.close - candle.open);

/** -------------------------------- Impulse -------------------------------- */
export function detectImpulse(
  completed: Candle[],
  atr: number,
  pip: number,
  t: PriceReactionThresholds = PRICE_REACTION_THRESHOLDS,
): ImpulseRead {
  const empty: ImpulseRead = {
    direction: "NO_IMPULSE",
    strength: 0,
    candleCount: 0,
    displacementPips: 0,
    displacementAtr: 0,
    overlap: 0,
    retrace: 1,
    consistency: 0,
  };
  if (completed.length < t.impulseMinBars || atr <= 0) return empty;

  const window = completed.slice(-t.impulseMaxBars);
  const net = window.at(-1)!.close - window[0]!.open;
  const netAbs = Math.abs(net);
  const dir = Math.sign(net);
  const displacementAtr = netAbs / atr;

  // Consistency: candles whose body agrees with the net direction.
  const agreeing = window.filter((candle) => bodySign(candle) === dir).length;
  const consistency = window.length ? agreeing / window.length : 0;

  // Overlap of adjacent candles.
  let overlapSum = 0;
  let overlapPairs = 0;
  for (let index = 1; index < window.length; index += 1) {
    const a = window[index - 1]!;
    const b = window[index]!;
    const overlap = Math.max(0, Math.min(a.high, b.high) - Math.max(a.low, b.low));
    const combined = Math.max(a.high, b.high) - Math.min(a.low, b.low);
    if (combined > 0) {
      overlapSum += overlap / combined;
      overlapPairs += 1;
    }
  }
  const overlap = overlapPairs ? overlapSum / overlapPairs : 0;

  // Retracement: largest counter-move against the net direction / net move.
  let maxAdverse = 0;
  let running = window[0]!.open;
  for (const candle of window) {
    const move = dir >= 0 ? running - candle.low : candle.high - running;
    if (move > maxAdverse) maxAdverse = move;
    running = dir >= 0 ? Math.max(running, candle.close) : Math.min(running, candle.close);
  }
  const retrace = netAbs > 0 ? Math.min(1, maxAdverse / netAbs) : 1;

  // Trailing run of candles in the net direction.
  let candleCount = 0;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (bodySign(window[index]!) === dir && dir !== 0) candleCount += 1;
    else break;
  }

  const isImpulse =
    displacementAtr >= t.impulseMinDisplacementAtr &&
    consistency >= t.impulseMinConsistency &&
    overlap <= t.impulseMaxOverlap &&
    retrace <= t.impulseMaxRetrace &&
    dir !== 0;

  // Deterministic 0..1 strength from the same measurable factors.
  const strength = Math.max(
    0,
    Math.min(
      1,
      0.4 * Math.min(displacementAtr / (t.impulseMinDisplacementAtr * 2), 1) +
        0.25 * consistency +
        0.2 * (1 - overlap) +
        0.15 * (1 - retrace),
    ),
  );

  return {
    direction: !isImpulse ? "NO_IMPULSE" : dir > 0 ? "BULLISH_IMPULSE" : "BEARISH_IMPULSE",
    strength: round(strength, 3),
    candleCount,
    displacementPips: round(net / pip, 1),
    displacementAtr: round(displacementAtr * (dir < 0 ? -1 : 1), 3),
    overlap: round(overlap, 3),
    retrace: round(retrace, 3),
    consistency: round(consistency, 3),
  };
}

/** ------------------------------ Structure shift ------------------------------ */
export function detectStructureShift(
  completed: Candle[],
  t: PriceReactionThresholds = PRICE_REACTION_THRESHOLDS,
): { shift: StructureShift; level: number | null } {
  const reach = t.structurePivotReach;
  const window = completed.slice(-t.structureLookback);
  if (window.length < reach * 2 + 3) return { shift: "NONE", level: null };

  const swingHighs: Array<{ index: number; price: number }> = [];
  const swingLows: Array<{ index: number; price: number }> = [];
  for (let index = reach; index < window.length - reach; index += 1) {
    const candle = window[index]!;
    const slice = window.slice(index - reach, index + reach + 1);
    if (slice.every((other) => other === candle || other.high <= candle.high)) {
      swingHighs.push({ index, price: candle.high });
    }
    if (slice.every((other) => other === candle || other.low >= candle.low)) {
      swingLows.push({ index, price: candle.low });
    }
  }
  const lastClose = window.at(-1)!.close;
  // Bullish shift: after a down move (recent lower highs), close breaks the most
  // recent minor swing high upward.
  const lastSwingHigh = swingHighs.at(-1);
  const priorSwingHigh = swingHighs.at(-2);
  if (lastSwingHigh && priorSwingHigh && lastSwingHigh.price < priorSwingHigh.price && lastClose > lastSwingHigh.price) {
    return { shift: "BULLISH", level: lastSwingHigh.price };
  }
  // Bearish shift: after an up move (recent higher lows), close breaks the most
  // recent minor swing low downward.
  const lastSwingLow = swingLows.at(-1);
  const priorSwingLow = swingLows.at(-2);
  if (lastSwingLow && priorSwingLow && lastSwingLow.price > priorSwingLow.price && lastClose < lastSwingLow.price) {
    return { shift: "BEARISH", level: lastSwingLow.price };
  }
  return { shift: "NONE", level: null };
}

/** --------------------------- Per-side S/R reaction --------------------------- */
function evaluateSide(
  side: ReactionSide,
  frozenLevel: number,
  liveLevel: number,
  completed: Candle[],
  atr: number,
  pip: number,
  t: PriceReactionThresholds,
): SideReaction {
  const probe = completed.slice(-t.outsideLookback);
  const last = completed.at(-1)!;
  const touch = t.touchAtr * atr;

  // "beyond" is below the level for support, above it for resistance.
  const beyond = (price: number) => (side === "support" ? frozenLevel - price : price - frozenLevel);
  const extreme = (candle: Candle) => (side === "support" ? candle.low : candle.high);
  const oppBody = (candle: Candle) => (side === "support" ? candle.close - candle.open : candle.open - candle.close);
  const rejWick = (candle: Candle) =>
    side === "support"
      ? Math.min(candle.open, candle.close) - candle.low
      : candle.high - Math.max(candle.open, candle.close);

  const maxPenetration = Math.max(0, ...probe.map((candle) => beyond(extreme(candle))));
  const penetrationClose = Math.max(0, beyond(last.close));
  const currentlyBeyond = beyond(last.close) > touch;

  // Trailing run of completed candles that CLOSED beyond the frozen level.
  let barsOutside = 0;
  for (let index = completed.length - 1; index >= 0; index -= 1) {
    if (beyond(completed[index]!.close) > touch) barsOutside += 1;
    else break;
  }

  const penetratedMeaningfully = maxPenetration >= t.minPenetrationAtr * atr;
  const reclaimed = penetratedMeaningfully && !currentlyBeyond;
  // The reclaim happened on the first recent candle that closed back inside.
  let reclaimTimestamp: string | null = null;
  if (reclaimed) {
    for (let index = completed.length - 1; index >= 0; index -= 1) {
      if (beyond(completed[index]!.close) <= touch) reclaimTimestamp = completed[index]!.time;
      else break;
    }
  }

  // Fakeout: real penetration, reclaimed within the allowed window.
  const fakeout: FakeoutState =
    penetratedMeaningfully &&
    maxPenetration >= t.fakeoutMinPenetrationAtr * atr &&
    reclaimed &&
    barsOutside === 0 &&
    countRecentOutside(completed, beyond, touch, t) <= t.fakeoutMaxBarsOutside
      ? side === "support"
        ? "SUPPORT_FALSE_BREAK"
        : "RESISTANCE_FALSE_BREAK"
      : "NONE";

  // Acceptance: sustained, meaningful close beyond the level.
  const distanceBeyond = penetrationClose;
  const distanceBeyondAtr = atr > 0 ? distanceBeyond / atr : 0;
  const meaningfulClose = distanceBeyond >= t.acceptMinCloseAtr * atr;
  let acceptanceState: AcceptanceState = "NOT_ACCEPTED";
  if (barsOutside >= t.acceptMinBars && distanceBeyondAtr >= t.acceptMinDistanceAtr) {
    acceptanceState = "ACCEPTED";
  } else if (meaningfulClose && currentlyBeyond) {
    acceptanceState = "POSSIBLE_ACCEPTANCE";
  }

  // Rejection evidence (only meaningful once the level was probed).
  const evidence: string[] = [];
  let score = 0;
  if (penetratedMeaningfully) {
    const extremeCandle = probe.reduce((best, candle) => (beyond(extreme(candle)) > beyond(extreme(best)) ? candle : best), probe[0]!);
    const prev = completed.at(-2);
    if (rejWick(extremeCandle) / atr >= t.rejWickAtr) {
      score += t.rejWeightWick;
      evidence.push("rejection wick");
    }
    if (!currentlyBeyond) {
      score += t.rejWeightCloseInside;
      evidence.push("closed back inside");
    }
    if (oppBody(last) / atr >= t.rejBodyAtr) {
      score += t.rejWeightStrongBody;
      evidence.push("strong opposite body");
    }
    if (prev && (oppBody(prev) > 0 || (side === "support" ? last.close > prev.close : last.close < prev.close))) {
      score += t.rejWeightFollowThrough;
      evidence.push("follow-through");
    }
    const madeNewExtreme = beyond(extreme(last)) >= maxPenetration - 1e-9;
    if (!madeNewExtreme) {
      score += t.rejWeightFailedContinuation;
      evidence.push("failed continuation");
    }
  }
  score = Math.max(0, Math.min(1, score));
  const rejectionStrength: RejectionStrength =
    score >= t.rejStrongScore ? "STRONG" : score >= t.rejModerateScore ? "MODERATE" : score > 0 ? "WEAK" : "NONE";

  // Distance from current price to the frozen level (for approach/no-interaction).
  const distanceToLevel = Math.abs(last.close - frozenLevel);

  // Derive a single interaction state.
  let interactionState: InteractionState;
  if (acceptanceState === "ACCEPTED") {
    interactionState = "ACCEPTED_BREAKOUT";
  } else if (reclaimed && (fakeout !== "NONE" || rejectionStrength !== "NONE")) {
    interactionState = "RECLAIMED";
  } else if (currentlyBeyond) {
    interactionState = "PENETRATING";
  } else if (penetratedMeaningfully) {
    interactionState = "REJECTING";
  } else if (distanceToLevel <= touch) {
    interactionState = "TOUCHING";
  } else if (distanceToLevel <= t.approachStateAtr * atr) {
    interactionState = "APPROACHING";
  } else {
    interactionState = "NO_INTERACTION";
  }

  return {
    side,
    frozenLevel,
    liveLevel,
    penetrationPips: round(penetrationClose / pip, 1),
    penetrationAtr: atr > 0 ? round(penetrationClose / atr, 3) : 0,
    maximumPenetrationPips: round(maxPenetration / pip, 1),
    maximumPenetrationAtr: atr > 0 ? round(maxPenetration / atr, 3) : 0,
    barsOutside,
    currentlyBeyond,
    reclaimed,
    reclaimTimestamp,
    fakeout,
    acceptanceState,
    barsBeyondLevel: barsOutside,
    distanceBeyondPips: round(distanceBeyond / pip, 1),
    distanceBeyondAtr: round(distanceBeyondAtr, 3),
    rejectionScore: round(score, 3),
    rejectionStrength,
    rejectionEvidence: evidence,
    interactionState,
  };
}

/** Count how many of the recent completed candles closed beyond the level. */
function countRecentOutside(
  completed: Candle[],
  beyond: (price: number) => number,
  touch: number,
  t: PriceReactionThresholds,
): number {
  const probe = completed.slice(-t.outsideLookback);
  return probe.filter((candle) => beyond(candle.close) > touch).length;
}

/** ------------------------------- Approach ------------------------------- */
function classifyApproach(
  impulse: ImpulseRead,
  nearestDistanceAtr: number | null,
  towardLevel: boolean,
  t: PriceReactionThresholds,
): ApproachClass {
  if (nearestDistanceAtr === null || nearestDistanceAtr > t.approachMaxAtr || !towardLevel) return "NONE";
  const disp = Math.abs(impulse.displacementAtr);
  if (impulse.overlap >= 0.55 && impulse.retrace >= 0.5) return "CHOPPY";
  if (impulse.direction !== "NO_IMPULSE" && disp >= t.impulseMinDisplacementAtr) return "AGGRESSIVE";
  if (disp >= 0.6 && impulse.consistency >= 0.5) return "CONTROLLED";
  return "WEAK";
}

/** ------------------------------ Main entry ------------------------------ */
export function analyzePriceReaction(input: {
  candles: Candle[];
  instrument: MajorInstrument;
  sr: SrStructureAssessment;
  context?: PriceReactionContext;
  frozenSupport?: number;
  frozenResistance?: number;
  /** Timeframe-profile overrides (impulse sensitivity, confirmation window…). */
  thresholds?: Partial<PriceReactionThresholds>;
}): PriceReactionAssessment {
  const t: PriceReactionThresholds = { ...PRICE_REACTION_THRESHOLDS, ...input.thresholds };
  const { instrument, sr, context } = input;
  const pip = pipSizeFor(instrument);
  const atr = sr.frozen.atr;
  const timeframe = sr.timeframe;
  const completed = input.candles.filter((candle) => candle.complete !== false);
  const last = completed.at(-1);

  // Frozen reference boundary = outer range BEFORE the recent probe (or supplied
  // override). Never the live recalculated level, so a failed break can't vanish.
  const reference = completed.length > t.reactionBars
    ? computeSupportResistanceLevels(completed.slice(0, -t.reactionBars), instrument)
    : null;
  const frozenSupport = input.frozenSupport ?? reference?.rangeLow ?? sr.frozen.supportRange;
  const frozenResistance = input.frozenResistance ?? reference?.rangeHigh ?? sr.frozen.resistanceRange;

  const impulse = detectImpulse(completed, atr, pip, t);
  const support = evaluateSide("support", frozenSupport, sr.live.supportRange, completed, atr, pip, t);
  const resistance = evaluateSide("resistance", frozenResistance, sr.live.resistanceRange, completed, atr, pip, t);
  const { shift: structureShift, level: structureShiftLevel } = detectStructureShift(completed, t);

  // Pick the primary side: whichever shows a real interaction, else the nearer.
  const supportActive = support.interactionState !== "NO_INTERACTION";
  const resistanceActive = resistance.interactionState !== "NO_INTERACTION";
  const close = last?.close ?? frozenSupport;
  const distToSupport = Math.abs(close - frozenSupport);
  const distToResistance = Math.abs(close - frozenResistance);
  let primarySide: ReactionSide | null;
  if (supportActive && !resistanceActive) primarySide = "support";
  else if (resistanceActive && !supportActive) primarySide = "resistance";
  else if (supportActive && resistanceActive) primarySide = distToSupport <= distToResistance ? "support" : "resistance";
  else primarySide = null;

  const primary = primarySide === "support" ? support : primarySide === "resistance" ? resistance : null;

  // Approach: is price moving toward the primary (or nearest) outer level?
  const nearestSide: ReactionSide | null = primarySide ?? (distToSupport <= distToResistance ? "support" : "resistance");
  const nearestDistanceAtr = atr > 0
    ? (nearestSide === "support" ? distToSupport : distToResistance) / atr
    : null;
  const towardLevel = nearestSide === "support"
    ? impulse.displacementAtr < 0 || (last !== undefined && last.close <= frozenSupport + t.approachStateAtr * atr)
    : impulse.displacementAtr > 0 || (last !== undefined && last.close >= frozenResistance - t.approachStateAtr * atr);
  const approach = classifyApproach(impulse, nearestDistanceAtr, Boolean(towardLevel), t);

  // Confirmation. Context is echoed but the broader market never auto-vetoes a
  // reversal (item 9): a bearish market does not force-reject a support long.
  const confirmationBias: "long" | "short" | null = primarySide === "support" ? "long" : primarySide === "resistance" ? "short" : null;
  const currentConfirmationCandleCount = primary ? primary.barsOutside : 0;
  const structureAgrees =
    (primarySide === "support" && structureShift === "BULLISH") ||
    (primarySide === "resistance" && structureShift === "BEARISH");

  let confirmationState: ConfirmationState = "WAIT";
  if (!primary || primary.interactionState === "NO_INTERACTION") {
    confirmationState = "WAIT";
  } else if (primary.acceptanceState === "ACCEPTED") {
    // The level gave way — the reversal setup is invalidated (a breakout is its
    // own Stage 4 concern, not a reversal confirmation).
    confirmationState = "INVALIDATED";
  } else if (
    primary.reclaimed &&
    primary.rejectionScore >= t.confirmStrongScore &&
    (structureAgrees || primary.rejectionStrength === "STRONG")
  ) {
    // Can confirm on candle 1 — do not force waiting for candle 2/3.
    confirmationState = "ENTER_CONDITION_MET";
  } else if (primary.currentlyBeyond && primary.barsOutside > t.maxConfirmationBars) {
    confirmationState = "INVALIDATED";
  } else {
    confirmationState = "WAIT";
  }

  const debug: PriceReactionDebug = {
    pair: instrument,
    timeframe,
    marketCondition: context?.marketCondition ?? null,
    srMigration: context?.migration ?? sr.overallMigration,
    nearestOuterSide: nearestSide,
    nearestOuterFrozen: nearestSide === "support" ? frozenSupport : frozenResistance,
    nearestOuterLive: nearestSide === "support" ? sr.live.supportRange : sr.live.resistanceRange,
    impulseDirection: impulse.direction,
    impulseStrength: impulse.strength,
    impulseCandleCount: impulse.candleCount,
    approach,
    interactionState: primary?.interactionState ?? "NO_INTERACTION",
    penetrationPips: primary ? primary.penetrationPips : null,
    penetrationAtr: primary ? primary.penetrationAtr : null,
    barsBeyond: primary ? primary.barsBeyondLevel : null,
    fakeoutState: primary?.fakeout ?? "NONE",
    rejectionScore: primary ? primary.rejectionScore : null,
    rejectionStrength: primary?.rejectionStrength ?? "NONE",
    reclaimed: primary?.reclaimed ?? false,
    acceptanceState: primary?.acceptanceState ?? "NOT_ACCEPTED",
    structureShift,
    confirmationState,
    maxConfirmationCandles: t.maxConfirmationBars,
    currentConfirmationCandleCount,
    atrPips: atr > 0 ? round(atr / pip, 1) : 0,
  };

  return {
    instrument,
    timeframe,
    impulse,
    approach,
    primarySide,
    support,
    resistance,
    structureShift,
    structureShiftLevel,
    confirmationState,
    confirmationBias,
    maxConfirmationCandles: t.maxConfirmationBars,
    currentConfirmationCandleCount,
    debug,
  };
}
