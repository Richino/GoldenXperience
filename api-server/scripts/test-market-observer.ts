import assert from "node:assert/strict";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { ObserverPlan, ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { MarketPatternEngine } from "../src/market-patterns.js";
import { MarketStateEngine } from "../src/market-state.js";
import { evaluateObserverPlan } from "../src/market-observer-plan.js";
import { explainObserver, ObserverAiGate } from "../src/market-observer-ai.js";

const start = Date.parse("2026-10-05T16:00:00Z"), iso = (delta = 0) => new Date(start + delta).toISOString();
const engine = new MarketPatternEngine(["EUR_USD"]), state = new MarketStateEngine(engine);
engine.setConnection("connected", "oanda", iso());
function bars(tf: string, interval: number, rising = true): Candle[] {
  return Array.from({ length: 30 }, (_, i) => {
    const close = 1.1 + (rising ? i : 30 - i) * 0.0001;
    return { time: iso((i - 30) * interval), open: close - 0.00005, high: close + 0.00015, low: close - 0.00015, close, complete: true, volume: 0 };
  });
}
for (const [tf, interval] of Object.entries({ M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 })) {
  engine.context({ instrument: "EUR_USD", granularity: tf, source: "oanda", snapshot: { instrument: "EUR_USD", granularity: tf, source: "oanda", candles: bars(tf, interval) } }, iso());
}
state.calendarContext({ snapshot: { source: "forex_factory", connected: true, events: [], coverageUntil: iso(86_400_000) } }, iso());
for (let i = 0; i <= 120; i++) {
  const mid = 1.1029 + i * 0.000001;
  engine.observe({ instrument: "EUR_USD", time: iso(i * 250), status: "tradeable", bids: [{ price: String(mid - 0.000025) }], asks: [{ price: String(mid + 0.000025) }] }, iso(i * 250));
}
let read = state.update("EUR_USD", iso(30_000));
assert.equal(read.state, "live"); assert.equal(read.lean, "up"); assert.equal(read.blockers.length, 0);
assert.ok(read.movement.find(w => w.seconds === 30)?.ready);
assert.equal(read.quote!.spreadPips.toFixed(1), "0.5");
assert.equal(state.update("EUR_USD", iso(30_001)).revision, read.revision, "Unchanged state cannot manufacture an event");
state.contextError({ context: "calendar" });
assert.ok(state.update("EUR_USD", iso(30_001)).blockers.some(b => b.includes("News")));
assert.equal(state.update("EUR_USD", iso(40_000)).state, "paused", "Heartbeats/old contexts cannot refresh quotes");
const beforeGap = engine.contextHistory("EUR_USD", "M1");
const gapBar = { ...beforeGap.at(-1)!, time: iso(60_000), complete: true };
engine.context({ instrument: "EUR_USD", granularity: "M1", source: "oanda", snapshot: { instrument: "EUR_USD", granularity: "M1", source: "oanda", candles: [gapBar] } }, iso(120_000));
assert.equal(engine.history("EUR_USD", "M1").length, 1, "Geometric patterns do not bridge session/missing-bar gaps");
assert.ok(engine.contextHistory("EUR_USD", "M1").length >= 30, "Closed trading-bar context survives a session gap");

const base: ObserverPlan = { id: "test", version: 1, instrument: "EUR_USD", mode: "NORMAL", createdAt: iso(), updatedAt: iso(), expiresAt: iso(4 * 3_600_000),
  status: "WATCHING", resumeStatus: "WATCHING", direction: "long", reason: "watch", thesis: "test hypothesis", zone: { low: 1.0999, high: 1.1003 }, entry: 1.1001, stop: 1.099, target: 1.1023,
  trigger: { timeframe: "M5", boundary: 1.1002, after: iso() }, invalidation: "Bid <= stop", lastEvaluatedCandle: iso(-300_000), confirmationCandle: null,
  triggeredAt: null, observedEntry: null, outcome: null, facts: [] };
const live = (at: number, bid = 1.10005, ask = 1.1001): ObserverRead => ({ ...read, asOf: iso(at), blockers: [], state: "live", quote: { bid, ask, time: iso(at), spreadPips: (ask - bid) / 0.0001 } });
const candle = (time: number, close: number, complete = true): Candle => ({ time: iso(time), open: 1.1, high: Math.max(1.1004, close), low: Math.min(1.0999, close), close, complete, volume: 0 });
assert.equal(evaluateObserverPlan(base, live(301_000), [candle(-300_000, 1.1004)]).status, "READY", "Pre-plan closes cannot trigger a new plan");
assert.equal(evaluateObserverPlan(base, live(301_000), [candle(0, 1.1004, false)]).status, "READY", "Forming candles cannot trigger");
let triggered = evaluateObserverPlan(base, live(301_000), [candle(0, 1.1004)]);
assert.equal(triggered.status, "TRIGGERED"); assert.equal(triggered.observedEntry, 1.1001);
assert.equal(triggered.entry, base.entry); assert.equal(triggered.stop, base.stop);
const widened = evaluateObserverPlan(base, live(301_000, 1.10005, 1.1008), [candle(0, 1.1004)]);
assert.equal(widened.status, "WATCHING", "Mid/bid inside a zone cannot substitute for the executable long ask");
assert.equal(evaluateObserverPlan(widened, live(302_000), [candle(0, 1.1004)]).status, "TRIGGERED", "A timely retest can follow a confirmed close");
assert.equal(evaluateObserverPlan(widened, live(700_000), [candle(0, 1.1004)]).status, "READY", "Old confirmation expires");
assert.equal(evaluateObserverPlan(base, live(1000, 1.0989, 1.099), []).status, "INVALIDATED");
assert.equal(evaluateObserverPlan(base, live(4 * 3_600_000), []).status, "EXPIRED");
let paused = evaluateObserverPlan(triggered, { ...live(302_000), state: "paused", quote: null }, []);
assert.equal(paused.status, "PAUSED");
assert.equal(evaluateObserverPlan(paused, live(330_000), []).outcome?.kind, "unknown_after_gap", "Do not invent outcomes during a feed gap");
assert.equal(evaluateObserverPlan(triggered, { ...live(302_000, 1.1023, 1.1024), blockers: ["High-impact news"] }, []).outcome?.kind, "target_observed", "News pauses entries, not observation of an already triggered signal");
assert.equal(evaluateObserverPlan({ ...base, direction: null, entry: null, trigger: null }, live(301_000), [candle(0, 1.1004)]).status, "WATCHING");
const short = { ...base, direction: "short" as const, entry: 1.1001, stop: 1.102, target: 1.098, trigger: { ...base.trigger!, boundary: 1.1 } };
assert.equal(evaluateObserverPlan(short, live(301_000), [candle(0, 1.0998)]).status, "TRIGGERED");

let calls = 0;
const gate = new ObserverAiGate(async input => { calls++; return { state: "ready", text: input.headline, at: input.asOf, factIds: [] }; }, 2, 1000);
await gate.request(read); await gate.request({ ...read, revision: read.revision + 1, asOf: iso(30_500) });
assert.equal(calls, 1, "Quote/revision churn respects cooldown");
await gate.request({ ...read, revision: read.revision + 1, asOf: iso(31_100) });
assert.equal((await gate.request({ ...read, revision: read.revision + 2, asOf: iso(32_200) }))?.state, "limited");
assert.equal(calls, 2);
const oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-only-key";
try {
  const fake = (factIds: string[]) => (async () => new Response(JSON.stringify({ output_text: JSON.stringify({ factIds }) }))) as typeof fetch;
  const result = await explainObserver(read, fake([read.facts[0].id]));
  assert.equal(result.text, read.facts[0].text, "AI cannot rewrite facts, levels, or probabilities");
  await assert.rejects(explainObserver(read, fake(["invented-price"])), /unsupported evidence/);
} finally { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
console.log("Market observer tests passed: live facts, quality gates, causal executable triggers, immutable plans, gaps, expiry and AI budgets/validation.");
