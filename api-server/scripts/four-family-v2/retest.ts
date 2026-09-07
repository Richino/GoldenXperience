import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {measureBrokerExecution} from '../../src/execution-measurement.js';
import {confirmEntryV2,replayEntryPlan,type EntryBar,type ExecutableMinute,type ReplayPlan,type ReplayResult} from '../../src/four-family-entry-v2.js';
import {classifyRegime} from '../../../frontend/src/lib/strategy/regime.js';
import {dayTradingSession} from '../../../frontend/src/lib/strategy/strategy-engine.js';
import {MAX_SPREAD_PIPS} from '../../../frontend/src/lib/strategy/strategy-common.js';

const dir=path.resolve('research-v2/four-family-v2-201-trades');
const source=JSON.parse(fs.readFileSync(`${dir}/cohort.json`,'utf8'));
const cohort:any[]=source.cohort;
if(cohort.length!==201)throw new Error('Expected the frozen 201 trades');
const executions=new Map<string,any>(source.execution.map((x:any)=>[String(x.trade_sequence),x]));
const familyNames=['ema','breakout','momentum','meanrev'];
const minutes=new Map<string,ExecutableMinute[]>(),m15=new Map<string,EntryBar[]>();
const hash=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputHashes:Record<string,string>={protocol:hash(`${dir}/PROTOCOL.md`),correction:hash(`${dir}/REPLAY_CORRECTION.md`),cohort:hash(`${dir}/cohort.json`),entryCode:hash('src/four-family-entry-v2.ts'),measurementCode:hash('src/execution-measurement.ts'),runner:hash('scripts/four-family-v2/retest.ts')};
const brokerHashes:string[]=[];
for(const instrument of new Set(cohort.map(x=>x.instrument))){
 for(const granularity of ['M1','M15']){
  const file=`${dir}/cache/${instrument}-${granularity}.json`;inputHashes[`${instrument}-${granularity}`]=hash(file);
  const raw=JSON.parse(fs.readFileSync(file,'utf8')).candles;
  if(granularity==='M1')minutes.set(instrument,raw.map((c:any)=>({time:Date.parse(c.time),bo:+c.bid.o,bh:+c.bid.h,bl:+c.bid.l,bc:+c.bid.c,ao:+c.ask.o,ah:+c.ask.h,al:+c.ask.l,ac:+c.ask.c})));
  else m15.set(instrument,raw.map((c:any)=>({time:Date.parse(c.time)+900000,open:+c.mid.o,high:+c.mid.h,low:+c.mid.l,close:+c.mid.c})));
 }
}
function forcedAt(ms:number){
 const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',timeZoneName:'longOffset'}).formatToParts(new Date(ms));
 const val=(name:string)=>p.find(x=>x.type===name)!.value;
 const offset=val('timeZoneName').replace('GMT','');
 return Date.parse(`${val('year')}-${val('month')}-${val('day')}T16:45:00${offset}`);
}
const noEntry=(status:string,reason:string)=>({status,reason,r:status==='wait'?0:null,entry:null,exit:null,exitTime:null});
const records:any[]=[];
for(const t of cohort){
 const seq=String(t.trade_sequence),e=executions.get(seq)!;
 const brokerFile=`${dir}/cache/broker-${seq}.json`;
 if(fs.existsSync(brokerFile))brokerHashes.push(`${seq}:${hash(brokerFile)}`);
 const broker=fs.existsSync(brokerFile)?JSON.parse(fs.readFileSync(brokerFile,'utf8')).state:null;
 const measurement=measureBrokerExecution({instrument:t.instrument,direction:t.direction,signalEntry:Number(t.entry),stop:Number(t.stop),requestedUnits:Number(e.calculated_units),nominalRiskAmount:Number(e.nominal_risk_amount),inverted:t.inverted},broker);
 const at=Date.parse(t.decision_time),end=forcedAt(at),pip=t.instrument.includes('JPY')?.01:.0001;
 const available=minutes.get(t.instrument)!;
 const actualEntryTime=broker?.openTime?Date.parse(broker.openTime):at;
 const original:ReplayPlan={time:actualEntryTime,entryTiming:'within_minute',direction:t.direction,entry:measurement?.entry??+t.entry,stop:measurement?.initialStop??+t.stop,target:+t.target,forcedAt:end,pip,slippagePips:.1};
 const control=replayEntryPlan(original,available);
 const controlStress=replayEntryPlan({...original,slippagePips:.5},available);
 const history=m15.get(t.instrument)!;
 const signalIndex=history.findIndex(b=>b.time===at);
 const preceding=history.slice(Math.max(0,signalIndex-20),signalIndex);
 const future=history.slice(signalIndex+1,signalIndex+5);
 let decision:any=noEntry('data_incomplete','Missing signal history'),candidate:any=decision,candidateStress:any=decision,plan:ReplayPlan|null=null;
 if(signalIndex>=20&&preceding.length===20){
  const contiguous=preceding.every((b,i)=>b.time===at-(20-i)*900000);
  if(contiguous){
   const opp={family:t.strategy_family,time:at,direction:t.direction,rawDirection:t.original_direction??t.direction,entry:+t.entry,stop:+t.stop,target:+t.target,signal:history[signalIndex]!,rangeHigh:Math.max(...preceding.map(b=>b.high)),rangeLow:Math.min(...preceding.map(b=>b.low)),breakoutLevel:t.features.breakout?.level??null};
   decision=confirmEntryV2(opp,future);
   candidate=noEntry(decision.status==='invalidated'?'wait':decision.status,decision.reason??'');candidateStress=candidate;
   if(decision.status==='confirmed'){
    const q=available.find(b=>b.time===decision.time);
    if(!q){candidate=noEntry('data_incomplete','Missing executable entry minute');}
    else if(decision.time>=end||!dayTradingSession(new Date(decision.time)).open){candidate=noEntry('wait','Confirmation outside entry session');}
    else if((q.ao-q.bo)/pip>(MAX_SPREAD_PIPS[t.instrument]??1.5)+1e-9){candidate=noEntry('wait','Spread ceiling');}
    else {
     const direction=decision.direction,sign=direction==='long'?1:-1;
     const entry=sign===1?q.ao:q.bo;
     let stop=+t.stop,target=+t.target;
     if(t.strategy_family==='momentum'){
      const risk=Math.abs(+t.entry- +t.stop);
      stop=entry-sign*risk;target=entry+sign*risk*Number(t.planned_r);
     }
     const risk=sign*(entry-stop),reward=sign*(target-entry);
     const originalRR=Math.abs(+t.target- +t.entry)/Math.abs(+t.entry- +t.stop);
     let reject:string|null=null;
     if(!(risk>0)||!(reward>0))reject='Invalid delayed geometry';
     else if(t.strategy_family!=='momentum'&&reward/risk+1e-9<originalRR)reject='Delayed reward/risk below frozen V1';
     if(t.strategy_family==='meanrev'){
      const asOf=history.filter(b=>b.time<=decision.time).slice(-250).map(b=>({...b,time:new Date(b.time-900000).toISOString(),volume:0,complete:true}));
      const regime=classifyRegime(t.instrument,asOf,new Date(decision.time).toISOString());
      if(regime.regime==='trending'||regime.trendStrength>.4)reject='Mean reversion no longer non-trending';
      if(reward/risk<1)reject='Less than 1R to original mean';
     }
     // Check executable stop invalidation and completeness before delayed entry.
     let expected=at;
     for(const b of available){if(b.time<at)continue;if(b.time>=decision.time)break;if(b.time!==expected){reject='DATA_INCOMPLETE_BEFORE_ENTRY';break;}expected+=60000;
      if(t.strategy_family!=='momentum'&&(t.direction==='long'?b.bl<=+t.stop:b.ah>=+t.stop)){reject='Original executable stop reached while waiting';break;}}
     if(reject)candidate=noEntry(reject.startsWith('DATA_INCOMPLETE')?'data_incomplete':'wait',reject);
     else {plan={time:decision.time,direction,entry,stop,target,forcedAt:end,pip,slippagePips:.1};candidate=replayEntryPlan(plan,available);candidateStress=replayEntryPlan({...plan,slippagePips:.5},available);}
    }
    if(!plan)candidateStress=candidate;
   }
  }
 }
 const normalized=measurement?.priceResultR??(e.broker_trade_id?null:Number(t.result_r));
 records.push({sequence:seq,family:t.strategy_family,instrument:t.instrument,time:t.decision_time,day:t.decision_time.slice(0,10),inverted:t.inverted,storedR:Number(t.result_r),storedBasis:t.result_basis,measurement,normalizedR:normalized,normalizationSource:measurement?'broker_fill':e.broker_trade_id?'unavailable':'model',original,control,controlStress,decision,candidate,candidateStress,plan});
}
function summarize(items:any[],arm:string){
 const known=items.filter(x=>x[arm]?.status==='resolved'||x[arm]?.status==='wait');
 const executed=items.filter(x=>x[arm]?.status==='resolved');
 const values=known.map(x=>Number(x[arm].r)),returns=executed.map(x=>Number(x[arm].r));
 const sum=(v:number[])=>v.reduce((s,x)=>s+x,0),mean=(v:number[])=>v.length?sum(v)/v.length:null;
 const wins=returns.filter(x=>x>0),losses=returns.filter(x=>x<0);
 let equity=0,peak=0,dd=0;for(const x of [...executed].sort((a,b)=>(a[arm].exitTime??0)-(b[arm].exitTime??0))){equity+=x[arm].r;peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity);}
 const reasons:Record<string,number>={};for(const x of items){const reason=String(x[arm].reason);reasons[reason]=(reasons[reason]??0)+1;}
 return {opportunities:items.length,resolved:executed.length,wait:known.length-executed.length,missing:items.length-known.length,coverage:executed.length/items.length,totalR:sum(returns),perExecutedR:mean(returns),perKnownOpportunityR:mean(values),winRate:executed.length?wins.length/executed.length:null,profitFactor:losses.length?sum(wins)/-sum(losses):null,maxDrawdownR:dd,ambiguous:executed.filter(x=>x[arm].ambiguous).length,reasons};
}
// Process each arm's actual entry event in time order. Missing exits block to session close.
for(const arm of ['control','candidate']){
 const busy=new Map<string,number>();
 const events=[...records].sort((a,b)=> (arm==='control'?a.original.time:a.plan?.time??Infinity)-(arm==='control'?b.original.time:b.plan?.time??Infinity)||Number(a.sequence)-Number(b.sequence));
 for(const row of events){
  const p=arm==='control'?row.original:row.plan;
  if(!p){row[`${arm}Portfolio`]=row[arm];continue;}
  if((busy.get(row.instrument)??-Infinity)>p.time){row[`${arm}Portfolio`]=noEntry('wait','One open position per instrument');continue;}
  row[`${arm}Portfolio`]=row[arm];busy.set(row.instrument,row[arm].exitTime??p.forcedAt);
 }
}
const pairStats=(items:any[])=>{
 const matched=items.filter(x=>x.control.status==='resolved'&&['resolved','wait'].includes(x.candidate.status));
 return {n:matched.length,controlR:matched.reduce((s,x)=>s+x.control.r,0),candidateR:matched.reduce((s,x)=>s+x.candidate.r,0),deltaPerOpportunity:matched.length?matched.reduce((s,x)=>s+x.candidate.r-x.control.r,0)/matched.length:null};
};
const families=Object.fromEntries(familyNames.map(f=>{const a=records.filter(x=>x.family===f);return [f,{storedTotal:a.reduce((s,x)=>s+x.storedR,0),normalizedTotal:a.reduce((s,x)=>s+(x.normalizedR??0),0),normalizedN:a.filter(x=>x.normalizedR!==null).length,brokerN:a.filter(x=>x.measurement).length,brokerTotal:a.reduce((s,x)=>s+(x.measurement?.priceResultR??0),0),control:summarize(a,'control'),candidate:summarize(a,'candidate'),controlStress:summarize(a,'controlStress'),candidateStress:summarize(a,'candidateStress'),matched:pairStats(a)}];}));
inputHashes.brokerManifest=createHash('sha256').update(brokerHashes.sort().join('\n')).digest('hex');
const summary={generatedAt:new Date().toISOString(),scope:{n:records.length,sourceSha256:source.sourceSha256,brokerRecovered:records.filter(x=>x.measurement).length,modelClosesReconciled:records.filter(x=>x.measurement&&x.storedBasis==='model').length,normalizedBasis:'broker fill price / actual initial price risk; remaining no-broker models retain price-risk R',validation:'Same inspected opportunities. Not OOS. V2 not activated.'},inputHashes,families,overall:{control:summarize(records,'control'),candidate:summarize(records,'candidate'),controlStress:summarize(records,'controlStress'),candidateStress:summarize(records,'candidateStress'),matched:pairStats(records),controlPortfolio:summarize(records,'controlPortfolio'),candidatePortfolio:summarize(records,'candidatePortfolio')},chronology:Object.fromEntries(['earlier','Aug31-Sep4'].map(period=>{const a=records.filter(x=>(x.day>='2026-08-31')===(period==='Aug31-Sep4'));return [period,{control:summarize(a,'control'),candidate:summarize(a,'candidate'),matched:pairStats(a)}];})),momentumPolicies:Object.fromEntries(['momentum-retest-continuation-v2','momentum-failed-break-v2'].map(policy=>[policy,summarize(records.filter(x=>x.decision.policy===policy),'candidate')]))};
fs.writeFileSync(`${dir}/RESULTS.json`,JSON.stringify({summary,records},null,2));
fs.writeFileSync(`${dir}/SUMMARY.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify({scope:summary.scope,families:Object.fromEntries(Object.entries(families).map(([f,s]:[string,any])=>[f,{normalizedN:s.normalizedN,normalizedTotal:s.normalizedTotal,control:s.control,candidate:s.candidate,matched:s.matched}])),overall:summary.overall},null,2));
