import type { Candle, MajorInstrument } from "@/types/forex";
import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import type { MarketAssessment, MarketCondition } from "@/lib/strategy/market-condition";
import type { SrStructureAssessment, RangeWidthClass } from "@/lib/strategy/sr-structure";
import type { PriceReactionAssessment, ReactionSide } from "@/lib/strategy/price-reaction";

/**
 * Stage 4 trade-proposal engine.
 *
 * Stages 1–3 context → trade candidate → entry → structural SL → swing target →
 * R:R + spread validation → LONG / SHORT / WAIT / NO_TRADE. Deterministic and
 * UI-free so realtime monitoring can reuse it. The AI never invents these
 * numbers; it only interprets the finished proposal.
 *
 * Item 16: everything uses information available at the click. Penetration and
 * structure are measured against the Stage 2/3 FROZEN S/R, never a repainted
 * live level. No future candles.
 */

export type ProposalAction = "LONG" | "SHORT" | "WAIT" | "NO_TRADE";
/**
 * Stage 8 state model. PLANNED = a full range-reversion plan exists (entry/SL/TP)
 * but the entry trigger has not confirmed yet; READY = the trigger confirmed.
 * WAIT = no actionable outer boundary (e.g. middle of range). INVALIDATED = an
 * accepted breakout cancelled the range trade (never reversed into a breakout).
 */
export type ProposalStatus =
  | "WAIT"
  | "PLANNED"
  | "READY"
  | "INVALIDATED"
  | "NO_TRADE";
export type SetupType =
  | "SUPPORT_FALSE_BREAK_RECLAIM"
  | "RESISTANCE_FALSE_BREAK_RECLAIM"
  | "SUPPORT_REJECTION"
  | "RESISTANCE_REJECTION"
  | "NONE";
/** The range-reversion family: which outer boundary the plan trades back from. */
export type SetupFamily = "SUPPORT_REVERSION" | "RESISTANCE_REVERSION" | "NONE";
export type TargetType =
  | "RESISTANCE_SWING"
  | "SUPPORT_SWING"
  | "RESISTANCE_RANGE"
  | "SUPPORT_RANGE"
  | "NONE";

/** ---- Centralized, tunable thresholds (not tuned to past outcomes). ---- */
export const TRADE_PROPOSAL_THRESHOLDS = {
  /** Minimum acceptable reward:risk. Structure comes first, then this gate. */
  minRiskReward: 1.3,
  /** Structural SL safety buffer = max(this × ATR14, floor). Fakeout-aware. */
  slBufferAtrFraction: 0.3,
  slMinBufferPips: 2,
  /**
   * Volatility breathing room: the SL distance from entry is floored to at least
   * max(this × ATR14, avgCandleRange × slMinRangeMult) + spread. This stops
   * unrealistically tight stops (e.g. a 2-pip SL when the average candle is
   * ~1.4 pips and the spread is ~1.6 pips) — but the stop is still placed beyond
   * the structural invalidation, and it is NOT a fixed widening.
   */
  slMinAtrFraction: 1.0,
  slMinRangeMult: 2.5,
  /** Recent completed candles averaged for the "average move" / breathing room. */
  avgMoveLookback: 14,
  /** Reject when spread eats more than this share of reward / risk. */
  maxSpreadPctOfReward: 33,
  maxSpreadPctOfRisk: 50,
  /** Targets smaller than this are not worth the spread. */
  minRewardPips: 4,
  /** Completed candles scanned for the structural (fakeout/rejection) extreme. */
  reactionExtremeLookback: 6,
  /** Reject when spread eats more than this share of the whole S/R range. */
  maxSpreadPctOfRange: 25,
  /** Acceptable penetration beyond the boundary (ATR) — the fakeout/invalidation
   *  zone. Price may move this far past S/R with the range thesis still valid. */
  expectedPenetrationAtr: 0.5,
  /** How far inside the boundary the entry zone starts (ATR). */
  entryInnerBufferAtr: 0.1,
} as const;

export type TradeProposalThresholds = { -readonly [K in keyof typeof TRADE_PROPOSAL_THRESHOLDS]: number };

export interface TradeProposalDebug {
  pair: string;
  timeframe: string;
  currentPrice: number;
  marketCondition: MarketCondition;
  frozenSupport: number;
  frozenResistance: number;
  liveSupport: number;
  liveResistance: number;
  srMigration: string;
  nearestSide: ReactionSide | null;
  rangeWidthClass: RangeWidthClass;
  rangeWidthPips: number;
  rangeWidthAtr: number;
  spreadPctOfRange: number | null;
  impulse: string;
  approach: string;
  interactionState: string;
  fakeoutState: string;
  rejectionStrength: string;
  reclaimed: boolean;
  acceptanceState: string;
  confirmationState: string;
  suggestedDirection: ProposalAction;
  setupFamily: SetupFamily;
  trigger: string;
  invalidation: string;
  entryPrice: number | null;
  preferredEntry: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  expectedPenetrationPips: number | null;
  structuralExtreme: number | null;
  slBufferPips: number | null;
  slBufferAtr: number | null;
  avgMovePips: number | null;
  stopLoss: number | null;
  targetLevel: number | null;
  targetType: TargetType;
  riskPips: number | null;
  rewardPips: number | null;
  riskReward: number | null;
  spreadPips: number;
  spreadPctOfRisk: number | null;
  spreadPctOfReward: number | null;
  finalAction: ProposalAction;
  finalReason: string;
}

export interface TradeProposal {
  action: ProposalAction;
  status: ProposalStatus;
  /** The timeframe this proposal was built for (OANDA granularity). */
  analysisTimeframe: string;
  marketCondition: MarketCondition;
  setupType: SetupType;
  rangeWidthClass: RangeWidthClass;
  /** support→long, resistance→short. */
  side: ReactionSide | null;
  setupFamily: SetupFamily;
  /** What entry behaviour will flip PLANNED → READY. */
  trigger: string;
  /** What cancels the range trade (an accepted breakout — never a reversal). */
  invalidation: string;

  entryPrice: number | null;
  /** The single best price inside the entry zone. */
  preferredEntry: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  /** Acceptable penetration beyond the boundary before the thesis is void. */
  expectedPenetrationPips: number | null;
  entryReason: string;

  stopLoss: number | null;
  structuralExtreme: number | null;
  slBufferPips: number | null;
  slBufferAtr: number | null;
  /** Average completed-candle range in pips (the "average move"). */
  avgMovePips: number | null;
  riskPips: number | null;

  takeProfit: number | null;
  targetType: TargetType;
  rewardPips: number | null;

  riskReward: number | null;

  spreadPips: number;
  spreadPctOfRisk: number | null;
  spreadPctOfReward: number | null;
  spreadPctOfRange: number | null;

  confirmation: string;
  reason: string;

  debug: TradeProposalDebug;
}

const round = (value: number, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Build the deterministic proposal from the Stage 1–3 assessments + quote. */
export function buildTradeProposal(input: {
  instrument: MajorInstrument;
  candles: Candle[];
  quote: { bid: number; ask: number; mid: number };
  assessment: MarketAssessment;
  sr: SrStructureAssessment;
  reaction: PriceReactionAssessment;
  /** The timeframe this proposal is for (OANDA granularity). Default sr.timeframe. */
  timeframe?: string;
  /** Timeframe-profile overrides (min R:R, SL buffer, spread limits…). */
  thresholds?: Partial<TradeProposalThresholds>;
}): TradeProposal {
  const t: TradeProposalThresholds = { ...TRADE_PROPOSAL_THRESHOLDS, ...input.thresholds };
  const { instrument, quote, assessment, sr, reaction } = input;
  const analysisTimeframe = input.timeframe ?? sr.timeframe;
  const pip = pipSizeFor(instrument);
  const precision = precisionFor(instrument);
  const fmt = (value: number) => Number(value.toFixed(precision));
  const atr = sr.frozen.atr;
  const completed = input.candles.filter((candle) => candle.complete !== false);
  const currentPrice = quote.mid;
  const spreadPips = round((quote.ask - quote.bid) / pip, 1);
  const spreadPctOfRange = sr.rangeWidthPips > 0 ? round((spreadPips / sr.rangeWidthPips) * 100, 0) : null;

  // ---- 6: Direction follows LOCATION, strictly. Resistance = SHORT, Support
  // = LONG. A small penetration/fakeout beyond a boundary still evaluates the
  // SAME mean-reversion side (never flips to the breakout). Middle = no side. ----
  const aboveRange = currentPrice > sr.frozen.resistanceRange;
  const belowRange = currentPrice < sr.frozen.supportRange;
  let side: ReactionSide | null;
  if (assessment.location === "NEAR_RESISTANCE") side = "resistance";
  else if (assessment.location === "NEAR_SUPPORT") side = "support";
  else if (assessment.location === "OUTSIDE_RANGE") side = aboveRange ? "resistance" : belowRange ? "support" : null;
  else side = null; // MIDDLE_OF_RANGE
  const sideReaction = side === "support" ? reaction.support : side === "resistance" ? reaction.resistance : null;
  const isLong = side === "support";

  const setupFamily: SetupFamily = side === "support" ? "SUPPORT_REVERSION" : side === "resistance" ? "RESISTANCE_REVERSION" : "NONE";
  const trigger = isLong
    ? "Support rejection / failed break / reclaim"
    : "Resistance rejection / failed break / reclaim";
  const invalidation = isLong
    ? "Accepted breakdown below Support"
    : "Accepted breakout above Resistance";
  // Reaction detail (which behaviour is currently forming). Never required.
  const setupType: SetupType = !side
    ? "NONE"
    : side === "support"
      ? sideReaction!.fakeout === "SUPPORT_FALSE_BREAK" ? "SUPPORT_FALSE_BREAK_RECLAIM" : "SUPPORT_REJECTION"
      : sideReaction!.fakeout === "RESISTANCE_FALSE_BREAK" ? "RESISTANCE_FALSE_BREAK_RECLAIM" : "RESISTANCE_REJECTION";

  const baseDebug: TradeProposalDebug = {
    pair: instrument,
    timeframe: sr.timeframe,
    currentPrice: fmt(currentPrice),
    marketCondition: assessment.condition,
    frozenSupport: fmt(sr.frozen.supportRange),
    frozenResistance: fmt(sr.frozen.resistanceRange),
    liveSupport: fmt(sr.live.supportRange),
    liveResistance: fmt(sr.live.resistanceRange),
    srMigration: sr.overallMigration,
    nearestSide: reaction.debug.nearestOuterSide,
    rangeWidthClass: sr.rangeWidthClass,
    rangeWidthPips: sr.rangeWidthPips,
    rangeWidthAtr: sr.rangeWidthAtr,
    spreadPctOfRange,
    impulse: reaction.impulse.direction,
    approach: reaction.approach,
    interactionState: reaction.debug.interactionState,
    fakeoutState: reaction.debug.fakeoutState,
    rejectionStrength: reaction.debug.rejectionStrength,
    reclaimed: reaction.debug.reclaimed,
    acceptanceState: reaction.debug.acceptanceState,
    confirmationState: reaction.confirmationState,
    suggestedDirection: side === "support" ? "LONG" : side === "resistance" ? "SHORT" : "WAIT",
    setupFamily,
    trigger,
    invalidation,
    entryPrice: null,
    preferredEntry: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    expectedPenetrationPips: null,
    structuralExtreme: null,
    slBufferPips: null,
    slBufferAtr: null,
    avgMovePips: null,
    stopLoss: null,
    targetLevel: null,
    targetType: "NONE",
    riskPips: null,
    rewardPips: null,
    riskReward: null,
    spreadPips,
    spreadPctOfRisk: null,
    spreadPctOfReward: null,
    finalAction: "WAIT",
    finalReason: "",
  };

  const decided = (
    action: ProposalAction,
    status: ProposalStatus,
    confirmation: string,
    reason: string,
    entryReason: string,
    extra: Partial<TradeProposal> = {},
  ): TradeProposal => ({
    action,
    status,
    analysisTimeframe,
    marketCondition: assessment.condition,
    setupType,
    setupFamily,
    trigger,
    invalidation,
    rangeWidthClass: sr.rangeWidthClass,
    side,
    entryPrice: extra.entryPrice ?? null,
    preferredEntry: extra.preferredEntry ?? null,
    entryZoneLow: extra.entryZoneLow ?? null,
    entryZoneHigh: extra.entryZoneHigh ?? null,
    expectedPenetrationPips: extra.expectedPenetrationPips ?? null,
    entryReason,
    stopLoss: extra.stopLoss ?? null,
    structuralExtreme: extra.structuralExtreme ?? null,
    slBufferPips: extra.slBufferPips ?? null,
    slBufferAtr: extra.slBufferAtr ?? null,
    avgMovePips: extra.avgMovePips ?? null,
    riskPips: extra.riskPips ?? null,
    takeProfit: extra.takeProfit ?? null,
    targetType: extra.targetType ?? "NONE",
    rewardPips: extra.rewardPips ?? null,
    riskReward: extra.riskReward ?? null,
    spreadPips,
    spreadPctOfRisk: extra.spreadPctOfRisk ?? null,
    spreadPctOfReward: extra.spreadPctOfReward ?? null,
    spreadPctOfRange,
    confirmation,
    reason,
    debug: {
      ...baseDebug,
      finalAction: action,
      finalReason: reason,
      entryPrice: extra.entryPrice ?? null,
      preferredEntry: extra.preferredEntry ?? null,
      entryZoneLow: extra.entryZoneLow ?? null,
      entryZoneHigh: extra.entryZoneHigh ?? null,
      expectedPenetrationPips: extra.expectedPenetrationPips ?? null,
      structuralExtreme: extra.structuralExtreme ?? null,
      slBufferPips: extra.slBufferPips ?? null,
      slBufferAtr: extra.slBufferAtr ?? null,
      avgMovePips: extra.avgMovePips ?? null,
      stopLoss: extra.stopLoss ?? null,
      targetLevel: extra.takeProfit ?? null,
      targetType: extra.targetType ?? "NONE",
      riskPips: extra.riskPips ?? null,
      rewardPips: extra.rewardPips ?? null,
      riskReward: extra.riskReward ?? null,
      spreadPctOfRisk: extra.spreadPctOfRisk ?? null,
      spreadPctOfReward: extra.spreadPctOfReward ?? null,
    },
  });

  // ---- 3: Market condition gate. Messy chop is normally NO_TRADE. ----
  if (assessment.condition === "MESSY_CHOP") {
    return decided("NO_TRADE", "NO_TRADE", "NONE", "Messy chop — no clean structure to trade.", "No entry: messy chop.");
  }

  // ---- 6 / Example G: middle of range → WAIT, never manufacture a trade. ----
  if (!side || !sideReaction) {
    return decided("WAIT", "WAIT", "NONE", "Price is in the middle of the range — not near an actionable boundary.", "Waiting for price to reach an outer boundary.");
  }

  // ---- 18: An ACCEPTED breakout CANCELS the range trade. Never reverse. ----
  if (sideReaction.acceptanceState === "ACCEPTED") {
    const reason = isLong
      ? "Accepted breakdown below Support — long cancelled (we do not short the breakdown)."
      : "Accepted breakout above Resistance — short cancelled (we do not long the breakout).";
    return decided("NO_TRADE", "INVALIDATED", "NONE", reason, "Cancelled: level accepted a breakout.");
  }

  // ---- 3 / 15: A too-tight outer range leaves no room after spread. ----
  if (sr.rangeWidthClass === "TOO_TIGHT") {
    return decided("NO_TRADE", "NO_TRADE", "NONE", "Range too tight to trade after spread.", "No entry: range too tight.");
  }

  // ================= PLAN THE TRADE NOW (item 7). =================
  // The plan is computed regardless of confirmation; confirmation only decides
  // PLANNED vs READY.
  const boundary = sideReaction.frozenLevel;
  const expectedPenetration = atr * t.expectedPenetrationAtr;   // item 10
  const innerBuffer = atr * t.entryInnerBufferAtr;
  const expectedPenetrationPips = round(expectedPenetration / pip, 1);

  // ---- 9: Best entry area — at / near / slightly beyond the boundary. ----
  // SHORT: sell at/above resistance up to the penetration ceiling.
  // LONG:  buy at/below support down to the penetration floor.
  let entryZoneLow: number;
  let entryZoneHigh: number;
  let preferredEntry: number;
  if (isLong) {
    entryZoneLow = boundary - expectedPenetration;      // acceptable fakeout floor
    entryZoneHigh = boundary + innerBuffer;             // just inside the range
    // Prefer the current price when it is already inside the zone; else the boundary.
    preferredEntry = Math.min(Math.max(currentPrice, entryZoneLow), entryZoneHigh);
  } else {
    entryZoneLow = boundary - innerBuffer;
    entryZoneHigh = boundary + expectedPenetration;     // acceptable fakeout ceiling
    preferredEntry = Math.max(Math.min(currentPrice, entryZoneHigh), entryZoneLow);
  }
  const entryReason = isLong
    ? `Long the Support ${fmt(boundary)} reversion; buy the boundary/fakeout back into the range.`
    : `Short the Resistance ${fmt(boundary)} reversion; sell the boundary/fakeout back into the range.`;

  // ---- 13: SL = beyond the structural invalidation, floored to volatility
  // breathing room. Two independent requirements, and we take whichever is
  // FURTHER (never tighter, never a fixed widening):
  //   (a) structural: beyond the recent extreme / boundary+penetration + buffer.
  //   (b) volatility: at least max(1×ATR, avgCandleRange×2.5) + spread from entry.
  // The final risk in pips is then an OUTPUT of (a)/(b), and R:R falls out of it.
  const structuralExtreme = structuralExtremeOf(completed, side, t.reactionExtremeLookback);
  const slBuffer = Math.max(atr * t.slBufferAtrFraction, t.slMinBufferPips * pip);
  const invalidationAnchor = isLong
    ? Math.min(structuralExtreme, boundary - expectedPenetration)
    : Math.max(structuralExtreme, boundary + expectedPenetration);
  const structuralStop = isLong ? invalidationAnchor - slBuffer : invalidationAnchor + slBuffer;
  const structuralDistance = Math.abs(preferredEntry - structuralStop);

  const avgMove = averageCandleRange(completed, t.avgMoveLookback);
  const spreadPrice = quote.ask - quote.bid;
  const volatilityFloor = Math.max(atr * t.slMinAtrFraction, avgMove * t.slMinRangeMult) + spreadPrice;

  const slDistance = Math.max(structuralDistance, volatilityFloor);
  const stopLoss = isLong ? preferredEntry - slDistance : preferredEntry + slDistance;
  const riskPips = round(slDistance / pip, 1);
  const slBufferPips = round(slBuffer / pip, 1);
  const slBufferAtr = atr > 0 ? round(slBuffer / atr, 2) : null;
  const avgMovePips = round(avgMove / pip, 1);

  const planExtras = {
    entryPrice: fmt(preferredEntry), preferredEntry: fmt(preferredEntry),
    entryZoneLow: fmt(entryZoneLow), entryZoneHigh: fmt(entryZoneHigh), expectedPenetrationPips,
    structuralExtreme: fmt(structuralExtreme), slBufferPips, slBufferAtr, avgMovePips, stopLoss: fmt(stopLoss), riskPips,
  };

  if ((isLong && stopLoss >= preferredEntry) || (!isLong && stopLoss <= preferredEntry) || riskPips <= 0) {
    return decided("NO_TRADE", "NO_TRADE", "NONE", "No valid structural stop for this setup.", entryReason, planExtras);
  }

  // ---- 14 / 15: Target = internal Swing back inside the range. Never target
  // the opposite outer boundary across a WIDE / EXTREME range. ----
  const target = selectTarget(side, preferredEntry, sr, pip);
  if (!target) {
    return decided("NO_TRADE", "NO_TRADE", "NONE", "No valid structural target inside the range (no usable swing).", entryReason, planExtras);
  }
  const takeProfit = target.price;
  const rewardPips = round(Math.abs(takeProfit - preferredEntry) / pip, 1);
  const riskReward = riskPips > 0 ? round(rewardPips / riskPips, 2) : 0;
  const spreadPctOfRisk = riskPips > 0 ? round((spreadPips / riskPips) * 100, 0) : null;
  const spreadPctOfReward = rewardPips > 0 ? round((spreadPips / rewardPips) * 100, 0) : null;
  const numbers: Partial<TradeProposal> = {
    ...planExtras,
    takeProfit: fmt(takeProfit), targetType: target.type, rewardPips, riskReward, spreadPctOfRisk, spreadPctOfReward,
  };

  // ---- 16: Economics gates. Structure was fixed first; only now do we judge. ----
  if (rewardPips < t.minRewardPips) {
    return decided("NO_TRADE", "NO_TRADE", "NONE", `Target only ${rewardPips} pips away — too small to trade.`, entryReason, numbers);
  }
  if (riskReward < t.minRiskReward) {
    return decided("NO_TRADE", "NO_TRADE", "NONE", `R:R ${riskReward} is below the ${t.minRiskReward} minimum.`, entryReason, numbers);
  }
  if (spreadPctOfReward !== null && spreadPctOfReward > t.maxSpreadPctOfReward) {
    return decided("NO_TRADE", "NO_TRADE", "NONE", `Spread / TP is ${spreadPctOfReward}% — the target is too small for the spread.`, entryReason, numbers);
  }
  if (spreadPctOfRisk !== null && spreadPctOfRisk > t.maxSpreadPctOfRisk) {
    return decided("NO_TRADE", "NO_TRADE", "NONE", `Spread / SL is ${spreadPctOfRisk}% — execution cost too high for the stop distance.`, entryReason, numbers);
  }
  if (spreadPctOfRange !== null && spreadPctOfRange > t.maxSpreadPctOfRange) {
    return decided("NO_TRADE", "NO_TRADE", "NONE", `Spread is ${spreadPctOfRange}% of the range — too tight after spread.`, entryReason, numbers);
  }

  // ---- 8 / 11 / 23: Confirmation only decides PLANNED vs READY. ----
  const action: ProposalAction = isLong ? "LONG" : "SHORT";
  const confirmedForDirection =
    reaction.confirmationState === "ENTER_CONDITION_MET" &&
    (isLong ? reaction.confirmationBias === "long" : reaction.confirmationBias === "short");
  const targetLabel = target.type.endsWith("SWING") ? (isLong ? "resistance swing" : "support swing") : "internal structure";

  if (confirmedForDirection) {
    const reason = isLong
      ? `Support reversion confirmed; long toward ${targetLabel} at ${fmt(takeProfit)} (${riskReward}R).`
      : `Resistance reversion confirmed; short toward ${targetLabel} at ${fmt(takeProfit)} (${riskReward}R).`;
    return decided(action, "READY", trigger, reason, entryReason, numbers);
  }
  const reason = isLong
    ? `Support reversion planned; long toward ${targetLabel} at ${fmt(takeProfit)} (${riskReward}R). Waiting for: ${trigger}.`
    : `Resistance reversion planned; short toward ${targetLabel} at ${fmt(takeProfit)} (${riskReward}R). Waiting for: ${trigger}.`;
  return decided(action, "PLANNED", trigger, reason, entryReason, numbers);
}

/** Average candle range (high−low), in price, over the recent completed candles. */
function averageCandleRange(completed: Candle[], lookback: number): number {
  const window = completed.slice(-lookback);
  if (!window.length) return 0;
  return window.reduce((sum, candle) => sum + (candle.high - candle.low), 0) / window.length;
}

/** The fakeout/rejection extreme over the recent completed candles. */
function structuralExtremeOf(completed: Candle[], side: ReactionSide, lookback: number): number {
  const probe = completed.slice(-lookback);
  if (!probe.length) return completed.at(-1)?.close ?? 0;
  return side === "support"
    ? Math.min(...probe.map((candle) => candle.low))
    : Math.max(...probe.map((candle) => candle.high));
}

/**
 * Target selection. LONG prefers a resistance swing above entry; SHORT a
 * support swing below entry. The opposite outer Range is used only when the
 * range is NORMAL and no swing exists — never for WIDE / EXTREME ranges.
 */
function selectTarget(
  side: ReactionSide,
  entry: number,
  sr: SrStructureAssessment,
  pip: number,
): { price: number; type: TargetType } | null {
  const minGap = TRADE_PROPOSAL_THRESHOLDS.minRewardPips * pip;
  const wideOrExtreme = sr.rangeWidthClass === "WIDE" || sr.rangeWidthClass === "EXTREME";

  if (side === "support") {
    const swing = sr.frozen.resistanceSwing ?? sr.live.resistanceSwing;
    if (swing !== null && swing > entry + minGap) return { price: swing, type: "RESISTANCE_SWING" };
    if (!wideOrExtreme) {
      const outer = sr.frozen.resistanceRange;
      if (outer > entry + minGap) return { price: outer, type: "RESISTANCE_RANGE" };
    }
    return null;
  }
  const swing = sr.frozen.supportSwing ?? sr.live.supportSwing;
  if (swing !== null && swing < entry - minGap) return { price: swing, type: "SUPPORT_SWING" };
  if (!wideOrExtreme) {
    const outer = sr.frozen.supportRange;
    if (outer < entry - minGap) return { price: outer, type: "SUPPORT_RANGE" };
  }
  return null;
}

export interface ProposalViolation {
  code: string;
  message: string;
}

/**
 * Stage 7 contradiction / sanity checks (item 11). A directional proposal that
 * trips any of these is structurally impossible or self-inconsistent and must
 * be rejected rather than silently shown. Pure and testable; the pipeline
 * downgrades a tripping LONG/SHORT to NO_TRADE.
 */
export function validateProposal(
  proposal: TradeProposal,
  sr: SrStructureAssessment,
  reaction: PriceReactionAssessment,
): ProposalViolation[] {
  const violations: ProposalViolation[] = [];
  const push = (code: string, message: string) => violations.push({ code, message });

  // Timeframe isolation — the proposal, S/R and reaction must share a timeframe.
  if (proposal.analysisTimeframe !== sr.timeframe) {
    push("TIMEFRAME_MISMATCH", `Proposal timeframe ${proposal.analysisTimeframe} != S/R timeframe ${sr.timeframe}.`);
  }

  if (proposal.action !== "LONG" && proposal.action !== "SHORT") return violations;
  const isLong = proposal.action === "LONG";

  // A directional proposal must be PLANNED (plan ready, awaiting trigger) or
  // READY (trigger confirmed).
  if (proposal.status !== "READY" && proposal.status !== "PLANNED") {
    push("BAD_STATUS", `Directional proposal has status ${proposal.status}, expected PLANNED or READY.`);
  }
  // READY specifically must come from a met confirmation for this direction.
  if (proposal.status === "READY" && reaction.confirmationState !== "ENTER_CONDITION_MET") {
    push("CONFIRMATION_NOT_MET", `READY proposal while confirmation is ${reaction.confirmationState}.`);
  }

  const { entryPrice, stopLoss, takeProfit, riskPips, rewardPips, riskReward, spreadPips } = proposal;
  if (entryPrice === null || stopLoss === null || takeProfit === null) {
    push("MISSING_LEVELS", "Directional proposal is missing entry, stop, or target.");
    return violations;
  }

  // Geometry: SL on the losing side, TP on the winning side.
  if (isLong && !(stopLoss < entryPrice)) push("SL_SIDE", "LONG stop loss is not below entry.");
  if (isLong && !(takeProfit > entryPrice)) push("TP_SIDE", "LONG target is not above entry.");
  if (!isLong && !(stopLoss > entryPrice)) push("SL_SIDE", "SHORT stop loss is not above entry.");
  if (!isLong && !(takeProfit < entryPrice)) push("TP_SIDE", "SHORT target is not below entry.");

  if (!(riskPips !== null && riskPips > 0)) push("RISK_NONPOSITIVE", "Risk in pips is not positive.");
  if (!(rewardPips !== null && rewardPips > 0)) push("REWARD_NONPOSITIVE", "Reward in pips is not positive.");

  // R:R must equal reward/risk (numbers were not fudged to fit).
  if (riskPips !== null && rewardPips !== null && riskPips > 0 && riskReward !== null) {
    const expected = rewardPips / riskPips;
    if (Math.abs(expected - riskReward) > 0.05) push("RR_MISMATCH", `R:R ${riskReward} != reward/risk ${expected.toFixed(2)}.`);
  }

  // Target must clear execution cost.
  if (rewardPips !== null && rewardPips <= spreadPips) push("TARGET_INSIDE_SPREAD", `Reward ${rewardPips}p is inside the ${spreadPips}p spread.`);

  // Never fade a level that has already accepted a break against the trade.
  const entrySide = isLong ? reaction.support : reaction.resistance;
  if (entrySide.acceptanceState === "ACCEPTED") {
    push("FADING_ACCEPTED_BREAKOUT", `${isLong ? "LONG" : "SHORT"} reversal while the ${isLong ? "support" : "resistance"} level accepted a breakout.`);
  }

  return violations;
}
