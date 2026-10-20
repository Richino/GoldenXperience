/** Analysis-only contract. No field in this contract authorizes a broker operation. */
export type SwingSide = "BUY" | "SELL";
export type SwingFrame = "D1" | "H4" | "H1" | "M15";
export type SwingControl = "BUYERS_DOMINANT" | "SELLERS_DOMINANT" | "CONTESTED" | "INSUFFICIENT_DATA";
export type SwingLean = "BUY_FAVORED" | "SELL_FAVORED" | "NO_DIRECTIONAL_EDGE" | "INSUFFICIENT_DATA";
export type SwingStyle = "AGGRESSIVE" | "BALANCED" | "CONSERVATIVE";
export type SwingZoneStatus = "WATCHING" | "TOUCHED" | "EVALUATING" | "ELIGIBLE" | "REJECTED" | "EXPIRED";
export type SwingBehavior = "REJECTION" | "BREAKOUT" | "CONTINUATION" | "FAILED_BREAKOUT" | "CONSOLIDATION" | "INSUFFICIENT_DATA";
export type SwingQuote = { bid: number; ask: number; time: string; tradeable: boolean; source: "oanda" };
export type SwingFrameRead = {
  timeframe: SwingFrame; condition: string; control: SwingControl; sufficient: boolean; atr: number;
  lastClosedOpenTime: string | null; formingOpenTime: string | null; evidence: string[];
  highs: Array<{ price: number; time: string; confirmedAt: string }>;
  lows: Array<{ price: number; time: string; confirmedAt: string }>;
  momentum: { displacementAtr: number; efficiency: number; bodyStrength: number; closePosition: number; persistence: number;
    accelerationAtr: number; recoveryPercent: number | null; volatilityRatio: number | null };
};
export type SwingStructureZone = { lower: number; upper: number; type: string; relevance: string; timeframes: string[];
  swingReferences: Array<{ price: number; time: string; confirmedAt: string }>; evidence: string[] };
export type SwingCalendarEvent = { id: string; title: string; currency: string; timestamp: string; impact: number;
  actual: string | null; forecast: string | null; previous: string | null; revised: null; timingVerified: boolean;
  surprise?: { side: "ABOVE" | "BELOW" | "IN_LINE" | "UNKNOWN"; difference: number | null; unit: string | null };
  reaction?: { status: "OBSERVED" | "UNVERIFIED"; changePercent: number | null; explanation: string; startAt: string | null; endAt: string | null } };
export type SwingMarket = {
  instrument: string; capturedAt: string; quote: SwingQuote | null; pipSize: number; precision: number;
  state: "CURRENT" | "MARKET_CLOSED" | "ROLLOVER" | "STALE" | "PROVIDER_ERROR";
  issues: string[]; frames: Record<SwingFrame, SwingFrameRead>; structureZones: SwingStructureZone[];
  calendar: { available: boolean; fetchedAt: string | null; coverageUntil: string | null; events: SwingCalendarEvent[] };
};
export type SwingInterpretation = {
  instrument: string; d1Condition: string; h4Condition: string; h1Condition: string;
  technicalLean: SwingLean; combinedLean: SwingLean; explanation: string; swingOutlook: string;
  buyEvidence: string[]; sellEvidence: string[]; contradictions: string[]; drivers: string[]; invalidation: string[];
  changes: string[]; limitations: string[]; sourceIds: string[];
  levels: Array<{ price: number; reference: string }>;
  proposedZones: Array<{ lower: number; upper: number; classification: "PULLBACK_REVERSAL" | "BREAKOUT_CONTINUATION"; reason: string }>;
};
export type SwingAssessment = {
  id: string; instrument: string; createdAt: string; expiresAt: string; horizon: string;
  sourceTimes: Record<string, string | null>; interpretation: SwingInterpretation;
  fundamentalBias: string; fundamentalSummary: string;
  sources: Array<{ id: string; url: string; title: string | null; publisher: string; publishedAt: string | null; retrievedAt: string }>;
  fundamentalEvidence: Array<{ id: string; factor: string; description: string; impactOnPair: string; evidenceType: string; observedAt: string | null; sourceIds: string[] }>;
  calendar: SwingCalendarEvent[]; limitations: string[];
};
export type SwingMovementWindow = {
  seconds: number; samples: number; coveredSeconds: number; ready: boolean; upCount: number; downCount: number; unchangedCount: number;
  upPips: number; downPips: number; netPips: number; efficiency: number; velocity: number | null; acceleration: number | null;
  consecutiveUp: number; consecutiveDown: number; directionChanges: number; high: number | null; low: number | null;
  pullbackPips: number; recoveryPips: number; failedHighExtensions: number; failedLowExtensions: number;
  spreadPips: number | null; maxSpreadPips: number | null; observedQuotesPerSecond: number;
  aboveZoneSeconds: number; belowZoneSeconds: number; insideZoneSeconds: number;
};
export type SwingMovement = {
  instrument: string; asOf: string; lastBrokerTime: string | null; connection: string; state: "READY" | "WARMING" | "STALE" | "DISCONNECTED";
  reason: string | null; gaps: number; rejected: number; heartbeats: number; windows: SwingMovementWindow[];
  summaries: Array<{ timeframe: "H1" | "H4"; bucket: string; firstBrokerTime: string; lastBrokerTime: string;
    upCount: number; downCount: number; upPips: number; downPips: number; netPips: number; resets: number }>;
  normalization: { atrRatio: number | null; spreadRatio: number | null; sessionActivityRatio: number | null; quoteFrequencyRatio: number | null };
  limitation: string;
};
export type SwingZone = {
  id: string; instrument: string; assessmentId: string | null; timeframe: "H4"; lower: number; upper: number;
  classification: "PULLBACK_REVERSAL" | "BREAKOUT_CONTINUATION"; structuralType: string; status: SwingZoneStatus;
  createdAt: string; validatedAt: string; expiresAt: string; revision: number; touchedAt: string | null;
  evidence: string[]; fundamentalContext: string[]; swingReferences: SwingStructureZone["swingReferences"];
  buyScenario: string; sellScenario: string; invalidation: { lower: number; upper: number; rules: string[] };
  behavior: SwingBehavior; behaviorSide: SwingSide | null; reason: string; generation: string;
};
export type SwingExpectancy = { status: "VALIDATED" | "UNAVAILABLE"; strategyVersion: string; sampleSize: number | null;
  expectancyR: number | null; winRate: number | null; validatedAt: string | null; source: string | null };
export type SwingScenario = {
  id: string; zoneId: string; instrument: string; side: SwingSide; style: SwingStyle; asOf: string;
  preference: SwingLean; eligibility: "ELIGIBLE" | "WATCHING" | "BLOCKED" | "INVALIDATED";
  provisional: boolean; entry: number | null; stop: number | null; firstTarget: number | null; secondTarget: number | null;
  stopPips: number | null; rewardPips: number | null; rewardRisk: number | null; spreadImpactR: number | null;
  financingImpact: number | null; riskPercent: number; riskAmount: number | null; units: number | null; accountCurrency: string | null;
  support: string[]; contradictions: string[]; blockers: string[]; expectancy: SwingExpectancy;
};
export type SwingEvent = { id: string; at: string; kind: string; zoneId: string | null; detail: string; data: Record<string, unknown> };
export type SwingJob = { id: string; kind: "DAILY" | "MATERIAL_NEWS" | "MANUAL" | "HOURLY_CHECK"; status: string; createdAt: string; completedAt: string | null; error: string | null };
export type SwingView = {
  enabled: boolean; runtime: { available: boolean; reason: string | null }; analysisOnly: true; instrument: string;
  monitor: { active: boolean; style: SwingStyle } | null; market: SwingMarket | null; assessment: SwingAssessment | null;
  assessmentFresh: boolean; zones: SwingZone[]; unavailableZones: string[]; movement: SwingMovement | null;
  control: { d1: SwingControl; h4: SwingControl; pressure: SwingControl }; preference: SwingLean; scenarios: SwingScenario[];
  events: SwingEvent[]; job: SwingJob | null; usage: { requests: number; inputTokens: number; outputTokens: number;
    searches: number; knownCostUsd: number; unknownCostRequests: number; latencyMs: number };
};
