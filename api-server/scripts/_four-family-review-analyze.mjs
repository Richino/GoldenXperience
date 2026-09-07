import fs from 'node:fs';
const dir='research-v2/four-family-review-20260905';
const raw=JSON.parse(fs.readFileSync(`${dir}/ledger.json`));
const families=['ema','breakout','momentum','meanrev'];
const rows=raw.rows.filter(x=>families.includes(x.strategy_family)&&x.status==='closed'&&(x.net_result_r??x.result_r)!=null).map(x=>({...x,r:Number(x.net_result_r??x.result_r),cost:x.total_cost_r==null?null:Number(x.total_cost_r),gross:x.gross_result_r==null?null:Number(x.gross_result_r),riskPips:Math.abs(Number(x.entry)-Number(x.stop))/(x.instrument.includes('JPY')?.01:.0001),day:x.opened_at.slice(0,10)}));
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
let seed=9052026;const rng=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
function stats(a){
 const win=a.filter(x=>x.r>0),loss=a.filter(x=>x.r<0);const groups=Object.values(Object.groupBy(a,x=>x.day));
 const boots=[];for(let k=0;k<3000&&groups.length;k++){let sum=0,n=0;for(let i=0;i<groups.length;i++){const g=groups[Math.floor(rng()*groups.length)];sum+=g.reduce((s,x)=>s+x.r,0);n+=g.length;}boots.push(sum/n);}boots.sort((a,b)=>a-b);
 return {n:a.length,days:groups.length,winRate:win.length/a.length,netR:a.reduce((s,x)=>s+x.r,0),expectancy:avg(a.map(x=>x.r)),dayBootstrap95:boots.length?[boots[75],boots[2925]]:null,pf:-win.reduce((s,x)=>s+x.r,0)/loss.reduce((s,x)=>s+x.r,0),avgWin:avg(win.map(x=>x.r)),avgLoss:avg(loss.map(x=>x.r)),costKnown:a.filter(x=>x.cost!==null).length,meanCost:avg(a.filter(x=>x.cost!==null).map(x=>x.cost)),meanGross:avg(a.filter(x=>x.gross!==null).map(x=>x.gross)),riskPips:avg(a.map(x=>x.riskPips)),holdHours:avg(a.map(x=>(Date.parse(x.closed_at)-Date.parse(x.opened_at))/3600000)),mfe:avg(a.filter(x=>x.max_favorable_r!=null).map(x=>Number(x.max_favorable_r))),losersReachedHalfR:loss.filter(x=>x.max_favorable_r!=null&&Number(x.max_favorable_r)>=.5).length,first:a.at(0)?.opened_at,last:a.at(-1)?.opened_at};
}
function group(key,a=rows){return Object.fromEntries(Object.entries(Object.groupBy(a,key)).map(([k,v])=>[k,stats(v)]));}
const out={queriedAt:raw.queriedAt,scope:{totalLedger:raw.rows.length,inScope:rows.length,excluded:raw.rows.length-rows.length,basisCounts:Object.fromEntries(Object.entries(Object.groupBy(rows,x=>x.result_basis??'missing')).map(([k,v])=>[k,v.length]))},all:stats(rows),family:group(x=>x.strategy_family),familyPolicy:group(x=>`${x.strategy_family}|inverted=${x.inverted}`),familyOutcome:group(x=>`${x.strategy_family}|${x.outcome}`),familySession:group(x=>`${x.strategy_family}|${x.session}`),familyRegime:group(x=>`${x.strategy_family}|${x.regime}`),familyPair:group(x=>`${x.strategy_family}|${x.instrument}`),familyWeek:group(x=>{const d=new Date(x.day);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return `${x.strategy_family}|${d.toISOString().slice(0,10)}`}),familyCost:group(x=>`${x.strategy_family}|${x.cost==null?'unknown':x.cost<=.1?'<=0.1R':'>0.1R'}`),familyRecent:group(x=>`${x.strategy_family}|${x.day>='2026-08-31'?'Aug31-Sep4':'earlier'}`),checklist:group(x=>`${x.strategy_family}|${x.checklist_score}`)};
fs.writeFileSync(`${dir}/SUMMARY.json`,JSON.stringify(out,null,2));
const integrity=JSON.parse(fs.readFileSync(`${dir}/INTEGRITY.json`)).rows.find(x=>x.kind==='risk_units').data;
const riskIndex=new Map(integrity.map(x=>[String(x.trade_sequence),x]));
const sum=a=>a.reduce((s,x)=>s+x,0);
const basisReview=Object.fromEntries(families.map(f=>{
 const a=rows.filter(x=>x.strategy_family===f),b=a.filter(x=>x.result_basis==='broker'),m=a.filter(x=>x.result_basis==='model');
 const proxy=b.map(x=>{const z=riskIndex.get(String(x.trade_sequence));return x.r*Number(z.calculated_units)/Number(z.submitted_units);});
 return [f,{n:a.length,brokerN:b.length,brokerNet:sum(b.map(x=>x.r)),brokerE:avg(b.map(x=>x.r)),modelN:m.length,modelNet:sum(m.map(x=>x.r)),modelE:avg(m.map(x=>x.r)),recordedGeometryE:avg(a.map(x=>(x.direction==='long'?Number(x.exit)-Number(x.entry):Number(x.entry)-Number(x.exit))/Math.abs(Number(x.entry)-Number(x.stop)))),brokerCapped:b.filter(x=>{const z=riskIndex.get(String(x.trade_sequence));return Number(z.submitted_units)<Number(z.calculated_units);}).length,brokerSizingAdjustedProxyE:avg(proxy),mixedSizingAdjustedProxyE:(sum(proxy)+sum(m.map(x=>x.r)))/a.length}];
}));
fs.writeFileSync(`${dir}/BASIS_REVIEW.json`,JSON.stringify(basisReview,null,2));
const pairs=JSON.parse(fs.readFileSync(`${dir}/PAIRS.json`)).rows.find(x=>x.kind==='pairs').data;
const paired=pairs.filter(x=>x.original_r!=null&&x.inverted_r!=null);
const pairStats=a=>({n:a.length,original:avg(a.map(x=>Number(x.original_r))),inverted:avg(a.map(x=>Number(x.inverted_r)))});
const pairReview={total:pairs.length,paired:pairStats(paired),bySource:Object.fromEntries(Object.entries(Object.groupBy(paired,x=>`${x.original_source}/${x.inverted_source}`)).map(([k,v])=>[k,pairStats(v)])),bySession:Object.fromEntries(Object.entries(Object.groupBy(paired,x=>x.session)).map(([k,v])=>[k,pairStats(v)]))};
fs.writeFileSync(`${dir}/PAIR_SUMMARY.json`,JSON.stringify(pairReview,null,2));
console.log(JSON.stringify({scope:out.scope,all:out.all,family:out.family,familyPolicy:out.familyPolicy,familyRecent:out.familyRecent},null,2));
