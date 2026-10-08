import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { computeSessionTradability, rankQualifiedMarkets, MARKET_SELECTION_POLICY, classifySelectionStructure } from "../../frontend/src/lib/strategy/ny-tradability.js";
import { morningScanSlot, morningPicksState, morningChartHref, type MorningScanRun } from "../../frontend/src/lib/strategy/morning-scan.js";
import { forexUniverse, selectionMap } from "../src/market-selection-service.js";
import { scheduledScanAuthorized } from "../src/morning-market-scanner.js";
import { fixtureInput, fixtureNews, FIXTURE_TIME } from "./fixtures/morning-scan.js";

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); checks++; console.log(`ok ${name}`); }
await check("weekday / DST / five-minute slots / closure calendar", () => {
  assert.equal(morningScanSlot(new Date("2026-03-06T11:30:00Z")), "2026-03-06:0");
  assert.equal(morningScanSlot(new Date("2026-03-09T10:30:00Z")), "2026-03-09:0");
  assert.equal(morningScanSlot(new Date("2026-11-02T11:30:00Z")), "2026-11-02:0");
  assert.equal(morningScanSlot(new Date("2026-10-07T10:34:59Z")), "2026-10-07:0");
  assert.equal(morningScanSlot(FIXTURE_TIME), "2026-10-07:1");
  for (const time of ["2026-10-10T10:35:00Z", "2026-10-11T10:35:00Z", "2026-10-07T10:29:59Z", "2026-10-07T15:00:00Z"]) assert.equal(morningScanSlot(new Date(time)), null);
  assert.equal(morningScanSlot(FIXTURE_TIME, ["2026-10-07"]), null);
});
await check("account discovery filters non-currency / precision mismatch and deduplicates", () => {
  assert.deepEqual(forexUniverse([{ name: "EUR_USD", type: "CURRENCY", pipLocation: -4 }, { name: "USD_JPY", type: "CURRENCY", pipLocation: -2 }, { name: "EUR_USD", pipLocation: -4 }, { name: "XAU_USD", type: "METAL", pipLocation: -2 }, { name: "GBP_USD", pipLocation: -2 }]), ["EUR_USD", "USD_JPY"]);
});
const qualified = ["EUR_USD", "GBP_USD", "USD_JPY"].map(i => computeSessionTradability(fixtureInput(i)));
await check("three synthetic candidates pass actual shared calculations, fewer than five stay fewer", () => {
  assert.equal(rankQualifiedMarkets(qualified).length, 3);
  assert.ok(qualified.every(p => p.selection?.direction === "UPTREND"));
  assert.equal(rankQualifiedMarkets(qualified.slice(0, 1)).length, 1);
  assert.equal(rankQualifiedMarkets([]).length, 0);
  assert.equal(rankQualifiedMarkets([...qualified, ...qualified]).length, 3);
});
await check("ranking is deterministic, only qualified, ties use instrument", () => {
  const caution = computeSessionTradability({ ...fixtureInput("AUD_USD"), news: [fixtureNews("AUD", 45)] });
  assert.equal(caution.selection!.status, "CAUTION");
  assert.equal(rankQualifiedMarkets([caution, ...qualified]).length, 3);
  assert.deepEqual(rankQualifiedMarkets([...qualified].reverse()), rankQualifiedMarkets(qualified));
});
await check("future and forming candles cannot alter pivots, levels or rankings", () => {
  const input = fixtureInput("EUR_USD");
  const future = { ...input.m15!.at(-1)!, time: new Date(FIXTURE_TIME.getTime() + 900_000).toISOString(), high: 99, close: 9 };
  assert.deepEqual(computeSessionTradability({ ...input, m15: [...input.m15!, future, { ...future, complete: false }] }), qualified[0]);
  assert.deepEqual(computeSessionTradability({ ...input, m15: [...input.m15!].reverse(), h1: [...input.h1!].reverse() }), qualified[0]);
  assert.equal(classifySelectionStructure([]), "UNCLEAR");
  const bearish = input.m15!.map(b => ({ ...b, open: 3-b.open, high: 3-b.low, low: 3-b.high, close: 3-b.close }));
  assert.equal(classifySelectionStructure(bearish.slice(-64)), "DOWNTREND");
});
await check("weak / unstable movement and excessive executable cost cannot qualify", () => {
  const quiet = fixtureInput("EUR_USD");
  quiet.m15 = quiet.m15!.map(b => ({ ...b, open: 1+(b.open-1)/100, high: 1+(b.high-1)/100, low: 1+(b.low-1)/100, close: 1+(b.close-1)/100 }));
  assert.equal(computeSessionTradability(quiet).selection!.status, "REJECTED");
  for (const i of ["EUR_USD", "USD_JPY"]) assert.ok(Math.abs(computeSessionTradability(fixtureInput(i)).spreadPips!-.6) < 1e-7);
  const costly = fixtureInput("EUR_GBP"); costly.quote!.ask += .002;
  assert.equal(computeSessionTradability(costly).selection!.status, "REJECTED");
});
await check("missing / stale / future quotes, stale H1, invalid OHLC rejected as data failure", () => {
  const input = fixtureInput("EUR_USD");
  for (const quote of [null, { ...input.quote!, time: "2026-10-07T10:00:00Z" }, { ...input.quote!, time: "2026-10-07T11:00:00Z" }]) assert.equal(computeSessionTradability({ ...input, quote }).selection!.dataFailure, true);
  assert.equal(computeSessionTradability({ ...input, h1: input.h1!.slice(0,-3) }).selection!.dataFailure, true);
  assert.equal(computeSessionTradability({ ...input, m15: input.m15!.map(b => ({ ...b, high: NaN })) }).selection!.dataFailure, true);
});
await check("missing calendar UNKNOWN and either currency high impact blocks, unrelated events do not", () => {
  for (const currency of ["USD", "EUR"]) assert.equal(computeSessionTradability({ ...fixtureInput("EUR_USD"), news: [fixtureNews(currency, 10)] }).selection!.status, "REJECTED");
  assert.equal(computeSessionTradability({ ...fixtureInput("EUR_GBP"), news: [fixtureNews("USD", 10)] }).selection!.news.events.length, 0);
  assert.equal(computeSessionTradability({ ...fixtureInput("EUR_USD"), news: null }).selection!.news.state, "UNKNOWN");
  assert.equal(computeSessionTradability({ ...fixtureInput("EUR_USD"), news: null }).selection!.status, "REJECTED");
  assert.equal(computeSessionTradability({ ...fixtureInput("EUR_USD"), news: null }, undefined, { ...MARKET_SELECTION_POLICY, requireNews: false }).selection!.status, "CAUTION");
});
await check("London so far and previous-day/equal/swing reference levels remain causal", () => {
  const p = qualified[0]!;
  const bars = fixtureInput("EUR_USD").m15!;
  const london = p.selection!.levels.find(l => l.name === "London so far high")!;
  assert.ok(london);
  assert.equal(london.price, Math.max(...bars.filter(b => Date.parse(b.time) >= Date.parse("2026-10-07T07:00:00Z") && Date.parse(b.time)+900_000 <= FIXTURE_TIME.getTime()).map(b => b.high)));
  assert.ok(p.selection!.levels.some(l => l.name.startsWith("Previous UTC day")));
});
await check("closed / stale / failed / unavailable Home states and selected chart navigation", () => {
  const run = { dateEt: "2026-10-07", evaluatedAt: FIXTURE_TIME.toISOString(), status: "SUCCESS" } as MorningScanRun;
  assert.equal(morningPicksState(run, false, FIXTURE_TIME), "READY");
  assert.equal(morningPicksState(run, true, FIXTURE_TIME), "STALE");
  assert.equal(morningPicksState(run, false, new Date("2026-10-07T10:43:00Z")), "STALE");
  assert.equal(morningPicksState(null, false, FIXTURE_TIME), "UNAVAILABLE");
  assert.equal(morningPicksState(run, false, FIXTURE_TIME, ["2026-10-07"]), "CLOSED");
  assert.equal(morningChartHref("USD_JPY"), "/chart?instrument=USD_JPY");
});
await check("bounded concurrency and abort waits for all workers", async () => {
  let active = 0; let maximum = 0;
  const result = await selectionMap(Array.from({ length: 12 }, (_, i) => i), async i => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--; return i*2; });
  assert.equal(maximum, 4); assert.equal(active, 0); assert.equal(result[11], 22);
  await assert.rejects(selectionMap([1,2], async i => i, AbortSignal.abort()));
});
await check("scheduled endpoint denies missing or incorrect token", () => {
  const previous = process.env.MORNING_SCAN_JOB_TOKEN;
  process.env.MORNING_SCAN_JOB_TOKEN = "synthetic-test-token";
  assert.equal(scheduledScanAuthorized(undefined), false); assert.equal(scheduledScanAuthorized("Bearer wrong"), false); assert.equal(scheduledScanAuthorized("Bearer synthetic-test-token"), true);
  if (previous === undefined) delete process.env.MORNING_SCAN_JOB_TOKEN; else process.env.MORNING_SCAN_JOB_TOKEN = previous;
});
const newsRejected = computeSessionTradability({ ...fixtureInput("NZD_USD"), news: [fixtureNews("NZD", 10)] });
const wide = fixtureInput("EUR_GBP"); wide.quote!.ask += .002;
const summarize = (p: typeof qualified[number]) => ({ instrument: p.instrument, status: p.selection!.status, direction: p.selection!.direction,
  suitabilityPoints: p.selection!.rankScore, spreadPips: p.spreadPips, atrPips: p.selection!.atrPips, reasons: p.selection!.reasons, explanation: p.selection!.explanation });
const example = { label: "SYNTHETIC FIXTURE — not a live scan or historical performance claim", at: FIXTURE_TIME.toISOString(), qualified: rankQualifiedMarkets(qualified).map(summarize), rejected: [newsRejected, computeSessionTradability(wide)].map(summarize) };
await mkdir(new URL("../../docs/", import.meta.url), { recursive: true });
await writeFile(new URL("../../docs/morning-scan-fixture.json", import.meta.url), JSON.stringify(example, null, 2)+"\n");
console.log(`${checks} morning scanner checks passed; example written to docs/morning-scan-fixture.json`);
