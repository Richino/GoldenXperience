/** Versioned, practice-only news STOP/OCO contract. Never used by the normal ticket. */
export const NEWS_V3 = 3;
export type NewsSide = "long" | "short";
export type NewsRunState = "SCHEDULED" | "PREPARING" | "READY" | "SUBMITTING" | "PENDING_ORDERS" | "OCO_CANCELLING" | "OPEN" | "TRAILING" | "CANCELLING" | "EXCEPTION" | "CLOSED" | "SKIPPED" | "EXPIRED" | "CANCELLED" | "HALTED";
export const NEWS_TERMINAL: NewsRunState[] = ["CLOSED", "SKIPPED", "EXPIRED", "CANCELLED", "HALTED"];
export type NewsReleaseMember = { id: string; title: string; currency: string };
export type NewsRelease = { id: string; title: string; currency: string; time: string; impact: number; provider: "forex_factory"; events?: NewsReleaseMember[] };
export type NewsV3Settings = {
  version: 3; distancePips: number; stopMode: "ATR" | "FIXED"; stopPips: number; atrMultiplier: number; minimumStopPips: number; maximumStopPips: number;
  riskPerTradePercent: number; maxEventRiskPercent: number; maxSpreadPips: number; maxSlippagePips: number;
  trailingActivationPips: number; trailingDistancePips: number; windowSeconds: number;
  maxHoldMinutes: number; emergencyLossR: number; emergencySpreadPips: number; disconnectExitSeconds: number;
  failSafe: "CANCEL_AND_FLATTEN"; emergencyPolicy: "FLATTEN_SETUP";
};
export const NEWS_V3_DEFAULTS: NewsV3Settings = {
  version: 3, distancePips: 10, stopMode: "ATR", stopPips: 15, atrMultiplier: 2, minimumStopPips: 5, maximumStopPips: 100,
  riskPerTradePercent: 1, maxEventRiskPercent: 1, maxSpreadPips: 3, maxSlippagePips: 2,
  trailingActivationPips: 10, trailingDistancePips: 7, windowSeconds: 60,
  maxHoldMinutes: 0, emergencyLossR: 1.5, emergencySpreadPips: 0, disconnectExitSeconds: 30,
  failSafe: "CANCEL_AND_FLATTEN", emergencyPolicy: "FLATTEN_SETUP",
};
export type NewsLeg = {
  side: NewsSide; entryId: string; clientId: string; tradeClientId: string;
  state: "UNSENT" | "SUBMITTING" | "UNKNOWN" | "PENDING" | "FILLED" | "CANCELLED" | "REJECTED";
  entry: number | null; bound: number | null; stopDistance: number | null; units: number;
  orderId: string | null; tradeId: string | null; paperTradeId: string | null;
  submittedAt: string | null; acknowledgedAt: string | null; brokerTime: string | null; cancellationRequestedAt: string | null; cancellationConfirmedAt: string | null;
  httpDispatchedAt?: string | null;
  fillTime: string | null; fillPrice: number | null; slippagePips: number | null; fillSpreadPips: number | null;
  initialStop: number | null; activeStop: number | null; trailingOrderId: string | null; trailingRequestedAt: string | null; trailingActivatedAt: string | null;
  unrealizedPips: number | null; maximumFavorablePips: number; protectedPips: number | null;
  realizedPL: number | null; realizedR: number | null; realizedPips?: number | null; exitPrice: number | null; closedAt: string | null; lastProtectionAt: string | null;
};
export type NewsRun = {
  id: string; userId: string; accountKey: string; instrument: string; eventKey: string; version: 3; revision: number;
  state: NewsRunState; release: NewsRelease; settings: NewsV3Settings; createdAt: string; targetSubmitAt: string; preparedAt: string | null;
  calendarCheckedAt: string; calendarFetchedAt: string; transactionSeed: string; lastReconciledAt: string | null;
  preparedQuote: { bid: number; ask: number; time: string } | null;
  risk: { equity: number; currency: string; conversion: number; eventCash: number; perLegCash: number; perLegPercent: number; stopPips: number; atrPips: number | null } | null;
  constraints: { minimumTrail: number; maximumTrail: number; precision: number; minimumUnits: number; maximumUnits: number } | null;
  clock: { sampledAt: string; offsetMs: number; uncertaintyMs: number } | null;
  levelsFrozenAt?: string | null; exposureCheckedAt?: string | null; ownedOpenTradeIds?: string[];
  legs: Record<NewsSide, NewsLeg>; firstFillSide: NewsSide | null; exception: string | null; reason: string | null;
  endedAt: string | null; timeline: Array<{ at: string; event: string; detail: string }>;
};
export type NewsV3Preview = { settings: NewsV3Settings; release: NewsRelease; quote: { bid: number; ask: number; time: string }; buyEntry: number; sellEntry: number; risk: NonNullable<NewsRun["risk"]>; units: number; checkedAt: string; targetSubmitAt: string };
export type PublicNewsRun = Omit<NewsRun, "userId" | "accountKey">;
export const NEWS_V3_LABEL: Record<NewsRunState, string> = {
  SCHEDULED: "Scheduled", PREPARING: "Checking broker and release", READY: "Ready for T−2s", SUBMITTING: "Submitting both STOP orders", PENDING_ORDERS: "Both orders confirmed",
  OCO_CANCELLING: "Fill confirmed · cancelling opposite", OPEN: "Open · initial stop protected", TRAILING: "Open · broker trailing active", CANCELLING: "Cancelling and reconciling",
  EXCEPTION: "Emergency risk reduction", CLOSED: "Closed", SKIPPED: "Skipped", EXPIRED: "Window ended", CANCELLED: "Cancelled", HALTED: "Exception resolved · news entries paused",
};
