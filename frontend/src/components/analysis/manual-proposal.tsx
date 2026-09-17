"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { freezeTradeContext } from "@/lib/strategy/trade-monitor";

/** Where the frozen Analyze context waits between accept and the create POST. */
export const frozenContextKey = (instrument: string) => `gx-frozen-ctx:${instrument}`;

/**
 * Capture the Stage 5 frozen context at accept and stash it (per instrument) so
 * the pending-entry create can persist it with the trade. Best-effort: if
 * storage is unavailable the trade still opens, only structural monitoring is
 * skipped for it.
 */
export function stashFrozenContext(analysis: ManualAnalysis) {
  const { trade, proposal, srStructure, priceReaction } = analysis;
  if (!trade || !proposal || !srStructure || !priceReaction) return;
  try {
    const context = freezeTradeContext({
      instrument: analysis.instrument,
      timeframe: srStructure.timeframe || "M15",
      direction: trade.direction,
      entry: trade.entry,
      stopLoss: trade.stop,
      takeProfit: trade.target,
      setupType: proposal.setupType,
      marketConditionAtEntry: analysis.market,
      migrationAtEntry: srStructure.overallMigration,
      frozen: srStructure.frozen,
      reactionAtEntry: {
        interactionState: priceReaction.debug.interactionState,
        fakeout: priceReaction.debug.fakeoutState,
        rejectionStrength: priceReaction.debug.rejectionStrength,
        confirmation: proposal.confirmation,
        structureShift: priceReaction.debug.structureShift,
      },
    });
    window.sessionStorage.setItem(frozenContextKey(analysis.instrument), JSON.stringify(context));
  } catch {
    // Storage blocked (private mode, quota) — monitoring just won't be armed.
  }
}

export type MarketCondition =
  | "TRENDING_BULLISH"
  | "TRENDING_BEARISH"
  | "STRUCTURED_RANGE"
  | "MESSY_CHOP";
export type PriceLocation =
  | "NEAR_SUPPORT"
  | "NEAR_RESISTANCE"
  | "MIDDLE_OF_RANGE"
  | "OUTSIDE_RANGE";
export type AnalyzeAction = "long" | "short" | "wait" | "no_trade";

export type ProposalAction = "LONG" | "SHORT" | "WAIT" | "NO_TRADE";
export type ProposalStatus =
  | "WAIT"
  | "PLANNED"
  | "READY"
  | "INVALIDATED"
  | "NO_TRADE";
export type SetupFamily = "SUPPORT_REVERSION" | "RESISTANCE_REVERSION" | "NONE";
export type SetupType =
  | "SUPPORT_FALSE_BREAK_RECLAIM"
  | "RESISTANCE_FALSE_BREAK_RECLAIM"
  | "SUPPORT_REJECTION"
  | "RESISTANCE_REJECTION"
  | "NONE";
export type TargetType =
  | "RESISTANCE_SWING"
  | "SUPPORT_SWING"
  | "RESISTANCE_RANGE"
  | "SUPPORT_RANGE"
  | "NONE";

export type TradeProposal = {
  action: ProposalAction;
  status: ProposalStatus;
  analysisTimeframe: string;
  marketCondition: MarketCondition;
  setupType: SetupType;
  setupFamily: SetupFamily;
  trigger: string;
  invalidation: string;
  rangeWidthClass: RangeWidthClass;
  side: "support" | "resistance" | null;
  entryPrice: number | null;
  preferredEntry: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  expectedPenetrationPips: number | null;
  entryReason: string;
  stopLoss: number | null;
  structuralExtreme: number | null;
  slBufferPips: number | null;
  slBufferAtr: number | null;
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
};

export type MarketConditionDebug = {
  pair: string;
  timeframe: string;
  windowSizes: { short: number; medium: number; broad: number };
  shortTerm: MarketCondition;
  mediumTerm: MarketCondition;
  broad: MarketCondition;
  finalCondition: MarketCondition;
  directionalEfficiency: number;
  candleOverlap: number;
  directionChangeRate: number;
  atrPips: number;
  slopeAtr: number;
  location: PriceLocation;
  nearestSupportPips: number | null;
  nearestResistancePips: number | null;
  gate: "CONTINUE" | "WAIT";
};

export type MigrationDirection = "UP" | "DOWN" | "FLAT";
export type OverallMigration = "MIGRATING_UP" | "MIGRATING_DOWN" | "MIXED" | "STABLE";
export type RangeWidthClass = "TOO_TIGHT" | "TIGHT" | "NORMAL" | "WIDE" | "EXTREME";

export type SrSnapshot = {
  timestamp: string;
  timeframe: string;
  current: number;
  supportRange: number;
  resistanceRange: number;
  supportSwing: number | null;
  resistanceSwing: number | null;
  atr: number;
};

export type SrStructureDebug = {
  pair: string;
  timeframe: string;
  currentSupportRange: number;
  previousSupportRange: number | null;
  supportRangeMigration: MigrationDirection;
  currentResistanceRange: number;
  previousResistanceRange: number | null;
  resistanceRangeMigration: MigrationDirection;
  currentSupportSwing: number | null;
  currentResistanceSwing: number | null;
  supportSwingMigration: MigrationDirection;
  resistanceSwingMigration: MigrationDirection;
  overallMigration: OverallMigration;
  rangeWidthPips: number;
  rangeWidthAtr: number;
  rangeWidthClass: RangeWidthClass;
  current: number;
  distanceToSupportRangePips: number | null;
  distanceToResistanceRangePips: number | null;
  distanceToSupportSwingPips: number | null;
  distanceToResistanceSwingPips: number | null;
  atrPips: number;
};

/** Stage 2 S/R structure read: frozen-vs-live levels, migration, range width. */
export type SrStructure = {
  instrument: string;
  timeframe: string;
  frozen: SrSnapshot;
  live: SrSnapshot;
  previous: SrSnapshot | null;
  overallMigration: OverallMigration;
  rangeWidthPips: number;
  rangeWidthAtr: number;
  rangeWidthClass: RangeWidthClass;
  debug: SrStructureDebug;
};

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

export type PriceReactionDebug = {
  pair: string;
  timeframe: string;
  nearestOuterSide: "support" | "resistance" | null;
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
};

export type PriceReaction = {
  confirmationBias: "long" | "short" | null;
  debug: PriceReactionDebug;
};

/** The executable half, present only for a READY long/short (accept handoff). */
export type ManualTradePlan = {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  riskPips: number;
  rewardPips: number;
};

export type TimeframeConfluence = "ALIGNED" | "MIXED" | "COUNTER_TREND" | "NEUTRAL";
export type HigherTimeframeRead = {
  timeframe: string;
  label: string;
  condition: MarketCondition;
  trend: "bullish" | "bearish" | "sideways";
};

export type ManualAnalysis = {
  instrument: string;
  /** OANDA granularity this analysis is frozen to (e.g. "M15"). */
  analysisTimeframe: string;
  analyzedAt: string;
  testOnly: true;
  action: AnalyzeAction;
  market: MarketCondition;
  location: PriceLocation;
  gate: "CONTINUE" | "WAIT";
  reason: string;
  newsSummary: string;
  trade: ManualTradePlan | null;
  proposal: TradeProposal | null;
  srStructure: SrStructure | null;
  priceReaction: PriceReaction | null;
  higherTimeframeContext: HigherTimeframeRead[];
  confluence: TimeframeConfluence;
  /** Stage 7 flat, explainable decision trace. */
  trace: Record<string, string | number | boolean | null>;
  /** Stage 7 sanity-check violation codes (empty when clean). */
  violations: string[];
  debug: MarketConditionDebug;
};

const CHART_OPEN_DELAY_MS = 180;

/** "STRUCTURED_RANGE" → "Structured range". */
function humanize(value: string) {
  const lower = value.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** OANDA granularity → chart label ("M15" → "15m"). */
function timeframeLabel(granularity: string): string {
  const map: Record<string, string> = { M1: "1m", M5: "5m", M15: "15m", H1: "1H", H4: "4H" };
  return map[granularity] ?? granularity;
}

function setupLabel(setup: SetupType): string {
  switch (setup) {
    case "SUPPORT_FALSE_BREAK_RECLAIM": return "Support fakeout + reclaim";
    case "RESISTANCE_FALSE_BREAK_RECLAIM": return "Resistance fakeout + reclaim";
    case "SUPPORT_REJECTION": return "Support rejection";
    case "RESISTANCE_REJECTION": return "Resistance rejection";
    default: return "—";
  }
}

function familyLabel(family: SetupFamily): string {
  return family === "SUPPORT_REVERSION" ? "Support reversion" : family === "RESISTANCE_REVERSION" ? "Resistance reversion" : "—";
}

function targetLabel(target: TargetType): string {
  switch (target) {
    case "RESISTANCE_SWING":
    case "SUPPORT_SWING": return "Swing";
    case "RESISTANCE_RANGE":
    case "SUPPORT_RANGE": return "Range";
    default: return "";
  }
}

/**
 * The test-only "AI analysis" flow shared by the watchlist and the chart page:
 * request an analysis for an instrument, lock the page behind the modal, and
 * hand acceptance off to the chart's pending-entry draft. A WAIT result is a
 * valid, common outcome and has nothing to accept. Accepting a long/short
 * never places an order — it opens a reviewable draft.
 */
export function useManualProposal() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<ManualAnalysis | null>(null);
  const [analyzingInstrument, setAnalyzingInstrument] = useState<string | null>(
    null,
  );
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    if (!analysis) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousBodyPosition = document.body.style.position;
    const previousBodyTop = document.body.style.top;
    const previousBodyWidth = document.body.style.width;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    const previousHtmlHeight = document.documentElement.style.height;
    const previousBodyMinHeight = document.body.style.minHeight;
    const scrollY = window.scrollY;
    let touchStartY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY;
      if (touchStartY === null || currentY === undefined) return;
      const modal = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".manual-proposal")
        : null;
      if (!modal) {
        event.preventDefault();
        return;
      }
      const delta = currentY - touchStartY;
      const atTop = modal.scrollTop <= 0;
      const atBottom = modal.scrollTop + modal.clientHeight >= modal.scrollHeight - 1;
      if ((atTop && delta > 0) || (atBottom && delta < 0)) event.preventDefault();
    };
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    // On iOS a position:fixed body with no explicit height leaves fixed
    // descendants (the portaled modal) short of the physical screen, so the
    // centered dialog rides up and the bare page shows below. Pinning html/body
    // to the dynamic viewport height gives the modal the full screen to center in.
    document.documentElement.style.height = "100dvh";
    document.body.style.minHeight = "100dvh";
    document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.body.style.position = previousBodyPosition;
      document.body.style.top = previousBodyTop;
      document.body.style.width = previousBodyWidth;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
      document.documentElement.style.height = previousHtmlHeight;
      document.body.style.minHeight = previousBodyMinHeight;
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchmove", onTouchMove, true);
      window.scrollTo(0, scrollY);
    };
  }, [analysis]);

  const analyze = useCallback(async (instrument: string, timeframe?: string) => {
    setAnalysisError(null);
    setAnalyzingInstrument(instrument);
    try {
      const response = await fetch(apiUrl("/api/manual-analysis"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // Stage 6: analyze the selected chart timeframe (server defaults to 15m).
        body: JSON.stringify({ instrument, ...(timeframe ? { timeframe } : {}) }),
      });
      const payload = await response.json() as { analysis?: ManualAnalysis; error?: string };
      if (!response.ok || !payload.analysis) throw new Error(payload.error ?? "Analysis could not run.");
      setAnalysis(payload.analysis);
    } catch (reason) {
      setAnalysisError(reason instanceof Error ? reason.message : "Analysis could not run.");
    } finally {
      setAnalyzingInstrument(null);
    }
  }, []);

  const acceptProposal = useCallback(() => {
    const trade = analysis?.trade;
    if (!analysis || !trade) return;
    stashFrozenContext(analysis);
    const parameters = new URLSearchParams({
      instrument: analysis.instrument,
      entry: String(trade.entry),
      stop: String(trade.stop),
      target: String(trade.target),
      direction: trade.direction,
      preferredEntryTime: analysis.proposal?.entryReason ?? "",
      rationale: analysis.reason,
      proposal: "manual-analysis",
    });
    // Give the modal one frame of visible feedback before navigation. During
    // this small handoff window the returned cancellation function makes an
    // outside tap or Cancel a real cancellation rather than a cosmetic one.
    const timeout = window.setTimeout(() => {
      router.push(`/chart?${parameters.toString()}`);
    }, CHART_OPEN_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [analysis, router]);

  /**
   * Arm backend monitoring for a PLANNED setup (Stage 8). Persists the frozen
   * plan server-side; the backend then watches completed candles on the plan's
   * timeframe and alerts on READY / INVALIDATED even if this UI is gone.
   */
  const monitorSetup = useCallback(() => {
    const proposal = analysis?.proposal;
    if (!analysis || !proposal || proposal.status !== "PLANNED" || !analysis.srStructure) return;
    const payload = {
      instrument: analysis.instrument,
      timeframe: analysis.analysisTimeframe,
      plan: {
        direction: proposal.side === "support" ? "long" : "short",
        setupFamily: proposal.setupFamily,
        marketConditionAtEntry: analysis.market,
        entryZoneLow: proposal.entryZoneLow,
        entryZoneHigh: proposal.entryZoneHigh,
        preferredEntry: proposal.preferredEntry,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        riskReward: proposal.riskReward,
        trigger: proposal.trigger,
        invalidation: proposal.invalidation,
        frozen: analysis.srStructure.frozen,
        createdAt: analysis.analyzedAt,
      },
    };
    void fetch(apiUrl("/api/planned-setups"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  }, [analysis]);

  return {
    analysis,
    setAnalysis,
    analyze,
    analyzingInstrument,
    analysisError,
    acceptProposal,
    monitorSetup,
  };
}

/** The reviewable AI-analysis modal. Portals to <body>, above the page. */
export function ManualProposalModal({
  analysis,
  currentPrice = null,
  onDismiss,
  onAccept,
  onMonitor,
}: {
  analysis: ManualAnalysis | null;
  /** The live executable side: Ask for a long, Bid for a short. */
  currentPrice?: number | null;
  onDismiss: () => void;
  /** Starts navigation and may return a cancellation function for the handoff. */
  onAccept: () => void | (() => void);
  /** Arms backend monitoring for a PLANNED setup (Stage 8). */
  onMonitor?: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const cancelOpenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setMonitoring(false);
    if (analysis) return;
    cancelOpenRef.current?.();
    cancelOpenRef.current = null;
    setOpening(false);
  }, [analysis]);

  useEffect(
    () => () => {
      cancelOpenRef.current?.();
    },
    [],
  );

  if (!analysis) return null;

  const trade = analysis.trade;
  const proposal = analysis.proposal;
  const actionLabel = analysis.action === "no_trade" ? "NO TRADE" : analysis.action.toUpperCase();
  // For a plan without an executable trade yet, derive the side from the setup.
  const planDirection = trade?.direction ?? (proposal?.side === "support" ? "long" : proposal?.side === "resistance" ? "short" : null);
  const executableSide = planDirection === "long" ? "Ask" : "Bid";
  const currentPriceIsValid = currentPrice !== null && Number.isFinite(currentPrice);
  const entryDistancePips = trade && currentPriceIsValid
    ? (currentPrice - trade.entry) / pipSizeFor(analysis.instrument)
    : null;
  const entryDistanceLabel = entryDistancePips === null
    ? "Waiting for a live quote"
    : Math.abs(entryDistancePips) < 0.05
      ? "At entry"
      : `${Math.abs(entryDistancePips).toFixed(1)} pips ${entryDistancePips > 0 ? "above" : "below"} entry`;

  const debug = analysis.debug;
  const sr = analysis.srStructure;
  const pr = analysis.priceReaction;
  const confirmationTone = (state: ConfirmationState) =>
    state === "ENTER_CONDITION_MET" ? "up" : state === "INVALIDATED" ? "down" : "flat";
  const pips = (value: number | null) => (value === null ? "—" : `${value.toFixed(1)} pips`);
  const price = (value: number) => formatChartPrice(value, analysis.instrument);
  const migrationTone = (value: OverallMigration | MigrationDirection) =>
    value === "UP" || value === "MIGRATING_UP"
      ? "up"
      : value === "DOWN" || value === "MIGRATING_DOWN"
        ? "down"
        : "flat";

  function dismiss() {
    cancelOpenRef.current?.();
    cancelOpenRef.current = null;
    setOpening(false);
    onDismiss();
  }

  function accept() {
    if (opening) return;
    cancelOpenRef.current = onAccept() ?? null;
    setOpening(true);
  }

  return createPortal(
    (
      <div
        className="manual-proposal-backdrop"
        role="presentation"
        data-pull-to-refresh-ignore="true"
        onMouseDown={(event) => event.target === event.currentTarget && dismiss()}
      >
        <section
          className="manual-proposal"
          data-action={analysis.action}
          role="dialog"
          aria-modal="true"
          aria-labelledby="manual-proposal-title"
        >
          <header>
            <div>
              <h2 id="manual-proposal-title">{displayNameFor(analysis.instrument)} · {timeframeLabel(analysis.analysisTimeframe)}</h2>
              {proposal ? <small className="manual-proposal-status">{humanize(proposal.status)}</small> : null}
            </div>
            <strong className={`manual-proposal-action is-${analysis.action}`}>
              {actionLabel}
            </strong>
          </header>

          {analysis.higherTimeframeContext.length ? (
            <p className="manual-proposal-htf">
              <b>Context:</b>{" "}
              {analysis.higherTimeframeContext
                .map((read) => `${read.label} ${read.trend === "sideways" ? "neutral" : read.trend}`)
                .join(" · ")}
              {" "}<span className={`htf-confluence is-${analysis.confluence.toLowerCase()}`}>{humanize(analysis.confluence)}</span>
            </p>
          ) : null}

          {proposal && proposal.entryPrice !== null ? (
            <>
              <div className="manual-proposal-quote" aria-label="Live price">
                <span>Live {executableSide}</span>
                <strong>{currentPriceIsValid ? formatChartPrice(currentPrice, analysis.instrument) : "—"}</strong>
                <small>{entryDistanceLabel}</small>
              </div>
              <div className="manual-proposal-condition">
                <div><span>Market</span><strong>{humanize(analysis.market)}</strong></div>
                <div><span>Location</span><strong>{humanize(analysis.location)}</strong></div>
                <div><span>Setup</span><strong>{familyLabel(proposal.setupFamily)}</strong></div>
              </div>
              <dl>
                <div>
                  <dt>Entry zone</dt>
                  <dd>{proposal.entryZoneLow === null || proposal.entryZoneHigh === null ? "—" : `${formatChartPrice(proposal.entryZoneLow, analysis.instrument)}–${formatChartPrice(proposal.entryZoneHigh, analysis.instrument)}`}</dd>
                </div>
                <div><dt>Preferred</dt><dd>{proposal.preferredEntry === null ? "—" : formatChartPrice(proposal.preferredEntry, analysis.instrument)}</dd></div>
                <div><dt>R:R</dt><dd>{proposal.riskReward === null ? "—" : `1 : ${proposal.riskReward}`}</dd></div>
              </dl>
              <dl>
                <div><dt>SL</dt><dd>{proposal.stopLoss === null ? "—" : formatChartPrice(proposal.stopLoss, analysis.instrument)}</dd></div>
                <div>
                  <dt>TP</dt>
                  <dd>{proposal.takeProfit === null ? "—" : formatChartPrice(proposal.takeProfit, analysis.instrument)}{proposal.targetType !== "NONE" ? ` · ${targetLabel(proposal.targetType)}` : ""}</dd>
                </div>
                <div><dt>R:R</dt><dd>{proposal.riskReward === null ? "—" : `1 : ${proposal.riskReward}`}</dd></div>
              </dl>
              <dl className="manual-proposal-economics">
                <div><dt>Average move</dt><dd>{pips(proposal.avgMovePips)}</dd></div>
                <div><dt>Spread</dt><dd>{proposal.spreadPips.toFixed(1)} pips</dd></div>
                <div><dt>SL distance</dt><dd>{pips(proposal.riskPips)}</dd></div>
                <div><dt>TP distance</dt><dd>{pips(proposal.rewardPips)}</dd></div>
                <div><dt>Spread / SL</dt><dd>{proposal.spreadPctOfRisk === null ? "—" : `${proposal.spreadPctOfRisk}%`}</dd></div>
                <div><dt>Spread / TP</dt><dd>{proposal.spreadPctOfReward === null ? "—" : `${proposal.spreadPctOfReward}%`}</dd></div>
              </dl>
              <p className="manual-proposal-entry-time"><b>Trigger:</b> {proposal.trigger}</p>
              <p className="manual-proposal-wait-reason"><b>Invalidation:</b> {proposal.invalidation}</p>
              <p><b>Why:</b> {analysis.reason}</p>
            </>
          ) : (
            <>
              <div className="manual-proposal-condition">
                <div><span>Market</span><strong>{humanize(analysis.market)}</strong></div>
                <div><span>Location</span><strong>{humanize(analysis.location)}</strong></div>
                <div><span>Setup</span><strong>{proposal ? familyLabel(proposal.setupFamily) : "—"}</strong></div>
              </div>
              <p className="manual-proposal-wait-reason"><b>Reason:</b> {analysis.reason}</p>
            </>
          )}

          <p><b>News:</b> {analysis.newsSummary}</p>

          <details className="manual-proposal-debug manual-proposal-debug-root">
            <summary>Debug details</summary>

          <details className="manual-proposal-debug">
            <summary>Analysis trace</summary>
            <dl>
              {Object.entries(analysis.trace).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value === null ? "—" : typeof value === "number" ? value.toString() : String(value)}</dd>
                </div>
              ))}
            </dl>
          </details>

          <details className="manual-proposal-debug">
            <summary>Condition detail</summary>
            <dl>
              <div><dt>Timeframe</dt><dd>{timeframeLabel(debug.timeframe)}</dd></div>
              <div><dt>Windows</dt><dd>{debug.windowSizes.short}/{debug.windowSizes.medium}/{debug.windowSizes.broad}</dd></div>
              <div><dt>Short-term</dt><dd>{humanize(debug.shortTerm)}</dd></div>
              <div><dt>Medium-term</dt><dd>{humanize(debug.mediumTerm)}</dd></div>
              <div><dt>Broad</dt><dd>{humanize(debug.broad)}</dd></div>
              <div><dt>Final</dt><dd>{humanize(debug.finalCondition)}</dd></div>
              <div><dt>Dir. efficiency</dt><dd>{Math.round(debug.directionalEfficiency * 100)}%</dd></div>
              <div><dt>Candle overlap</dt><dd>{Math.round(debug.candleOverlap * 100)}%</dd></div>
              <div><dt>Dir-change rate</dt><dd>{Math.round(debug.directionChangeRate * 100)}%</dd></div>
              <div><dt>ATR (medium)</dt><dd>{debug.atrPips.toFixed(1)} pips</dd></div>
              <div><dt>Slope (ATR)</dt><dd>{debug.slopeAtr.toFixed(2)}</dd></div>
              <div><dt>To support</dt><dd>{pips(debug.nearestSupportPips)}</dd></div>
              <div><dt>To resistance</dt><dd>{pips(debug.nearestResistancePips)}</dd></div>
              <div><dt>Gate</dt><dd>{debug.gate}</dd></div>
            </dl>
          </details>

          {sr ? (
            <details className="manual-proposal-debug">
              <summary>S/R structure &amp; migration</summary>
              <dl>
                <div><dt>Overall migration</dt><dd className={`mig-${migrationTone(sr.debug.overallMigration)}`}>{humanize(sr.debug.overallMigration)}</dd></div>
                <div><dt>Range width</dt><dd>{sr.debug.rangeWidthPips.toFixed(1)} pips · {sr.debug.rangeWidthAtr.toFixed(2)} ATR</dd></div>
                <div><dt>Range class</dt><dd>{humanize(sr.debug.rangeWidthClass)}</dd></div>
                <div><dt>ATR14</dt><dd>{sr.debug.atrPips.toFixed(1)} pips</dd></div>

                <div><dt>Support range (now)</dt><dd>{price(sr.debug.currentSupportRange)}</dd></div>
                <div><dt>Support range (prev)</dt><dd>{sr.debug.previousSupportRange === null ? "—" : price(sr.debug.previousSupportRange)}</dd></div>
                <div><dt>Support migration</dt><dd className={`mig-${migrationTone(sr.debug.supportRangeMigration)}`}>{sr.debug.supportRangeMigration}</dd></div>

                <div><dt>Resistance range (now)</dt><dd>{price(sr.debug.currentResistanceRange)}</dd></div>
                <div><dt>Resistance range (prev)</dt><dd>{sr.debug.previousResistanceRange === null ? "—" : price(sr.debug.previousResistanceRange)}</dd></div>
                <div><dt>Resistance migration</dt><dd className={`mig-${migrationTone(sr.debug.resistanceRangeMigration)}`}>{sr.debug.resistanceRangeMigration}</dd></div>

                <div><dt>Support swing</dt><dd>{sr.debug.currentSupportSwing === null ? "—" : price(sr.debug.currentSupportSwing)} ({sr.debug.supportSwingMigration})</dd></div>
                <div><dt>Resistance swing</dt><dd>{sr.debug.currentResistanceSwing === null ? "—" : price(sr.debug.currentResistanceSwing)} ({sr.debug.resistanceSwingMigration})</dd></div>

                <div><dt>Current price</dt><dd>{price(sr.debug.current)}</dd></div>
                <div><dt>→ Support range</dt><dd>{pips(sr.debug.distanceToSupportRangePips)}</dd></div>
                <div><dt>→ Resistance range</dt><dd>{pips(sr.debug.distanceToResistanceRangePips)}</dd></div>
                <div><dt>→ Support swing</dt><dd>{pips(sr.debug.distanceToSupportSwingPips)}</dd></div>
                <div><dt>→ Resistance swing</dt><dd>{pips(sr.debug.distanceToResistanceSwingPips)}</dd></div>

                <div><dt>Frozen support</dt><dd>{price(sr.frozen.supportRange)}</dd></div>
                <div><dt>Live support</dt><dd>{price(sr.live.supportRange)}</dd></div>
                <div><dt>Frozen resistance</dt><dd>{price(sr.frozen.resistanceRange)}</dd></div>
                <div><dt>Live resistance</dt><dd>{price(sr.live.resistanceRange)}</dd></div>
              </dl>
            </details>
          ) : null}

          {pr ? (
            <details className="manual-proposal-debug">
              <summary>Price action &amp; reaction</summary>
              <dl>
                <div><dt>Confirmation</dt><dd className={`mig-${confirmationTone(pr.debug.confirmationState)}`}>{humanize(pr.debug.confirmationState)}</dd></div>
                <div><dt>Confirm candles</dt><dd>{pr.debug.currentConfirmationCandleCount}/{pr.debug.maxConfirmationCandles}{pr.confirmationBias ? ` · ${pr.confirmationBias}` : ""}</dd></div>

                <div><dt>Impulse</dt><dd>{humanize(pr.debug.impulseDirection)}</dd></div>
                <div><dt>Impulse strength</dt><dd>{Math.round(pr.debug.impulseStrength * 100)}% · {pr.debug.impulseCandleCount} bar{pr.debug.impulseCandleCount === 1 ? "" : "s"}</dd></div>
                <div><dt>Approach</dt><dd>{humanize(pr.debug.approach)}</dd></div>

                <div><dt>Reacting with</dt><dd>{pr.debug.nearestOuterSide ? humanize(pr.debug.nearestOuterSide) : "—"}</dd></div>
                <div><dt>Frozen level</dt><dd>{pr.debug.nearestOuterFrozen === null ? "—" : price(pr.debug.nearestOuterFrozen)}</dd></div>
                <div><dt>Live level</dt><dd>{pr.debug.nearestOuterLive === null ? "—" : price(pr.debug.nearestOuterLive)}</dd></div>
                <div><dt>Interaction</dt><dd>{humanize(pr.debug.interactionState)}</dd></div>

                <div><dt>Penetration</dt><dd>{pips(pr.debug.penetrationPips)}{pr.debug.penetrationAtr === null ? "" : ` · ${pr.debug.penetrationAtr.toFixed(2)} ATR`}</dd></div>
                <div><dt>Bars beyond</dt><dd>{pr.debug.barsBeyond === null ? "—" : pr.debug.barsBeyond}</dd></div>
                <div><dt>Fakeout</dt><dd>{humanize(pr.debug.fakeoutState)}</dd></div>
                <div><dt>Reclaimed</dt><dd>{pr.debug.reclaimed ? "Yes" : "No"}</dd></div>

                <div><dt>Rejection</dt><dd>{humanize(pr.debug.rejectionStrength)}{pr.debug.rejectionScore === null ? "" : ` · ${pr.debug.rejectionScore.toFixed(2)}`}</dd></div>
                <div><dt>Acceptance</dt><dd>{humanize(pr.debug.acceptanceState)}</dd></div>
                <div><dt>Structure shift</dt><dd>{humanize(pr.debug.structureShift)}</dd></div>
                <div><dt>ATR14</dt><dd>{pr.debug.atrPips.toFixed(1)} pips</dd></div>
              </dl>
            </details>
          ) : null}

          {proposal ? (
            <details className="manual-proposal-debug">
              <summary>Proposal detail</summary>
              <dl>
                <div><dt>Timeframe</dt><dd>{timeframeLabel(proposal.analysisTimeframe)}</dd></div>
                <div><dt>Action</dt><dd>{humanize(proposal.action)}</dd></div>
                <div><dt>Status</dt><dd>{humanize(proposal.status)}</dd></div>
                <div><dt>Setup</dt><dd>{humanize(proposal.setupType)}</dd></div>
                <div><dt>Range class</dt><dd>{humanize(proposal.rangeWidthClass)}</dd></div>
                <div><dt>Confirmation</dt><dd>{humanize(proposal.confirmation)}</dd></div>

                <div><dt>Entry</dt><dd>{proposal.entryPrice === null ? "—" : price(proposal.entryPrice)}</dd></div>
                <div><dt>Entry zone</dt><dd>{proposal.entryZoneLow === null || proposal.entryZoneHigh === null ? "—" : `${price(proposal.entryZoneLow)}–${price(proposal.entryZoneHigh)}`}</dd></div>
                <div><dt>Structural extreme</dt><dd>{proposal.structuralExtreme === null ? "—" : price(proposal.structuralExtreme)}</dd></div>
                <div><dt>SL buffer</dt><dd>{pips(proposal.slBufferPips)}{proposal.slBufferAtr === null ? "" : ` · ${proposal.slBufferAtr.toFixed(2)} ATR`}</dd></div>
                <div><dt>Average move</dt><dd>{pips(proposal.avgMovePips)}</dd></div>
                <div><dt>Stop loss</dt><dd>{proposal.stopLoss === null ? "—" : price(proposal.stopLoss)}</dd></div>

                <div><dt>Target</dt><dd>{proposal.takeProfit === null ? "—" : price(proposal.takeProfit)}</dd></div>
                <div><dt>Target type</dt><dd>{humanize(proposal.targetType)}</dd></div>
                <div><dt>Risk</dt><dd>{pips(proposal.riskPips)}</dd></div>
                <div><dt>Reward</dt><dd>{pips(proposal.rewardPips)}</dd></div>
                <div><dt>R:R</dt><dd>{proposal.riskReward === null ? "—" : proposal.riskReward.toFixed(2)}</dd></div>

                <div><dt>Spread</dt><dd>{proposal.spreadPips.toFixed(1)} pips</dd></div>
                <div><dt>Spread / SL</dt><dd>{proposal.spreadPctOfRisk === null ? "—" : `${proposal.spreadPctOfRisk}%`}</dd></div>
                <div><dt>Spread / TP</dt><dd>{proposal.spreadPctOfReward === null ? "—" : `${proposal.spreadPctOfReward}%`}</dd></div>
                <div><dt>Spread / range</dt><dd>{proposal.spreadPctOfRange === null ? "—" : `${proposal.spreadPctOfRange}%`}</dd></div>
              </dl>
            </details>
          ) : null}

          </details>

          <footer>
            <button type="button" className="manual-proposal-dismiss pressable" onClick={dismiss}>
              {opening ? "Cancel" : "Dismiss"}
            </button>
            {trade ? (
              <button
                type="button"
                className="manual-proposal-accept pressable"
                onClick={accept}
                disabled={opening}
                aria-live="polite"
              >
                {opening ? <><LoaderCircle className="size-3.5 animate-spin" /> Opening chart…</> : "Accept & open chart"}
              </button>
            ) : proposal?.status === "PLANNED" && onMonitor ? (
              <button
                type="button"
                className="manual-proposal-accept pressable"
                onClick={() => { if (!monitoring) { onMonitor?.(); setMonitoring(true); } }}
                disabled={monitoring}
                aria-live="polite"
              >
                {monitoring ? "Monitoring…" : "Monitor setup"}
              </button>
            ) : null}
          </footer>
        </section>
      </div>
    ),
    document.body,
  );
}
