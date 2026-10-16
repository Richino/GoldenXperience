import type { TradePlan } from "@/lib/trade-plans/api";

/** Synthetic EUR/USD plans for the dev preview and tests. Not market data. */
const hours = (n: number, from = Date.parse("2026-10-16T12:00:00Z")) => new Date(from + n * 3_600_000).toISOString();

const conditionsReversal = (direction: "BUY" | "SELL") => [
  { key: "approach", label: `Price reaches the ${direction === "BUY" ? "support" : "resistance"} zone`, status: "PENDING" as const, detail: null },
  { key: "rejection_or_sweep", label: "Rejection or liquidity sweep", status: "PENDING" as const, detail: null },
  { key: "reclaim", label: "Zone reclaimed (if swept)", status: "PENDING" as const, detail: null },
  { key: "local_structure", label: `H1 structure turns ${direction === "BUY" ? "up" : "down"}`, status: "PENDING" as const, detail: null },
  { key: "stop_placement", label: "Stop beyond the rejection", status: "PENDING" as const, detail: null },
  { key: "reward_risk", label: "Reward/risk still adequate", status: "PENDING" as const, detail: null },
  { key: "execution_safety", label: "News, spread and risk checks", status: "PENDING" as const, detail: null },
];

export function fixturePlan(direction: "BUY" | "SELL", patch: Partial<TradePlan> = {}): TradePlan {
  const buy = direction === "BUY";
  return {
    id: buy ? "00000000-0000-4000-8000-0000000000b1" : "00000000-0000-4000-8000-0000000000b2",
    analysisId: "00000000-0000-4000-8000-0000000000aa",
    instrument: "EUR_USD",
    direction,
    setupType: "SR_REVERSAL",
    status: "PENDING_APPROVAL",
    planVersion: 1,
    stateVersion: "2",
    monitoringMode: null,
    pausedAt: null,
    timeframe: "H4",
    marketBias: "Bearish",
    trendClassification: "D1 downtrend · H4 unclear · H1 transition",
    entryZoneLow: buy ? 1.12113 : 1.12399,
    entryZoneHigh: buy ? 1.12153 : 1.12439,
    stopLoss: buy ? 1.12015 : 1.12537,
    takeProfit: buy ? 1.12386 : 1.12166,
    rewardRisk: 1.76,
    maxRiskPercent: 1,
    plan: {
      style: "SWING",
      maxHoldTradingDays: 5,
      rules: { atrTimeframe: "H4", confirmTimeframe: "H1" },
      explanation: [
        buy
          ? "Support at 1.12113–1.12153 (2 swing reactions, old resistance that flipped), 0.5 H4 ATR from price."
          : "Resistance at 1.12399–1.12439 (2 swing reactions, structural), 0.4 H4 ATR from price.",
        "Reaching the zone is not a signal: the plan needs a rejection and an H1 structure turn.",
      ],
      invalidation: { rules: [buy ? "A completed M15 close below 1.12088 (the zone gave way)." : "A completed M15 close above 1.12464 (the zone gave way).", "The plan expires before confirming."] },
    },
    strategyVersion: "trade-plans-v1",
    marketDataAt: hours(-0.2),
    expiresAt: hours(71),
    createdAt: hours(-1),
    updatedAt: hours(-1),
    monitorStage: null,
    lastEvaluatedAt: null,
    lastPrice: null,
    notTriggeredReason: null,
    monitorState: null,
    conditions: conditionsReversal(direction),
    ...patch,
  };
}

/** Accepted and being watched, price between the zones. */
export function watchingPair(price = 1.12296): TradePlan[] {
  const common = { status: "MONITORING" as const, monitoringMode: "NOTIFY" as const, lastPrice: price, lastEvaluatedAt: hours(-0.02), monitorStage: "WAITING_FOR_ZONE" };
  return [
    fixturePlan("BUY", { ...common, notTriggeredReason: "Waiting for price to reach the zone 1.12113–1.12153." }),
    fixturePlan("SELL", { ...common, notTriggeredReason: "Waiting for price to reach the zone 1.12399–1.12439." }),
  ];
}

/** Synthetic research (contract v2) for the dev preview only. example.com links; not real reporting. */
export function fixtureResearch(): import("@/lib/trade-plans/api").ResearchResult {
  const at = new Date(Date.parse("2026-10-16T09:00:00Z")).toISOString();
  const source = (id: string, path: string, publisher: string, type: "official" | "news" | "analysis" | "forum") =>
    ({ id, url: `https://example.com/${path}`, publisher, title: `Fixture ${publisher}`, retrievedAt: at, publishedAt: at, type });
  return {
    cached: true,
    research: {
      id: "00000000-0000-4000-8000-0000000000cc", instrument: "EUR_USD", status: "COMPLETE", model: "fixture", sourceCount: 4,
      createdAt: at, expiresAt: hours(5), fresh: true, staleReason: null,
      usage: { inputTokens: 9000, outputTokens: 1800, webSearchCalls: 4, costUsd: null },
      calendar: { available: true, readAt: at, source: "Fixture calendar", note: null, released: [], upcoming: [] },
      report: {
        schemaVersion: "2.1", pair: "EUR_USD", base: "EUR", quote: "USD",
        research: { id: "00000000-0000-4000-8000-0000000000cc", createdAt: at, cutoffAt: at, horizon: "2-5 trading days", status: "complete", quality: "medium", missingData: ["Fixture: verified relative bond yields"], model: "fixture", effort: "high", durationMs: 160000 },
        outlook: { overall: "mixed", shortTerm: "bullish", swingTerm: "bearish", fundamental: "bullish", technical: "bearish", explanation: "Fixture: a short-term recovery within a broader downtrend." },
        factors: [
          { id: "F1", factor: "Fixture: Fed hike bets fade", currency: "USD", effectOnCurrency: "weakens", impactOnPair: "bullish", importance: "high", evidenceType: "verified_data", description: "Fixture description.", observedAt: at, uncertainty: null, sourceIds: ["src_001"] },
          { id: "F2", factor: "Fixture: French fiscal risk", currency: "EUR", effectOnCurrency: "weakens", impactOnPair: "bearish", importance: "medium", evidenceType: "attributed_analysis", description: "Fixture description.", observedAt: null, uncertainty: "Fixture uncertainty.", sourceIds: ["src_002"] },
        ],
        events: [
          { id: "e1", title: "Fixture CPI m/m", currency: "USD", impact: 3, at: hours(-20), actual: "0.4%", forecast: "0.3%", previous: "0.2%", status: "released", source: "Fixture calendar", implication: "Fixture: hot print but the dollar fell." },
          { id: "e2", title: "Fixture ECB decision", currency: "EUR", impact: 3, at: hours(30), actual: null, forecast: "2.00%", previous: "2.00%", status: "scheduled", source: "Fixture calendar", implication: null },
        ],
        sentiment: {
          professional: [{ text: "Fixture analyst expects a bounce toward resistance.", stance: "bullish", sourceIds: ["src_003"] }],
          retail: [{ text: "Fixture forum thread split.", stance: "mixed", sourceIds: ["src_004"] }],
          positioning: [],
          expectations: "Fixture: markets price no further Fed hike this month.",
          limitations: "Fixture: a handful of public comments; no positioning data found.",
        },
        bullishThesis: { hypothesis: "Fixture: a recovery if dollar weakness continues.", supportingFactorIds: ["F1"], opposingFactorIds: ["F2"], catalysts: ["Fixture ECB decision"], strengthensIf: ["Fixture: softer US data"], weakensIf: ["Fixture: a hawkish Fed surprise"] },
        bearishThesis: { hypothesis: "Fixture: the downtrend resumes if the bounce fades.", supportingFactorIds: ["F2"], opposingFactorIds: ["F1"], catalysts: [], strengthensIf: ["Fixture: wider fiscal stress"], weakensIf: ["Fixture: firmer euro data"] },
        assessment: {
          nearTermLean: "bullish", swingLean: "unresolved",
          evidenceBalance: { bullish: 3, bearish: 2, strongerSide: "neither" },
          drivers: ["Fixture: softer US yields", "Fixture: French fiscal risk"],
          strongestOpposing: "Fixture: French fiscal risk keeps a premium on the euro.",
          changeTriggers: ["Fixture: a hot US CPI print", "Fixture: a hawkish ECB surprise"],
          rationale: "Fixture: near-term evidence tilts to a recovery; over 2–5 days the sides are balanced.",
          supportingFactorIds: ["F1"],
        },
        sources: [source("src_001", "news/1", "Example Wire", "news"), source("src_002", "news/2", "Example Times", "news"), source("src_003", "analysis/1", "Example FX", "analysis"), source("src_004", "forum/1", "Example Forum", "forum")],
        summary: "Fixture: technicals lean bearish while near-term fundamentals favour a recovery; the evidence conflicts.",
      },
    },
  };
}
