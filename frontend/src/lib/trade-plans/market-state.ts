/** Deterministic interpretation contract. Research, observation and entry permission stay separate. */
export type ObservedMarketState = "STRONG_BULLISH_TREND" | "BULLISH_TREND" | "BULLISH_RECOVERY" | "RANGE" | "BEARISH_RECOVERY" | "BEARISH_TREND" | "STRONG_BEARISH_TREND" | "VOLATILE_UNSTRUCTURED" | "INSUFFICIENT_DATA";
export type FundamentalEnvironment = "BULLISH" | "SLIGHTLY_BULLISH" | "MIXED" | "SLIGHTLY_BEARISH" | "BEARISH" | "INSUFFICIENT_EVIDENCE";
export type ForwardLean = "BULLISH" | "SLIGHTLY_BULLISH" | "NEUTRAL" | "SLIGHTLY_BEARISH" | "BEARISH" | "INDETERMINATE";
export type MarketStateCondition = { timeframe: "H1" | "H4" | "D1"; relation: "CLOSE_ABOVE" | "CLOSE_BELOW"; level: number; explanation: string };
export type Catalyst = {
  id: string; topic: string; currency: string; factorIds: string[]; sourceIds: string[];
  bullish: number; bearish: number; shortTermNet: number; swingNet: number;
  latestObservedAt: string | null; persistence: "NOT_ESTABLISHED";
};
export type MarketOpportunity = {
  direction: "BUY" | "SELL"; status: "CONDITIONAL_PLAN" | "RESEARCH_CASE_ONLY";
  thesis: string; setupType: string | null; trigger: string | null;
  entryZone: { low: number; high: number } | null; stop: number | null; target: number | null;
  confirmation: string[]; invalidation: string[]; expiresAt: string | null;
  readiness: "WAITING_FOR_CONFIRMATION" | "WAITING_FOR_RISK_REWARD" | "NO_NEW_PLAN";
};
export type MarketStateSnapshot = {
  schemaVersion: "1.0"; engineVersion: string; id: string; inputHash: string;
  instrument: string; researchId: string; generatedAt: string;
  analysisStatus?: "ANALYSIS_COMPLETE" | "ANALYSIS_PARTIAL" | "TECHNICAL_DATA_UNAVAILABLE";
  quality: { status: "VALID" | "PARTIAL" | "STALE" | "UNAVAILABLE"; issues: string[] };
  source: {
    schedule?: { instrument?: string; interruptions?: Array<{from:number;to:number}> };
    dataSnapshot?: Record<string, unknown>;
    market: "oanda"; marketOpen: boolean; researchCreatedAt: string; calendarReadAt: string | null;
    calendarIssue?: string | null;
    structure?: Record<string, { direction: string | null; asOf: string | null }>;
    candleClosedAt: Record<"H1" | "H4" | "D1", string | null>;
  };
  observed: {
    classification: ObservedMarketState; timeframe: "M15" | "H1" | "H4"; asOf: string | null;
    explanation: string; evidence: string[]; continuation: MarketStateCondition[]; invalidation: MarketStateCondition[];
    momentum?: "UPWARD" | "DOWNWARD" | "CHOPPY";
    recentMoveAtr: number | null; efficiency: number | null;
  };
  fundamental: {
    classification: FundamentalEnvironment; explanation: string;
    rawScores: { bullish: number; bearish: number }; adjusted: { bullish: number; bearish: number };
    catalysts: Catalyst[];
  };
  forward: Record<"shortTerm" | "swing", { classification: ForwardLean; horizon: string; explanation: string; supportingCatalystIds: string[]; opposingCatalystIds: string[] }>;
  opportunities: MarketOpportunity[];
  reactions: Array<{ eventId: string; title: string; at: string; status: "OBSERVED" | "UNVERIFIED"; from: number | null; to: number | null; startAt: string | null; endAt: string | null; changePercent: number | null; overlappingReleases: boolean; explanation: string }>;
  previous: { id: string; observedStateChanged: boolean; shortTermChanged: boolean; swingChanged: boolean } | null;
  summary: string;
  costs: { modelCalls: 0; webSearchCalls: 0 };
  evidenceLimits?: string[];
  planEvaluation?: { analysisId?: string; result: string; reason: string | null; diagnostics?: import("./analysis-status").PlanDiagnostics; rejected: Array<{direction: "BUY" | "SELL"; setupType: string; reason: string; code?: string}> };
};
export type MarketStateView = { snapshot: MarketStateSnapshot; usable: boolean; reasons: string[] };

/** Colour for a classification: which way it points, and whether only slightly. */
export type Tone = "bullish" | "bearish" | "mixed" | "neutral" | "unknown";
export function toneOf(classification: string): { tone: Tone; soft: boolean } {
  const soft = classification.startsWith("SLIGHTLY_") || classification.endsWith("_RECOVERY");
  if (classification.includes("BULLISH")) return { tone: "bullish", soft };
  if (classification.includes("BEARISH")) return { tone: "bearish", soft };
  if (classification === "MIXED" || classification === "RANGE" || classification === "VOLATILE_UNSTRUCTURED") return { tone: "mixed", soft: false };
  if (classification === "NEUTRAL") return { tone: "neutral", soft: false };
  return { tone: "unknown", soft: false };
}

export const OBSERVED_LABEL: Record<ObservedMarketState, string> = {
  STRONG_BULLISH_TREND: "Strong bullish trend", BULLISH_TREND: "Bullish trend", BULLISH_RECOVERY: "Bullish recovery",
  RANGE: "Range", BEARISH_RECOVERY: "Bearish recovery", BEARISH_TREND: "Bearish trend", STRONG_BEARISH_TREND: "Strong bearish trend",
  VOLATILE_UNSTRUCTURED: "Unstructured / two-way", INSUFFICIENT_DATA: "Insufficient data",
};
export const FUNDAMENTAL_LABEL: Record<FundamentalEnvironment, string> = {
  BULLISH: "Bullish", SLIGHTLY_BULLISH: "Slightly bullish", MIXED: "Mixed", SLIGHTLY_BEARISH: "Slightly bearish", BEARISH: "Bearish", INSUFFICIENT_EVIDENCE: "Insufficient evidence",
};
export const FORWARD_LABEL: Record<ForwardLean, string> = {
  BULLISH: "Bullish", SLIGHTLY_BULLISH: "Slightly bullish", NEUTRAL: "Neutral", SLIGHTLY_BEARISH: "Slightly bearish", BEARISH: "Bearish", INDETERMINATE: "Indeterminate",
};
