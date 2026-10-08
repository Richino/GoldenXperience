import assert from "node:assert/strict";
import { discoverSelectionInstruments, evaluateSelection, selectionPolicy } from "../src/market-selection-service.js";
import { fixtureInput, FIXTURE_TIME } from "./fixtures/morning-scan.js";
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const names = ["EUR_USD", "GBP_USD", "USD_JPY", "EUR_HKD"];
const counts = new Map<string, number>();
let requests = 0;
process.env.OANDA_API_KEY = "synthetic-fixture-token";
process.env.OANDA_ACCOUNT_ID = "synthetic-fixture-account";
process.env.OANDA_ENVIRONMENT = "practice";
Date.now = () => FIXTURE_TIME.getTime();
globalThis.fetch = async (input, options) => {
  requests++;
  assert.equal(options?.method ?? "GET", "GET", "scanner cannot send orders");
  const url = new URL(String(input));
  counts.set(url.pathname+url.search, (counts.get(url.pathname+url.search) ?? 0)+1);
  if (url.pathname.endsWith("/instruments")) return Response.json({ instruments: names.map(name => ({ name, type: "CURRENCY", pipLocation: name.endsWith("JPY") ? -2 : -4, displayPrecision: name.endsWith("JPY") ? 3 : 5 })) });
  if (url.pathname.endsWith("/pricing")) return Response.json({ prices: names.filter(n => n !== "EUR_HKD").map(instrument => { const q = fixtureInput(instrument).quote!; return { instrument, time: q.time, bids: [{ price: String(q.bid) }], asks: [{ price: String(q.ask) }], status: "tradeable" }; }) });
  if (url.pathname.endsWith("/candles")) {
    const name = url.pathname.split("/").at(-2)!;
    if (name === "GBP_USD" && counts.get(url.pathname+url.search) === 1) return new Response("Synthetic rate limit", { status: 429 });
    const tf = url.searchParams.get("granularity")!;
    const data = fixtureInput(name);
    return Response.json({ granularity: tf, candles: (tf === "M15" ? data.m15 : data.h1)!.map(b => ({ time: b.time, complete: b.complete, volume: b.volume, mid: { o: String(b.open), h: String(b.high), l: String(b.low), c: String(b.close) } })) });
  }
  if (url.hostname === "nfs.faireconomy.media") return Response.json([{ title: "Synthetic late-week release", country: "USD", date: "2026-10-09T12:30:00Z", impact: "High", forecast: "", previous: "" }]);
  throw new Error(`Unexpected provider ${url.hostname}`);
};
try {
  assert.deepEqual(await discoverSelectionInstruments(), [...names].sort());
  const result = await evaluateSelection(names);
  assert.equal(result.pairs.filter(p => p.selection?.status === "QUALIFIED").length, 3);
  assert.equal(result.pairs.find(p => p.instrument === "EUR_HKD")!.selection!.status, "REJECTED");
  assert.equal(result.pairs.find(p => p.instrument === "EUR_HKD")!.selection!.news.state, "UNKNOWN");
  assert.ok([...counts.values()].some(count => count === 2), "429 retried");
  const first = requests;
  await evaluateSelection(names);
  assert.equal(requests, first, "fresh history, prices and calendar are shared without duplicate requests");
  Date.now = () => FIXTURE_TIME.getTime() + 5*60_000;
  await evaluateSelection(names);
  assert.equal(requests, first+1, "five-minute revalidation refreshes quotes only between candle closes");
  process.env.MORNING_SCAN_INSTRUMENT_POLICIES = '{"EUR_USD":{"objectivePips":0}}';
  assert.throws(() => selectionPolicy("EUR_USD"), /positive/);
  process.env.MORNING_SCAN_INSTRUMENT_POLICIES = '{"EUR_USD":{"weights":{"structure":100}}}';
  assert.throws(() => selectionPolicy("EUR_USD"), /weights/);
  console.log("Provider integration passed: dynamic discovery, 429 retry, completed real-source candles, batch executable quotes, calendar coverage, exotic UNKNOWN, cache reuse, five-minute quote refresh, validated policy, no order requests.");
} finally { globalThis.fetch = originalFetch; Date.now = originalNow; delete process.env.MORNING_SCAN_INSTRUMENT_POLICIES; }
