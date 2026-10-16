import assert from "node:assert/strict";
import { buildCalendarSnapshot, calendarRefs, parseReleaseValue, surpriseOf } from "../src/intelligence/calendar-snapshot.js";
import { canonicalUrl, plainText } from "../src/intelligence/research-report.js";
import { impactOnPair, technicalBias, validateResearch, type MarketIntelligence } from "../src/intelligence/research-contract.js";
import { collectSources, estimateCost, runResearch, type TechnicalSummary } from "../src/intelligence/openai-research.js";
import { alignmentOf, researchContextForPlan } from "../src/intelligence/plan-research.js";
import { budgetVerdict, researchFreshness, researchSettings } from "../src/intelligence/research-service.js";
import { attachIntelligence } from "../src/trade-plan-service.js";
import { generateTradePlans, TRADE_PLAN_CONFIG } from "../src/trade-plan-generator.js";
import { evaluateConfirmation, type PlanForConfirmation } from "../src/trade-plan-confirmation.js";
import { decideMonitorActions } from "../src/trade-plan-monitor.js";
import { executionChecks, type ExecutionInput } from "../src/trade-plan-execution-checks.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { EconomicCalendarEvent } from "../../frontend/src/lib/oanda/calendar.js";

/**
 * Market intelligence → trading engine, end to end, with a mocked OpenAI and
 * the real generator, confirmation engine, monitor decisions and execution
 * checks. No network, no database.
 */

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}
const NOW = Date.parse("2026-10-14T12:00:00Z");
const HOUR = 3_600_000;

// ── Fixtures ──────────────────────────────────────────────────────
const events: EconomicCalendarEvent[] = [
  { id: "1", title: "CPI m/m", currency: "USD", region: "us", impact: 3, timestamp: "2026-10-13T12:30:00Z", forecast: "0.3%", previous: "0.2%", actual: "0.4%", unit: null },
  { id: "1b", title: "CPI m/m", currency: "USD", region: "us", impact: 3, timestamp: "2026-10-13T08:30:00-04:00", forecast: "0.3%", previous: "0.2%", actual: "0.4%", unit: null },
  { id: "2", title: "ECB Press Conference", currency: "EUR", region: "eu", impact: 3, timestamp: "2026-10-15T12:45:00Z", forecast: null, previous: null, actual: null, unit: null },
  { id: "3", title: "BoJ minutes", currency: "JPY", region: "jp", impact: 3, timestamp: "2026-10-15T00:00:00Z", forecast: null, previous: null, actual: null, unit: null },
];
const snapshot = buildCalendarSnapshot({ events, currencies: ["EUR", "USD"], now: NOW });
const refs = calendarRefs(snapshot);
const SEARCH = [
  { url: "https://www.reuters.com/markets/currencies/dollar-slips-2026-10-13/", title: "Reuters" },
  { url: "https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp261015.en.html", title: "ECB" },
  { url: "https://www.fxstreet.com/analysis/eurusd-outlook-123", title: "FXStreet" },
  { url: "https://www.forexfactory.com/thread/123-eurusd", title: "FF thread" },
];
const meta = { id: "r-test", createdAt: new Date(NOW).toISOString(), model: "test-model", effort: "high", durationMs: 1000 };

/** A model answer in the v2 shape; `lean` sets which way the factors point for EUR/USD. */
function answer(lean: "bullish" | "bearish" | "mixed" = "mixed", extra: Record<string, unknown> = {}) {
  const usd = lean === "bearish" ? "strengthens" : "weakens";
  const eur = lean === "bullish" ? "strengthens" : "weakens";
  return {
    quality: "medium",
    missingData: ["Verified relative bond yields"],
    outlook: { overall: lean === "mixed" ? "mixed" : lean, shortTerm: "bullish", swingTerm: "bearish", fundamental: lean === "mixed" ? "bullish" : lean, explanation: "Short-term recovery inside a broader downtrend." },
    factors: [
      { id: "F1", factor: "Fed hike bets fade", currency: "USD", effectOnCurrency: usd, importance: "high", evidenceType: "verified_data", description: "Dollar fell after CPI.", observedAt: "2026-10-13T15:00:00Z", uncertainty: null, urls: ["https://reuters.com/markets/currencies/dollar-slips-2026-10-13?utm_source=x"] },
      { id: "F2", factor: "French fiscal risk", currency: "EUR", effectOnCurrency: lean === "mixed" ? "weakens" : eur, importance: "medium", evidenceType: "attributed_analysis", description: "Debt concerns.", observedAt: null, uncertainty: "Depends on budget talks.", urls: ["https://www.fxstreet.com/analysis/eurusd-outlook-123"] },
      { id: "F3", factor: "Invented scoop", currency: "EUR", effectOnCurrency: "strengthens", importance: "high", evidenceType: "verified_data", description: "Not real.", observedAt: null, uncertainty: null, urls: ["https://made-up.example/story"] },
    ],
    eventImplications: [{ eventId: "e1", implication: "Hot CPI, yet the dollar fell." }, { eventId: "e99", implication: "Unknown event." }],
    sentiment: {
      professional: [{ text: "Bank sees a bounce.", stance: "bullish", urls: ["https://www.fxstreet.com/analysis/eurusd-outlook-123"] }],
      retail: [{ text: "Thread split.", stance: "mixed", urls: ["https://www.forexfactory.com/thread/123-eurusd"] }],
      positioning: [{ text: "Forum says everyone is short.", stance: "bearish", urls: ["https://www.forexfactory.com/thread/123-eurusd"] }],
      expectations: "No further Fed hike priced this month.",
      limitations: "Few public comments.",
    },
    bullishThesis: { hypothesis: "Recovery if dollar weakness continues.", supportingFactorIds: ["F1"], opposingFactorIds: ["F2", "F3", "F9"], catalysts: ["ECB decision"], strengthensIf: ["Softer US data"], weakensIf: ["Hawkish Fed"] },
    bearishThesis: { hypothesis: "Downtrend resumes if the bounce fades.", supportingFactorIds: ["F2"], opposingFactorIds: ["F1"], catalysts: [], strengthensIf: ["Fiscal stress"], weakensIf: ["Firmer euro data"] },
    sourceDates: [{ url: SEARCH[0]!.url, publisher: "Reuters", publishedAt: "2026-10-13T15:00:00Z" }, { url: SEARCH[2]!.url, publisher: "FXStreet", publishedAt: "2099-01-01T00:00:00Z" }],
    summary: "Near-term recovery is plausible, but the broader downtrend remains a risk.",
    ...extra,
  };
}
const validate = (raw: unknown, pair = "EUR_USD", trend: Record<string, string> = { D1: "DOWNTREND", H4: "UNCLEAR" }) =>
  validateResearch(raw, { pair, searchUrls: SEARCH, calendar: refs, technicalTrend: trend, meta });
function intel(lean: "bullish" | "bearish" | "mixed" = "mixed", pair = "EUR_USD"): MarketIntelligence {
  const result = validate(answer(lean), pair);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return (result as { intelligence: MarketIntelligence }).intelligence;
}

// ── Calendar (verified data only) ─────────────────────────────────
await test("release values and surprises parse; no bullish/bearish assumption", () => {
  assert.deepEqual(parseReleaseValue("245K"), { value: 245_000, unit: "K" });
  assert.equal(surpriseOf("0.4%", "0.3%").side, "ABOVE");
  assert.equal(surpriseOf("0.4%", "250K").side, "UNKNOWN");
});
await test("calendar slice: pair currencies, UTC, de-duplicated, stable ids, revisions unavailable", () => {
  assert.equal(snapshot.released.length, 1);
  assert.equal(snapshot.released[0]!.at, "2026-10-13T12:30:00.000Z");
  assert.deepEqual(refs.map((ref) => [ref.id, ref.status, ref.currency]), [["e1", "released", "USD"], ["e2", "scheduled", "EUR"]]);
  assert.equal(refs[0]!.revised, null);
  assert.equal(buildCalendarSnapshot({ events: null, currencies: ["EUR", "USD"], now: NOW }).available, false);
});

// ── Contract and validation ───────────────────────────────────────
await test("Test 7 — pair independence: the server derives each factor's pair direction from base/quote", () => {
  assert.equal(impactOnPair("EUR_USD", "USD", "weakens"), "bullish");
  assert.equal(impactOnPair("USD_JPY", "USD", "weakens"), "bearish");
  assert.equal(impactOnPair("GBP_USD", "GBP", "strengthens"), "bullish");
  assert.equal(impactOnPair("AUD_USD", "USD", "strengthens"), "bearish");
  assert.equal(impactOnPair("USD_CAD", "CAD", "strengthens"), "bearish");
  assert.equal(impactOnPair("EUR_JPY", "JPY", "weakens"), "bullish");
  assert.equal(impactOnPair("EUR_JPY", "USD", "weakens"), "unknown", "a third currency has no mechanical pair direction");
  assert.equal(impactOnPair("EUR_USD", "USD", "mixed"), "mixed");
  // The same USD-weakness factor read for two pairs points opposite ways.
  assert.equal(intel("mixed", "EUR_USD").factors.find((f) => f.id === "F1")!.impactOnPair, "bullish");
  const jpy = validate({ ...answer("mixed"), factors: [answer("mixed").factors[0]] }, "USD_JPY");
  assert.ok(jpy.ok && jpy.intelligence.factors[0]!.impactOnPair === "bearish");
});

await test("a valid answer becomes a typed snapshot with registry source ids and server metadata", () => {
  const result = validate(answer("mixed"));
  assert.ok(result.ok);
  if (!result.ok) return;
  const r = result.intelligence;
  assert.equal(r.schemaVersion, "2.1");
  assert.equal(r.research.id, "r-test");
  assert.equal(r.research.horizon, "2-5 trading days");
  assert.equal(r.outlook.technical, "bearish", "technical bias comes from the engine's D1/H4, not GPT");
  assert.deepEqual(r.factors.map((f) => f.id), ["F1", "F2"], "the factor citing an unreturned URL is dropped");
  assert.ok(r.factors.every((f) => f.sourceIds.every((id) => r.sources.some((s) => s.id === id))));
  assert.equal(r.sources.find((s) => s.url === SEARCH[0]!.url)!.publishedAt, "2026-10-13T15:00:00.000Z");
  assert.equal(r.sources.find((s) => s.url === SEARCH[2]!.url)!.publishedAt, null, "a publication date after the cut-off is not trusted");
  assert.equal(r.sources.find((s) => s.url === SEARCH[3]!.url)!.type, "forum");
  assert.equal(r.events.find((e) => e.id === "e1")!.implication, "Hot CPI, yet the dollar fell.");
  assert.equal(r.events.find((e) => e.id === "e1")!.actual, "0.4%", "figures are the calendar's, not GPT's");
  assert.deepEqual(r.bullishThesis.opposingFactorIds, ["F2"], "references to dropped or unknown factors are removed");
  assert.equal(r.sentiment.positioning.length, 0, "forum posts are not positioning data");
  assert.equal(r.sentiment.retail.length, 1);
  const reasons = result.drops.map((d) => d.reason);
  for (const expected of ["cited URL was not returned by the web search", "unknown event id", "unknown or dropped factor id", "forum posts are not positioning data"]) {
    assert.ok(reasons.includes(expected), expected);
  }
});

await test("MIXED and UNKNOWN stay distinct: no cited factors means unknown, not mixed", () => {
  const result = validate({ ...answer("mixed"), factors: [] });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.intelligence.outlook.fundamental, "unknown");
    assert.equal(result.intelligence.research.quality, "low");
    assert.equal(result.intelligence.research.status, "partial");
  }
  assert.equal(intel("mixed").outlook.overall, "mixed");
});

await test("Test 4 — invalid output is rejected and never reaches the engine", () => {
  assert.equal(validate(null).ok, false);
  assert.equal(validate("text").ok, false);
  const { summary: _s, ...noSummary } = answer("mixed");
  assert.equal(validate(noSummary).ok, false);
  const { factors: _f, ...noFactors } = answer("mixed");
  assert.equal(validate(noFactors).ok, false);
  assert.equal(validate({ ...answer("mixed"), outlook: { ...answer("mixed").outlook, overall: "very bullish" } }).ok, false);
});

await test("technical bias from structure", () => {
  assert.equal(technicalBias({ D1: "DOWNTREND", H4: "DOWNTREND" }), "bearish");
  assert.equal(technicalBias({ D1: "DOWNTREND", H4: "UPTREND" }), "mixed");
  assert.equal(technicalBias({ D1: "UNCLEAR", H4: "UNCLEAR" }), "unknown");
});

await test("inline markdown and URL matching", () => {
  assert.equal(plainText("Dollar fell. ([aol.com](https://www.aol.com/x))"), "Dollar fell.");
  assert.equal(canonicalUrl("https://www.reuters.com/a/?utm_source=x"), canonicalUrl("https://reuters.com/a"));
});

// ── The research call (mocked OpenAI) ─────────────────────────────
const technical: TechnicalSummary = { instrument: "EUR_USD", readAt: new Date(NOW).toISOString(), price: 1.1229, trend: { D1: "DOWNTREND", H4: "UNCLEAR" }, atr: { H4: 0.002 }, zones: [], plans: [] };
const payloadFor = (body: unknown) => ({
  output: [
    { type: "web_search_call", action: { type: "search", sources: SEARCH.slice(0, 3).map(({ url }) => ({ type: "url", url })) } },
    { type: "web_search_call", action: { type: "search", sources: [{ type: "url", url: SEARCH[3]!.url }] } },
    { type: "message", content: [{ type: "output_text", text: typeof body === "string" ? body : JSON.stringify(body), annotations: [] }] },
  ],
  usage: { input_tokens: 12_000, output_tokens: 2_000 },
});
const env = { OPENAI_API_KEY: "k", OPENAI_RESEARCH_MODEL: "test-model", OPENAI_RESEARCH_EFFORT: "high", OPENAI_PRICE_INPUT_PER_MTOK: "1", OPENAI_PRICE_OUTPUT_PER_MTOK: "4", OPENAI_PRICE_WEB_SEARCH_CALL: "0.01" } as NodeJS.ProcessEnv;
const mock = (body: unknown, status = 200) => async () => new Response(JSON.stringify(status === 200 ? payloadFor(body) : body), { status });
const research = (fetcher: (url?: string, init?: RequestInit) => Promise<Response>, e = env) => runResearch({ instrument: "EUR_USD", currencies: ["EUR", "USD"], technical, calendar: refs, calendarNote: null, researchId: "r-test", now: NOW, env: e, fetcher: fetcher as typeof fetch });

await test("a research run: strict v2 schema, untrusted-content rule, verified calendar passed, cost recorded", async () => {
  let sent: Record<string, unknown> = {};
  const outcome = await research(async (_url?: string, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify(payloadFor(answer("mixed"))), { status: 200 }); });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
  assert.equal((sent.text as { format: { name: string; strict: boolean } }).format.name, "market_intelligence_v2");
  assert.equal((sent.reasoning as { effort: string }).effort, "high");
  assert.match(String(sent.input), /untrusted DATA/);
  assert.match(String(sent.input), /"id":"e1"/);
  if (!outcome.ok) return;
  assert.equal(outcome.usage.costUsd, 0.04);
  assert.equal(outcome.intelligence.research.effort, "high");
  assert.equal(collectSources(payloadFor({})).length, 4);
});

await test("Test 4 (live path) — malformed JSON, rate limits, timeouts and no key fail without a snapshot", async () => {
  const bad = await research(mock("not json"));
  assert.ok(!bad.ok && /not valid JSON/.test(bad.error), bad.ok ? "" : bad.error);
  const missing = await research(mock({ ...answer("mixed"), outlook: undefined }));
  assert.ok(!missing.ok && /Research rejected/.test(missing.error), missing.ok ? "" : missing.error);
  const limited = await research(mock({ error: { message: "slow" } }, 429));
  assert.ok(!limited.ok && /rate limit/.test(limited.error), limited.ok ? "" : limited.error);
  const slow = await research(async () => { const error = new Error("t"); error.name = "TimeoutError"; throw error; });
  assert.ok(!slow.ok && /timed out/.test(slow.error), slow.ok ? "" : slow.error);
  const unset = await research(mock(answer("mixed")), {} as NodeJS.ProcessEnv);
  assert.ok(!unset.ok && /not configured/.test(unset.error), unset.ok ? "" : unset.error);
  assert.equal(estimateCost({ inputTokens: 1, outputTokens: 1, webSearchCalls: 1 }, { inputPerMTok: null, outputPerMTok: 1, perSearch: 1 }), null);
});

// ── Freshness and budget ──────────────────────────────────────────
await test("Test 5 — stale research is labelled stale (time, new release, or older format)", () => {
  const row = { created_at: new Date(NOW - 2 * HOUR), expires_at: new Date(NOW + 4 * HOUR), currencies: ["EUR", "USD"], report: { schemaVersion: "2.0" } };
  assert.equal(researchFreshness(row, [], NOW).fresh, true);
  assert.equal(researchFreshness({ ...row, expires_at: new Date(NOW - 1) }, [], NOW).fresh, false);
  assert.match(researchFreshness(row, [{ currency: "USD", impact: 3, at: new Date(NOW - HOUR).toISOString() }], NOW).reason ?? "", /USD release/);
  assert.match(researchFreshness({ ...row, report: { overallBias: "MIXED" } }, [], NOW).reason ?? "", /older format/);
});
await test("budget stops optional research", () => {
  const settings = { ...researchSettings({} as NodeJS.ProcessEnv), dailyRunLimit: 3, dailyBudgetUsd: 1, monthlyBudgetUsd: 10 };
  assert.equal(budgetVerdict({ todayRuns: 3, todayUsd: 0, monthUsd: 0, unknownCostRuns: 0 }, settings).allowed, false);
  assert.equal(budgetVerdict({ todayRuns: 0, todayUsd: 1, monthUsd: 0, unknownCostRuns: 0 }, settings).allowed, false);
});

// ── Research meets plans ──────────────────────────────────────────
type Path = Array<[number, number]>;
const priceAt = (path: Path, at: number) => { if (at <= path[0]![0]) return path[0]![1]; for (let i = 1; i < path.length; i += 1) { const [t1, p1] = path[i]!; const [t0, p0] = path[i - 1]!; if (at <= t1) return p0 + ((p1 - p0) * (at - t0)) / (t1 - t0); } return path.at(-1)![1]; };
function candles(path: Path, step: number, count: number, end: number, wick = 0.001): Candle[] {
  const first = Math.floor(end / step) * step - count * step;
  return Array.from({ length: count }, (_, i) => { const open = first + i * step; const s = [0, 0.25, 0.5, 0.75, 1].map((f) => priceAt(path, open + f * step)); return { time: new Date(open).toISOString(), open: s[0]!, close: s[4]!, high: Math.max(...s) + wick, low: Math.min(...s) - wick, volume: 100, complete: true }; });
}
const span = 52 * 24 * HOUR;
const pathOf = (legs: number[]): Path => legs.map((offset, i) => [NOW - span + (span * i) / (legs.length - 1), 1.12 + offset * 5]);
const DOWN = pathOf([0, 0.02, 0.0, 0.012, -0.008, 0.004, -0.016, -0.006, -0.024, -0.012, -0.03, -0.019, -0.0198]);
const UP = pathOf([0, -0.02, 0.0, -0.012, 0.008, -0.004, 0.016, 0.006, 0.024, 0.012, 0.03, 0.019, 0.0198]);
const marketOf = (path: Path) => ({
  candles: { D1: candles(path, 24 * HOUR, 300, NOW), H4: candles(path, 4 * HOUR, 300, NOW), H1: candles(path, HOUR, 300, NOW), M15: candles(path, HOUR / 4, 300, NOW) },
  quote: { bid: priceAt(path, NOW) - 0.00004, ask: priceAt(path, NOW) + 0.00004, time: new Date(NOW - 1000).toISOString() },
  news: [], now: NOW,
});
type Generated = ReturnType<typeof generateTradePlans>["plans"][number];
const rulesOf = (plans: Generated[]) => JSON.stringify(plans.map((p) => [p.direction, p.entryZoneLow, p.entryZoneHigh, p.stopLoss, p.takeProfit, (p.plan as { rules?: unknown }).rules, p.expiresAt]));
const contextOptions = { fresh: true, staleReason: null, technicalReadAt: new Date(NOW).toISOString(), now: NOW };
const ctx = (plan: Generated) => (plan.plan as Record<string, unknown>).intelligence as ReturnType<typeof researchContextForPlan>;
const confirmable = (plan: Generated): PlanForConfirmation => ({ ...plan, stopLoss: plan.stopLoss!, takeProfit: plan.takeProfit!, createdAt: new Date(NOW).toISOString() } as PlanForConfirmation);
const limits = { maxSpreadStopFraction: 0.15, maxDataAgeSeconds: 120, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 };

await test("alignment summarises cited factors, not a probability", () => {
  assert.equal(alignmentOf(0, 0), "no_evidence");
  assert.equal(alignmentOf(6, 2), "supports");
  assert.equal(alignmentOf(2, 6), "opposes");
  assert.equal(alignmentOf(3, 2), "mixed");
});

await test("Test 1 — bullish research reaches the plans, but a BUY is still only conditional", () => {
  const market = marketOf(UP);
  const generated = generateTradePlans({ instrument: "EUR_USD", ...market, maxRiskPercent: 1 });
  const buy = generated.plans.find((p) => p.direction === "BUY");
  assert.ok(buy, `expected a BUY plan: ${generated.reason}`);
  attachIntelligence(generated.plans, intel("bullish"), contextOptions);
  assert.equal(ctx(buy!).alignment, "supports", "structured findings are consumed per plan");
  assert.equal(ctx(buy!).researchId, "r-test");
  assert.ok(ctx(buy!).supporting.length >= 1);
  // GPT being bullish confirms nothing: no candle has formed since the plan.
  const result = evaluateConfirmation({ plan: confirmable(buy!), candles: market.candles, quote: market.quote, news: [], now: NOW + 60_000, limits });
  assert.notEqual(result.outcome, "CONFIRMED");
  assert.ok(!decideMonitorActions({ status: "MONITORING", mode: "AUTO", instrument: "EUR_USD", direction: "BUY", confirmation: result }).some((a) => a.kind === "execute"));
});

await test("Test 2 — MIXED research does not block planning; horizons stay separate; both sides evaluated", () => {
  const market = marketOf(DOWN);
  const generated = generateTradePlans({ instrument: "EUR_USD", ...market, maxRiskPercent: 1 });
  const before = rulesOf(generated.plans);
  const mixed = intel("mixed");
  assert.equal(mixed.outlook.overall, "mixed");
  assert.notEqual(mixed.outlook.shortTerm, mixed.outlook.swingTerm);
  attachIntelligence(generated.plans, mixed, contextOptions);
  assert.equal(generated.plans.length, 2, `both sides planned: ${generated.reason}`);
  for (const plan of generated.plans) assert.ok(["supports", "opposes", "mixed"].includes(ctx(plan).alignment));
  assert.equal(rulesOf(generated.plans), before, "research never changes levels, rules or expiry");
});

await test("Test 3 — conflicting evidence is preserved on both sides; safety rules unchanged", () => {
  const market = marketOf(UP);
  const generated = generateTradePlans({ instrument: "EUR_USD", ...market, maxRiskPercent: 1 });
  const before = rulesOf(generated.plans);
  attachIntelligence(generated.plans, intel("bearish"), contextOptions);
  const buy = generated.plans.find((p) => p.direction === "BUY")!;
  assert.equal(ctx(buy).alignment, "opposes", "technical BUY setup, bearish fundamentals: the conflict is stated");
  assert.ok(ctx(buy).opposing.length >= 1);
  assert.ok(ctx(buy).thesis?.hypothesis);
  assert.equal(rulesOf(generated.plans), before);
  assert.match(ctx(buy).note, /never|not change|unchanged/i);
});

const execBase: ExecutionInput = {
  plan: { instrument: "EUR_USD", direction: "SELL", stopLoss: 1.1254, takeProfit: 1.1166, expiresAt: "2026-10-16T12:00:00Z", maxRiskPercent: 1, minRewardRisk: 1.5, proposalEntry: 1.124 },
  now: NOW,
  settings: { autoApproved: true, killSwitch: false, suspended: false, maxRiskPercent: 1, maxAggregateRiskPercent: 3, maxOpenPositions: 3, dailyLossLimitPercent: 3, maxSpreadStopFraction: 0.15, maxSlippageStopFraction: 0.1, maxDataAgeSeconds: 10, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 },
  brokerEnvironment: "practice", marketOpen: true,
  quote: { bid: 1.124, ask: 1.12408, time: new Date(NOW - 1000).toISOString() },
  news: [], account: { nav: 10_000, marginAvailable: 10_000 }, quoteToUsdRate: 1, openInstruments: [], openAutoTrades: { count: 0, riskPercent: 0 }, realizedTodayPL: 0,
};

await test("Test 5 — with stale research the technical engine still plans; research-dependent Auto entry is blocked when required", () => {
  const market = marketOf(DOWN);
  const generated = generateTradePlans({ instrument: "EUR_USD", ...market, maxRiskPercent: 1 });
  attachIntelligence(generated.plans, intel("mixed"), { ...contextOptions, fresh: false, staleReason: "New high-impact USD release since the research." });
  assert.ok(generated.plans.length > 0, "technical planning works without fresh research");
  assert.equal(ctx(generated.plans[0]!).fresh, false);
  assert.match(ctx(generated.plans[0]!).staleReason ?? "", /USD release/);
  assert.equal(executionChecks({ ...execBase, research: { required: true, fresh: false, reason: "stale" } }).ok, false);
  assert.equal(executionChecks({ ...execBase, research: { required: false, fresh: false, reason: "stale" } }).ok, true, "not required: stale research does not block");
});

await test("Test 6 — an approved BUY stays as approved when new research turns bearish; no SELL is created or executed", () => {
  const market = marketOf(UP);
  const generated = generateTradePlans({ instrument: "EUR_USD", ...market, maxRiskPercent: 1 });
  const buy = generated.plans.find((p) => p.direction === "BUY")!;
  attachIntelligence([buy], intel("bullish"), contextOptions);
  const approved = JSON.stringify(buy);
  // New research arrives and leans the other way: it is evaluated against the plan, not applied to it.
  const later = researchContextForPlan({ instrument: "EUR_USD", direction: "BUY", expiresAt: buy.expiresAt }, { ...intel("bearish"), research: { ...intel("bearish").research, id: "r-later" } }, contextOptions);
  assert.equal(later.alignment, "opposes", "the warning condition is detected");
  assert.equal(JSON.stringify(buy), approved, "the approved plan is untouched");
  assert.equal(ctx(buy).alignment, "supports", "the plan keeps the research it was approved with");
  // The monitor's decisions do not take research as an input: nothing executes because GPT changed its mind.
  const waiting = evaluateConfirmation({ plan: confirmable(buy), candles: market.candles, quote: market.quote, news: [], now: NOW + 60_000, limits });
  const actions = decideMonitorActions({ status: "MONITORING", mode: "AUTO", instrument: "EUR_USD", direction: "BUY", confirmation: waiting });
  assert.ok(!actions.some((a) => a.kind === "execute"));
});

await test("optional gate: Auto trade can refuse to enter against opposing research (off by default)", () => {
  assert.equal(researchSettings({} as NodeJS.ProcessEnv).blockAutoWhenOpposed, false);
  assert.equal(executionChecks({ ...execBase, research: { required: false, fresh: true, reason: null, blockWhenOpposed: false, alignment: "opposes" } }).ok, true);
  const blocked = executionChecks({ ...execBase, research: { required: false, fresh: true, reason: null, blockWhenOpposed: true, alignment: "opposes" } });
  assert.ok(!blocked.ok && blocked.checks.some((c) => c.key === "research_alignment" && !c.ok));
  assert.equal(executionChecks({ ...execBase, research: { required: false, fresh: true, reason: null, blockWhenOpposed: true, alignment: "supports" } }).ok, true);
});

await test("Test 8 — no forced trade: poor reward/risk gives NO_VALID_SETUP whatever the research says", () => {
  const config = TRADE_PLAN_CONFIG as unknown as { minRewardRisk: number };
  const original = config.minRewardRisk;
  config.minRewardRisk = 50;
  try {
    const generated = generateTradePlans({ instrument: "EUR_USD", ...marketOf(DOWN), maxRiskPercent: 1 });
    attachIntelligence(generated.plans, intel("bullish"), contextOptions);
    assert.equal(generated.result, "NO_VALID_SETUP");
    assert.equal(generated.plans.length, 0);
  } finally {
    config.minRewardRisk = original;
  }
});

/** Hand-built BUY breakout to drive confirmation (same shape as the confirmation tests). */
const M15 = 900_000;
const T0 = Date.parse("2026-10-14T08:00:00Z");
const rows = (list: Array<[number, number, number, number]>) => list.map(([o, h, l, c], i): Candle => ({ time: new Date(T0 + i * M15).toISOString(), open: o, high: h, low: l, close: c, volume: 1, complete: true }));
const toH1 = (list: Candle[]) => { const out: Candle[] = []; for (let i = 0; i + 3 < list.length; i += 4) { const g = list.slice(i, i + 4); out.push({ time: g[0]!.time, open: g[0]!.open, close: g[3]!.close, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), volume: 4, complete: true }); } return out; };

await test("Test 9 — full workflow: research → JSON → validation → plans → approval context → monitoring → confirmation → notify or practice order", async () => {
  // 1-3. Research (mocked OpenAI) → strict JSON → validated snapshot.
  const outcome = await research(mock(answer("bullish")));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  // 4-5. The technical engine's plan; the validated snapshot is attached to its side.
  const plan: PlanForConfirmation = {
    instrument: "EUR_USD", direction: "BUY", setupType: "BREAKOUT_RETEST", entryZoneLow: 1.0997, entryZoneHigh: 1.1003, stopLoss: 1.0985, takeProfit: 1.105,
    createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 48 * HOUR).toISOString(),
    plan: { breakoutLevel: 1.1, breakoutAlreadyClosed: false, invalidation: { failLevel: 1.09975, zoneFarEdge: 1.099 }, rules: { atrH1: 0.001, minRewardRisk: 1.5, confirmationValidMinutes: 60, breakoutCloseH1Atr: 0.25, retestToleranceH1Atr: 0.3, retestFailH1Atr: 0.25 } },
  };
  const context = researchContextForPlan(plan, outcome.intelligence, { ...contextOptions, now: T0 });
  assert.equal(context.alignment, "supports");
  assert.equal(context.researchId, "r-test");
  // 6-7. Approved and monitored: the deterministic engine confirms on closed candles; research plays no part.
  const list = rows([[1.0995, 1.0998, 1.0994, 1.0997], [1.0997, 1.1001, 1.0996, 1.1], [1.1, 1.1003, 1.0999, 1.1002], [1.1002, 1.1006, 1.1001, 1.1004], [1.1004, 1.1006, 1.1001, 1.1002], [1.1002, 1.1004, 1.1, 1.1003], [1.1003, 1.1009, 1.1002, 1.1008]]);
  const now = T0 + list.length * M15 + 1000;
  const confirmation = evaluateConfirmation({ plan, candles: { H1: toH1(list), M15: list }, quote: { bid: 1.1008, ask: 1.1009, time: new Date(now - 1000).toISOString() }, news: [], now, limits: { ...limits, maxDataAgeSeconds: 10 } });
  assert.equal(confirmation.outcome, "CONFIRMED", confirmation.notTriggeredReason ?? "");
  // 8a. Notify: confirmed → notified, no order.
  const notify = decideMonitorActions({ status: "MONITORING", mode: "NOTIFY", instrument: "EUR_USD", direction: "BUY", confirmation });
  assert.ok(notify.some((a) => a.kind === "transition" && a.to === "NOTIFIED"));
  assert.ok(!notify.some((a) => a.kind === "execute"));
  // 8b. Auto: confirmed → execution hand-off → practice-only safety checks build the order.
  const auto = decideMonitorActions({ status: "MONITORING", mode: "AUTO", instrument: "EUR_USD", direction: "BUY", confirmation });
  assert.ok(auto.some((a) => a.kind === "execute"));
  const order = executionChecks({ ...execBase, now, plan: { ...execBase.plan, direction: "BUY", stopLoss: 1.0985, takeProfit: 1.105, expiresAt: plan.expiresAt, proposalEntry: confirmation.proposal!.entry }, quote: { bid: 1.1008, ask: 1.1009, time: new Date(now - 1000).toISOString() }, research: { required: true, fresh: true, reason: null, blockWhenOpposed: true, alignment: context.alignment } });
  assert.ok(order.ok, JSON.stringify(order.checks.filter((c) => !c.ok)));
  // Never on a live account.
  assert.equal(executionChecks({ ...execBase, brokerEnvironment: "live" }).ok, false);
});

console.log(`market intelligence: ${passed} checks passed`);
