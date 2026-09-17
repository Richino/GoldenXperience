import type { Candle, MajorInstrument } from "@/types/forex";
import { pipSizeFor } from "@/lib/instruments/catalog";
import { assessMarketCondition, type MarketCondition } from "@/lib/strategy/market-condition";
import {
  analyzeSrStructure,
  type SrSnapshot,
  type OverallMigration,
} from "@/lib/strategy/sr-structure";
import { analyzePriceReaction, type ImpulseDirection } from "@/lib/strategy/price-reaction";
import { profileFor } from "@/lib/strategy/timeframe-profiles";

/**
 * Stage 5 live trade-monitoring + S/R alert engine.
 *
 * Active trade → original frozen context + current candles → Stages 1–3 engines
 * → compare original vs live → trade-health engine → HOLD / WARNING /
 * EXIT_SUGGESTED + alert events. Deterministic and UI-free. It never moves SL/TP
 * or closes anything (item 14); it only recommends.
 *
 * Item 19: only information available now is used. The frozen context is passed
 * in and never rewritten; migration is measured against it. Structural decisions
 * use completed candles (item 2).
 */

export type TradeHealthStatus = "HOLD" | "WARNING" | "EXIT_SUGGESTED";
export type TradeDirection = "long" | "short";

export type MonitorEventType =
  | "NEW_SUPPORT"
  | "NEW_RESISTANCE"
  | "SR_MIGRATION"
  | "OPPOSITE_IMPULSE"
  | "MARKET_CONDITION_CHANGE"
  | "STRUCTURE_FAILURE"
  | "WARNING"
  | "EXIT_SUGGESTED";

/** The original Analyze context, frozen when the trade became active. */
export interface FrozenTradeContext {
  version: 1;
  instrument: MajorInstrument;
  timeframe: string;
  direction: TradeDirection;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  setupType: string;
  marketConditionAtEntry: MarketCondition;
  migrationAtEntry: OverallMigration;
  /** Entry-time S/R snapshot — the comparison baseline. Never overwritten. */
  frozen: SrSnapshot;
  reactionAtEntry: {
    interactionState: string;
    fakeout: string;
    rejectionStrength: string;
    confirmation: string;
    structureShift: string;
  };
  createdAt: string;
}

export interface MonitorEvent {
  type: MonitorEventType;
  timestamp: string;
  tradeId: string | null;
  instrument: MajorInstrument;
  timeframe: string;
  level: number | null;
  reason: string;
  /** Compact market snapshot for later review. */
  snapshot: {
    price: number;
    marketCondition: MarketCondition;
    migration: OverallMigration;
    impulse: ImpulseDirection;
    unrealizedR: number;
  };
  /** Stable key for deduplication. */
  dedupeKey: string;
}

export interface HealthFactor {
  name: string;
  /** Signed contribution to the score (negative = adverse to the trade). */
  contribution: number;
  note: string;
}

export interface TradeMonitorDebug {
  tradeId: string | null;
  pair: string;
  timeframe: string;
  direction: TradeDirection;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  currentPrice: number;
  unrealizedR: number;
  distanceToTpPips: number;
  distanceToSlPips: number;
  originalMarketCondition: MarketCondition;
  currentMarketCondition: MarketCondition;
  originalSupport: number;
  originalResistance: number;
  currentSupport: number;
  currentResistance: number;
  srMigration: OverallMigration;
  newSupportSwing: number | null;
  newResistanceSwing: number | null;
  currentImpulse: ImpulseDirection;
  originalSetup: string;
  currentInteraction: string;
  currentAcceptance: string;
  newOpposingStructure: number | null;
  structureFailed: boolean;
  healthScore: number;
  factors: HealthFactor[];
  status: TradeHealthStatus;
  reason: string;
}

export interface TradeHealth {
  status: TradeHealthStatus;
  /** Structural health 0..100 (NOT a probability of winning). */
  score: number;
  reason: string;
  unrealizedR: number;
  events: MonitorEvent[];
  factors: HealthFactor[];
  debug: TradeMonitorDebug;
}

/** ---- Centralized, tunable weights + thresholds. ---- */
export const TRADE_MONITOR_WEIGHTS = {
  baseline: 100,
  structureFailure: -70,
  acceptedBreakoutAgainst: -70,
  oppositeImpulseMax: -22,
  newOpposingSr: -18,
  repeatedRejectionOfNewSr: -12,
  migrationUnfavorable: -12,
  conditionTurnedOpposite: -18,
  conditionTurnedMessy: -12,
  supportiveImpulseMax: 10,
  migrationFavorable: 6,
} as const;

export const TRADE_MONITOR_THRESHOLDS = {
  /** Score at/below this is EXIT_SUGGESTED; at/below warn is WARNING. */
  exitScore: 45,
  warnScore: 75,
  /** A meaningful opposite impulse needs at least this strength (0..1). */
  opposingImpulseMinStrength: 0.35,
  /** A new opposing level counts once it is at least this fraction of ATR14
   *  different from the original (matches Stage 2 significance). */
  newLevelSignificanceAtr: 0.25,
  /** Profit-protection: once unrealized R is at/above this, adverse evidence
   *  escalates sooner (thresholds are raised). */
  profitProtectionR: 0.6,
  profitProtectionBump: 12,
} as const;

const round = (value: number, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Assemble the frozen context at the moment a proposal becomes an active trade.
 * Called on accept and persisted with the trade; never rewritten afterwards.
 */
export function freezeTradeContext(input: {
  instrument: MajorInstrument;
  timeframe: string;
  direction: TradeDirection;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  setupType: string;
  marketConditionAtEntry: MarketCondition;
  migrationAtEntry: OverallMigration;
  frozen: SrSnapshot;
  reactionAtEntry: FrozenTradeContext["reactionAtEntry"];
}): FrozenTradeContext {
  return { version: 1, createdAt: new Date().toISOString(), ...input };
}

/** Unrealized R from a price: (move in favor) / (entry→SL risk). */
function unrealizedRFrom(direction: TradeDirection, entry: number, stopLoss: number, price: number): number {
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return 0;
  const move = direction === "long" ? price - entry : entry - price;
  return round(move / risk, 2);
}

/**
 * The one entry point. Feed the frozen context + current candles + quote and it
 * returns the trade-health assessment and any alert events (already deduped is
 * the caller's job via `dedupeKey`).
 */
export function monitorTrade(input: {
  context: FrozenTradeContext;
  candles: Candle[];
  quote: { bid: number; ask: number; mid: number };
  tradeId?: string | null;
}): TradeHealth {
  const w = TRADE_MONITOR_WEIGHTS;
  const th = TRADE_MONITOR_THRESHOLDS;
  const { context } = input;
  const instrument = context.instrument;
  const pip = pipSizeFor(instrument);
  const isLong = context.direction === "long";
  const tradeId = input.tradeId ?? null;
  const completed = input.candles.filter((candle) => candle.complete !== false);
  const lastClose = completed.at(-1)?.close ?? input.quote.mid;
  const timestamp = completed.at(-1)?.time ?? new Date().toISOString();

  // --- Reuse the Stages 1–3 engines on current candles, using the trade's OWN
  // frozen-timeframe profile (item 15) — not whatever chart the user is viewing. ---
  const profile = profileFor(context.timeframe);
  const assessment = assessMarketCondition({
    candles: input.candles,
    instrument,
    timeframe: context.timeframe,
    windows: profile.windows,
    thresholds: profile.marketCondition,
  });
  // Migration is measured against the ENTRY-time frozen snapshot (item 4).
  const currentSr = analyzeSrStructure({
    candles: input.candles,
    instrument,
    timeframe: context.timeframe,
    migrationStepBars: profile.migrationStepBars,
    thresholds: profile.sr,
    previousSnapshot: context.frozen,
  });
  // Reaction uses the ENTRY frozen boundaries so a failed level can't repaint.
  const reaction = currentSr
    ? analyzePriceReaction({
        candles: input.candles,
        instrument,
        sr: currentSr,
        thresholds: profile.reaction,
        frozenSupport: context.frozen.supportRange,
        frozenResistance: context.frozen.resistanceRange,
      })
    : null;

  const atr = context.frozen.atr;
  const unrealizedR = unrealizedRFrom(context.direction, context.entry, context.stopLoss, lastClose);
  const distanceToTpPips = round(Math.abs(context.takeProfit - lastClose) / pip, 1);
  const distanceToSlPips = round(Math.abs(lastClose - context.stopLoss) / pip, 1);

  const currentCondition = assessment.condition;
  const migration = currentSr?.overallMigration ?? "STABLE";
  const impulse = reaction?.impulse ?? { direction: "NO_IMPULSE" as ImpulseDirection, strength: 0 };

  // Current live levels + entry-side reaction.
  const currentSupport = currentSr?.frozen.supportRange ?? context.frozen.supportRange;
  const currentResistance = currentSr?.frozen.resistanceRange ?? context.frozen.resistanceRange;
  const currentSupportSwing = currentSr?.frozen.supportSwing ?? null;
  const currentResistanceSwing = currentSr?.frozen.resistanceSwing ?? null;
  const entrySideReaction = reaction ? (isLong ? reaction.support : reaction.resistance) : null;
  const oppSideReaction = reaction ? (isLong ? reaction.resistance : reaction.support) : null;

  const factors: HealthFactor[] = [];
  const events: MonitorEvent[] = [];
  const snapshot = {
    price: round(lastClose, 5),
    marketCondition: currentCondition,
    migration,
    impulse: impulse.direction,
    unrealizedR,
  };
  const pushEvent = (type: MonitorEventType, level: number | null, reason: string, keyExtra = "") => {
    events.push({
      type,
      timestamp,
      tradeId,
      instrument,
      timeframe: context.timeframe,
      level: level === null ? null : round(level, 5),
      reason,
      snapshot,
      dedupeKey: `${type}:${level === null ? "" : level.toFixed(5)}${keyExtra ? `:${keyExtra}` : ""}`,
    });
  };

  let score: number = w.baseline;
  const add = (name: string, contribution: number, note: string) => {
    if (contribution === 0) return;
    score += contribution;
    factors.push({ name, contribution: round(contribution, 1), note });
  };

  // --- 8: Structure failure — the entry level accepted a break against us. ---
  const structureFailed = Boolean(
    entrySideReaction &&
      (entrySideReaction.acceptanceState === "ACCEPTED" ||
        entrySideReaction.interactionState === "ACCEPTED_BREAKOUT"),
  );
  if (structureFailed) {
    add("structureFailure", w.structureFailure, isLong
      ? "Support accepted a breakdown — original long thesis invalidated."
      : "Resistance accepted a breakout — original short thesis invalidated.");
    pushEvent("STRUCTURE_FAILURE", isLong ? currentSupport : currentResistance, isLong
      ? "Price accepted a break below the entry support with no reclaim."
      : "Price accepted a break above the entry resistance with no reclaim.");
  }

  // --- 6: Momentum — meaningful opposite impulse is adverse. ---
  const opposingImpulse = isLong ? impulse.direction === "BEARISH_IMPULSE" : impulse.direction === "BULLISH_IMPULSE";
  const supportiveImpulse = isLong ? impulse.direction === "BULLISH_IMPULSE" : impulse.direction === "BEARISH_IMPULSE";
  if (opposingImpulse && impulse.strength >= th.opposingImpulseMinStrength) {
    const contribution = w.oppositeImpulseMax * impulse.strength;
    add("oppositeImpulse", contribution, `Opposite ${impulse.direction} (strength ${Math.round(impulse.strength * 100)}%).`);
    pushEvent("OPPOSITE_IMPULSE", null, `A meaningful ${isLong ? "bearish" : "bullish"} impulse formed against the position.`);
  } else if (supportiveImpulse) {
    add("supportiveImpulse", w.supportiveImpulseMax * impulse.strength, `Supportive ${impulse.direction}.`);
  }

  // --- 3 + 5: New opposing S/R between price and target. ---
  const significance = th.newLevelSignificanceAtr * atr;
  const newOpposingStructure = detectNewOpposingLevel({
    isLong,
    lastClose,
    takeProfit: context.takeProfit,
    entryResistanceSwing: context.frozen.resistanceSwing,
    entrySupportSwing: context.frozen.supportSwing,
    currentResistanceSwing,
    currentSupportSwing,
    significance,
  });
  if (newOpposingStructure !== null) {
    add("newOpposingSr", w.newOpposingSr, isLong
      ? "New resistance formed between price and target."
      : "New support formed between price and target.");
    // Repeated rejection at that new level is stronger evidence.
    const rejectingNew = oppSideReaction && (oppSideReaction.interactionState === "REJECTING" || oppSideReaction.rejectionStrength === "MODERATE" || oppSideReaction.rejectionStrength === "STRONG");
    if (rejectingNew) {
      add("repeatedRejectionOfNewSr", w.repeatedRejectionOfNewSr, "Price is repeatedly rejecting the new opposing level.");
    }
    pushEvent(isLong ? "NEW_RESISTANCE" : "NEW_SUPPORT", newOpposingStructure, isLong
      ? `New resistance formed at ${newOpposingStructure.toFixed(5)}, between price and target.`
      : `New support formed at ${newOpposingStructure.toFixed(5)}, between price and target.`);
  }

  // --- 4: S/R migration relative to direction. ---
  if (currentSr) {
    const supportMig = currentSr.migrations.supportRange.direction;
    const resistanceMig = currentSr.migrations.resistanceRange.direction;
    if (isLong) {
      if (supportMig === "UP") add("migrationFavorable", w.migrationFavorable, "Support migrating up — supportive.");
      if (resistanceMig === "DOWN") add("migrationUnfavorable", w.migrationUnfavorable, "Resistance migrating down toward price — unfavorable.");
    } else {
      if (resistanceMig === "DOWN") add("migrationFavorable", w.migrationFavorable, "Resistance migrating down — supportive.");
      if (supportMig === "UP") add("migrationUnfavorable", w.migrationUnfavorable, "Support migrating up toward price — unfavorable.");
    }
    if (migration !== "STABLE" && migration !== context.migrationAtEntry) {
      pushEvent("SR_MIGRATION", null, `Overall S/R structure is now ${migration.replace(/_/g, " ").toLowerCase()}.`, migration);
    }
  }

  // --- 7: Market-condition change relative to the position. ---
  if (currentCondition !== context.marketConditionAtEntry) {
    const turnedOpposite =
      (isLong && currentCondition === "TRENDING_BEARISH") || (!isLong && currentCondition === "TRENDING_BULLISH");
    const turnedMessy = currentCondition === "MESSY_CHOP";
    if (turnedOpposite) {
      add("conditionTurnedOpposite", w.conditionTurnedOpposite, `Market turned ${currentCondition.replace(/_/g, " ").toLowerCase()} against the position.`);
      pushEvent("MARKET_CONDITION_CHANGE", null, `Market condition changed to ${currentCondition.replace(/_/g, " ").toLowerCase()}, against the trade.`, currentCondition);
    } else if (turnedMessy) {
      add("conditionTurnedMessy", w.conditionTurnedMessy, "Market lost structure (messy chop).");
      pushEvent("MARKET_CONDITION_CHANGE", null, "Market condition changed to messy chop.", currentCondition);
    }
  }

  score = Math.max(0, Math.min(100, round(score, 1)));

  // --- 10 + 13: Status from score, with structure-failure override and
  // profit-protection escalation. ---
  const adversePresent = factors.some((factor) => factor.contribution < 0);
  const protect = unrealizedR >= th.profitProtectionR && adversePresent;
  const exitScore = th.exitScore + (protect ? th.profitProtectionBump : 0);
  const warnScore = th.warnScore + (protect ? th.profitProtectionBump : 0);

  let status: TradeHealthStatus;
  if (structureFailed || score <= exitScore) status = "EXIT_SUGGESTED";
  else if (score <= warnScore) status = "WARNING";
  else status = "HOLD";

  const reason = buildReason(status, isLong, structureFailed, factors, unrealizedR, protect);
  if (status === "WARNING") pushEvent("WARNING", null, reason);
  if (status === "EXIT_SUGGESTED") pushEvent("EXIT_SUGGESTED", null, reason);

  const debug: TradeMonitorDebug = {
    tradeId,
    pair: instrument,
    timeframe: context.timeframe,
    direction: context.direction,
    entry: context.entry,
    stopLoss: context.stopLoss,
    takeProfit: context.takeProfit,
    currentPrice: round(lastClose, 5),
    unrealizedR,
    distanceToTpPips,
    distanceToSlPips,
    originalMarketCondition: context.marketConditionAtEntry,
    currentMarketCondition: currentCondition,
    originalSupport: context.frozen.supportRange,
    originalResistance: context.frozen.resistanceRange,
    currentSupport,
    currentResistance,
    srMigration: migration,
    newSupportSwing: currentSupportSwing,
    newResistanceSwing: currentResistanceSwing,
    currentImpulse: impulse.direction,
    originalSetup: context.setupType,
    currentInteraction: entrySideReaction?.interactionState ?? "NO_INTERACTION",
    currentAcceptance: entrySideReaction?.acceptanceState ?? "NOT_ACCEPTED",
    newOpposingStructure,
    structureFailed,
    healthScore: score,
    factors,
    status,
    reason,
  };

  return { status, score, reason, unrealizedR, events, factors, debug };
}

/** A new opposing level significantly nearer than the original, between price and TP. */
function detectNewOpposingLevel(input: {
  isLong: boolean;
  lastClose: number;
  takeProfit: number;
  entryResistanceSwing: number | null;
  entrySupportSwing: number | null;
  currentResistanceSwing: number | null;
  currentSupportSwing: number | null;
  significance: number;
}): number | null {
  const { isLong, lastClose, takeProfit, significance } = input;
  if (isLong) {
    const current = input.currentResistanceSwing;
    if (current === null) return null;
    // Relevant only if it sits between current price and the target.
    if (!(current > lastClose && current < takeProfit)) return null;
    const original = input.entryResistanceSwing;
    // New if there was no swing here before, or it moved down meaningfully.
    if (original === null || current < original - significance) return current;
    return null;
  }
  const current = input.currentSupportSwing;
  if (current === null) return null;
  if (!(current < lastClose && current > takeProfit)) return null;
  const original = input.entrySupportSwing;
  if (original === null || current > original + significance) return current;
  return null;
}

function buildReason(
  status: TradeHealthStatus,
  isLong: boolean,
  structureFailed: boolean,
  factors: HealthFactor[],
  unrealizedR: number,
  protect: boolean,
): string {
  if (status === "HOLD") {
    return `Original thesis intact${unrealizedR !== 0 ? ` (${unrealizedR > 0 ? "+" : ""}${unrealizedR}R)` : ""}.`;
  }
  const adverse = factors
    .filter((factor) => factor.contribution < 0)
    .sort((a, b) => a.contribution - b.contribution)
    .slice(0, 3)
    .map((factor) => factor.note);
  if (status === "EXIT_SUGGESTED") {
    if (structureFailed) {
      return `${isLong ? "Support" : "Resistance"} failed — ${adverse.join(" + ") || "structure invalidated"}.`;
    }
    return `${protect ? "Protecting profit: " : ""}${adverse.join(" + ") || "structure has materially deteriorated"}.`;
  }
  return adverse.join(" + ") || "Some adverse evidence has appeared, but the thesis is not clearly broken.";
}
