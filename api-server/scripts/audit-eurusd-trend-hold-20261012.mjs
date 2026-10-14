import {config} from 'dotenv';
import pg from 'pg';
import fs from 'node:fs';
for(const p of ['.env','.env.local']) config({path:p,quiet:true});
const pool=new pg.Pool({connectionString:process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL});
const db=await pool.connect();
await db.query('BEGIN READ ONLY');
const cols=await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('paper_trades','paper_trade_events','practice_order_intents','manual_practice_order_intents') ORDER BY table_name,ordinal_position");
const trades=await db.query("SELECT * FROM paper_trades WHERE replace(upper(pair),'/','_')='EUR_USD' AND opened_at >= '2026-09-28T04:00:00Z' ORDER BY opened_at");
const events=await db.query('SELECT * FROM paper_trade_events WHERE paper_trade_id=ANY($1::uuid[]) ORDER BY occurred_at',[trades.rows.map(t=>t.id)]);
fs.mkdirSync('research-v2/eurusd-trend-hold-20261012',{recursive:true});
fs.writeFileSync('research-v2/eurusd-trend-hold-20261012/source.json',JSON.stringify({trades:trades.rows,events:events.rows},null,2));
await db.query('ROLLBACK');db.release();await pool.end();
const token=process.env.OANDA_API_KEY||process.env.OANDA_API_TOKEN;
const host=process.env.OANDA_ENVIRONMENT==='live'?'https://api-fxtrade.oanda.com':'https://api-fxpractice.oanda.com';
async function get(route){const r=await fetch(host+'/v3/'+route,{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw new Error('OANDA '+r.status+' '+(await r.text()).slice(0,200));return r.json();}
const acct=process.env.OANDA_ACCOUNT_ID;
const out='research-v2/eurusd-trend-hold-20261012/';
const summary=await get(`accounts/${acct}/summary`);
const pricing=await get(`accounts/${acct}/pricing?instruments=EUR_USD`);
const broker=[];for(const t of trades.rows){const id=t.notes.match(/broker trade (\d+)/)?.[1];broker.push(id?(await get(`accounts/${acct}/trades/${id}`)).trade:null);}
const end=pricing.time;
async function candles(gran,from,to){const found=[];let cursor=from;while(Date.parse(cursor)<Date.parse(to)){const chunkEnd=new Date(Math.min(Date.parse(to),Date.parse(cursor)+(gran==='M1'?4000*60000:4000*14400000))).toISOString();const j=await get(`instruments/EUR_USD/candles?granularity=${gran}&price=MBA&from=${encodeURIComponent(cursor)}&to=${encodeURIComponent(chunkEnd)}`);found.push(...j.candles.filter(c=>c.complete));cursor=chunkEnd;}return [...new Map(found.map(c=>[c.time,c])).values()];}
const h4=await candles('H4','2026-08-01T00:00:00Z',end);
const m1=await candles('M1','2026-09-28T04:00:00Z',end);
fs.writeFileSync(out+'market.json',JSON.stringify({summary:summary.account,pricing,broker,h4,m1},null,2));
console.log(JSON.stringify({trades:trades.rows.length,end,m1:m1.length,h4:h4.length,account:{balance:summary.account.balance,NAV:summary.account.NAV,marginRate:summary.account.marginRate,hedgingEnabled:summary.account.hedgingEnabled},broker:broker.map(t=>({id:t?.id,initialUnits:t?.initialUnits,realizedPL:t?.realizedPL,financing:t?.financing,state:t?.state}))},null,2));
