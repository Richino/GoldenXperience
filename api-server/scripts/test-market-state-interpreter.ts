import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { interpretMarketState, readMarketTechnicals, groupMarketCatalysts, type InterpretMarketInput } from "../src/intelligence/market-state-interpreter.js";
import { marketStateView, storeMarketState } from "../src/intelligence/market-state-store.js";
import { technicalSummaryFor } from "../src/intelligence/research-service.js";
import { generateTradePlans } from "../src/trade-plan-generator.js";
import type { MarketIntelligence, Factor } from "../src/intelligence/research-contract.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const NOW = Date.parse("2026-10-14T12:00:00Z"), HOUR = 3_600_000;
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); console.log(`ok  ${name}`); passed++; }
const factor = (id: string, patch: Partial<Factor> = {}): Factor => ({ id, factor: "US yields retreat", currency: "USD", effectOnCurrency: "weakens", impactOnPair: "bullish", importance: "high", evidenceType: "attributed_analysis", description: "Treasury yields fell as Fed tightening expectations receded.", observedAt: new Date(NOW - HOUR).toISOString(), uncertainty: null, sourceIds: ["s1"], ...patch });
function input(): InterpretMarketInput {
  const candles = (step: number): Candle[] => Array.from({ length: 300 }, (_, i) => {
    const open = 1.11 + i * 0.00004 + Math.sin(i * 0.4) * 0.002;
    const close = 1.11 + (i + 1) * 0.00004 + Math.sin((i + 1) * 0.4) * 0.002;
    return { time: new Date(NOW - (300 - i) * step).toISOString(), open, close, high: Math.max(open, close) + 0.0005, low: Math.min(open, close) - 0.0005, volume: 100, complete: true };
  });
  const market = { instrument: "EUR_USD" as const, now: NOW, quote: { bid: 1.12, ask: 1.1201, time: new Date(NOW).toISOString() }, candles: { H1: candles(HOUR), H4: candles(4 * HOUR), D1: candles(24 * HOUR) } };
  const technical = readMarketTechnicals(market);
  const intel: MarketIntelligence = {
    schemaVersion: "2.1", pair: "EUR_USD", base: "EUR", quote: "USD",
    research: { id: randomUUID(), createdAt: new Date(NOW - 120_000).toISOString(), cutoffAt: new Date(NOW - 120_000).toISOString(), horizon: "2-5 trading days", status: "complete", quality: "medium", missingData: [], model: "test", effort: "medium", durationMs: 1000 },
    outlook: { overall: "mixed", shortTerm: "bullish", swingTerm: "mixed", fundamental: "mixed", technical: "bearish", explanation: "Research narrative, not observed price." },
    factors: [factor("F1"), factor("F2", { factor: "ECB outlook improves", currency: "EUR", effectOnCurrency: "strengthens", description: "Euro-area employment improves.", sourceIds: ["s2"] })],
    sources: ["s1", "s2"].map(id => ({ id, url: `https://example.com/${id}`, publisher: "Fixture wire", title: "Fixture", retrievedAt: new Date(NOW).toISOString(), publishedAt: null, type: "news", verification: "returned_by_search" })),
    events: [], sentiment: { professional: [], retail: [], positioning: [], expectations: "", limitations: "" },
    bullishThesis: { hypothesis: "Recovery continuation if its own price conditions confirm.", supportingFactorIds: ["F1"], opposingFactorIds: [], catalysts: [], strengthensIf: ["A completed bullish break"], weakensIf: ["A failed reclaim"] },
    bearishThesis: { hypothesis: "Downtrend continuation after rejection.", supportingFactorIds: [], opposingFactorIds: ["F1"], catalysts: [], strengthensIf: ["A completed bearish break"], weakensIf: ["A sustained recovery"] }, summary: "Fixture research.",
  };
  return { intelligence: intel, market, technical, researchFresh: true, calendar: { source: "forex_factory", readAt: new Date(NOW - 120_000).toISOString(), available: true, currencies: ["EUR", "USD"], upcoming: [], released: [], revisions: "unavailable", note: null } };
}
function recoveryInput() {
  const i = input();
  // Existing engine outputs are explicit inputs to the interpretation classifier.
  i.technical.foundation.higher!.direction = "DOWNTREND";
  i.technical.foundation.primary!.direction = "DOWNTREND";
  i.technical.h1!.direction = "UPTREND";
  i.technical.h1!.atr = 0.001;
  i.technical.candles.H1.slice(-13).forEach((c, index) => { c.open = 1.12 + index * 0.0003; c.close = c.open + 0.0001; c.high = c.close + 0.0001; c.low = c.open - 0.0001; });
  return i;
}

await test("research inputs defer technical analysis and proposals until validation", async () => {
  const context = await technicalSummaryFor("EUR_USD");
  assert.equal(context.deferredUntilResearchValidation, true); assert.equal(context.price, null);
  assert.deepEqual(context.trend, {}); assert.deepEqual(context.atr, {}); assert.deepEqual(context.zones, []); assert.deepEqual(context.plans, []);
});
await test("shared technical engine accepts usable history without proposing plans", () => { const i = input(); assert.deepEqual(i.technical.issues, []); assert.ok(i.technical.h1?.sufficient); });
await test("a price recovery against the higher trend is not a confirmed reversal", () => {
  const s = interpretMarketState(recoveryInput());
  assert.equal(s.observed.classification, "BULLISH_RECOVERY");
  assert.equal(s.forward.shortTerm.classification, "SLIGHTLY_BULLISH");
  assert.equal(s.forward.swing.classification, "INDETERMINATE");
  assert.match(s.observed.explanation, /not a confirmed/);
  assert.equal(s.opportunities.length, 2);
  assert.deepEqual(s.costs, { modelCalls: 0, webSearchCalls: 0 });
});
await test("a mixed economic environment can coexist with an observed recovery", () => {
  const i = recoveryInput(); i.intelligence.factors.push(factor("F3", { factor: "French fiscal risk", currency: "EUR", effectOnCurrency: "weakens", impactOnPair: "bearish", description: "French fiscal risk", importance: "high" }), factor("F4", { factor: "Energy exposure", currency: "EUR", effectOnCurrency: "weakens", impactOnPair: "bearish", description: "Energy exposure", importance: "high" }));
  const s = interpretMarketState(i); assert.equal(s.fundamental.classification, "MIXED"); assert.equal(s.observed.classification, "BULLISH_RECOVERY");
});
await test("trend strength, ranges and unstructured price retain distinct meanings", () => {
  const strong = recoveryInput(); strong.technical.foundation.higher!.direction = "UPTREND"; strong.technical.foundation.primary!.direction = "UPTREND";
  assert.equal(interpretMarketState(strong).observed.classification, "STRONG_BULLISH_TREND");
  strong.technical.h1!.atr = 0.004; assert.equal(interpretMarketState(strong).observed.classification, "BULLISH_TREND");
  const range = recoveryInput(); range.technical.foundation.higher!.direction = "RANGE"; range.technical.foundation.primary!.direction = "RANGE"; range.technical.h1!.direction = "RANGE";
  range.technical.candles.H1.slice(-13).forEach(c => { c.open = c.close = 1.12; c.high = 1.121; c.low = 1.119; });
  assert.equal(interpretMarketState(range).observed.classification, "RANGE");
  range.technical.foundation.primary!.direction = "UNCLEAR"; assert.equal(interpretMarketState(range).observed.classification, "VOLATILE_UNSTRUCTURED");
});
await test("downward countertrend movement is a bearish recovery, not a bearish trend reversal", () => {
  const i = recoveryInput(); i.technical.foundation.higher!.direction = "UPTREND"; i.technical.foundation.primary!.direction = "UPTREND"; i.technical.h1!.direction = "DOWNTREND";
  i.technical.candles.H1.slice(-13).forEach(c => { const high = c.high; c.open = 2.3 - c.open; c.close = 2.3 - c.close; c.high = 2.3 - c.low; c.low = 2.3 - high; });
  const s = interpretMarketState(i); assert.equal(s.observed.classification, "BEARISH_RECOVERY"); assert.equal(s.forward.swing.classification, "INDETERMINATE");
  i.technical.foundation.higher!.direction = "DOWNTREND"; i.technical.foundation.primary!.direction = "DOWNTREND";
  assert.equal(interpretMarketState(i).observed.classification, "STRONG_BEARISH_TREND");
  i.technical.h1!.atr = 0.004; assert.equal(interpretMarketState(i).observed.classification, "BEARISH_TREND");
});
await test("balanced range evidence is neutral; absent directional evidence is indeterminate", () => {
  const i = recoveryInput(); i.technical.foundation.higher!.direction = "RANGE"; i.technical.foundation.primary!.direction = "RANGE"; i.technical.h1!.direction = "RANGE";
  i.technical.candles.H1.slice(-13).forEach(c => { c.open = c.close = 1.12; c.high = 1.121; c.low = 1.119; });
  i.intelligence.factors[1] = factor("opposing", { factor: "French fiscal risk", currency: "EUR", effectOnCurrency: "weakens", impactOnPair: "bearish", description: "French fiscal risk" });
  assert.equal(interpretMarketState(i).forward.shortTerm.classification, "NEUTRAL");
  i.intelligence.factors = []; const s = interpretMarketState(i); assert.equal(s.fundamental.classification, "INSUFFICIENT_EVIDENCE"); assert.equal(s.forward.shortTerm.classification, "INDETERMINATE");
});
await test("duplicate policy/yield stories cannot outvote independent evidence", () => {
  const i = input(); const base = groupMarketCatalysts(i.intelligence, NOW); i.intelligence.factors.push(factor("duplicate", { factor: "Fed expectations", sourceIds: ["s2"] }));
  const grouped = groupMarketCatalysts(i.intelligence, NOW); assert.equal(grouped.length, base.length); assert.equal(grouped.find(c => c.currency === "USD")!.bullish, base.find(c => c.currency === "USD")!.bullish);
});
await test("old, undated, future and uncited factors cannot masquerade as fresh catalysts", () => {
  const i = input(); const fresh = groupMarketCatalysts(i.intelligence, NOW).find(c => c.currency === "USD")!;
  i.intelligence.factors[0]!.observedAt = new Date(NOW - 10 * 24 * HOUR).toISOString(); const old = groupMarketCatalysts(i.intelligence, NOW).find(c => c.currency === "USD")!; assert.ok(old.shortTermNet < fresh.shortTermNet);
  i.intelligence.factors[0]!.observedAt = null; assert.ok(groupMarketCatalysts(i.intelligence, NOW).find(c => c.currency === "USD")!.bullish < fresh.bullish);
  i.intelligence.factors[0]!.observedAt = new Date(NOW + HOUR).toISOString(); assert.ok(!groupMarketCatalysts(i.intelligence, NOW).some(c => c.currency === "USD"));
  i.intelligence.factors[0]!.observedAt = new Date(NOW).toISOString(); i.intelligence.factors[0]!.sourceIds = ["not-returned"]; assert.ok(!groupMarketCatalysts(i.intelligence, NOW).some(c => c.currency === "USD"));
});
await test("base/quote direction is derived, rather than trusting a copied model label", () => {
  const i = input(); i.intelligence.pair = "USD_JPY"; i.intelligence.base = "USD"; i.intelligence.quote = "JPY";
  const usd = groupMarketCatalysts(i.intelligence, NOW).find(c => c.currency === "USD")!; assert.equal(usd.bullish, 0); assert.ok(usd.bearish > 0);
});
await test("invalid research blocks interpretation; technical/calendar gaps preserve qualified observations", () => {
  for (const mutate of [(i: InterpretMarketInput) => { i.researchFresh = false; }, (i: InterpretMarketInput) => { i.technical.issues.push("Stale H1"); }, (i: InterpretMarketInput) => { i.intelligence.pair = "GBP_USD"; }]) {
    const i = recoveryInput(); mutate(i); const s = interpretMarketState(i);
    if (!i.researchFresh || i.intelligence.pair !== i.market.instrument) assert.equal(s.observed.classification, "INSUFFICIENT_DATA");
    else { assert.equal(s.quality.status, "PARTIAL"); assert.match(s.observed.explanation, /Partial/); }
    assert.equal(s.forward.shortTerm.classification, "INDETERMINATE"); assert.equal(s.opportunities.length, 0);
  }
});
await test("calendar absence limits event conclusions without discarding validated price interpretation", () => {
  const i = recoveryInput(); i.calendar = null;
  const s = interpretMarketState(i);
  assert.equal(s.analysisStatus, "ANALYSIS_COMPLETE"); assert.equal(s.observed.classification, "BULLISH_RECOVERY");
  assert.equal(s.quality.status, "PARTIAL"); assert.deepEqual(s.quality.issues, []);
  assert.match(s.evidenceLimits!.join(" "), /calendar unavailable/); assert.deepEqual(s.reactions, []);
});
await test("forming and future candles cannot change the technical read", () => {
  const i = input(); const before = readMarketTechnicals(i.market);
  i.market.candles.H1!.push({ ...i.market.candles.H1!.at(-1)!, time: new Date(NOW).toISOString(), close: 10, high: 11, complete: true });
  i.market.candles.H1!.push({ ...i.market.candles.H1!.at(-1)!, time: new Date(NOW - HOUR / 2).toISOString(), complete: false });
  const after = readMarketTechnicals(i.market); assert.equal(after.h1?.close, before.h1?.close); assert.equal(after.candles.H1.length, before.candles.H1.length);
});
await test("missing OHLC or stale weekend history is refused", () => {
  const i = input(); i.market.candles.H1!.at(-1)!.high = NaN; assert.ok(readMarketTechnicals(i.market).issues.some(x => /malformed/.test(x)));
  const old = input(); old.market.now = Date.parse("2026-10-24T12:00:00Z"); assert.equal(readMarketTechnicals(old.market).stale, true);
});
await test("time-aligned reaction windows report movement, not inferred causation", () => {
  const i = recoveryInput(); i.calendar!.released = [{ title: "CPI", currency: "USD", impact: 3, at: new Date(NOW - 3 * HOUR).toISOString(), actual: "0.4%", forecast: "0.3%", previous: "0.2%", surprise: { side: "ABOVE", difference: 0.1, unit: "%" } }];
  const s = interpretMarketState(i); assert.equal(s.reactions[0]!.status, "OBSERVED"); assert.match(s.reactions[0]!.explanation, /not causation/);
  i.calendar!.released[0]!.at = new Date(NOW - 10 * 24 * HOUR).toISOString(); assert.equal(interpretMarketState(i).reactions.length, 0);
});
await test("an absent reaction window stays unverified", () => {
  const i = input(); i.calendar!.released = [{ title: "CPI", currency: "USD", impact: 3, at: new Date(NOW - 10 * 60_000).toISOString(), actual: "0.4%", forecast: "0.3%", previous: "0.2%", surprise: { side: "ABOVE", difference: 0.1, unit: "%" } }];
  const r = interpretMarketState(i).reactions[0]!; assert.equal(r.status, "UNVERIFIED"); assert.equal(r.changePercent, null);
});
await test("previous snapshots are compared without changing their contents or approved plan inputs", () => {
  const i = recoveryInput(); const previous = interpretMarketState(i); i.previous = previous; const frozen = JSON.stringify(i);
  const next = interpretMarketState(i); assert.equal(next.previous?.observedStateChanged, false); assert.equal(JSON.stringify(i), frozen);
  const blocked = marketStateView(next, { fresh: false, reason: "New release since research." }, NOW); assert.equal(blocked.usable, false);
  assert.equal(marketStateView(next, { fresh: true, reason: null }, NOW + 4 * HOUR).usable, false);
});

// Real PostgreSQL persistence checks, rolled back; no provider requests or broker actions.
config({ path: ".env", quiet: true }); config({ path: ".env.local", quiet: true });
if (process.env.DATABASE_URL) await test("snapshot persistence is idempotent and never writes trading tables", async () => {
  const { db } = await import("../src/database.js"); const c = await db().connect();
  try {
    await c.query("BEGIN"); const i = recoveryInput();
    i.market.dataSnapshot = {id:"persisted-diagnostic-fixture"};
    const generated = generateTradePlans({...i.market,news:[],maxRiskPercent:1});
    i.planEvaluation = {analysisId:generated.analysisId,result:generated.result,reason:generated.reason,diagnostics:generated.diagnostics,rejected:generated.rejected};
    await c.query("INSERT INTO market_research(id,instrument,currencies,trigger,status,model,report) VALUES($1,'EUR_USD',ARRAY['EUR','USD'],'MANUAL','COMPLETE','test',$2::jsonb)", [i.intelligence.research.id, JSON.stringify(i.intelligence)]);
    const before = await c.query("SELECT (SELECT count(*) FROM trade_plans)::int AS plans,(SELECT count(*) FROM trade_plan_approvals)::int AS approvals,(SELECT count(*) FROM trade_plan_execution_attempts)::int AS executions");
    const first = await storeMarketState(i, c); const second = await storeMarketState(i, c); assert.equal(first.id, second.id);
    assert.equal(first.planEvaluation?.diagnostics?.snapshotId,"persisted-diagnostic-fixture");
    assert.equal(first.planEvaluation?.diagnostics?.sides.length,2);
    assert.ok(first.planEvaluation?.diagnostics?.checks.some(check=>check.input==="H4:structure-and-ATR"));
    assert.equal(Number((await c.query("SELECT count(*) FROM market_state_snapshots WHERE research_id=$1", [i.intelligence.research.id])).rows[0].count), 1);
    assert.deepEqual((await c.query("SELECT (SELECT count(*) FROM trade_plans)::int AS plans,(SELECT count(*) FROM trade_plan_approvals)::int AS approvals,(SELECT count(*) FROM trade_plan_execution_attempts)::int AS executions")).rows, before.rows);
  } finally { await c.query("ROLLBACK"); c.release(); await db().end(); }
});
console.log(`Market state interpreter: ${passed} checks passed; no paid model requests.`);
