import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { input } from "./fixtures/analysis-input.js";
import type { MarketIntelligence } from "../src/intelligence/research-contract.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import { interpretMarketState, readMarketTechnicals } from "../src/intelligence/market-state-interpreter.js";
import { marketStateView } from "../src/intelligence/market-state-store.js";
import { generateTradePlans, ANALYZE_DEPENDENCIES } from "../src/trade-plan-generator.js";
import { technicalAnalysisStatus, storedPlanResult, sameAnalysisSnapshot } from "../../frontend/src/lib/trade-plans/analysis-status.js";
import { candleAligned } from "../../frontend/src/lib/strategy/candle-clock.js";
import { researchRequestBody, researchConfig } from "../src/intelligence/openai-research.js";
import { currencyEvidenceLeads } from "../src/intelligence/research-service.js";
import { validateGeneratedPlans } from "../src/trade-plan-service.js";
const recorded = JSON.parse(readFileSync(new URL("./fixtures/oct18-oanda-analysis.json", import.meta.url), "utf8")) as {cutoff:string;timeframes:Record<"D1"|"H4"|"H1"|"M15",{candles:Candle[]}>};
const report = JSON.parse(readFileSync(new URL("./fixtures/oct18-research.json", import.meta.url), "utf8")) as MarketIntelligence;
let passed=0;
function test(name:string,fn:()=>void) { fn(); console.log(`ok ${++passed}: ${name}`); }
function original() {
  const i=input(); i.market.now=Date.parse(recorded.cutoff); i.market.quote=null;
  i.market.candles=structuredClone(Object.fromEntries(Object.entries(recorded.timeframes).map(([tf,r])=>[tf,r.candles])));
  i.market.dataSnapshot={id:"oct18-reconstructed"}; i.technical=readMarketTechnicals(i.market);
  i.intelligence=structuredClone(report); i.calendar!.readAt=report.research.cutoffAt;
  return i;
}
test("October 18 broker reconstruction: Friday D1/H4 are valid context before first Sunday H4 close",()=>{
  const i=original(), s=interpretMarketState(i);
  assert.deepEqual(i.technical.issues,[]); assert.equal(s.analysisStatus,"ANALYSIS_COMPLETE");
  assert.equal(s.source.candleClosedAt.D1,"2026-10-16T21:00:00.000Z");
  assert.equal(s.source.candleClosedAt.H4,"2026-10-16T21:00:00.000Z");
  assert.equal(s.source.candleClosedAt.H1,"2026-10-18T22:00:00.000Z");
  assert.equal(s.quality.status,"PARTIAL"); assert.deepEqual(s.quality.issues,[]);
  assert.equal(technicalAnalysisStatus(s),"ANALYSIS_COMPLETE");
  const result=generateTradePlans({...i.market,news:[],maxRiskPercent:1});
  assert.equal(result.result,"PLANS"); assert.deepEqual(new Set(result.plans.map(p=>p.direction)),new Set(["BUY","SELL"]));
  assert.ok(result.plans.every(p=>p.analysisInputs?.dataSnapshotId==="oct18-reconstructed"));
  if (process.argv.includes("--write-preview")) writeFileSync("../frontend/src/lib/trade-plans/fixtures/completed-market-state.json",JSON.stringify(s,null,2));
});
test("valid unclear H4 remains a complete read and genuinely uncertain swing",()=>{
  const i=original(); i.technical.foundation.primary!.direction="UNCLEAR";
  const s=interpretMarketState(i); assert.equal(s.analysisStatus,"ANALYSIS_COMPLETE");
  assert.equal(s.forward.swing.classification,"INDETERMINATE"); assert.match(s.forward.swing.explanation,/not missing candle/);
});
test("optional research gaps never become technical rejection reasons",()=>{
  const i=input(); i.intelligence.research.missingData=["No retail sentiment","Technical stage intentionally deferred"];
  const s=interpretMarketState(i); assert.equal(s.quality.status,"PARTIAL"); assert.deepEqual(s.quality.issues,[]);
  assert.equal(technicalAnalysisStatus(s),"ANALYSIS_COMPLETE");
  delete s.analysisStatus; assert.equal(technicalAnalysisStatus(s),"ANALYSIS_COMPLETE");
});
test("H4 missing skips swing strategies while verified H1 observations survive",()=>{
  const i=original(); delete i.market.candles.H4; i.technical=readMarketTechnicals(i.market);
  const s=interpretMarketState(i), r=generateTradePlans({...i.market,news:[],maxRiskPercent:1});
  assert.equal(s.analysisStatus,"ANALYSIS_PARTIAL"); assert.equal(s.observed.timeframe,"H1");
  assert.equal(r.result,"TECHNICAL_DATA_UNAVAILABLE"); assert.ok(r.diagnostics!.sides.every(side=>side.status==="SKIPPED"));
  assert.ok(r.diagnostics!.checks.some(c=>c.code==="MISSING_REQUIRED_H4_DATA"));
});
test("malformed timestamps cannot vanish during normalization",()=>{
  const i=original(); i.market.candles.H4!.push({...i.market.candles.H4![0]!,time:"invalid"});
  const r=generateTradePlans({...i.market,news:[],maxRiskPercent:1});
  assert.equal(r.result,"DATA_VALIDATION_FAILED");
  i.technical=readMarketTechnicals(i.market); assert.ok(i.technical.issues.some(r=>/malformed/.test(r)));
});
test("missing current H1 blocks swing plans even though Friday H4 remains current",()=>{
  const i=original(); i.market.now=Date.parse("2026-10-18T23:03:00Z");
  const r=generateTradePlans({...i.market,news:[],maxRiskPercent:1});
  assert.equal(r.result,"TECHNICAL_DATA_UNAVAILABLE"); assert.ok(r.diagnostics!.checks.some(c=>c.code==="STALE_CANDLE_DATA"));
});
test("partial research quality cannot bypass H4 freshness on read",()=>{
  const s=interpretMarketState(original()); assert.equal(s.quality.status,"PARTIAL");
  // H1 is current at this clock; a missing H4 completion must still fail.
  s.source.candleClosedAt.H1="2026-10-19T02:00:00Z"; s.observed.asOf=s.source.candleClosedAt.H1;
  const view=marketStateView(s,{fresh:true,reason:null},Date.parse("2026-10-19T02:05:00Z"));
  assert.equal(view.usable,false); assert.ok(view.reasons.some(r=>/H4/.test(r)));
});
test("quote/calendar failures affect execution rather than erasing price structure or plans",()=>{
  const i=original(); i.calendar=null; const s=interpretMarketState(i);
  assert.equal(s.analysisStatus,"ANALYSIS_COMPLETE"); assert.equal(s.reactions.length,0); assert.match(s.evidenceLimits!.join(" "),/calendar unavailable/);
  const r=generateTradePlans({...i.market,news:null,maxRiskPercent:1}); assert.equal(r.result,"PLANS");
  assert.ok(r.diagnostics!.checks.some(c=>c.category==="EXECUTION" && c.status!=="PASS"));
});
test("independent sides report qualified or disqualified with structured reasons",()=>{
  const i=input(); const r=generateTradePlans({...i.market,news:[],maxRiskPercent:1});
  for (const direction of ["BUY","SELL"] as const) {
    const d=r.diagnostics!.sides.find(s=>s.direction===direction)!;
    assert.equal(d.status,r.plans.some(p=>p.direction===direction)?"CONDITIONAL_PLAN":"NO_VALID_SETUP");
    if(d.status==="NO_VALID_SETUP") assert.ok(d.reasons.length);
  }
});
for (const [price, side] of [[1.125,"BUY"],[1.11,"SELL"]] as const) test(`${side} can qualify while the opposite side fails`,()=>{
  const i=input(); i.market.quote={bid:price,ask:price+0.0001,time:new Date(i.market.now).toISOString()};
  const r=generateTradePlans({...i.market,news:[],maxRiskPercent:1});
  assert.deepEqual(r.plans.map(p=>p.direction),[side]);
  const other=r.diagnostics!.sides.find(s=>s.direction!==side)!;
  assert.equal(other.status,"NO_VALID_SETUP"); assert.ok(other.reasons.every(r=>r.code && r.reason));
});
test("mismatched snapshot versions fail consistency check",()=>{
  assert.equal(sameAnalysisSnapshot("a","a","a"),true); assert.equal(sameAnalysisSnapshot("a","a","b"),false);
  assert.equal(sameAnalysisSnapshot("a",null,"a"),false);
});
test("invalid generated levels fail validation before eligibility is recorded or old plans can be retired",()=>{
  const i=input(),r=generateTradePlans({...i.market,news:[],maxRiskPercent:1}); assert.ok(r.plans.length);
  r.plans.forEach(p=>p.stopLoss=NaN); validateGeneratedPlans(r,new Date(i.market.now));
  assert.equal(r.result,"DATA_VALIDATION_FAILED"); assert.deepEqual(r.plans,[]);
  assert.ok(r.diagnostics!.sides.every(s=>s.status!=="CONDITIONAL_PLAN"));
  assert.ok(r.rejected.some(r=>r.code==="PLAN_VALIDATION_FAILED"));
});
test("old failed-data jobs are distinct from completed no-setup jobs",()=>{
  assert.equal(storedPlanResult("NO_VALID_SETUP","Market data is not usable: Latest H4 candle closed 2983 min ago; the feed looks stale."),"TECHNICAL_DATA_UNAVAILABLE");
  assert.equal(storedPlanResult("NO_VALID_SETUP","No setup qualified. No nearby zone."),"NO_VALID_SETUP");
});
test("declared timeframe dependencies match the installed swing strategies",()=>{
  assert.deepEqual(ANALYZE_DEPENDENCIES.swingPlans.SR_REVERSAL,["D1","H4","H1"]);
  assert.equal(ANALYZE_DEPENDENCIES.shortTermPlans,"NOT_IMPLEMENTED_IN_THIS_PIPELINE");
});
test("broker candle timestamps must match granularity and NY17 alignment",()=>{
  assert.equal(candleAligned(Date.parse("2026-10-18T21:00:00Z"),"H4"),true);
  assert.equal(candleAligned(Date.parse("2026-10-18T22:00:00Z"),"H4"),false);
  assert.equal(candleAligned(Date.parse("2026-10-18T21:15:00Z"),"H1"),false);
});
test("research prompt requests recent weekend coverage without an extra search budget",()=>{
  const i=original(); const body=researchRequestBody({instrument:"EUR_USD",currencies:["EUR","USD"],technical:{instrument:"EUR_USD",readAt:recorded.cutoff,deferredUntilResearchValidation:true,price:null,trend:{},atr:{},zones:[],plans:[]},calendar:[],calendarNote:null,researchId:i.intelligence.research.id,now:i.market.now},researchConfig({OPENAI_RESEARCH_MAX_SEARCHES:"6"}));
  assert.match(body.input,/preceding 72 hours/); assert.match(body.input,/weekend political/); assert.match(body.input,/intentionally empty/); assert.equal(body.max_tool_calls,6);
});
test("currency cache reuses cited currency evidence across pairs without treating it as current research",()=>{
  const leads=currencyEvidenceLeads([report,report],["EUR","JPY"],Date.parse(recorded.cutoff));
  assert.ok(leads.length); assert.ok(leads.every(lead=>lead.currency==="EUR" && lead.urls.length && lead.researchCutoff===report.research.cutoffAt));
  assert.equal(new Set(leads.map(l=>l.factor)).size,leads.length);
  const i=structuredClone(report); i.factors.forEach(f=>f.sourceIds=["not-in-source-registry"]);
  assert.deepEqual(currencyEvidenceLeads([i],["EUR"],Date.parse(recorded.cutoff)),[]);
});
console.log(`Analyze status: ${passed} deterministic checks passed; no provider calls.`);
