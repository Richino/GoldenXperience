import assert from "node:assert/strict";
import { ObserverConversation, observerChatText, compactObserverChatMessage, observerDecisionText, observerSnapshotCanReplace } from "../src/lib/observer-conversation";
import type { ObserverSnapshot, ObserverRead, ObserverPlan } from "../src/lib/market-observer-types";

const start = Date.parse("2026-10-05T14:00:00Z"), time = (offset: number) => new Date(start + offset).toISOString();
function snapshot(pair = "EUR_USD", offset = 0): ObserverSnapshot {
  const read: ObserverRead = { version: "market-observer@2", instrument: pair, asOf: time(offset), state: "live", lean: "down", headline: "Leaning down", changedAt: time(0), revision: 1,
    facts: [{ id: "quote-pressure", category: "movement", text: "30s quote pressure: leaning down; aligned with H1." }], blockers: [], changeConditions: [],
    pressure: { direction: "down", observedDirection: "down", covered: true, pending: false, relation: "aligned" }, quote: { bid: 1.1, ask: 1.10005, time: time(offset), spreadPips: 0.5 },
    movement: [], patterns: [], ai: { state: "disabled", text: null, at: null, factIds: [] } };
  return { enabled: true, storage: "ready", read, plan: null, history: [] };
}
const conversation = new ObserverConversation();
const original = snapshot();
const first = conversation.ingest("EUR_USD", original, time(0));
assert.equal(first.length, 1); assert.match(first[0].text, /leaning down/); assert.ok(first[0].text.length < 120);
const evidence = structuredClone(first[0].evidence);
for (let ms = 1000; ms <= 9000; ms += 1000) assert.deepEqual(conversation.ingest("EUR_USD", snapshot("EUR_USD", ms), time(ms)), [], "New timestamps alone must not create messages");
original.read!.facts[0].text = "mutated fixture";
assert.deepEqual(first[0].evidence, evidence, "Earlier messages keep evidence from their own time");
assert.equal(conversation.ingest("EUR_JPY", snapshot("EUR_JPY", 0), time(9000)).length, 1);
assert.deepEqual(conversation.ingest("EUR_USD", snapshot("EUR_JPY", 9000), time(9000)), [], "Pair mismatch cannot enter another pair's feed");
const opposed = snapshot("EUR_USD", 9500); opposed.read!.pressure.direction = "up"; opposed.read!.pressure.relation = "opposed";
opposed.read!.facts[0].text = "30s quote pressure: leaning up; opposing H1.";
assert.deepEqual(conversation.ingest("EUR_USD", opposed, time(9500)), [], "Routine changes coalesce rather than flooding the log");
opposed.read!.asOf = time(30000);
assert.match(conversation.ingest("EUR_USD", opposed, time(30000))[0].text, /pullback or a turn/);

const plan: ObserverPlan = { id: "p1", version: 1, instrument: "EUR_USD", mode: "NORMAL", status: "READY", resumeStatus: "READY", createdAt: time(0), updatedAt: time(10100), expiresAt: time(3600000),
  direction: "short", reason: "Candle confirmed.", thesis: "Downtrend pullback", zone: { low: 1.0999, high: 1.1002 }, entry: 1.1, stop: 1.101, target: 1.098,
  trigger: { timeframe: "M5", boundary: 1.1002, after: time(0) }, invalidation: "A price above the stop invalidates the short.", lastEvaluatedCandle: time(0), confirmationCandle: time(0),
  triggeredAt: null, observedEntry: null, outcome: null, facts: [] };
const ready = snapshot("EUR_USD", 10100); ready.plan = plan; ready.history = [{ id: "1", at: time(10100), status: "READY", reason: plan.reason }];
ready.checks = [{ id: "confirmation", label: "M5 candle confirmation", state: "met", detail: "Full new candle confirmed." }];
const readyConversation = new ObserverConversation();
const readyMessages = readyConversation.ingest("EUR_USD", ready, time(10100));
assert(readyMessages.some(m => /entry checks still need to pass/.test(m.text)));
const zoneOnly = structuredClone(ready); zoneOnly.plan!.confirmationCandle = null; zoneOnly.checks![0].state = "waiting";
assert.doesNotMatch(observerDecisionText(zoneOnly, "EUR_USD"), /Candle confirmed/, "READY alone is not a candle confirmation");
assert.match(observerDecisionText(zoneOnly, "EUR_USD"), /Awaiting a valid closed-candle/);
const finished = snapshot("EUR_USD", 10200); finished.plan = { ...plan, status: "CLOSED", triggeredAt: time(10120), observedEntry: 1.1, outcome: { kind: "target_observed", at: time(10180), price: 1.098 } };
finished.history = [...ready.history, { id: "2", at: time(10120), status: "TRIGGERED", reason: "Short condition observed." }, { id: "3", at: time(10180), status: "CLOSED", reason: "Target quote observed." }];
const quickEvents = readyConversation.ingest("EUR_USD", finished, time(10200));
assert(quickEvents.some(m => /triggered.*Short condition observed/.test(m.text)), "Trigger between UI polls must survive through journal events");
assert(quickEvents.some(m => /closed.*Target quote observed/.test(m.text)));
assert.deepEqual(readyConversation.ingest("EUR_USD", finished, time(10300)), []);
assert.deepEqual(readyConversation.ingest("EUR_USD", ready, time(10400)), [], "Older read cannot replace an outcome");
const latePlan = structuredClone(ready); latePlan.read!.asOf = finished.read!.asOf;
assert.equal(observerSnapshotCanReplace(finished, latePlan, "EUR_USD"), false, "A newer/equal read timestamp cannot resurrect a terminal plan");
const delayedJournal = new ObserverConversation();
const memoryFirst = structuredClone(ready); memoryFirst.history = [];
delayedJournal.ingest("EUR_USD", memoryFirst, time(10100));
assert.deepEqual(delayedJournal.ingest("EUR_USD", ready, time(10200)), [], "Delayed persistence must not repeat a transition already shown from a plan snapshot");

const paused = snapshot("EUR_JPY", 10500); paused.read!.state = "paused"; paused.read!.blockers = ["Prices are not tradeable."];
paused.read!.ai = { state: "ready", source: "model", text: "Stale bullish interpretation", at: time(0), factIds: [] };
const pausedMessages = new ObserverConversation().ingest("EUR_JPY", paused, time(10500));
assert.equal(pausedMessages.length, 1); assert.match(pausedMessages[0].text, /stopped coming in/); assert.doesNotMatch(pausedMessages[0].text, /bullish|Leaning down/);
assert.equal(conversation.failure("EUR_USD", time(11000)).length, 1);
assert.deepEqual(conversation.failure("EUR_USD", time(12000)), []);
const recover = conversation.ingest("EUR_USD", snapshot("EUR_USD", 61000), time(61000));
assert(recover.some(m => /couldn.t see what price did/.test(m.text)));
const explained = snapshot("EUR_USD", 14000); explained.read!.ai = { state: "ready", source: "model", text: "Selling pressure supports the hourly lean.", watch: "Watch the next candle confirmation.", at: time(14000), factIds: ["quote-pressure"], evidence: [{ id: "quote-pressure", text: "Frozen measured pressure." }] };
const rulesOnly = new ObserverConversation(); rulesOnly.ingest("EUR_USD", snapshot("EUR_USD", 13000), time(13000));
const explanation = rulesOnly.ingest("EUR_USD", explained, time(14000));
assert.equal(explanation.length, 0, "Chat uses rules, not a second model explanation");
explained.read!.asOf = time(15000); explained.read!.ai.at = time(15000);
assert.deepEqual(rulesOnly.ingest("EUR_USD", explained, time(15000)), [], "Repeated explanation with a newer timestamp is not a new insight");
const historical = snapshot("AUD_JPY", 16000); historical.read!.patterns = [{ id: "old", kind: "double_top", timeframe: "M5", state: "confirmed", direction: "down", at: time(0), historical: true, contextState: "current" }];
assert.doesNotMatch(observerDecisionText(historical, "AUD_JPY"), /double top/);
historical.read!.patterns[0].historical = false; historical.read!.patterns[0].state = "forming";
assert.match(observerDecisionText(historical, "AUD_JPY"), /forming.*Forming shapes can change/);
const weekend = snapshot(); weekend.read!.asOf = "2026-10-10T14:00:00Z";
const closedText = observerDecisionText(weekend, "EUR_USD");
assert.match(closedText, /Forex market closed.*Watching resumes after the market reopens/);
assert.doesNotMatch(closedText, /Leaning down|Detected/, "A closed market cannot sound like a live directional decision");
const interruptedText = observerDecisionText(paused, "EUR_JPY");
assert.doesNotMatch(interruptedText, /market closed/i, "An open-market feed interruption is different from a scheduled closure");
console.log("Observer chat tests passed: pair isolation, poll deduplication, conditional guidance, frozen evidence, fast lifecycle events, stale reads, gaps, AI source separation and market closure messaging.");
const noisy = new ObserverConversation();
noisy.ingest("EUR_USD", snapshot(), time(0));
for (let ms = 1000; ms < 120000; ms += 1000) {
  const update = snapshot("EUR_USD", ms);
  update.read!.state = ms % 2000 ? "paused" : "live";
  update.read!.blockers = [`Transient gate ${ms}`];
  const messages = noisy.ingest("EUR_USD", update, time(ms));
  assert.ok(messages.every(m => m.text.length <= 280));
  if (ms > 30000) assert.equal(messages.length, 0, "Repeated feed flaps stay quiet for two minutes");
}
assert.ok(compactObserverChatMessage(observerDecisionText(ready, "EUR_USD")).length <= 280);
assert.match(observerChatText(zoneOnly, "EUR_USD"), /leaning down/);
