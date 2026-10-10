import assert from "node:assert/strict";
import { config } from "dotenv";
import type { ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { explainObserver } from "../src/market-observer-ai.js";

config({ path: ".env", quiet: true }); config({ path: ".env.local", quiet: true });
// Explicit synthetic facts exercise the actual configured provider without account/trade data.
const fixture: ObserverRead = { version: "synthetic-check", instrument: "EUR_USD", headline: "Timeframes disagree", asOf: new Date().toISOString(),
  state: "live", lean: "conflicting", changedAt: new Date().toISOString(), revision: 1,
  pressure: { direction: "down", observedDirection: "down", covered: true, pending: false, relation: "opposed" },
  blockers: ["News coverage is unknown. This fixture is not a live market analysis."],
  changeConditions: ["H1 and H4 regain directional alignment.", "News coverage becomes current."], quote: null, movement: [], patterns: [],
  ai: { state: "disabled", text: null, at: null, factIds: [] }, facts: [
    { id: "structure-H1", category: "structure", text: "H1 closed-candle movement leans up." },
    { id: "structure-H4", category: "structure", text: "H4 closed-candle movement leans down." },
    { id: "quote-pressure", category: "movement", text: "Short-term quote pressure leans down, opposing H1." },
    { id: "risk", category: "risk", text: "News coverage is unknown. This fixture is not a live market analysis." },
  ] };
const result = await explainObserver(fixture);
assert.equal(result.state, "ready", "The configured provider must return validated highlights");
assert.ok(result.factIds.length > 0);
assert.equal(result.source, "model");
assert.ok(result.watch && result.evidence?.length);
console.log(JSON.stringify({ state: result.state, source: result.source, text: result.text, factIds: result.factIds, watch: result.watch, syntheticFixture: true }));
