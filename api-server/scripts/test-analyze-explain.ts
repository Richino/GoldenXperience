/**
 * Analyze V2 explanation service with a stubbed model (no network, no key
 * needed): a faithful answer is returned; an answer that changes the
 * decision or invents a number is rejected; a model failure is an error the
 * app can fall back from.
 *
 *   npm run analyze-explain:test
 */
import assert from "node:assert/strict";
import { explainAnalysis } from "../src/analyze-explain.js";
import type { ExplanationFacts } from "../../frontend/src/lib/strategy/analyze-v2/explain.js";

process.env.OPENAI_API_KEY = "test-key";
const realFetch = globalThis.fetch;
let lastBody: Record<string, unknown> | null = null;
function stub(output: unknown, status = 200) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    lastBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(status === 200 ? { output_text: JSON.stringify(output) } : { error: "down" }), { status });
  }) as typeof fetch;
}

const facts: ExplanationFacts = {
  pair: "EUR/USD",
  mode: "NORMAL",
  decision: "LONG",
  headline: "Bullish pullback qualified: M15 uptrend, confirmed turn at 1.10906–1.10914.",
  timeframes: { structure: "M15", higher: "H1" },
  structure: { primaryTrend: "UPTREND", higherTrend: "UPTREND", alignment: "M15 uptrend, in line with H1 uptrend.", evidence: ["Swing lows 1.10290 → 1.10590 (higher)"], structureLevel: "1.10590" },
  setup: { status: "TRIGGERED", zone: "1.10906–1.10914", retracedShareOfImpulse: "35%" },
  plan: { entry: "1.10966", stop: "1.10883", target: "1.11116", stopPips: "8.3", targetPips: "15.0", rewardRisk: "1.81", spreadPips: "1.2", stopBasis: "Below the pullback low 1.10900", targetBasis: "15-pip day-trade target" },
  checks: [{ check: "Spread", status: "CAUTION", reason: "1.2 pips, 14% of the 8.3-pip risk." }],
  news: { state: "CLEAR", reason: "No medium- or high-impact EUR/USD news in the next 6h." },
  volatility: "Normal volatility (last candle 1.4 ATR).",
  liquidity: { risk: "CLEAR", findings: ["No specific liquidity concern identified near the entry, stop or target."], confirmation: null, nearestAbove: null, nearestBelow: null },
  invalidation: "A bid at 1.10883 ends the trade.",
  watch: null,
};
const answer = {
  decision: "LONG",
  summary: "The M15 uptrend pulled back to 1.10906–1.10914 and a closed candle confirmed the turn.",
  direction: "Rising swing lows on M15, with H1 in the same direction.",
  location: "The pullback held the old high that now acts as support.",
  support: "Both timeframes agree and no news is due in the next 6 hours.",
  risks: "A bid at 1.10883 ends the trade; the 1.2-pip spread is 14% of the risk.",
  levels: "Stop below the pullback low 1.10900; target 15.0 pips away at 1.11116 for 1.81R.",
};

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed += 1;
  console.log(`ok  ${name}`);
}

await test("a faithful explanation is returned", async () => {
  stub(answer);
  const result = await explainAnalysis(facts);
  assert.equal(result.explanation.decision, "LONG");
  assert.equal(result.explanation.levels, answer.levels);
  const sent = JSON.stringify(lastBody);
  assert.match(sent, /json_schema/);
  assert.match(sent, /Never calculate, round, convert or alter a number/);
});

await test("an explanation that changes the decision is rejected", async () => {
  stub({ ...answer, decision: "SHORT" });
  await assert.rejects(explainAnalysis(facts), /Explanation rejected/);
});

await test("an explanation that invents a price is rejected", async () => {
  stub({ ...answer, levels: "A safer stop would be 1.10850." });
  await assert.rejects(explainAnalysis(facts), /not in the analysis: 1\.10850/);
});

await test("a model outage is an error, not a fabricated answer", async () => {
  stub(null, 503);
  await assert.rejects(explainAnalysis(facts), /could not respond/);
});

await test("no key configured is a clear error", async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(explainAnalysis(facts), /not configured/);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} tests passed`);
