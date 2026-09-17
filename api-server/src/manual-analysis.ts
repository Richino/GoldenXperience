import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { currenciesOf } from "../../frontend/src/lib/instruments/catalog.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import {
  assessMarketCondition,
  type MarketAssessment,
  type MarketConditionDebug,
  type MarketCondition,
  type PriceLocation,
} from "../../frontend/src/lib/strategy/market-condition.js";
import {
  analyzeSrStructure,
  type SrStructureAssessment,
} from "../../frontend/src/lib/strategy/sr-structure.js";
import {
  analyzePriceReaction,
  type PriceReactionAssessment,
} from "../../frontend/src/lib/strategy/price-reaction.js";
import {
  buildTradeProposal,
  validateProposal,
  type TradeProposal,
} from "../../frontend/src/lib/strategy/trade-proposal.js";
import { profileFor, type AnalysisTimeframe } from "../../frontend/src/lib/strategy/timeframe-profiles.js";

/** A flat, human-readable trace of one Analyze decision (Stage 7, item 10). */
export type AnalysisTrace = Record<string, string | number | boolean | null>;
import type { MajorInstrument } from "./market-stream-types.js";

/** One higher-timeframe context read (item 12). */
export type HigherTimeframeRead = {
  timeframe: string;
  label: string;
  condition: MarketCondition;
  trend: "bullish" | "bearish" | "sideways";
};

/** Descriptive alignment of higher timeframes to the setup (item 13). */
export type TimeframeConfluence = "ALIGNED" | "MIXED" | "COUNTER_TREND" | "NEUTRAL";

/** LONG, SHORT, WAIT, or NO_TRADE — Analyze is never obligated to pick a side. */
export type AnalyzeAction = "long" | "short" | "wait" | "no_trade";

/** The executable half, present only when the proposal is a READY long/short. */
export type ManualTradePlan = {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  riskPips: number;
  rewardPips: number;
};

export type ManualAnalysisResult = {
  instrument: MajorInstrument;
  /** The OANDA granularity this analysis (and any resulting trade) is frozen to. */
  analysisTimeframe: string;
  analyzedAt: string;
  testOnly: true;
  /** The final Analyze verdict. */
  action: AnalyzeAction;
  /** Deterministic market classification from the condition engine. */
  market: MarketCondition;
  /** Where price sits relative to the existing S/R levels. */
  location: PriceLocation;
  /** The gate that decided whether a proposal was even considered. */
  gate: "CONTINUE" | "WAIT";
  /** Plain-English explanation of the verdict, safe for a beginner. */
  reason: string;
  /** News context, always shown. */
  newsSummary: string;
  /**
   * Stage 4 deterministic proposal: action/status, structural entry/SL/TP,
   * R:R and spread checks. The engine produces every number; the AI only
   * interprets. Present whenever the analysis ran past insufficient-data.
   */
  proposal: TradeProposal | null;
  /** Present only for a READY long/short — the accept→chart handoff. */
  trade: ManualTradePlan | null;
  /**
   * Stage 2 S/R structure: frozen-vs-live levels, migration, outer-range width,
   * and internal-swing distances. Always present; context, never a trigger.
   */
  srStructure: SrStructureAssessment | null;
  /**
   * Stage 3 price-action reaction: impulse, approach, S/R interaction, fakeout
   * vs acceptance, rejection evidence, structure shift, confirmation state.
   * Context for the AI; it never generates entry/SL/TP (Stage 4).
   */
  priceReaction: PriceReactionAssessment | null;
  /** Stage 6 optional higher-timeframe context (item 12). */
  higherTimeframeContext: HigherTimeframeRead[];
  /** Stage 6 timeframe confluence descriptor (item 13). */
  confluence: TimeframeConfluence;
  /** Stage 7 flat, explainable decision trace (item 10). */
  trace: AnalysisTrace;
  /** Stage 7 sanity-check violations that forced a downgrade (item 11). */
  violations: string[];
  /** Inspectable classification data for validating against the chart. */
  debug: MarketConditionDebug;
};

/** Stage 4: the AI only keeps or downgrades the engine's proposal and explains. */
type ModelDecision = {
  verdict?: unknown;
  reason?: unknown;
};

function responseText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const response = value as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return "";
  return response.output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      });
    })
    .join("\n");
}

/** The precomputed, structured market read handed to the AI. */
function marketBriefForPrompt(
  assessment: MarketAssessment,
  sr: SrStructureAssessment | null,
  reaction: PriceReactionAssessment | null,
  higherTimeframeContext: HigherTimeframeRead[] = [],
  confluence: TimeframeConfluence = "NEUTRAL",
) {
  const { windows, levels } = assessment;
  return {
    analysisTimeframe: assessment.timeframe,
    marketCondition: assessment.condition,
    currentPriceLocation: assessment.location,
    trendDirection: assessment.trendDirection,
    directionalEfficiency: windows.medium.directionalEfficiency,
    candleOverlap: windows.medium.candleOverlap,
    directionChangeRate: windows.medium.directionChangeRate,
    recentVolatilityAtrPips: windows.medium.atrPips,
    slopeAtr: windows.medium.slopeAtr,
    conditionShortTerm: windows.short.condition,
    conditionMediumTerm: windows.medium.condition,
    conditionBroad: windows.broad.condition,
    higherTimeframeContext: higherTimeframeContext.map((read) => ({ timeframe: read.label, condition: read.condition, trend: read.trend })),
    timeframeConfluence: confluence,
    supportResistance: levels
      ? {
          resistanceRange: levels.rangeHigh,
          supportRange: levels.rangeLow,
          nearestSwingHigh: levels.swingHigh,
          nearestSwingLow: levels.swingLow,
        }
      : null,
    distanceToSupportPips: assessment.nearestSupportPips,
    distanceToResistancePips: assessment.nearestResistancePips,
    // Stage 2 S/R structure — all precomputed. The model interprets it as
    // context; it must NOT compute migration itself, and migration is never an
    // entry trigger on its own.
    srStructure: sr
      ? {
          overallMigration: sr.overallMigration,
          supportRangeMigration: sr.migrations.supportRange.direction,
          resistanceRangeMigration: sr.migrations.resistanceRange.direction,
          supportSwingMigration: sr.migrations.supportSwing.direction,
          resistanceSwingMigration: sr.migrations.resistanceSwing.direction,
          rangeWidthPips: sr.rangeWidthPips,
          rangeWidthAtr: sr.rangeWidthAtr,
          rangeWidthClass: sr.rangeWidthClass,
          distanceToSupportRangePips: sr.distances.supportRange.distancePips,
          distanceToResistanceRangePips: sr.distances.resistanceRange.distancePips,
          distanceToSupportSwingPips: sr.distances.supportSwing.distancePips,
          distanceToResistanceSwingPips: sr.distances.resistanceSwing.distancePips,
        }
      : null,
    // Stage 3 price-action reaction — all precomputed. The model interprets it;
    // it must NOT recompute impulse/penetration/rejection/acceptance itself.
    priceReaction: reaction
      ? {
          impulse: reaction.impulse.direction,
          impulseStrength: reaction.impulse.strength,
          impulseDisplacementAtr: reaction.impulse.displacementAtr,
          approach: reaction.approach,
          reactingWith: reaction.primarySide,
          interactionState: reaction.debug.interactionState,
          penetrationAtr: reaction.debug.penetrationAtr,
          barsBeyondLevel: reaction.debug.barsBeyond,
          fakeout: reaction.debug.fakeoutState,
          rejectionScore: reaction.debug.rejectionScore,
          rejectionStrength: reaction.debug.rejectionStrength,
          reclaimed: reaction.debug.reclaimed,
          acceptanceState: reaction.debug.acceptanceState,
          structureShift: reaction.structureShift,
          confirmation: reaction.confirmationState,
          confirmationBias: reaction.confirmationBias,
          confirmationCandles: `${reaction.currentConfirmationCandleCount}/${reaction.maxConfirmationCandles}`,
        }
      : null,
  };
}

function newsSummaryFor(
  pairEvents: Array<{ time: string; currency: string; impact: number; title: string }>,
): string {
  const nextNews = pairEvents[0];
  if (!nextNews) return "No relevant upcoming events were returned by the current ForexFactory feed.";
  const newsImpact = nextNews.impact >= 3
    ? "High impact — this can move the pair fast, so avoid entering close to the release."
    : nextNews.impact === 2
      ? "Medium impact — this can cause a short, choppy move."
      : "Low impact — this usually has a smaller effect on the pair.";
  const when = new Date(nextNews.time).toLocaleString("en-US", {
    timeZone: "America/New_York",
    timeStyle: "short",
    dateStyle: "medium",
  });
  return `${newsImpact} Next: ${nextNews.currency} ${nextNews.title} at ${when} ET.`;
}

/**
 * Read the market condition of each higher timeframe with its OWN profile
 * (item 12). Purely contextual: it never overrides the selected timeframe.
 */
async function readHigherTimeframes(
  instrument: MajorInstrument,
  higher: AnalysisTimeframe[],
): Promise<HigherTimeframeRead[]> {
  const reads = await Promise.all(
    higher.map(async (tf): Promise<HigherTimeframeRead | null> => {
      const p = profileFor(tf);
      const candles = await getCandles(instrument, p.timeframe, p.historyCount);
      if (candles.status.state !== "connected") return null;
      const assessment = assessMarketCondition({
        candles: candles.data.candles,
        instrument,
        timeframe: p.timeframe,
        windows: p.windows,
        thresholds: p.marketCondition,
      });
      return { timeframe: p.timeframe, label: p.label, condition: assessment.condition, trend: assessment.trendDirection };
    }),
  );
  return reads.filter((read): read is HigherTimeframeRead => read !== null);
}

/**
 * Descriptive alignment of higher timeframes with the setup direction (item 13).
 * Contextual only — never a win probability, never an auto-veto. A higher-TF
 * counter-trend increases the caution/confirmation bar; it does not prohibit.
 */
function computeConfluence(
  proposal: TradeProposal,
  primaryTrend: "bullish" | "bearish" | "sideways",
  higher: HigherTimeframeRead[],
): TimeframeConfluence {
  const direction: "long" | "short" | null =
    proposal.action === "LONG"
      ? "long"
      : proposal.action === "SHORT"
        ? "short"
        : proposal.side === "support"
          ? "long"
          : proposal.side === "resistance"
            ? "short"
            : primaryTrend === "bullish"
              ? "long"
              : primaryTrend === "bearish"
                ? "short"
                : null;
  if (!direction) return "NEUTRAL";
  const directional = higher.filter((read) => read.trend !== "sideways");
  if (!directional.length) return "NEUTRAL";
  const aligned = directional.filter((read) =>
    direction === "long" ? read.trend === "bullish" : read.trend === "bearish",
  ).length;
  const counter = directional.length - aligned;
  if (aligned > 0 && counter === 0) return "ALIGNED";
  if (counter > 0 && aligned === 0) return "COUNTER_TREND";
  return "MIXED";
}

/**
 * Stage 4 AI role: the engine's numbers are final. The model only KEEPS the
 * proposal or downgrades it to WAIT on a clear conflict (e.g. imminent
 * high-impact news), and writes one concise beginner sentence. It never invents
 * or changes a price. Returns null on any failure so the deterministic reason
 * is used and the analysis never breaks on the model.
 */
async function interpretProposal(input: {
  instrument: MajorInstrument;
  proposal: TradeProposal;
  brief: unknown;
  spreadPips: number;
  pairEvents: Array<{ time: string; currency: string; impact: number; title: string }>;
}): Promise<{ verdict: "keep" | "wait"; reason: string } | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const { proposal } = input;
  const prompt = JSON.stringify({
    task: "A deterministic engine produced this forex trade proposal. Every number is final and correct — do NOT change or recompute any of it. Decide only whether to KEEP the trade or downgrade it to WAIT because of a clear conflict, and explain in one concise beginner sentence.",
    proposal: {
      action: proposal.action,
      status: proposal.status,
      setupType: proposal.setupType,
      marketCondition: proposal.marketCondition,
      entryPrice: proposal.entryPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      targetType: proposal.targetType,
      riskPips: proposal.riskPips,
      rewardPips: proposal.rewardPips,
      riskReward: proposal.riskReward,
      confirmation: proposal.confirmation,
      engineReason: proposal.reason,
    },
    precomputedMarketRead: input.brief,
    spreadPips: input.spreadPips,
    upcomingRelevantCalendar: input.pairEvents,
    rules: [
      "Keep the trade unless there is a concrete reason to wait (for example a high-impact release is imminent, or the signals plainly contradict the setup).",
      "Never change entry, stop, target, or R:R. They are already correct.",
      "The reason must be one short sentence a beginner understands: who is in control and what would make the idea wrong.",
    ],
  });
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-5-mini",
        reasoning: { effort: "low" },
        input: prompt,
        text: {
          format: {
            type: "json_schema",
            name: "proposal_interpretation",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["verdict", "reason"],
              properties: {
                verdict: { type: "string", enum: ["keep", "wait"] },
                reason: { type: "string", minLength: 12, maxLength: 200 },
              },
            },
          },
        },
      }),
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as unknown;
    const decision = JSON.parse(responseText(payload)) as ModelDecision;
    const verdict = decision.verdict === "wait" ? "wait" : "keep";
    const reason = typeof decision.reason === "string" ? decision.reason.trim().slice(0, 200) : "";
    if (reason.length < 12) return { verdict, reason: proposal.reason };
    return { verdict, reason };
  } catch {
    return null;
  }
}

/**
 * Runs only when the owner explicitly clicks Analyze. It is intentionally
 * separate from every strategy/paper-cycle route: a proposal cannot create an
 * order, a pending entry, or a paper trade.
 *
 * Pipeline: candles → Stage 1 market condition → Stage 2 S/R structure →
 * Stage 3 price-action reaction → Stage 4 deterministic proposal (entry, SL,
 * TP, R:R, spread) → optional AI interpretation. Every trade number is produced
 * by the engine; the AI only keeps/downgrades and explains.
 */
export async function runManualAnalysis(
  instrument: MajorInstrument,
  timeframe?: string,
): Promise<ManualAnalysisResult> {
  // Stage 6: the selected chart timeframe is the primary analysis timeframe.
  const profile = profileFor(timeframe);
  const [pricing, primary, calendar] = await Promise.all([
    getPricing([instrument]),
    getCandles(instrument, profile.timeframe, profile.historyCount),
    getEconomicCalendar(),
  ]);
  const quote = pricing.data[0];
  const market = getForexSessionStatus();
  if (pricing.status.state !== "connected" || !quote || !(quote.bid > 0) || !(quote.ask >= quote.bid)) {
    throw new Error("A fresh OANDA quote is required before analysis can run.");
  }
  if (primary.status.state !== "connected") {
    throw new Error("Fresh OANDA chart data is required before analysis can run.");
  }
  // The economic calendar is context, not a prerequisite: every deterministic
  // stage (condition, S/R, reaction, entry/SL/TP, R:R) is computable without it.
  // A missing feed degrades to a "check news manually" note instead of blocking.
  const { base, quote: quoteCurrency } = currenciesOf(instrument);
  const pairEvents = (calendar.data.connected ? calendar.data.events : [])
    .filter((event) => event.currency === base || event.currency === quoteCurrency)
    .slice(0, 6)
    .map((event) => ({
      time: event.timestamp,
      currency: event.currency,
      impact: event.impact,
      title: event.title,
    }));
  const newsSummary = calendar.data.connected
    ? newsSummaryFor(pairEvents)
    : "Economic calendar unavailable — check upcoming high-impact news manually before entering.";

  const candles = primary.data.candles;
  // Stage 1 (1–4), timeframe-aware windows + near-level pip scale.
  const assessment = assessMarketCondition({
    candles,
    instrument,
    timeframe: profile.timeframe,
    windows: profile.windows,
    thresholds: profile.marketCondition,
  });
  // Stage 2: same-timeframe S/R snapshot/history → migration → range width.
  const srStructure = analyzeSrStructure({
    candles,
    instrument,
    timeframe: profile.timeframe,
    migrationStepBars: profile.migrationStepBars,
    thresholds: profile.sr,
  });
  // Stage 3: price-action reaction against the FROZEN S/R boundary.
  const priceReaction = srStructure
    ? analyzePriceReaction({
        candles,
        instrument,
        sr: srStructure,
        thresholds: profile.reaction,
        context: {
          marketCondition: assessment.condition,
          trendDirection: assessment.trendDirection,
          location: assessment.location,
          migration: srStructure.overallMigration,
        },
      })
    : null;
  // Item 12: optional higher-timeframe context, read with each HTF's own profile.
  const higherTimeframeContext = await readHigherTimeframes(instrument, profile.higherTimeframes);

  const baseResult = {
    instrument,
    analysisTimeframe: profile.timeframe,
    analyzedAt: new Date().toISOString(),
    testOnly: true as const,
    market: assessment.condition,
    location: assessment.location,
    gate: assessment.gate,
    newsSummary,
    srStructure,
    priceReaction,
    higherTimeframeContext,
    debug: assessment.debug,
  };

  // Stage 7: one flat, explainable trace per decision (item 10).
  const traceOf = (
    p: TradeProposal | null,
    finalAction: AnalyzeAction,
    reason: string,
    confluence: TimeframeConfluence,
  ): AnalysisTrace => ({
    pair: instrument,
    timeframe: profile.label,
    market: assessment.condition,
    support: srStructure?.frozen.supportRange ?? null,
    resistance: srStructure?.frozen.resistanceRange ?? null,
    supportSwing: srStructure?.frozen.supportSwing ?? null,
    resistanceSwing: srStructure?.frozen.resistanceSwing ?? null,
    rangeClass: srStructure?.rangeWidthClass ?? null,
    location: assessment.location,
    impulse: priceReaction?.impulse.direction ?? null,
    approach: priceReaction?.approach ?? null,
    interaction: priceReaction?.debug.interactionState ?? null,
    fakeout: priceReaction?.debug.fakeoutState ?? null,
    reclaim: priceReaction ? (priceReaction.debug.reclaimed ? "YES" : "NO") : null,
    acceptance: priceReaction?.debug.acceptanceState ?? null,
    confirmation: priceReaction?.confirmationState ?? null,
    entry: p?.entryPrice ?? null,
    sl: p?.stopLoss ?? null,
    tp: p?.takeProfit ?? null,
    riskPips: p?.riskPips ?? null,
    rewardPips: p?.rewardPips ?? null,
    riskReward: p?.riskReward ?? null,
    spreadPips: p?.spreadPips ?? null,
    higherTimeframes: higherTimeframeContext.map((r) => `${r.label}:${r.trend}`).join(", ") || "none",
    confluence,
    finalStatus: p?.status ?? null,
    finalAction,
    reason,
  });

  // Without Stage 2/3 structure there is nothing to build a proposal from.
  if (!srStructure || !priceReaction) {
    const reason = "Not enough candle history to analyze this pair yet.";
    return {
      ...baseResult,
      action: "wait",
      reason,
      proposal: null,
      confluence: "NEUTRAL",
      trace: traceOf(null, "wait", reason, "NEUTRAL"),
      violations: [],
      trade: null,
    };
  }

  // Stage 4: the deterministic engine decides the action and every number.
  const proposal = buildTradeProposal({
    instrument,
    candles,
    quote: { bid: quote.bid, ask: quote.ask, mid: quote.mid },
    assessment,
    sr: srStructure,
    reaction: priceReaction,
    timeframe: profile.timeframe,
    thresholds: profile.proposal,
  });
  // Item 13: alignment of higher timeframes with this setup — context only.
  const confluence = computeConfluence(proposal, assessment.trendDirection, higherTimeframeContext);
  // Item 11: contradiction checks. A directional proposal that trips any is
  // structurally impossible; downgrade it to NO_TRADE rather than emit it.
  const violations = proposal.action === "LONG" || proposal.action === "SHORT"
    ? validateProposal(proposal, srStructure, priceReaction)
    : [];
  const violationCodes = violations.map((violation) => violation.code);
  if (violations.length) {
    const reason = `Rejected by sanity check: ${violations.map((v) => v.message).join(" ")}`;
    return {
      ...baseResult,
      action: "no_trade",
      proposal,
      confluence,
      trace: traceOf(proposal, "no_trade", reason, confluence),
      violations: violationCodes,
      reason,
      trade: null,
    };
  }

  // Market closed: nothing is executable regardless of the technical setup.
  if (!market.marketOpen) {
    const reason = "Market closed — do not enter. Re-run analysis after forex reopens for a fresh price and timing.";
    return {
      ...baseResult,
      action: "wait",
      proposal,
      confluence,
      reason,
      trace: traceOf(proposal, "wait", reason, confluence),
      violations: violationCodes,
      trade: null,
    };
  }

  // WAIT / NO_TRADE are deterministic and concise — no model call.
  if (proposal.action === "WAIT") {
    return { ...baseResult, action: "wait", proposal, confluence, reason: proposal.reason, trace: traceOf(proposal, "wait", proposal.reason, confluence), violations: violationCodes, trade: null };
  }
  if (proposal.action === "NO_TRADE") {
    return { ...baseResult, action: "no_trade", proposal, confluence, reason: proposal.reason, trace: traceOf(proposal, "no_trade", proposal.reason, confluence), violations: violationCodes, trade: null };
  }

  const direction = proposal.action === "LONG" ? ("long" as const) : ("short" as const);

  // PLANNED (Stage 8): a full range-reversion plan exists but the entry trigger
  // has not confirmed. Return the plan with no executable trade — the UI offers
  // "Monitor Setup" and the backend watches for the READY trigger.
  if (proposal.status === "PLANNED") {
    return { ...baseResult, action: direction, proposal, confluence, reason: proposal.reason, trace: traceOf(proposal, direction, proposal.reason, confluence), violations: violationCodes, trade: null };
  }

  // READY LONG / SHORT. The engine's numbers are final; the AI only keeps or
  // downgrades to WAIT and writes the concise reason.
  const brief = marketBriefForPrompt(assessment, srStructure, priceReaction, higherTimeframeContext, confluence);
  const verdict = await interpretProposal({
    instrument,
    proposal,
    brief,
    spreadPips: proposal.spreadPips,
    pairEvents,
  });
  if (verdict?.verdict === "wait") {
    return { ...baseResult, action: "wait", proposal, confluence, reason: verdict.reason, trace: traceOf(proposal, "wait", verdict.reason, confluence), violations: violationCodes, trade: null };
  }
  const finalReason = verdict?.reason ?? proposal.reason;
  return {
    ...baseResult,
    action: direction,
    proposal,
    confluence,
    reason: finalReason,
    trace: traceOf(proposal, direction, finalReason, confluence),
    violations: violationCodes,
    trade: {
      direction,
      entry: proposal.entryPrice!,
      stop: proposal.stopLoss!,
      target: proposal.takeProfit!,
      riskReward: proposal.riskReward!,
      riskPips: proposal.riskPips!,
      rewardPips: proposal.rewardPips!,
    },
  };
}
