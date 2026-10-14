import { config } from 'dotenv';
import fs from 'node:fs';
for (const p of ['.env', '.env.local']) config({path:p,quiet:true});
const {getResearchCandles}=await import('../../frontend/src/lib/oanda/client.js');
const {readMarketFoundation}=await import('../../frontend/src/lib/strategy/analyze-v2/foundation.js');
const dir='research-v2/analyze-pullback-distance-20261013';
const measurements=JSON.parse(fs.readFileSync(dir+'/measurements.json','utf8'));
const durations:Record<string,number>={M15:900000,H1:3600000,H4:14400000,D:86400000};
const details=[];
for(const row of measurements.rows){const mode=row.mode,primary=mode==='SWING'?'H4':'M15',higher=mode==='SWING'?'D':'H1';
 const candles:Record<string,unknown>={};
 for(const gran of [primary,higher]){const raw=await getResearchCandles(row.pair,gran,300,{to:row.createdAt});candles[gran==='D'?'D1':gran]=raw.filter(c=>c.complete&&Date.parse(c.time)+durations[gran]!<=Date.parse(row.createdAt)).map(c=>({time:c.time,...c.mid,volume:c.volume,complete:true}));}
 const f=readMarketFoundation({instrument:row.pair,mode,candles,quote:null,now:Date.parse(row.createdAt)} as never);
 const reference=row.referenceApprox,structure=f.primary?.structureLevel,long=row.direction==='long';
 const zones=f.zones.filter(z=>z.status==='ACTIVE'&&structure!==null&&structure!==undefined&&(long?z.high>=structure&&z.low<=reference:z.low<=structure&&z.high>=reference));
 const nearest=[...zones].sort((a,b)=>Math.max(a.low-reference,reference-a.high,0)-Math.max(b.low-reference,reference-b.high,0));
 details.push({...row,primaryAtr:f.primary?.atr??null,distanceToZoneAtr:f.primary?.atr?row.distanceToZonePips*(row.pair.endsWith('JPY')?.01:.0001)/f.primary.atr:null,reconstructedPullbackState:f.pullback?.state,preferredZone:f.pullback?.zone??f.pullback?.nextZone??null,fallbackFirst:zones[0]??null,nearestEligible:nearest[0]??null,candidateCount:zones.length});
}
fs.writeFileSync(dir+'/details.json',JSON.stringify(details,null,2));
console.log(JSON.stringify(details.map(x=>({pair:x.pair,mode:x.mode,at:x.createdAt,pips:x.distanceToZonePips,atr:x.distanceToZoneAtr,pullback:x.reconstructedPullbackState,candidates:x.candidateCount,first:x.fallbackFirst?.low,nearest:x.nearestEligible?.low})),null,2));
