/** Wire contracts only. No server implementation or credentials in the browser. */
export type MarketLean = "up" | "down" | "range" | "conflicting" | "unknown";
export interface ObserverFact { id: string; text: string; category: "movement" | "structure" | "pattern" | "risk" }
export interface ObserverRead {
  version: string; instrument: string; asOf: string;
  state: "live" | "warming" | "paused"; lean: MarketLean; headline: string;
  changedAt: string; revision: number; facts: ObserverFact[]; blockers: string[];
  changeConditions: string[];
  quote: { bid: number; ask: number; time: string; spreadPips: number } | null;
  movement: Array<{ seconds: number; netPips: number; efficiency: number; velocity: number | null; samples: number; ready: boolean }>;
  patterns: Array<{ id: string; kind: string; timeframe: string; state: string; direction: string; at: string; historical: boolean }>;
  ai: { state: "disabled" | "pending" | "ready" | "error" | "limited"; text: string | null; at: string | null; factIds: string[] };
}
export type ObserverPlanStatus = "WATCHING" | "READY" | "TRIGGERED" | "PAUSED" | "INVALIDATED" | "EXPIRED" | "CLOSED";
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
  triggeredAt: string | null; observedEntry: number | null;
  outcome: { kind: "stop_observed" | "target_observed" | "unknown_after_gap"; at: string; price: number | null } | null;
  facts: string[];
}
export interface ObserverPlanEvent { id: string; at: string; status: ObserverPlanStatus; reason: string }
export interface ObserverSnapshot {
  enabled: boolean; reason?: string; read?: ObserverRead;
  plan: ObserverPlan | null; history: ObserverPlanEvent[];
  storage: "ready" | "unavailable";
}
