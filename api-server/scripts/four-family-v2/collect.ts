import fs from 'node:fs';
import path from 'node:path';
import {config} from 'dotenv';
import {createHash} from 'node:crypto';
for(const f of ['.env','.env.local']) config({path:path.resolve(f),override:false,quiet:true});
if(process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL=process.env.DATABASE_PUBLIC_URL;
if(process.env.OANDA_ENVIRONMENT==='live') throw new Error('This review is practice-only.');
const {db}=await import('../../src/database.js');
const {getPracticeTradeState}=await import('../../../frontend/src/lib/oanda/client.js');
const dir=path.resolve('research-v2/four-family-v2-201-trades');fs.mkdirSync(`${dir}/cache`,{recursive:true});
const frozen=fs.readFileSync('research-v2/four-family-review-20260905/ledger.json');
const cohort=JSON.parse(frozen.toString()).rows.filter((x:any)=>['ema','breakout','momentum','meanrev'].includes(x.strategy_family));
if(cohort.length!==201) throw new Error('Frozen cohort changed.');
const con=await db().connect();let rows:any[];
try {await con.query('BEGIN READ ONLY');rows=(await con.query(`SELECT t.id,t.trade_sequence,t.instrument,t.direction,t.entry,t.stop,t.target,t.nominal_risk_amount,t.calculated_units,t.evaluation_id,
 i.status order_status,i.broker_trade_id,i.request_payload FROM paper_strategy_trades t LEFT JOIN practice_order_intents i ON i.paper_trade_id=t.id WHERE t.trade_sequence=ANY($1::bigint[]) ORDER BY t.trade_sequence`,[cohort.map((x:any)=>x.trade_sequence)])).rows;await con.query('ROLLBACK');}finally{con.release();await db().end();}
fs.writeFileSync(`${dir}/cohort.json`,JSON.stringify({sourceSha256:createHash('sha256').update(frozen).digest('hex'),cohort,execution:rows},null,2));
const token=(process.env.OANDA_API_KEY??process.env.OANDA_API_TOKEN??'').trim().replace(/^["']|["']$/g,'');
async function request(url:string){for(let attempt=0;attempt<4;attempt++){try{const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(25000)});if(r.ok)return await r.json();if(![429,500,502,503,504].includes(r.status))throw new Error(`HTTP ${r.status}`);}catch(e){if(attempt===3)throw e;}await new Promise(r=>setTimeout(r,250*(attempt+1)));}throw new Error('Retries exhausted');}
let completed=0;let cursor=0;
await Promise.all(Array.from({length:3},async()=>{for(;;){const index=cursor++;if(index>=rows.length)return;const row=rows[index];if(!row.broker_trade_id)continue;const file=`${dir}/cache/broker-${row.trade_sequence}.json`;if(!fs.existsSync(file)){try{const state=await getPracticeTradeState(row.broker_trade_id);fs.writeFileSync(file,JSON.stringify({queriedAt:new Date().toISOString(),sequence:row.trade_sequence,state},null,2));}catch{fs.writeFileSync(file,JSON.stringify({sequence:row.trade_sequence,state:null,error:'BROKER_STATE_UNAVAILABLE'}));}}completed++;if(completed%30===0)console.log(`Broker records ${completed}`);}}));
const instruments=[...new Set(cohort.map((x:any)=>x.instrument))] as string[];
// A day of pre-signal bars is enough for frozen range references; no indicators are refit.
for(const instrument of instruments){for(const granularity of ['M1','M15']){
const file=`${dir}/cache/${instrument}-${granularity}.json`;if(fs.existsSync(file)){console.log(`${instrument} ${granularity}: cache`);continue;}
const subset=cohort.filter((x:any)=>x.instrument===instrument);const from=Math.min(...subset.map((x:any)=>Date.parse(x.decision_time)))-3*86400000;
const until=Math.max(...subset.map((x:any)=>Date.parse(x.decision_time)))+86400000;const step=granularity==='M1'?60000:900000;
let at=from;const candles:any[]=[];
for(let page=0;at<until&&page<30;page++){const body=await request(`https://api-fxpractice.oanda.com/v3/instruments/${instrument}/candles?price=MBA&granularity=${granularity}&count=5000&from=${encodeURIComponent(new Date(at).toISOString())}`);const list=(body.candles??[]).filter((x:any)=>x.complete&&x.bid&&x.ask&&x.mid);if(!list.length)break;candles.push(...list.filter((x:any)=>Date.parse(x.time)<until));const next=Date.parse(list.at(-1).time)+step;if(next<=at)throw new Error('Non-advancing candle page');at=next;}
const unique=[...new Map(candles.map(x=>[x.time,x])).values()].sort((a:any,b:any)=>Date.parse(a.time)-Date.parse(b.time));fs.writeFileSync(file,JSON.stringify({instrument,granularity,from:new Date(from).toISOString(),until:new Date(until).toISOString(),candles:unique}));console.log(`${instrument} ${granularity}: ${unique.length} candles`);
}}
console.log('Frozen cohort, broker facts, and candle cache collected. No writes to the database.');
