import assert from "node:assert/strict";
import { candleEnd, candleHealth, brokerOpen } from "../../frontend/src/lib/strategy/candle-clock.js";
import { checkCandleFreshness, checkQuote, normalizeCandles } from "../../frontend/src/lib/strategy/analyze-v2/data-quality.js";
import { getCandles } from "../../frontend/src/lib/oanda/client.js";
import { dailyPriceChange, dailyChangeLabel } from "../../frontend/src/lib/oanda/price-change.js";
import { interpretMarketState, readMarketTechnicals } from "../src/intelligence/market-state-interpreter.js";
import { evaluateConfirmation } from "../src/trade-plan-confirmation.js";
import { generateTradePlans } from "../src/trade-plan-generator.js";
import { buildCalendarSnapshot } from "../src/intelligence/calendar-snapshot.js";
import { completionNotice } from "../src/intelligence/research-jobs.js";
import { input } from "./fixtures/analysis-input.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const originalNow = Date.now;
Date.now = () => Date.parse("2026-10-18T22:42:59.990Z");
const at = Date.parse, HOUR = 3_600_000;
const bar = (time: string, complete = true): Candle => ({ time, complete, open: 1.12, high: 1.13, low: 1.11, close: 1.12297, volume: 10 });
let passed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) { await fn(); console.log(`ok ${++passed}: ${name}`); }
const fridayH4 = "2026-10-16T17:00:00Z"; // Friday 13:00 New York; ends 17:00.

for (const [name, clock] of [
  ["Friday before close", "2026-10-16T20:58:00Z"],
  ["Saturday", "2026-10-17T12:00:00Z"],
  ["Sunday before reopen", "2026-10-18T20:59:00Z"],
  ["Sunday immediately after reopen", "2026-10-18T21:06:00Z"],
  ["Sunday before first H4 completion", "2026-10-19T00:10:00Z"],
] as const) await test(name, () => {
  const open = name === "Friday before close" ? "2026-10-16T13:00:00Z" : fridayH4;
  assert.equal(candleHealth(at(open), "H4", at(clock)).missing, 0);
});
await test("reported 2983/3071 minute H4 ages are one valid Friday close at different clocks", () => {
  const close = candleEnd(at(fridayH4), "H4");
  assert.equal(Math.round((at("2026-10-18T22:42:59.990Z") - close) / 60_000), 2983);
  assert.equal(Math.round((at("2026-10-19T00:11:00Z") - close) / 60_000), 3071);
  assert.equal(checkCandleFreshness("H4", [bar(fridayH4)], "H4", at("2026-10-19T00:11:00Z"), 2).status, "PASS");
});
await test("saved H1 close becomes 131 minutes old; a real refresh is required", () => {
  const clock = at("2026-10-19T00:11:00Z");
  assert.equal((clock-at("2026-10-18T22:00:00Z"))/60_000, 131);
  assert.equal(checkCandleFreshness("H1", [bar("2026-10-18T21:00:00Z")], "H1", clock, 2).status, "FAIL");
  assert.equal(checkCandleFreshness("H1", [bar("2026-10-18T23:00:00Z")], "H1", clock, 2).status, "PASS");
});
await test("missing first Sunday H1 is detected after its completion grace", () => {
  assert.equal(candleHealth(at("2026-10-16T20:00:00Z"), "H1", at("2026-10-18T22:03:00Z")).missing, 1);
});
await test("Monday daily rollover expects Sunday's completed daily interval", () => {
  const clock = at("2026-10-19T21:03:00Z");
  assert.equal(candleHealth(at("2026-10-15T21:00:00Z"), "D1", clock).missing, 1);
  assert.equal(candleHealth(at("2026-10-18T21:00:00Z"), "D1", clock).missing, 0);
});
await test("DST daily boundaries use New York wall clock, including 23/25 hour days", () => {
  assert.equal(candleEnd(at("2026-03-07T22:00:00Z"), "D1"), at("2026-03-08T21:00:00Z"));
  assert.equal(candleEnd(at("2026-10-31T21:00:00Z"), "D1"), at("2026-11-01T22:00:00Z"));
});
await test("DST Sunday H4 completion stays 21:00 New York", () => {
  for (const [last, before, after] of [
    ["2026-03-06T18:00:00Z", "2026-03-09T00:59:00Z", "2026-03-09T01:03:00Z"],
    ["2026-10-30T17:00:00Z", "2026-11-02T01:59:00Z", "2026-11-02T02:03:00Z"],
  ]) {
    assert.equal(candleHealth(at(last!), "H4", at(before!)).missing, 0);
    assert.equal(candleHealth(at(last!), "H4", at(after!)).missing, 1);
  }
});
await test("verified broker holiday/interruptions excluded; unexplained missing bars fail closed", () => {
  const open=at("2026-12-24T20:00:00Z"), clock=at("2026-12-25T16:03:00Z");
  assert.ok(candleHealth(open,"H1",clock).missing>0);
  assert.equal(candleHealth(open,"H1",clock,[{from:open+HOUR,to:clock}]).missing,0);
});
await test("daily OANDA maintenance and NZD's additional break are instrument aware", () => {
  assert.equal(brokerOpen(at("2026-10-14T21:02:00Z")),false);
  assert.equal(brokerOpen(at("2026-10-14T21:05:00Z")),true);
  assert.equal(brokerOpen(at("2026-10-14T18:01:00Z"),[],"NZD_USD"),false);
  assert.equal(brokerOpen(at("2026-10-14T18:01:00Z"),[],"EUR_USD"),true);
});
await test("forming candles and future closes cannot confirm structure", () => {
  const i=input(), before=readMarketTechnicals(i.market);
  i.market.candles.H1!.push(bar(new Date(i.market.now).toISOString(),false),bar(new Date(i.market.now+HOUR).toISOString()));
  const after=readMarketTechnicals(i.market);
  assert.deepEqual(after.candles.H1,before.candles.H1);
});
await test("wrong ordering is normalized, duplicates identified, malformed OHLC rejected", () => {
  const a=bar("2026-10-14T09:00:00Z"), b=bar("2026-10-14T10:00:00Z");
  const n=normalizeCandles([b,a,a,{...b,high:NaN}],"H1");
  assert.equal(n.reordered,true); assert.equal(n.duplicates,1); assert.equal(n.malformed,1);
  assert.deepEqual(n.closed,[a,b]);
});
await test("closed weekends produce no synthetic historical gaps", () => {
  assert.equal(normalizeCandles([bar(fridayH4),bar("2026-10-18T21:00:00Z")],"H4").missing,0);
});
await test("missing historical market-hours candles are counted", () => {
  assert.equal(normalizeCandles([bar("2026-10-14T09:00:00Z"),bar("2026-10-14T12:00:00Z")],"H1").missing,2);
});
await test("normal weekday interpretation is complete", () => {
  const s=interpretMarketState(input()); assert.equal(s.analysisStatus,"ANALYSIS_COMPLETE");
});
await test("fresh H1 but missing H4 preserves partial observation and research", () => {
  const i=input(); i.market.candles.H4=[]; i.technical=readMarketTechnicals(i.market);
  const s=interpretMarketState(i);
  assert.equal(s.analysisStatus,"ANALYSIS_PARTIAL"); assert.equal(s.observed.timeframe,"H1");
  assert.ok(s.source.structure?.D1?.direction, "valid D1 is retained even when H4 is absent");
  assert.notEqual(s.fundamental.classification,"INSUFFICIENT_EVIDENCE"); assert.equal(s.opportunities.length,0);
  assert.equal(generateTradePlans({...i.market,news:[],maxRiskPercent:1}).result,"TECHNICAL_DATA_UNAVAILABLE");
});
await test("M15-only observations never invent daily structure or swing lean", () => {
  const i=input(); i.market.candles.M15=Array.from({length:300},(_,n)=>({...bar(new Date(i.market.now-(300-n)*900_000).toISOString()),close:1.12+n*.00001}));
  i.market.candles.H1=[]; i.market.candles.H4=[]; i.market.candles.D1=[]; i.technical=readMarketTechnicals(i.market);
  const s=interpretMarketState(i);
  assert.equal(s.analysisStatus,"ANALYSIS_PARTIAL"); assert.equal(s.observed.timeframe,"M15");
  assert.equal(s.source.structure?.D1?.direction,null); assert.equal(s.forward.swing.classification,"INDETERMINATE");
});
await test("no usable technical data retains research but cannot report no setup", () => {
  const i=input(); i.market.candles={}; i.technical=readMarketTechnicals(i.market);
  const s=interpretMarketState(i); assert.equal(s.analysisStatus,"TECHNICAL_DATA_UNAVAILABLE");
  assert.match(s.summary,/temporarily incomplete/); assert.ok(s.fundamental.catalysts.length);
});
await test("live prices cannot rescue a failed candle feed", () => {
  const i=input(); i.market.candles={};
  assert.ok(checkQuote("EUR_USD",i.market.quote,i.market.now,10_000).executable);
  assert.equal(generateTradePlans({...i.market,news:[],maxRiskPercent:1}).result,"TECHNICAL_DATA_UNAVAILABLE");
});
await test("carried context never makes a stale quote executable", () => {
  assert.equal(checkQuote("EUR_USD",{bid:1.12,ask:1.1201,time:"2026-10-16T20:59:00Z"},at("2026-10-18T22:10:00Z"),10_000).executable,null);
  assert.equal(checkQuote("EUR_USD",{bid:Infinity,ask:Infinity,time:"2026-10-18T22:10:00Z"},at("2026-10-18T22:10:00Z"),10_000).executable,null);
});
await test("technical retry reuses the same validated research without model calls", () => {
  const i=input(), id=i.intelligence.research.id, frozen=JSON.stringify(i.intelligence);
  i.market.candles.H4=[]; i.technical=readMarketTechnicals(i.market); assert.equal(interpretMarketState(i).analysisStatus,"ANALYSIS_PARTIAL");
  const fresh=input(); i.market.candles.H4=fresh.market.candles.H4; i.technical=readMarketTechnicals(i.market);
  const s=interpretMarketState(i); assert.equal(s.analysisStatus,"ANALYSIS_COMPLETE"); assert.equal(s.researchId,id);
  assert.equal(JSON.stringify(i.intelligence),frozen); assert.deepEqual(s.costs,{modelCalls:0,webSearchCalls:0});
});
await test("a complete evaluation with no nearby qualifying zone is NO_VALID_SETUP", () => {
  const i=input(); i.market.quote!.bid=1.15; i.market.quote!.ask=1.1501;
  const result=generateTradePlans({...i.market,news:[],maxRiskPercent:1});
  assert.equal(interpretMarketState(i).analysisStatus,"ANALYSIS_COMPLETE");
  assert.equal(result.result,"NO_VALID_SETUP"); assert.ok(result.rejected.length);
});
await test("historical Friday context cannot become a new confirmation", () => {
  const i=input();
  const plan=generateTradePlans({...i.market,news:[],maxRiskPercent:1}).plans[0]!;
  const result=evaluateConfirmation({ plan:{...plan,stopLoss:plan.stopLoss!,takeProfit:plan.takeProfit!,createdAt:new Date(i.market.now).toISOString()},candles:i.market.candles,quote:i.market.quote,news:[],now:i.market.now,limits:{maxSpreadStopFraction:.15,maxDataAgeSeconds:10,newsBlackoutBeforeMinutes:30,newsBlackoutAfterMinutes:30} });
  assert.equal(result.outcome,"WAITING"); assert.equal(result.proposal,null);
});
await test("M5 freshness excludes the broker's daily rollover break", () => {
  assert.equal(candleHealth(at("2026-10-14T20:55:00Z"),"M5",at("2026-10-14T21:07:00Z")).missing,0);
});
await test("future completed candles cannot change proposed plans", () => {
  const i=input();
  const levels=(result:ReturnType<typeof generateTradePlans>)=>result.plans.map(p=>[p.direction,p.setupType,p.entryZoneLow,p.entryZoneHigh,p.stopLoss,p.takeProfit]);
  const before=levels(generateTradePlans({...i.market,news:[],maxRiskPercent:1}));
  i.market.candles.H1!.push({...bar(new Date(i.market.now+HOUR).toISOString()),high:3,close:2});
  i.market.candles.H4!.push({...bar(new Date(i.market.now+4*HOUR).toISOString()),high:3,close:2});
  i.market.candles.D1!.push({...bar(new Date(i.market.now+24*HOUR).toISOString()),high:3,close:2});
  assert.deepEqual(levels(generateTradePlans({...i.market,news:[],maxRiskPercent:1})),before);
});
await test("notifications distinguish failed technical evaluation from no valid setup", () => {
  assert.match(completionNotice("EUR_USD","COMPLETED",null,"TECHNICAL_DATA_UNAVAILABLE").title,/incomplete/);
  assert.match(completionNotice("EUR_USD","COMPLETED",null,"NO_VALID_SETUP").message,/No setup meets/);
});
await test("daily percentage has a stable close baseline and never negative zero", () => {
  assert.equal(dailyPriceChange(1.12297,1.12),.27);
  assert.equal(dailyPriceChange(1.122969,1.12297),0);
  assert.equal(dailyChangeLabel(dailyPriceChange(1.122969,1.12297)),"+0.00% · Daily");
  assert.equal(dailyPriceChange(1.12297,null),null);
});
await test("valid empty calendar differs from unavailable and malformed calendar", () => {
  const common={currencies:["EUR","USD"],now:at("2026-10-18T22:00:00Z")};
  assert.equal(buildCalendarSnapshot({...common,events:[]}).status,"CALENDAR_AVAILABLE_NO_EVENTS");
  assert.equal(buildCalendarSnapshot({...common,events:null}).status,"CALENDAR_UNAVAILABLE");
  assert.equal(buildCalendarSnapshot({...common,events:[{currency:"USD",timestamp:"bad",title:"CPI",impact:3} as never]}).status,"CALENDAR_VALIDATION_FAILED");
});

// Only fixture HTTP responses: never contacts OANDA or a paid model.
process.env.OANDA_ACCOUNT_ID="fixture"; process.env.OANDA_API_KEY="fixture";
const originalFetch=globalThis.fetch;
const wire=(time:string,complete=true)=>({time,complete,volume:10,mid:{o:"1.12",h:"1.13",l:"1.11",c:"1.12297"}});
try {
  await test("OANDA alignment parameters, ordering and provenance validated", async()=>{
    globalThis.fetch=async(url)=>{ const u=new URL(String(url)); assert.equal(u.searchParams.get("dailyAlignment"),"17"); assert.equal(u.searchParams.get("alignmentTimezone"),"America/New_York"); return Response.json({instrument:"EUR_USD",granularity:"H1",candles:[wire("2026-10-18T22:00:00Z",false),wire("2026-10-18T21:00:00Z")]}); };
    const r=await getCandles("EUR_USD","H1",2);
    assert.equal(r.status.state,"connected"); assert.equal(r.data.candles[0]!.complete,true); assert.equal(r.data.candles[1]!.complete,false); assert.equal(r.data.provenance?.alignmentVersion,"oanda-ny17-v1");
  });
  await test("transient API failures retry boundedly; errors never return mock candles",async()=>{
    let calls=0; globalThis.fetch=async()=>{calls++; return new Response("unavailable",{status:503});};
    const r=await getCandles("EUR_USD","H1",3); assert.equal(calls,3); assert.equal(r.status.state,"error"); assert.equal(r.data.candles.length,0);
  });
  await test("duplicate/malformed/wrong-granularity broker responses fail validation",async()=>{
    for (const patch of [{candles:[wire("bad")]},{candles:[wire("2026-10-18T21:00:00Z"),wire("2026-10-18T21:00:00Z")]},{granularity:"H4"}]) {
      globalThis.fetch=async()=>Response.json({instrument:"EUR_USD",granularity:"H1",candles:[],...patch});
      assert.equal((await getCandles("EUR_USD","H1",4)).status.state,"error");
    }
  });
  await test("concurrent candle reads share one request; next analysis refreshes",async()=>{
    let calls=0; globalThis.fetch=async()=>{calls++; await new Promise(r=>setTimeout(r,1)); return Response.json({instrument:"EUR_USD",granularity:"H1",candles:[wire("2026-10-18T21:00:00Z")]});};
    await Promise.all([getCandles("EUR_USD","H1",5),getCandles("EUR_USD","H1",5)]); assert.equal(calls,1);
    await getCandles("EUR_USD","H1",5); assert.equal(calls,2);
  });
} finally { globalThis.fetch=originalFetch; }
Date.now = originalNow;
console.log(`Candle recovery: ${passed} deterministic checks passed.`);
