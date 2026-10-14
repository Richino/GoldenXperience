import {config} from 'dotenv';
import pg from 'pg';
import fs from 'node:fs';
for(const file of ['.env','.env.local'])config({path:file,quiet:true});
const host=process.env.OANDA_ENVIRONMENT==='live'?'https://api-fxtrade.oanda.com':'https://api-fxpractice.oanda.com';
async function get(route){const r=await fetch(host+'/v3/'+route,{headers:{Authorization:'Bearer '+(process.env.OANDA_API_KEY||process.env.OANDA_API_TOKEN)}});if(!r.ok)throw new Error('OANDA read failed '+r.status);return r.json();}
const account=process.env.OANDA_ACCOUNT_ID;
const pricing=await get(`accounts/${account}/pricing?instruments=EUR_USD`);
const open=(await get(`accounts/${account}/openTrades`)).trades;
const openIds=new Set(open.filter(t=>t.instrument==='EUR_USD').map(t=>t.id));
const ask=+pricing.prices[0].asks[0].price;
// Preserve the original comparison window rather than silently dropping older entries.
const start='2026-09-28T20:17:27.914Z';
const pool=new pg.Pool({connectionString:process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL});
const db=await pool.connect();await db.query('BEGIN READ ONLY');
const result=await db.query("SELECT id,opened_at,closed_at,status,direction,entry,exit,paper_pl,notes FROM paper_trades WHERE replace(upper(pair),'/','_')='EUR_USD' AND direction='short' AND opened_at >= $1 AND opened_at <= $2 ORDER BY opened_at",[start,pricing.time]);
await db.query('ROLLBACK');db.release();await pool.end();
const included=[],excluded=[];
for(const t of result.rows){const id=t.notes.match(/broker trade (\d+)/)?.[1];if(t.status!=='closed'||!id||openIds.has(id)){excluded.push({openedAt:t.opened_at,status:t.status,brokerId:id,reason:'Not a verified closed short'});continue;}
const trade=(await get(`accounts/${account}/trades/${id}`)).trade;
if(trade.state!=='CLOSED'){excluded.push({brokerId:id,reason:'Broker position still open'});continue;}
const entry=+trade.price,units=Math.abs(+trade.initialUnits),profit=(entry-ask)*units;
included.push({brokerId:id,openedAt:t.opened_at,closedAt:t.closed_at,entry,units,originalPricePnl:+trade.realizedPL,currentClosingAsk:ask,pipsIfHeld:(entry-ask)*10000,pricePnlIfHeld:profit,wouldBeWinningNow:profit>0});}
const report={valuedAt:pricing.time,startInclusive:start,closingAsk:ask,closedShortCount:included.length,winnersNow:included.filter(t=>t.wouldBeWinningNow).length,totalPricePnlIfHeld:included.reduce((a,t)=>a+t.pricePnlIfHeld,0),originalRealizedPricePnl:included.reduce((a,t)=>a+t.originalPricePnl,0),included,excluded,method:'Actual OANDA broker entry prices and initial units. Hypothetically ignore every exit, stop and target and hold each closed short to the current ask. Excludes currently open EUR_USD trades confirmed by OANDA. Price P/L includes entry/exit bid-ask execution prices but excludes hypothetical financing, extra slippage and account-wide margin feasibility. Winning at valuation does not mean winning throughout the holding period.'};
const dir='research-v2/closed-eurusd-shorts-held-20261013';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/RESULTS.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
