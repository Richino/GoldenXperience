import assert from "node:assert/strict";
import { buildCalendarSnapshot, parseReleaseValue, surpriseOf } from "../src/intelligence/calendar-snapshot.js";
import { canonicalUrl, validateReport } from "../src/intelligence/research-report.js";
import { collectSources, estimateCost, runResearch, type TechnicalSummary } from "../src/intelligence/openai-research.js";
import { budgetVerdict, researchFreshness, researchSettings } from "../src/intelligence/research-service.js";
import { attachIntelligence } from "../src/trade-plan-service.js";
import { generateTradePlans } from "../src/trade-plan-generator.js";
import { evaluateConfirmation, type PlanForConfirmation } from "../src/trade-plan-confirmation.js";
import { decideMonitorActions } from "../src/trade-plan-monitor.js";
import { executionChecks } from "../src/trade-plan-execution-checks.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { EconomicCalendarEvent } from "../../frontend/src/lib/oanda/calendar.js";

/**
 * Market intelligence: calendar slice, citation validation, the research call
 * (mocked OpenAI), freshness and budget, and the end-to-end scenarios where
 * research and price disagree. No network, no database.
 */

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => { passed += 1; console.log(`ok  ${name}`); }, (error) => { console.error(`FAIL ${name}`); throw error; });
}
const NOW = Date.parse("2026-10-14T12:00:00Z");
const HOUR = 3_600_000;

// ── Calendar ──────────────────────────────────────────────────────
await test("release values parse, including units and comparators", () => {
  assert.deepEqual(parseReleaseValue("0.3%"), { value: 0.3, unit: "%" });
  assert.deepEqual(parseReleaseValue("245K"), { value: 245_000, unit: "K" });
  assert.deepEqual(parseReleaseValue("-1.2B"), { value: -1.2e9, unit: "B" });
  assert.deepEqual(parseReleaseValue("<0.1%"), { value: 0.1, unit: "%" });
  assert.equal(parseReleaseValue("n/a"), null);
  assert.equal(parseReleaseValue(null), null);
});

await test("surprise is actual vs forecast, with no bullish/bearish assumption", () => {
  assert.equal(surpriseOf("0.4%", "0.3%").side, "ABOVE");
  assert.equal(surpriseOf("180K", "200K").side, "BELOW");
  assert.equal(surpriseOf("2.0%", "2.0%").side, "IN_LINE");
  assert.equal(surpriseOf("0.4%", "250K").side, "UNKNOWN", "different units are not compared");
  assert.equal(surpriseOf(null, "0.3%").side, "UNKNOWN");
  assert.ok(Math.abs(surpriseOf("0.4%", "0.3%").difference! - 0.1) < 1e-9);
});

const events: EconomicCalendarEvent[] = [
  { id: "1", title: "CPI m/m", currency: "USD", region: "us", impact: 3, timestamp: "2026-10-13T12:30:00Z", forecast: "0.3%", previous: "0.2%", actual: "0.4%", unit: null },
  { id: "1b", title: "CPI m/m", currency: "USD", region: "us", impact: 3, timestamp: "2026-10-13T08:30:00-04:00", forecast: "0.3%", previous: "0.2%", actual: "0.4%", unit: null },
  { id: "2", title: "ECB Press Conference", currency: "EUR", region: "eu", impact: 3, timestamp: "2026-10-15T12:45:00Z", forecast: null, previous: null, actual: null, unit: null },
  { id: "3", title: "BoJ minutes", currency: "JPY", region: "jp", impact: 3, timestamp: "2026-10-15T00:00:00Z", forecast: null, previous: null, actual: null, unit: null },
  { id: "4", title: "Low impact thing", currency: "USD", region: "us", impact: 1, timestamp: "2026-10-15T14:00:00Z", forecast: null, previous: null, actual: null, unit: null },
];

await test("the calendar slice keeps only the pair's currencies, in UTC, de-duplicated", () => {
  const snapshot = buildCalendarSnapshot({ events, currencies: ["EUR", "USD"], now: NOW });
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.upcoming.map((row) => row.title), ["ECB Press Conference"]);
  assert.equal(snapshot.released.length, 1, "the same release given in two time zones is one row");
  assert.equal(snapshot.released[0]!.at, "2026-10-13T12:30:00.000Z");
  assert.equal(snapshot.released[0]!.surprise.side, "ABOVE");
  assert.equal(snapshot.revisions, "unavailable");
});

await test("a missing calendar is reported unavailable, never filled in", () => {
  const snapshot = buildCalendarSnapshot({ events: null, currencies: ["EUR", "USD"], now: NOW });
  assert.equal(snapshot.available, false);
  assert.deepEqual(snapshot.upcoming, []);
  assert.match(snapshot.note ?? "", /could not be read/);
});

// ── Citations ─────────────────────────────────────────────────────
const RETURNED = ["https://www.reuters.com/markets/currencies/dollar-slips-2026-10-13/", "https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp261015.en.html", "https://www.fxstreet.com/analysis/eurusd-outlook-123", "https://www.forexfactory.com/thread/123-eurusd"];
const modelAnswer = {
  overallBias: "MIXED", confidence: "LOW",
  summary: "Technicals bearish, fundamentals mixed.",
  baseCurrency: { label: "Neutral", summary: "ECB on hold." }, quoteCurrency: { label: "Softening", summary: "Dollar eased." },
  ratesAndYields: "Yields lower.", riskSentiment: "Calm.", technicalVsFundamental: "They conflict.",
  news: [
    { headline: "Dollar slips after hot CPI fades", publisher: "Reuters", publishedAt: "2026-10-13T15:00:00Z", url: "https://reuters.com/markets/currencies/dollar-slips-2026-10-13?utm_source=x", currencies: ["USD"], topic: "US CPI dollar reaction", kind: "FACT", implication: "SUPPORTS_BUY", summary: "Dollar fell despite CPI above forecast." },
    { headline: "Dollar slips after CPI", publisher: "Some Blog", publishedAt: "2026-10-13T16:00:00Z", url: "https://www.fxstreet.com/analysis/eurusd-outlook-123", currencies: ["USD"], topic: "US CPI dollar reaction", kind: "ANALYSIS", implication: "SUPPORTS_BUY", summary: "Same story." },
    { headline: "Invented scoop", publisher: "Nowhere", publishedAt: null, url: "https://made-up.example/story", currencies: ["EUR"], topic: "fake", kind: "FACT", implication: "SUPPORTS_SELL", summary: "Not real." },
  ],
  sentiment: { summary: "Split.", limitations: "Few comments.", observations: [
    { source: "Forex Factory", url: "https://www.forexfactory.com/thread/123-eurusd", stance: "BULLISH_CALL", text: "Some expect a bounce." },
    { source: "Forum", url: "https://forum.example/unseen", stance: "BEARISH_CALL", text: "Uncited." },
  ] },
  bullishEvidence: [{ point: "Dollar fell after CPI.", urls: ["https://www.reuters.com/markets/currencies/dollar-slips-2026-10-13"] }, { point: "Uncited claim.", urls: ["https://not-returned.example"] }],
  bearishEvidence: [{ point: "ECB on hold, euro neutral.", urls: ["https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp261015.en.html"] }],
  catalysts: [{ event: "ECB decision", why: "Rates path." }],
  uncertainties: ["Conflicting signals."],
  conclusion: { supports: "No clear direction.", invalidatedBy: "A decisive break.", needsPriceConfirmation: "Breakout or rejection at the zones." },
};

await test("canonical URLs match despite www, tracking params and trailing slashes", () => {
  assert.equal(canonicalUrl("https://www.reuters.com/a/b/?utm_source=x#frag"), canonicalUrl("https://reuters.com/a/b"));
  assert.equal(canonicalUrl("javascript:alert(1)"), null);
});

await test("invented citations are dropped; repeats of one event count once; facts win over analysis", () => {
  const result = validateReport(modelAnswer, RETURNED, ["EUR", "USD"]);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.report.news.map((item) => item.publisher), ["Reuters"], "fake story dropped, duplicate analysis merged");
  assert.equal(result.report.bullishEvidence.length, 1, "uncited point dropped");
  assert.equal(result.report.sentiment.observations.length, 1, "unseen forum URL dropped");
  assert.equal(result.report.sentiment.observations[0]!.stance, "BULLISH_CALL");
  const reasons = result.dropped.map((item) => item.reason);
  assert.ok(reasons.includes("URL was not returned by the web search"));
  assert.ok(reasons.includes("duplicate report of the same event"));
  assert.ok(reasons.includes("no citation returned by the web search"));
});

await test("an answer with no surviving evidence cannot claim a direction", () => {
  const result = validateReport({ ...modelAnswer, overallBias: "BULLISH", confidence: "HIGH" }, [], ["EUR", "USD"]);
  assert.ok(result.ok);
  if (result.ok) { assert.equal(result.report.overallBias, "UNCLEAR"); assert.equal(result.report.confidence, "LOW"); }
});

await test("malformed answers are rejected or normalised", () => {
  assert.equal(validateReport(null, RETURNED, ["EUR", "USD"]).ok, false);
  assert.equal(validateReport({ ...modelAnswer, summary: "" }, RETURNED, ["EUR", "USD"]).ok, false);
  const odd = validateReport({ ...modelAnswer, overallBias: "MOON", confidence: 97 }, RETURNED, ["EUR", "USD"]);
  assert.ok(odd.ok && odd.report.overallBias === "UNCLEAR" && odd.report.confidence === "LOW");
});

// ── The research call (mocked OpenAI) ─────────────────────────────
const technical: TechnicalSummary = { instrument: "EUR_USD", readAt: new Date(NOW).toISOString(), price: 1.1229, trend: { D1: "DOWNTREND", H4: "DOWNTREND" }, atr: { H4: 0.002 }, zones: [], plans: [] };
const calendar = buildCalendarSnapshot({ events, currencies: ["EUR", "USD"], now: NOW });
function openAiPayload(answer: unknown) {
  return {
    output: [
      { type: "web_search_call", action: { type: "search", query: "EURUSD news", sources: RETURNED.slice(0, 3).map((url) => ({ type: "url", url })) } },
      { type: "web_search_call", action: { type: "search", query: "forex factory eurusd", sources: [{ type: "url", url: RETURNED[3] }] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(answer), annotations: [{ type: "url_citation", url: RETURNED[0], title: "Reuters" }] }] },
    ],
    usage: { input_tokens: 12_000, output_tokens: 2_000 },
  };
}
const env = { OPENAI_API_KEY: "test-key", OPENAI_RESEARCH_MODEL: "test-model", OPENAI_PRICE_INPUT_PER_MTOK: "1", OPENAI_PRICE_OUTPUT_PER_MTOK: "4", OPENAI_PRICE_WEB_SEARCH_CALL: "0.01" } as NodeJS.ProcessEnv;
let sentBody: Record<string, unknown> | null = null;
const okFetch = async (_url: string, init: RequestInit) => { sentBody = JSON.parse(String(init.body)); return new Response(JSON.stringify(openAiPayload(modelAnswer)), { status: 200 }); };

await test("a research call: web search tool, strict schema, sources collected, usage and cost recorded", async () => {
  const outcome = await runResearch({ instrument: "EUR_USD", currencies: ["EUR", "USD"], technical, calendar, now: NOW, fetcher: okFetch, env });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
  if (!outcome.ok) return;
  assert.equal(sentBody!.model, "test-model");
  assert.deepEqual(sentBody!.tools, [{ type: "web_search" }]);
  assert.equal(((sentBody!.text as { format: { type: string } }).format.type), "json_schema");
  assert.ok(String(sentBody!.input).includes("verifiedCalendar"), "the verified calendar is passed in");
  assert.equal(outcome.sources.length, 4);
  assert.equal(outcome.usage.webSearchCalls, 2);
  // 12k in at $1/M + 2k out at $4/M + 2 searches at $0.01 = 0.012 + 0.008 + 0.02
  assert.equal(outcome.usage.costUsd, 0.04);
  assert.equal(outcome.report.news.length, 1);
});

await test("cost is 'unknown' when prices are not configured", () => {
  assert.equal(estimateCost({ inputTokens: 10, outputTokens: 10, webSearchCalls: 1 }, { inputPerMTok: null, outputPerMTok: 1, perSearch: 1 }), null);
});

await test("rate limits, bad JSON, timeouts and a missing key fail cleanly", async () => {
  const limited = await runResearch({ instrument: "EUR_USD", currencies: ["EUR", "USD"], technical, calendar, now: NOW, env, fetcher: async () => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }) });
  assert.ok(!limited.ok && /rate limit/.test(limited.error));
  const garbled = await runResearch({ instrument: "EUR_USD", currencies: ["EUR", "USD"], technical, calendar, now: NOW, env, fetcher: async () => new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] }), { status: 200 }) });
  assert.ok(!garbled.ok && /not valid JSON/.test(garbled.error));
  const slow = await runResearch({ instrument: "EUR_USD", currencies: ["EUR", "USD"], technical, calendar, now: NOW, env, fetcher: async () => { const error = new Error("t"); error.name = "TimeoutError"; throw error; } });
  assert.ok(!slow.ok && /timed out/.test(slow.error));
  const unset = await runResearch({ instrument: "EUR_USD", currencies: ["EUR", "USD"], technical, calendar, now: NOW, env: {} as NodeJS.ProcessEnv, fetcher: okFetch });
  assert.ok(!unset.ok && /not configured/.test(unset.error));
});

await test("sources come from search results and citations only", () => {
  const sources = collectSources(openAiPayload(modelAnswer));
  assert.deepEqual(sources.map((source) => source.url).sort(), [...RETURNED].sort());
});

// ── Freshness, cache and budget ───────────────────────────────────
await test("research goes stale by time or by a newer high-impact release, and is reused otherwise", () => {
  const row = { created_at: new Date(NOW - 2 * HOUR), expires_at: new Date(NOW + 4 * HOUR), currencies: ["EUR", "USD"] };
  assert.equal(researchFreshness(row, [], NOW).fresh, true, "cache hit");
  assert.equal(researchFreshness({ ...row, expires_at: new Date(NOW - 1) }, [], NOW).fresh, false);
  const release = researchFreshness(row, [{ currency: "USD", impact: 3, at: new Date(NOW - HOUR).toISOString() }], NOW);
  assert.equal(release.fresh, false);
  assert.match(release.reason ?? "", /USD release/);
  assert.equal(researchFreshness(row, [{ currency: "JPY", impact: 3, at: new Date(NOW - HOUR).toISOString() }], NOW).fresh, true, "other currencies do not matter");
  assert.equal(researchFreshness(row, [{ currency: "USD", impact: 2, at: new Date(NOW - HOUR).toISOString() }], NOW).fresh, true, "medium impact does not force a refresh");
  assert.equal(researchFreshness(null, [], NOW).fresh, false);
});

await test("the budget stops optional research by run count and by spend", () => {
  const settings = { ...researchSettings({} as NodeJS.ProcessEnv), dailyRunLimit: 3, dailyBudgetUsd: 1, monthlyBudgetUsd: 10 };
  assert.equal(budgetVerdict({ todayRuns: 2, todayUsd: 0.5, monthUsd: 2, unknownCostRuns: 0 }, settings).allowed, true);
  assert.equal(budgetVerdict({ todayRuns: 3, todayUsd: 0.5, monthUsd: 2, unknownCostRuns: 0 }, settings).allowed, false);
  assert.equal(budgetVerdict({ todayRuns: 1, todayUsd: 1, monthUsd: 2, unknownCostRuns: 0 }, settings).allowed, false);
  assert.match(budgetVerdict({ todayRuns: 1, todayUsd: 0, monthUsd: 10, unknownCostRuns: 0 }, settings).reason ?? "", /Monthly/);
});

await test("Auto trade can require fresh research; it never bypasses the other checks", () => {
  const base = {
    plan: { instrument: "EUR_USD" as const, direction: "SELL" as const, stopLoss: 1.1254, takeProfit: 1.1166, expiresAt: "2026-10-16T12:00:00Z", maxRiskPercent: 1, minRewardRisk: 1.5, proposalEntry: 1.124 },
    now: NOW,
    settings: { autoApproved: true, killSwitch: false, suspended: false, maxRiskPercent: 1, maxAggregateRiskPercent: 3, maxOpenPositions: 3, dailyLossLimitPercent: 3, maxSpreadStopFraction: 0.15, maxSlippageStopFraction: 0.1, maxDataAgeSeconds: 10, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 },
    brokerEnvironment: "practice" as const, marketOpen: true,
    quote: { bid: 1.124, ask: 1.12408, time: new Date(NOW - 1000).toISOString() },
    news: [], account: { nav: 10_000, marginAvailable: 10_000 }, quoteToUsdRate: 1, openInstruments: [], openAutoTrades: { count: 0, riskPercent: 0 }, realizedTodayPL: 0,
  };
  assert.equal(executionChecks({ ...base, research: { required: false, fresh: false, reason: null } }).ok, true, "not required: research outage does not block");
  const blocked = executionChecks({ ...base, research: { required: true, fresh: false, reason: "OpenAI unavailable" } });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.checks.some((check) => check.key === "research" && !check.ok));
  assert.equal(executionChecks({ ...base, research: { required: true, fresh: true, reason: null } }).ok, true);
});

// ── Integration: research and price disagree ──────────────────────
/** One price path sampled into candles of every timeframe (same helper idea as the generator test). */
type Path = Array<[number, number]>;
const priceAt = (path: Path, at: number) => {
  if (at <= path[0]![0]) return path[0]![1];
  for (let i = 1; i < path.length; i += 1) { const [t1, p1] = path[i]!; const [t0, p0] = path[i - 1]!; if (at <= t1) return p0 + ((p1 - p0) * (at - t0)) / (t1 - t0); }
  return path.at(-1)![1];
};
function candles(path: Path, step: number, count: number, end: number, wick = 0.001): Candle[] {
  const first = Math.floor(end / step) * step - count * step;
  return Array.from({ length: count }, (_, i) => {
    const open = first + i * step;
    const s = [0, 0.25, 0.5, 0.75, 1].map((f) => priceAt(path, open + f * step));
    return { time: new Date(open).toISOString(), open: s[0]!, close: s[4]!, high: Math.max(...s) + wick, low: Math.min(...s) - wick, volume: 100, complete: true };
  });
}
// A falling market (lower highs, lower lows), ending between zones.
const legs = [0, 0.02, 0.0, 0.012, -0.008, 0.004, -0.016, -0.006, -0.024, -0.012, -0.03, -0.019, -0.0198];
const span = 52 * 24 * HOUR;
const down: Path = legs.map((offset, i) => [NOW - span + (span * i) / (legs.length - 1), 1.12 + offset * 5]);
const market = {
  candles: { D1: candles(down, 24 * HOUR, 300, NOW), H4: candles(down, 4 * HOUR, 300, NOW), H1: candles(down, HOUR, 300, NOW), M15: candles(down, HOUR / 4, 300, NOW) },
  quote: { bid: priceAt(down, NOW) - 0.00004, ask: priceAt(down, NOW) + 0.00004, time: new Date(NOW - 1000).toISOString() },
  news: [], now: NOW,
};

await test("scenario: technically bearish, fundamentals favour a recovery — both conditional plans, evidence on each side, nothing changed", async () => {
  const generated = generateTradePlans({ instrument: "EUR_USD", ...market, maxRiskPercent: 1 });
  assert.equal(generated.context?.trend.H4, "DOWNTREND", "the technical read is bearish");
  assert.equal(generated.plans.length, 2, `expected BUY and SELL, got ${generated.plans.map((p) => p.direction)}: ${generated.reason}`);
  const before = JSON.stringify(generated.plans.map((plan) => [plan.entryZoneLow, plan.entryZoneHigh, plan.stopLoss, plan.takeProfit, plan.plan.rules, plan.conditions]));

  // Research (mocked OpenAI) leans the other way: a recovery case, flagged as a conflict.
  const research = await runResearch({ instrument: "EUR_USD", currencies: ["EUR", "USD"], technical, calendar, now: NOW, env, fetcher: async () => new Response(JSON.stringify(openAiPayload({ ...modelAnswer, overallBias: "BULLISH", technicalVsFundamental: "Technicals bearish; fundamentals favour a recovery." })), { status: 200 }) });
  assert.ok(research.ok);
  if (!research.ok) return;
  assert.equal(research.report.overallBias, "BULLISH");
  assert.match(research.report.technicalVsFundamental, /bearish.*recovery/);

  attachIntelligence(generated.plans, { id: "r1", createdAt: new Date(NOW).toISOString(), report: research.report });
  const buy = generated.plans.find((plan) => plan.direction === "BUY")!;
  const sell = generated.plans.find((plan) => plan.direction === "SELL")!;
  assert.deepEqual((buy.plan.intelligence as { supporting: unknown[] }).supporting, research.report.bullishEvidence);
  assert.deepEqual((sell.plan.intelligence as { supporting: unknown[] }).supporting, research.report.bearishEvidence);
  // Research is context only: levels, rules and conditions are exactly what the technical engine produced.
  assert.equal(JSON.stringify(generated.plans.map((plan) => [plan.entryZoneLow, plan.entryZoneHigh, plan.stopLoss, plan.takeProfit, plan.plan.rules, plan.conditions])), before);

  // Approved and monitored: nothing has happened at the zones yet, so both wait — no immediate entry.
  for (const plan of generated.plans) {
    const confirmable: PlanForConfirmation = { ...plan, stopLoss: plan.stopLoss!, takeProfit: plan.takeProfit!, createdAt: new Date(NOW).toISOString() };
    const result = evaluateConfirmation({ plan: confirmable, candles: market.candles, quote: market.quote, news: [], now: NOW + 60_000, limits: { maxSpreadStopFraction: 0.15, maxDataAgeSeconds: 120, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 } });
    assert.equal(result.outcome, "WAITING", `${plan.direction}: ${result.notTriggeredReason}`);
    const actions = decideMonitorActions({ status: "MONITORING", mode: "AUTO", instrument: "EUR_USD", direction: plan.direction, confirmation: result });
    assert.ok(!actions.some((action) => action.kind === "execute" || action.kind === "transition"), "waiting plans neither move nor execute");
  }
});

/** Hand-built paired plans (BUY breakout above 1.1000, SELL breakdown below 1.0990) to show independence. */
const M15 = 900_000;
const T0 = Date.parse("2026-10-14T08:00:00Z");
const rows = (list: Array<[number, number, number, number]>) => list.map(([o, h, l, c], i): Candle => ({ time: new Date(T0 + i * M15).toISOString(), open: o, high: h, low: l, close: c, volume: 1, complete: true }));
const toH1 = (list: Candle[]) => { const out: Candle[] = []; for (let i = 0; i + 3 < list.length; i += 4) { const g = list.slice(i, i + 4); out.push({ time: g[0]!.time, open: g[0]!.open, close: g[3]!.close, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), volume: 4, complete: true }); } return out; };
const rules = { atrH1: 0.001, minRewardRisk: 1.5, confirmationValidMinutes: 60, breakoutCloseH1Atr: 0.25, retestToleranceH1Atr: 0.3, retestFailH1Atr: 0.25 };
const buyPlan: PlanForConfirmation = { instrument: "EUR_USD", direction: "BUY", setupType: "BREAKOUT_RETEST", entryZoneLow: 1.0997, entryZoneHigh: 1.1003, stopLoss: 1.0985, takeProfit: 1.105, createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 48 * HOUR).toISOString(), plan: { breakoutLevel: 1.1, breakoutAlreadyClosed: false, invalidation: { failLevel: 1.09975, zoneFarEdge: 1.099 }, rules } };
const sellPlan: PlanForConfirmation = { instrument: "EUR_USD", direction: "SELL", setupType: "BREAKOUT_RETEST", entryZoneLow: 1.0987, entryZoneHigh: 1.0993, stopLoss: 1.1005, takeProfit: 1.094, createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 48 * HOUR).toISOString(), plan: { breakoutLevel: 1.099, breakoutAlreadyClosed: false, invalidation: { failLevel: 1.09925, zoneFarEdge: 1.1 }, rules } };
const limits = { maxSpreadStopFraction: 0.15, maxDataAgeSeconds: 10, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 };
function judge(plan: PlanForConfirmation, list: Candle[], now: number, quote: { bid: number; ask: number }) {
  return evaluateConfirmation({ plan, candles: { H1: toH1(list), M15: list }, quote: { ...quote, time: new Date(now - 1000).toISOString() }, news: [], now, limits });
}

await test("scenario: only the independently confirmed side becomes actionable, and it stands the other down", () => {
  // Price breaks up through 1.1000, retests, continues: the BUY confirms; the SELL never saw its breakdown.
  const list = rows([[1.0995, 1.0998, 1.0994, 1.0997], [1.0997, 1.1001, 1.0996, 1.1], [1.1, 1.1003, 1.0999, 1.1002], [1.1002, 1.1006, 1.1001, 1.1004], [1.1004, 1.1006, 1.1001, 1.1002], [1.1002, 1.1004, 1.1, 1.1003], [1.1003, 1.1009, 1.1002, 1.1008]]);
  const now = T0 + list.length * M15 + 1000;
  const buy = judge(buyPlan, list, now, { bid: 1.1008, ask: 1.1009 });
  const sell = judge(sellPlan, list, now, { bid: 1.1008, ask: 1.1009 });
  assert.equal(buy.outcome, "CONFIRMED", buy.notTriggeredReason ?? "");
  assert.notEqual(sell.outcome, "CONFIRMED", "the SELL is not confirmed just because the BUY was");
  const buyActions = decideMonitorActions({ status: "MONITORING", mode: "AUTO", instrument: "EUR_USD", direction: "BUY", confirmation: buy });
  assert.ok(buyActions.some((action) => action.kind === "cancelSiblings"), "the confirmed side cancels the other: no conflicting position");
  assert.ok(buyActions.some((action) => action.kind === "execute"));
  const sellActions = decideMonitorActions({ status: "MONITORING", mode: "AUTO", instrument: "EUR_USD", direction: "SELL", confirmation: sell });
  assert.ok(!sellActions.some((action) => action.kind === "execute"));
});

await test("scenario: invalidating the bearish plan does not confirm the bullish one", () => {
  // Price closes above the SELL's zone (its invalidation) but has not retested for the BUY.
  const list = rows([[1.0995, 1.0998, 1.0994, 1.0997], [1.0997, 1.1001, 1.0996, 1.1], [1.1, 1.1003, 1.0999, 1.1002], [1.1002, 1.1006, 1.1001, 1.1004], [1.1004, 1.1012, 1.1005, 1.1011]]);
  const now = T0 + list.length * M15 + 1000;
  const sell = judge(sellPlan, list, now, { bid: 1.1011, ask: 1.1012 });
  const buy = judge(buyPlan, list, now, { bid: 1.1011, ask: 1.1012 });
  assert.equal(sell.outcome, "INVALIDATED");
  assert.equal(buy.outcome, "WAITING");
  assert.equal(buy.stage, "WAITING_FOR_RETEST");
});

await test("scenario: neither side confirms — both wait, then expire, and nothing is traded", () => {
  // Price drifts inside the range between the two levels.
  const list = rows(Array.from({ length: 16 }, (): [number, number, number, number] => [1.0995, 1.0998, 1.0993, 1.0996]));
  const now = T0 + list.length * M15 + 1000;
  for (const plan of [buyPlan, sellPlan]) {
    const waiting = judge(plan, list, now, { bid: 1.0995, ask: 1.0996 });
    assert.equal(waiting.outcome, "WAITING");
    const expired = judge({ ...plan, expiresAt: new Date(now - 1).toISOString() }, list, now, { bid: 1.0995, ask: 1.0996 });
    assert.equal(expired.outcome, "EXPIRED");
    const actions = decideMonitorActions({ status: "MONITORING", mode: "AUTO", instrument: "EUR_USD", direction: plan.direction, confirmation: expired });
    assert.ok(!actions.some((action) => action.kind === "execute"), "an expired plan never trades");
    assert.ok(actions.some((action) => action.kind === "transition" && action.to === "EXPIRED"));
  }
});

console.log(`market intelligence: ${passed} checks passed`);
