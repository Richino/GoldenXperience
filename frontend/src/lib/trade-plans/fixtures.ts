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

/** Synthetic research for the dev preview only. example.com links; not real reporting. */
export function fixtureResearch(): import("@/lib/trade-plans/api").ResearchResult {
  const at = new Date(Date.parse("2026-10-16T09:00:00Z")).toISOString();
  return {
    cached: true,
    research: {
      id: "00000000-0000-4000-8000-0000000000cc", instrument: "EUR_USD", status: "COMPLETE", model: "fixture", sourceCount: 6,
      createdAt: at, expiresAt: hours(5), fresh: true, staleReason: null,
      usage: { inputTokens: 9000, outputTokens: 1800, webSearchCalls: 4, costUsd: null },
      calendar: {
        available: true, readAt: at, source: "Fixture calendar", note: null,
        released: [{ title: "Fixture CPI m/m", currency: "USD", impact: 3, at: hours(-20), forecast: "0.3%", previous: "0.2%", actual: "0.4%", surprise: { side: "ABOVE", difference: 0.1, unit: "%" } }],
        upcoming: [{ title: "Fixture ECB rate decision", currency: "EUR", impact: 3, at: hours(30), forecast: "2.00%", previous: "2.00%", actual: null }],
      },
      report: {
        overallBias: "MIXED", confidence: "LOW",
        summary: "Fixture: the technical structure leans bearish while the example fundamentals point to a possible recovery; the evidence conflicts.",
        baseCurrency: { label: "Neutral", summary: "Fixture euro outlook." },
        quoteCurrency: { label: "Softening", summary: "Fixture dollar outlook." },
        ratesAndYields: "Fixture rates text.", riskSentiment: "Fixture risk mood.",
        technicalVsFundamental: "Fixture: H4/D1 structure bearish; fundamentals mixed-to-supportive.",
        news: [{ headline: "Fixture headline about inflation", publisher: "Example Wire", publishedAt: hours(-18), url: "https://example.com/news/1", currencies: ["USD"], topic: "inflation", kind: "FACT", implication: "MIXED", summary: "Fixture summary." }],
        sentiment: { summary: "Fixture: a handful of public comments, split.", observations: [{ source: "example forum", url: "https://example.com/forum/1", stance: "SPECULATION", text: "Fixture comment." }], limitations: "Fixture limitation." },
        bullishEvidence: [{ point: "Fixture: softer dollar data could support a recovery.", urls: ["https://example.com/news/1"] }],
        bearishEvidence: [{ point: "Fixture: the H4 lower highs are intact.", urls: ["https://example.com/news/2"] }],
        catalysts: [{ event: "Fixture ECB decision", why: "Fixture reason." }],
        uncertainties: ["Fixture uncertainty."],
        conclusion: { supports: "Fixture: no clear direction.", invalidatedBy: "Fixture.", needsPriceConfirmation: "Fixture: a confirmed break of either zone." },
      },
    },
  };
}
