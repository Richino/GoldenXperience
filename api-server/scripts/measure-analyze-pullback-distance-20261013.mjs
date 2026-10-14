import {config} from 'dotenv';import fs from 'node:fs';
for(const p of ['.env','.env.local'])config({path:p,quiet:true});
const dir='research-v2/analyze-pullback-distance-20261013',source=JSON.parse(fs.readFileSync(dir+'/source.json'));
const host=process.env.OANDA_ENVIRONMENT==='live'?'https://api-fxtrade.oanda.com':'https://api-fxpractice.oanda.com';
async function get(route){const r=await fetch(host+'/v3/'+route,{headers:{Authorization:'Bearer '+(process.env.OANDA_API_KEY||process.env.OANDA_API_TOKEN)}});if(!r.ok)throw new Error('OANDA '+r.status);return r.json();}
const pricing=await get('accounts/'+process.env.OANDA_ACCOUNT_ID+'/pricing?instruments=EUR_USD');const now=Date.parse(pricing.time);
const seen=new Set();const selected=source.plans.filter(x=>{const p=x.plan;if(p.entry===null||!p.pullback?.zone||!p.direction)return false;const key=x.instrument+'/'+p.mode+'/'+p.direction+'/'+p.entry;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,12);
const rows=[];
for(const x of selected){const p=x.plan,pip=x.instrument.endsWith('JPY')?.01:.0001,start=Date.parse(p.createdAt),expiry=Date.parse(p.expiresAt),end=Math.min(now,expiry);
 const before=(await get(`instruments/${x.instrument}/candles?price=MBA&granularity=M1&count=3&to=${encodeURIComponent(p.createdAt)}`)).candles.filter(c=>c.complete).at(-1);if(!before)continue;
 const reference=+(p.direction==='long'?before.ask.c:before.bid.c),bars=[];
 let cursor=start;while(cursor<end){const upto=Math.min(end,cursor+3000*60000);const j=await get(`instruments/${x.instrument}/candles?price=MBA&granularity=M1&from=${encodeURIComponent(new Date(cursor).toISOString())}&to=${encodeURIComponent(new Date(upto).toISOString())}`);bars.push(...j.candles.filter(c=>c.complete&&Date.parse(c.time)>=start));cursor=upto;}
 const zone=p.pullback.zone,hit=bars.find(c=>{const q=p.direction==='long'?c.ask:c.bid;return +q.h>=zone.low&&+q.l<=zone.high;});
 const nearest=Math.max(zone.low-reference,reference-zone.high,0)/pip;
 const bestPullback=bars.length?(p.direction==='long'?reference-Math.min(...bars.map(c=>+c.ask.l)):Math.max(...bars.map(c=>+c.bid.h))-reference)/pip:null;
 const away=bars.length?(p.direction==='long'?Math.max(...bars.map(c=>+c.ask.h))-reference:reference-Math.min(...bars.map(c=>+c.bid.l)))/pip:null;
 rows.push({pair:x.instrument,mode:p.mode,direction:p.direction,createdAt:p.createdAt,status:p.status,referenceApprox:reference,entry:p.entry,pullbackZone:zone,entryDistancePips:Math.abs(reference-p.entry)/pip,distanceToZonePips:nearest,maxRetraceTowardZonePips:bestPullback,maxTrendContinuationPips:away,zoneTouchedByCandle:!!hit,touchedAt:hit?.time??null,observedTouchRecorded:p.pullback.touchedAt,fullNaturalLifetimeElapsed:expiry<=now,observationHours:(end-start)/3600000,monitorTerminalReason:p.reason,notes:'Subsequent market path to natural expiry, even when monitoring was stopped/replaced early. M1 overlap is a possible touch, not proof of an observed quote, confirmation or executable fill. Creation price approximated by previous complete M1 close.'});
}
fs.writeFileSync(dir+'/measurements.json',JSON.stringify({valuedAt:pricing.time,rows},null,2));console.log(JSON.stringify({valuedAt:pricing.time,rows},null,2));
