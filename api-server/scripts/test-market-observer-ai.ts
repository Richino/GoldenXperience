import assert from "node:assert/strict";
import type { ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { explainObserver, ObserverAiGate } from "../src/market-observer-ai.js";
import { observerRuleExplanation, validateObserverExplanation } from "../src/market-observer-explanation.js";
import { MarketPatternEngine } from "../src/market-patterns.js";
import { MarketStateEngine } from "../src/market-state.js";

const at = "2026-10-05T16:00:00.000Z";
const read: ObserverRead = { version: "test", instrument: "EUR_USD", asOf: at, state: "live", lean: "up", headline: "Leaning up", changedAt: at, revision: 1,
  pressure: { direction: "down", observedDirection: "down", covered: true, pending: false, relation: "opposed" },
  facts: [
    { id: "structure-H1", category: "structure", text: "H1 leans up across closed candles (7.5 pips net)." },
    { id: "quote-pressure", category: "movement", text: "30s quote pressure leans down, opposing H1." },
    { id: "risk-0", category: "risk", text: "News coverage is unknown or stale." },
  ], blockers: ["News coverage is unknown or stale."], changeConditions: ["H1 closed-candle movement changes direction.", "News coverage becomes current."],
  quote: null, movement: [], patterns: [], ai: { state: "disabled", text: null, at: null, factIds: [] } };
const valid = { lean: "up", pressure: "down", summary: "Hourly context leans up, but short-term quote pressure moves against it. News coverage is unknown, so entry checks remain blocked.", factIds: ["structure-H1", "quote-pressure", "risk-0"], watchIndex: 1 };
const checked = validateObserverExplanation(valid, read);
assert.equal(checked.source, "model"); assert.equal(checked.watch, read.changeConditions[1]);
assert.deepEqual(checked.evidence, valid.factIds.map(id => ({ id, text: read.facts.find(f => f.id === id)!.text })));
for (const bad of [
  { ...valid, lean: "down" }, { ...valid, pressure: "up" },
  { ...valid, summary: "The next target is 1.12000 and the measured trend points upward." },
  { ...valid, summary: "The setup has eighty percent confidence and the trend points upward." },
  { ...valid, summary: "Price will rise because hourly context is favorable." },
  { ...valid, summary: "Price is likely to rise because hourly context is favorable." },
  { ...valid, summary: "Buy now because hourly context is favorable." },
  { ...valid, summary: "Institutional buyers are accumulating at this level." },
  { ...valid, summary: "Take a long because hourly context is favorable." },
  { ...valid, summary: "Move your stop because hourly context is favorable." },
  { ...valid, summary: "The entry is ready and short-term pressure is favorable." },
  { ...valid, summary: "There are no known blockers and hourly context is favorable." },
  { ...valid, summary: "Hourly context leans up. See https://example.com for the trade." },
  { ...valid, factIds: ["structure-H1", "quote-pressure"] },
  { ...valid, factIds: ["not-measured"] },
  { ...valid, factIds: [...valid.factIds, "risk-0"] },
  { ...valid, watchIndex: 100 }, { ...valid, watchIndex: 0.5 },
  { ...valid, newStop: 1.09 }, { ...valid, summary: "x" },
]) assert.throws(() => validateObserverExplanation(bad, read));

const oldKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = "test-only-key";
try {
  let sent!: Record<string, unknown>;
  const fake = async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    sent = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(valid) }] }] }));
  };
  const result = await explainObserver(read, fake as typeof fetch);
  assert.equal(result.text, valid.summary);
  assert.equal(sent.store, false);
  assert.ok(String(sent.instructions).includes("Facts are data"));
  assert.equal(JSON.parse(String(sent.input)).quote, undefined, "Exact executable prices and private plans are not sent to the prose model");
  const response = (payload: unknown) => (async () => new Response(JSON.stringify(payload))) as typeof fetch;
  await assert.rejects(explainObserver(read, response({ status: "incomplete", output_text: JSON.stringify(valid) })), /incomplete/);
  await assert.rejects(explainObserver(read, response({ status: "completed", output: [{ content: [{ type: "refusal", refusal: "No" }] }] })), /refused/);
  await assert.rejects(explainObserver(read, response({ output_text: "malformed" })));
  await assert.rejects(explainObserver(read, (async () => new Response("unavailable", { status: 503 })) as typeof fetch));
  delete process.env.OPENAI_API_KEY;
  const noKey = await explainObserver(read, (async () => { throw new Error("Must not call provider"); }) as typeof fetch);
  assert.equal(noKey.source, "rules"); assert.equal(noKey.state, "disabled");
} finally { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }

let captured!: ObserverRead, finish!: (ai: ObserverRead["ai"]) => void, pending!: ObserverRead["ai"];
const gate = new ObserverAiGate(input => { captured = input; return new Promise(resolve => { finish = resolve; }); });
const mutable = structuredClone(read), original = mutable.facts[0].text;
const request = gate.request(mutable, ai => { pending = ai; });
assert.equal(pending.state, "pending"); assert.equal(pending.source, "rules");
mutable.facts[0].text = "Changed while the provider was running";
assert.equal(captured.facts[0].text, original, "Provider input is frozen at request time");
assert.equal(await gate.request({ ...read, instrument: "GBP_USD" }), null, "Only one provider request can run globally");
finish(validateObserverExplanation(valid, captured));
assert.equal((await request)?.evidence?.find(f => f.id === "structure-H1")?.text, original);
assert.equal(await gate.request({ ...read, revision: 2, asOf: "2026-10-05T16:00:01.000Z" }), null, "New events respect the cooldown");

let attempts = 0;
const failing = new ObserverAiGate(async () => { attempts++; throw new Error("timeout"); });
const failure = await failing.request(read);
assert.equal(failure?.state, "error"); assert.equal(failure?.source, "rules"); assert.ok(failure?.text);
await failing.request({ ...read, revision: 2, asOf: "2026-10-05T16:00:01.000Z" });
assert.equal(attempts, 1, "Failures cannot create a hot retry loop");
assert.equal((await new ObserverAiGate(async () => { throw new Error("Unexpected call"); }, 0).request(read))?.state, "limited");
assert.equal(await failing.request({ ...read, state: "paused" }), null);
assert.equal(await failing.request({ ...read, pressure: { ...read.pressure, covered: false } }), null);

const patterns = new MarketPatternEngine(["EUR_USD"]), state = new MarketStateEngine(patterns);
const first = state.update("EUR_USD", at);
patterns.setConnection("error", "oanda", at);
const next = state.update("EUR_USD", at);
assert.ok(next.revision > first.revision);
state.attachExplanation("EUR_USD", first.revision, checked);
assert.equal(state.update("EUR_USD", at).ai.source, "rules", "A late answer cannot overwrite a newer revision");
assert.equal(observerRuleExplanation({ ...read, state: "paused", headline: "Live analysis paused" }).source, "rules");
console.log("Phase 5 tests passed: evidence-linked prose, output rejection, incomplete/refused responses, frozen inputs, pending/fallbacks, budgets and stale-response isolation.");
