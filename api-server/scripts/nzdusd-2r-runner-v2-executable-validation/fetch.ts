// Fetch extended OANDA Practice M1 bid/ask (entry .. entry+48h) for the 27 NZDUSD runner candidates. Read-only market data; no orders.
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

const INSTRUMENT = 'NZD_USD', H = 3_600_000, M = 60_000, PIP = 10_000;
const BASE = path.resolve('research-v2/nzdusd-2r-runner-v2-executable-validation');
const DATA = path.join(BASE, 'data');
const RAW = path.resolve('research-v2/nzdusd-bull-consensus-structure-v1-spread-validation/RAW_RESULTS.json');
type Candle = { t:number; bo:number; bh:number; bl:number; bc:number; ao:number; ah:number; al:number; ac:number };
const compact = (x:any):Candle => ({ t:Date.parse(x.time), bo:+x.bid.o, bh:+x.bid.h, bl:+x.bid.l, bc:+x.bid.c, ao:+x.ask.o, ah:+x.ask.h, al:+x.ask.l, ac:+x.ask.c });

async function main(){
  config({ path: path.resolve('.env'), quiet:true });
  config({ path: path.resolve('.env.local'), quiet:true });
  if((process.env.OANDA_ENVIRONMENT??'').toLowerCase()==='live') throw Error('Practice-only validation refuses a live OANDA environment');
  const token=(process.env.OANDA_API_KEY??process.env.OANDA_API_TOKEN??'').trim().replace(/^["']|["']$/g,'');
  if(!token) throw Error('Missing OANDA_API_KEY / OANDA_API_TOKEN');
  fs.mkdirSync(DATA,{recursive:true});

  const raw=JSON.parse(fs.readFileSync(RAW,'utf8'));
  const candidates=raw.rows.filter((r:any)=>r.matched && r.exec_exit_reason==='TARGET_2R');
  console.log('runner candidates (baseline TARGET_2R):', candidates.length);

  async function request(url:string){let last:any;for(let a=0;a<6;a++){try{const res=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30_000)});if(res.ok)return res.json();last=Error(`HTTP ${res.status}`);if(![429,500,502,503,504].includes(res.status))throw last;}catch(e){last=e;}await new Promise(r=>setTimeout(r,600*(a+1)));}throw last;}
  async function range(from:number,to:number){const out:Candle[]=[];for(let at=from;at<to;){const url=`https://api-fxpractice.oanda.com/v3/instruments/${INSTRUMENT}/candles?price=MBA&granularity=M1&count=5000&from=${encodeURIComponent(new Date(at).toISOString())}`;const body=await request(url);const batch=(body.candles??[]).filter((x:any)=>x.complete&&x.bid&&x.ask).map(compact).filter((c:Candle)=>c.t<to);if(!batch.length)break;out.push(...batch);const next=batch.at(-1)!.t+M;if(next<=at)break;at=next;}return out;}

  const file=path.join(DATA,`${INSTRUMENT}-M1-MBA-48H.json`);
  let existing:Candle[]=[];
  if(fs.existsSync(file)) existing=JSON.parse(fs.readFileSync(file,'utf8')).candles;
  const map=new Map(existing.map(c=>[c.t,c]));
  for(const c of candidates){
    const entryMs=Date.parse(c.resolved_utc_entry);
    const from=entryMs, to=entryMs+48*H;
    // skip if already fully covered by non-weekend expectation? just refetch missing head/tail cheaply: fetch whole window if we have < ~50% of an initial probe
    const have=[...map.keys()].filter(t=>t>=from&&t<to).length;
    if(have>500){ console.log(`trade ${c.trade_number}: already ${have} M1 in window, skip`); continue; }
    process.stdout.write(`trade ${c.trade_number} ${c.resolved_utc_entry} fetching 48h... `);
    const got=await range(from,to);
    for(const cc of got) map.set(cc.t,cc);
    console.log(`+${got.length}`);
  }
  const merged=[...map.values()].sort((a,b)=>a.t-b.t);
  fs.writeFileSync(file,JSON.stringify({instrument:INSTRUMENT,granularity:'M1',price:'MBA',window:'entry..entry+48h',candles:merged}));
  console.log('saved',merged.length,'M1 candles ->',file);
}
main();
