/** Wire contracts only. No server implementation or credentials in the browser. */
export type MarketLean = "up" | "down" | "range" | "conflicting" | "unknown";
export type QuotePressure = Exclude<MarketLean, "conflicting">;
export interface ObserverFact { id: string; text: string; category: "movement" | "structure" | "pattern" | "risk" }
export interface ObserverStory {
  version: "market-story@1";
  broader: { summary: string; direction: QuotePressure; timeframe: "H4"; bars: number; from: string | null; to: string | null };
  recent: { summary: string; direction: QuotePressure; timeframe: "H1"; bars: number; from: string | null; to: string | null };
  current: { summary: string; timeframe: "M15"; bars: number; from: string | null; to: string | null;
    levels: Array<{ role: "support" | "resistance"; price: number; low: number; high: number; time: string; knownAt: string;
      state: "holding" | "testing" | "broken" | "reclaimed"; condition: string }>;
    watch: string };
}
export interface ObserverRead {
  version: string; instrument: string; asOf: string;
  state: "live" | "warming" | "paused"; lean: MarketLean; headline: string;
  changedAt: string; revision: number; facts: ObserverFact[]; blockers: string[];
  changeConditions: string[];
  story?: ObserverStory;
  pressure: { direction: QuotePressure; observedDirection: QuotePressure; covered: boolean; pending: boolean; relation: "aligned" | "opposed" | "neutral" | "unknown" };
  quote: { bid: number; ask: number; time: string; spreadPips: number } | null;
  movement: Array<{ seconds: number; netPips: number; efficiency: number; velocity: number | null; samples: number; ready: boolean }>;
  patterns: Array<{ id: string; kind: string; timeframe: string; state: string; direction: string; at: string; historical: boolean; contextState: "current" | "paused" }>;
  ai: { state: "disabled" | "pending" | "ready" | "error" | "limited"; text: string | null; at: string | null; factIds: string[];
    source?: "model" | "rules"; evidence?: Array<{ id: string; text: string }>; watch?: string };
}
export type ObserverPlanStatus = "WATCHING" | "READY" | "TRIGGERED" | "PAUSED" | "INVALIDATED" | "EXPIRED" | "CLOSED";
export interface ConsolidationComparison {
  rules: "consolidation-comparison@1"; low: number; high: number; buffer: number; followThrough: number;
  holdSeconds: number; createdAt: string; expiresAt: string; lastQuoteAt: string | null; lastQuoteKey: string | null;
  state: "inside" | "attempt" | "unavailable" | "expired"; attempts: Array<{ side: "up" | "down"; startedAt: string;
    endedAt: string | null; continuousSince: string | null; samples: number;
    hold: { at: string | null; blockers: string[]; outcome: "pending" | "returned_inside" | "extended" | "unknown" };
    candle: { at: string | null; blockers: string[]; outcome: "pending" | "returned_inside" | "extended" | "unknown" } }>;
  truncated: boolean;
}
export interface ObserverPlan {
  id: string; version: number; instrument: string; mode: "NORMAL" | "SWING";
  createdAt: string; expiresAt: string; updatedAt: string; status: ObserverPlanStatus;
  resumeStatus: "WATCHING" | "READY" | "TRIGGERED";
  direction: "long" | "short" | null; reason: string; thesis: string;
  zone: { low: number; high: number } | null;
  entry: number | null; stop: number | null; target: number | null;
  trigger: { timeframe: "M5" | "H1"; boundary: number; after: string } | null;
  invalidation: string; lastEvaluatedCandle: string | null;
  confirmationCandle: string | null;
  /** Confirmation must start after the latest interruption/restart as well as creation. */
  confirmationAfter?: string;
  priceInterrupted?: boolean;
  triggeredAt: string | null; observedEntry: number | null;
  outcome: { kind: "stop_observed" | "target_observed" | "unknown_after_gap" | "monitoring_stopped"; at: string; price: number | null } | null;
  facts: string[];
  measurements?: ObserverSignalMeasurements;
  consolidation?: ConsolidationComparison;
  pullback?: { rules: "pullback-monitor@1"; zone: { low: number; high: number };
    phase: "approaching" | "testing" | "rebounding" | "confirmed" | "unavailable";
    touchedAt: string | null; lastQuoteKey: string | null; lastQuoteAt: string | null;
    receivedQuotes: number; lastEntry: number | null; move: "up" | "down" | "unchanged" | "unknown" };
}
export interface ObserverSignalMeasurements {
  version: "observer-evaluation@1"; engineVersion: string; planRulesVersion: string; patternRulesVersion: string;
  triggerQuote: { bid: number; ask: number; time: string; spreadPips: number };
  initialRiskPips: number; lastQuoteKey: string; lastObservedAt: string; lastExitPrice: number;
  observedQuotes: number; maxFavorablePips: number; maxAdversePips: number;
  firstGapAt: string | null;
  context: { lean: MarketLean; pressure: QuotePressure; relation: ObserverRead["pressure"]["relation"];
    patterns: Array<{ kind: string; timeframe: string; state: string }> };
}
export interface ObserverEvaluationRow {
  id: string; version: number; mode: ObserverPlan["mode"]; direction: ObserverPlan["direction"];
  triggeredAt: string; result: "target" | "stop" | "unknown" | "tracking" | "legacy" | "invalid";
  netPips: number | null; observedR: number | null; spreadPips: number | null;
  favorablePips: number | null; adversePips: number | null; durationSeconds: number | null;
}
export interface ObserverEvaluation {
  version: "observer-evaluation@1"; instrument: string; asOf: string; from: string | null; truncated: boolean;
  counts: { plans: number; noSignal: number; signals: number; measured: number; target: number; stop: number; unknown: number; tracking: number; legacy: number; invalid: number };
  metrics: { resolved: number; meanObservedR: number | null; meanNetPips: number | null; targetRateResolved: number | null;
    targetRateBounds: { low: number; high: number } | null; meanSpreadPips: number | null };
  baseline: { name: "No trade"; observedR: 0; differenceR: number | null };
  cohorts: Array<{ group: "mode" | "pressure" | "pattern" | "rules"; label: string; signals: number; resolved: number; meanObservedR: number | null }>;
  recent: ObserverEvaluationRow[]; limitations: string[];
}
export interface ObserverPlanEvent { id: string; at: string; status: ObserverPlanStatus; reason: string }
export interface ObserverPlanCheck { id: string; label: string; state: "met" | "waiting" | "blocked" | "unknown"; detail: string }
export interface ObserverJournal { plans: ObserverPlan[]; events: Array<ObserverPlanEvent & { planId: string; version: number; snapshot: ObserverPlan | null }> }
export interface ObserverSnapshot {
  enabled: boolean; reason?: string; read?: ObserverRead;
  plan: ObserverPlan | null; history: ObserverPlanEvent[];
  checks?: ObserverPlanCheck[];
  storage: "ready" | "unavailable";
}
