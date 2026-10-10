import assert from "node:assert/strict";
import { config } from "dotenv";
import type { ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { explainObserver } from "../src/market-observer-ai.js";

config({ path: ".env", quiet: true }); config({ path: ".env.local", quiet: true });
// Explicit synthetic facts exercise the actual configured provider without account/trade data.
const fixture = { instrument: "EUR_USD", headline: "Timeframes disagree", asOf: new Date().toISOString(), facts: [
  { id: "h1", category: "structure", text: "H1 closed-candle movement leans up." },
  { id: "h4", category: "structure", text: "H4 closed-candle movement leans down." },
  { id: "risk", category: "risk", text: "News coverage is unknown. This fixture is not a live market analysis." },
] } as ObserverRead;
const result = await explainObserver(fixture);
assert.equal(result.state, "ready", "The configured provider must return validated highlights");
assert.ok(result.factIds.length > 0);
console.log(JSON.stringify({ state: result.state, factIds: result.factIds, syntheticFixture: true }));
