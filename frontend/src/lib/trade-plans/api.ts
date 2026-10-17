import { apiUrl } from "@/lib/api/url";

/**
 * Typed client for /api/trade-plans. The server is authoritative: the client
 * sends a pair to analyze, the plan version it reviewed and the mode it chose
 * — never levels, sizes or a status.
 */

export type TradePlanStatus =
  | "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "MONITORING" | "CONFIRMED" | "NOTIFIED"
  | "EXECUTION_PENDING" | "ORDER_SUBMITTED" | "PARTIALLY_FILLED" | "FILLED" | "EXECUTION_FAILED"
  | "CLOSED" | "REJECTED" | "CANCELLED" | "INVALIDATED" | "EXPIRED" | "MISSED";

export type MonitoringMode = "NOTIFY" | "AUTO";
export type PlanFilter = "all" | "active" | "awaiting" | "monitoring" | "confirmed" | "executed" | "invalidated" | "expired" | "rejected";
export type ConditionStatus = "PENDING" | "PASSED" | "FAILED" | "BLOCKED";

export interface PlanCondition {
  key: string;
  label: string;
  status: ConditionStatus;
  detail: string | null;
}

export interface PlanBody {
  entryReadiness?: { status: "WAITING_FOR_RISK_REWARD" | "WAITING_FOR_CONFIRMATION"; estimatedRewardRisk: number; minRewardRisk: number; reason: string };
  entryTrigger?: string;
  confirmation?: string[];
  stopLossRule?: string;
  takeProfitRule?: string;
  positionSizingRule?: string;
  spreadSlippage?: { rule?: string };
  newsRestrictions?: { rule?: string; upcomingHighImpact?: Array<{ title: string; currency: string; at: string }> };
  invalidation?: { rules?: string[] };
  expiryRule?: string;
  explanation?: string[];
  zone?: { low: number; high: number };
  [key: string]: unknown;
}

export interface MonitorProposal {
  confirmedAt: string;
  side: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rewardRisk: number;
  spread: number | null;
  quoteTime: string | null;
}

export interface TradePlan {
  id: string;
  analysisId: string;
  instrument: string;
  direction: "BUY" | "SELL";
  setupType: "BREAKOUT_RETEST" | "SR_REVERSAL";
  status: TradePlanStatus;
  planVersion: number;
  stateVersion: string;
  monitoringMode: MonitoringMode | null;
  pausedAt: string | null;
  timeframe: string;
  marketBias: string;
  trendClassification: string;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number | null;
  takeProfit: number | null;
  rewardRisk: number | null;
  maxRiskPercent: number;
  plan: PlanBody;
  strategyVersion: string;
  marketDataAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  monitorStage: string | null;
  lastEvaluatedAt: string | null;
  lastPrice: number | null;
  notTriggeredReason: string | null;
  monitorState: {
    outcome?: string;
    proposal?: MonitorProposal | null;
    /** Attempts used of those approved, and the open window in closed candles. */
    progress?: { attempt: number; maxAttempts: number | null; window: { window: string; used: number; limit: number } | null } | null;
    /** Whether an order could go in right now (separate from confirmation). */
    safety?: { ok: boolean; blocks: string[] } | null;
  } | null;
  conditions: PlanCondition[];
  /** How the latest research changed this plan's evidence (never the plan). */
  thesisUpdate?: ThesisUpdate | null;
  latestEvent?: { type: string; reason: string | null; at: string } | null;
}

export interface ThesisUpdate {
  assessment: "STRENGTHENING" | "WEAKENING" | "UNCHANGED" | "CONFLICTED" | "OUTDATED";
  alignment: string;
  previousAlignment: string | null;
  summary: string | null;
  newSupporting: Array<{ id: string; factor: string }> | null;
  newOpposing: Array<{ id: string; factor: string }> | null;
  researchId: string;
  createdAt: string;
}

export interface PlanEvent {
  id: string;
  planVersion: number;
  type: string;
  from: TradePlanStatus | null;
  to: TradePlanStatus | null;
  actor: "user" | "monitor" | "executor" | "system";
  reason: string;
  createdAt: string;
}

export interface PlanDetail {
  plan: TradePlan;
  conditions: Array<PlanCondition & { evaluatedAt: string | null }>;
  approvals: Array<{ planVersion: number; monitoringMode: MonitoringMode; approvedAt: string; revokedAt: string | null; revokeReason: string | null }>;
  events: PlanEvent[];
  executionAttempts: Array<{ id: string; status: string; error: string | null; createdAt: string }>;
}

export interface GenerateResult {
  analysisId: string;
  /** The stored plans of this analysis, awaiting approval. */
  plans: TradePlan[];
  result: "PLANS" | "NO_VALID_SETUP";
  reason: string | null;
  planIds: string[];
  rejected: Array<{ direction: "BUY" | "SELL"; setupType: string; reason: string }>;
}

export interface ProgressResult {
  planId: string;
  planVersion: number;
  confirmation: {
    outcome: "WAITING" | "CONFIRMED" | "INVALIDATED" | "EXPIRED";
    stage: string;
    conditions: Array<{ key: string; status: ConditionStatus; detail: string; at: string | null }>;
    notTriggeredReason: string | null;
    proposal: MonitorProposal | null;
  };
}

export interface AutoTradeLimits {
  maxRiskPercent: number;
  maxAggregateRiskPercent: number;
  maxOpenPositions: number;
  dailyLossLimitPercent: number;
}

export interface AutoTradeSettings {
  autoTrade: boolean;
  approvedAt: string | null;
  limits: AutoTradeLimits;
  killSwitch: boolean;
  suspended: { at: string; reason: string | null } | null;
  broker: { environment: "practice" | "live" | "unconfigured" };
  /** False until order placement for confirmed Auto plans exists. */
  executorAvailable: boolean;
}

/** Market Intelligence contract v2 (mirrors api-server/src/intelligence/research-contract.ts). */
export type Bias = "bullish" | "bearish" | "mixed" | "neutral" | "unknown";
export type Quality = "high" | "medium" | "low";

export interface ResearchSource {
  id: string;
  url: string;
  publisher: string;
  title: string | null;
  retrievedAt: string;
  publishedAt: string | null;
  type: "official" | "news" | "analysis" | "forum" | "other";
}

export interface ResearchFactor {
  id: string;
  factor: string;
  currency: string;
  effectOnCurrency: "strengthens" | "weakens" | "mixed" | "unclear";
  impactOnPair: Bias;
  importance: Quality;
  evidenceType: "verified_data" | "attributed_analysis" | "hypothesis";
  description: string;
  observedAt: string | null;
  uncertainty: string | null;
  sourceIds: string[];
}

export interface ResearchEvent {
  id: string;
  title: string;
  currency: string;
  impact: number;
  at: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  status: "released" | "scheduled";
  source: string;
  implication: string | null;
}

export interface ResearchObservation { text: string; stance: "bullish" | "bearish" | "neutral" | "mixed"; sourceIds: string[] }

export type Lean = "bullish" | "bearish" | "neutral" | "unresolved";
/** Which way the cited evidence leans (server-checked); since contract 2.1. */
export interface DirectionalAssessment {
  nearTermLean: Lean;
  swingLean: Lean;
  evidenceBalance: { bullish: number; bearish: number; strongerSide: "bullish" | "bearish" | "neither" };
  drivers: string[];
  strongestOpposing: string;
  changeTriggers: string[];
  rationale: string;
  supportingFactorIds: string[];
}

export interface ResearchThesis {
  hypothesis: string;
  supportingFactorIds: string[];
  opposingFactorIds: string[];
  catalysts: string[];
  strengthensIf: string[];
  weakensIf: string[];
}

export interface MarketIntelligence {
  schemaVersion: string;
  pair: string;
  base: string;
  quote: string;
  research: { id: string; createdAt: string; cutoffAt: string; horizon: string; status: "complete" | "partial"; quality: Quality; missingData: string[]; model: string; effort: string; durationMs: number };
  outlook: { overall: Bias; shortTerm: Bias; swingTerm: Bias; fundamental: Bias; technical: Bias; explanation: string };
  factors: ResearchFactor[];
  events: ResearchEvent[];
  sentiment: { professional: ResearchObservation[]; retail: ResearchObservation[]; positioning: ResearchObservation[]; expectations: string; limitations: string };
  bullishThesis: ResearchThesis;
  bearishThesis: ResearchThesis;
  assessment?: DirectionalAssessment;
  sources: ResearchSource[];
  summary: string;
}

/** The research context frozen into a plan when it was made. */
export interface PlanResearchContext {
  researchId: string | null;
  researchedAt: string | null;
  fresh: boolean;
  alignment: "supports" | "opposes" | "mixed" | "no_evidence" | "no_research";
}

export interface CalendarRow { title: string; currency: string; impact: number; at: string; forecast: string | null; previous: string | null; actual: string | null }

export interface ResearchView {
  id: string;
  instrument: string;
  status: string;
  model: string | null;
  /** v2 contract; null (or an older format) when there is none. */
  report: MarketIntelligence | null;
  sourceCount: number;
  calendar: { available: boolean; readAt: string; source: string; upcoming: CalendarRow[]; released: Array<CalendarRow & { surprise: { side: string; difference: number | null; unit: string | null } }>; note: string | null };
  usage: { inputTokens: number | null; outputTokens: number | null; webSearchCalls: number | null; costUsd: number | null };
  createdAt: string;
  expiresAt: string | null;
  fresh: boolean;
  staleReason: string | null;
}

export type ResearchJobStatus = "QUEUED" | "RESEARCHING" | "VALIDATING" | "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED";
/** A background research job: only states the server has verified, no progress estimates. */
export interface ResearchJob {
  id: string;
  instrument: string;
  status: ResearchJobStatus;
  trigger: string;
  horizon: string;
  model: string;
  effort: string;
  researchId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; webSearchCalls: number | null; sources: number | null; costUsd: number | null; validationDrops: number | null };
  /** For a job you asked for: the plans it built for you, or why none. */
  plans?: { result: "PLANS" | "NO_VALID_SETUP" | "WATCHING" | "ERROR" | string; reason: string | null } | null;
}
export const JOB_RUNNING: ResearchJobStatus[] = ["QUEUED", "RESEARCHING", "VALIDATING"];

export interface ResearchResult {
  research: ResearchView | null;
  /** The pair's running job, else its latest job from the last day. */
  job?: ResearchJob | null;
  /** What Analyze did: reused fresh research, started or joined a background job, or was stopped by the budget. */
  state?: "cached" | "started" | "joined" | "budget" | "unconfigured";
  cached?: boolean;
  budget?: string | null;
  error?: string;
  configured?: boolean;
  /** Research is still running on the server; poll the cached GET until it is not. */
  running?: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
  return payload as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const tradePlansApi = {
  list: (filter: PlanFilter = "all", instrument?: string) =>
    request<{ plans: TradePlan[] }>(`/api/trade-plans?filter=${filter}${instrument ? `&instrument=${instrument}` : ""}`).then((r) => r.plans),
  get: (id: string) => request<PlanDetail>(`/api/trade-plans/${id}`),
  progress: (id: string) => request<ProgressResult>(`/api/trade-plans/${id}/progress`),
  generate: (instrument: string) => post<GenerateResult>("/api/trade-plans/generate", { instrument }),
  /** Cached market research for a pair (never triggers a research call). */
  research: (instrument: string) => request<ResearchResult>(`/api/intelligence/${instrument}`),
  /** Start (or join) background research for the pair when its research is stale; returns at once. */
  refreshResearch: (instrument: string, force = false) => post<ResearchResult>(`/api/intelligence/${instrument}/refresh`, { force }),
  /** Your research jobs: running, or ended in the last day (with the plans each built). */
  researchJobs: () => request<{ jobs: ResearchJob[] }>("/api/research-jobs"),
  researchJob: (jobId: string) => request<{ job: ResearchJob }>(`/api/research-jobs/${jobId}`),
  /** Remove a finished (failed or cancelled) research job from the Plans card. */
  dismissResearch: (jobId: string) => post<{ dismissed: boolean }>(`/api/research-jobs/${jobId}/dismiss`),
  cancelResearch: (jobId: string) => post<{ cancelled: boolean; reason: string | null }>(`/api/research-jobs/${jobId}/cancel`),
  autoTrade: () => request<AutoTradeSettings>("/api/trade-plans/auto-trade"),
  saveAutoTrade: (settings: AutoTradeLimits & { autoTrade: boolean }) =>
    request<AutoTradeSettings>("/api/trade-plans/auto-trade", { method: "PUT", body: JSON.stringify(settings) }),
  /** One Accept for the whole analysis, at the versions shown. */
  accept: (analysisId: string, mode: MonitoringMode, plans: Array<Pick<TradePlan, "id" | "planVersion">>) =>
    post("/api/trade-plans/accept", { analysisId, mode, versions: Object.fromEntries(plans.map((plan) => [plan.id, plan.planVersion])) }),
  approve: (id: string, planVersion: number, mode: MonitoringMode) => post(`/api/trade-plans/${id}/approve`, { planVersion, mode }),
  reject: (id: string, reason?: string) => post(`/api/trade-plans/${id}/reject`, { reason }),
  cancel: (id: string, reason?: string) => post(`/api/trade-plans/${id}/cancel`, { reason }),
  pause: (id: string) => post(`/api/trade-plans/${id}/pause`),
  resume: (id: string) => post(`/api/trade-plans/${id}/resume`),
  edit: (id: string, changes: { maxRiskPercent?: number; expiresAt?: string; reason?: string }) => post(`/api/trade-plans/${id}/edit`, changes),
};

export const STATUS_LABEL: Record<TradePlanStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  MONITORING: "Monitoring",
  CONFIRMED: "Confirmed",
  NOTIFIED: "Ready — you decide",
  EXECUTION_PENDING: "Executing",
  ORDER_SUBMITTED: "Order sent",
  PARTIALLY_FILLED: "Partly filled",
  FILLED: "Filled",
  EXECUTION_FAILED: "Execution failed",
  CLOSED: "Closed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  INVALIDATED: "Invalidated",
  EXPIRED: "Expired",
  MISSED: "Missed",
};

export const SETUP_LABEL: Record<TradePlan["setupType"], string> = {
  BREAKOUT_RETEST: "Breakout and retest",
  SR_REVERSAL: "Support/resistance reversal",
};
