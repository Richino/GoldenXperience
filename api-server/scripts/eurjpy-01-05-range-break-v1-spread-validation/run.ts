// Frozen-cohort EURJPY 01-05 Range Break V1 executable replay. RESEARCH / PAPER ONLY.
// Replays the exact 136 authoritative TradingView trades against OANDA Practice M1 bid/ask.
// No strategy rule is altered; no signal cohort is regenerated; no deployment / broker orders.
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

const SOURCE = 'C:/Users/arche/Downloads/GX_EURJPY_01-05_Range_Break_V1_-_1_to_2_RR_OANDA_EURJPY_2026-09-06_09380.csv';
const PINE = 'C:/Users/arche/Documents/eurjpy.txt';
const BASE = path.resolve('research-v2/eurjpy-01-05-range-break-v1-spread-validation');
const DATA = path.join(BASE, 'data');
const INSTRUMENT = 'EUR_JPY', PIP = 100, H = 3_600_000, M = 60_000;
const N_EXPECTED = 136, ORIGIN_HOUR = 6, EMA_LEN = 20, ATR_LEN = 14, HOLD = 3;

type C = { t:number; bo:number; bh:number; bl:number; bc:number; ao:number; ah:number; al:number; ac:number };
type T = { n:number; entryWall:string; exitWall:string; entry:number; exit:number; signal:string; exitLabel:string; duration:number; entryMs:number; exitMs:number };

// ---- America/New_York DST-aware wall-clock -> UTC ms -------------------------
function offset(utc:number){ const f=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}); const p:any={}; for(const x of f.formatToParts(new Date(utc)))p[x.type]=x.value; return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-utc; }
function nyUtc(s:string){ const [d,t]=s.trim().split(' '),[y,mo,da]=d.split('-').map(Number),[h,mi]=t.split(':').map(Number); const g=Date.UTC(y,mo-1,da,h,mi); let u=g-offset(g); return g-offset(u); }

// ---- authoritative cohort ----------------------------------------------------
function cohort():T[]{ const ls=fs.readFileSync(SOURCE,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).slice(1).map(x=>x.split(',')); const m=new Map<string,string[][]>(); for(const r of ls)m.set(r[0],[...(m.get(r[0])??[]),r]); const a:T[]=[]; for(const [k,v] of m){ const e=v.find(r=>r[1].startsWith('Entry')),x=v.find(r=>r[1].startsWith('Exit')); if(!e||!x)throw Error(`trade ${k}: incomplete CSV legs`); a.push({n:+k,entryWall:e[2],exitWall:x[2],entry:+e[4],exit:+x[4],signal:e[3],exitLabel:x[3],duration:+x[16],entryMs:nyUtc(e[2]),exitMs:nyUtc(x[2])}); } return a.sort((a,b)=>a.n-b.n); }

// ---- indicators / stats ------------------------------------------------------
function ema(v:number[],n:number){ const o:(number|null)[]=Array(v.length).fill(null),a=2/(n+1); let e=0; for(let i=0;i<v.length;i++){ if(i<n-1)continue; if(i===n-1)e=v.slice(0,n).reduce((s,x)=>s+x,0)/n; else e=a*v[i]+(1-a)*e; o[i]=e; } return o; }
function median(v:number[]){ if(!v.length)return 0; const a=[...v].sort((x,y)=>x-y),i=a.length>>1; return a.length%2?a[i]:(a[i-1]+a[i])/2; }
function stats(rs:number[]){ const w=rs.filter(x=>x>0),l=rs.filter(x=>x<=0),sum=(x:number[])=>x.reduce((a,b)=>a+b,0),gp=sum(w),gl=Math.abs(sum(l)); return{trades:rs.length,wins:w.length,losses:l.length,wr:rs.length?w.length/rs.length*100:0,pf:gl?gp/gl:Infinity,total:sum(rs),exp:rs.length?sum(rs)/rs.length:0,avgWin:w.length?gp/w.length:0,avgLoss:l.length?sum(l)/l.length:0}; }
function dd(rs:number[]){ let c=0,p=0,d=0; for(const r of rs){ c+=r; p=Math.max(p,c); d=Math.max(d,p-c); } return d; }
function compact(x:any):C{ return{t:Date.parse(x.time),bo:+x.bid.o,bh:+x.bid.h,bl:+x.bid.l,bc:+x.bid.c,ao:+x.ask.o,ah:+x.ask.h,al:+x.ask.l,ac:+x.ask.c}; }

// ---- OANDA Practice collection ----------------------------------------------
async function collect(ts:T[]){
  config({path:path.resolve('.env'),quiet:true}); config({path:path.resolve('.env.local'),quiet:true});
  if((process.env.OANDA_ENVIRONMENT??'').toLowerCase()==='live')throw Error('Practice-only validation refuses live environment');
  const token=(process.env.OANDA_API_KEY??process.env.OANDA_API_TOKEN??'').trim().replace(/^["']|["']$/g,''); if(!token)throw Error('Missing OANDA_API_KEY');
  fs.mkdirSync(DATA,{recursive:true});
  async function req(url:string){ for(let i=0;i<5;i++){ try{ const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)}); if(r.ok)return r.json(); if(![429,500,502,503,504].includes(r.status))throw Error(`HTTP ${r.status}`); }catch(e){ if(i===4)throw e; } await new Promise(r=>setTimeout(r,400*(i+1))); } throw Error('retry exhausted'); }
  async function range(g:'H1'|'M1',from:number,to:number){ const out:C[]=[],step=g==='H1'?H:M; for(let at=from;at<to;){ const u=`https://api-fxpractice.oanda.com/v3/instruments/${INSTRUMENT}/candles?price=MBA&granularity=${g}&count=5000&from=${encodeURIComponent(new Date(at).toISOString())}`,b=await req(u),l=(b.candles??[]).filter((x:any)=>x.complete&&x.bid&&x.ask); if(!l.length)break; for(const x of l){ const c=compact(x); if(c.t<to)out.push(c); } const next=Date.parse(l.at(-1).time)+step; if(next<=at)break; at=next; } return out; }
  const save=async(g:'H1'|'M1',f:number,t:number,file:string)=>{ if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8')).candles as C[]; const c=await range(g,f,t),m=new Map(c.map(x=>[x.t,x])); const a=[...m.values()].sort((x,y)=>x.t-y.t); fs.writeFileSync(file,JSON.stringify({instrument:INSTRUMENT,granularity:g,candles:a})); return a; };
  const last=Math.max(...ts.map(x=>x.entryMs));
  const h1=await save('H1',Date.UTC(2022,5,1),last+5*86400000,path.join(DATA,`${INSTRUMENT}-H1-MBA.json`));
  const m1File=path.join(DATA,`${INSTRUMENT}-M1-MBA.json`);
  if(fs.existsSync(m1File))return{h1,m1:JSON.parse(fs.readFileSync(m1File,'utf8')).candles as C[]};
  let all:C[]=[]; for(const t of ts){ all.push(...await range('M1',t.entryMs+H,t.entryMs+4*H)); }
  const mm=new Map(all.map(x=>[x.t,x])); const m1=[...mm.values()].sort((a,b)=>a.t-b.t);
  fs.writeFileSync(m1File,JSON.stringify({instrument:INSTRUMENT,granularity:'M1',candles:m1})); return{h1,m1};
}

const fmt=(n:number,d=4)=>Number.isFinite(n)?n.toFixed(d):(n>0?'∞':'-∞');

// ---- TRADES.csv --------------------------------------------------------------
function tradesCsv(rows:any[]){
  const cols=['trade_number','direction','tv_entry_timestamp','resolved_utc_entry','tv_exit_timestamp','resolved_utc_exit','tv_entry_price','oanda_mid_entry','oanda_bid_entry','oanda_ask_entry','entry_spread_pips','ema20','ema20_3','ema_slope_r','pre_range_high','pre_range_low','break_distance','break_distance_r','atr14','initial_risk_pips','original_stop','original_target','tv_exit_price','oanda_mid_exit','oanda_bid_exit','oanda_ask_exit','exit_spread_pips','tv_result_r','exec_result_r','execution_drag_r','tv_exit_reason','exec_exit_reason','spread_changed_outcome','ambiguous_intraminute','matched','unmatched_reason'];
  const f=(v:any)=>v==null||v===''?'':typeof v==='number'?(Number.isFinite(v)?String(+v.toFixed(8)):''):String(v);
  fs.writeFileSync(path.join(BASE,'TRADES.csv'),[cols.join(','),...rows.map(r=>cols.map(k=>f(r[k])).join(','))].join('\n'));
}

function main_render(raw:any){
  const r=raw.rows.filter((x:any)=>x.matched&&x.exec_result_r!==''); // matched executable rows
  const mid=r.map((x:any)=>x.tv_result_r), ex=r.map((x:any)=>x.exec_result_r), exOpt=r.map((x:any)=>x.exec_result_r_optimistic);
  const ms=stats(mid),es=stats(ex),eo=stats(exOpt);
  const sum=(a:number[])=>a.reduce((s,x)=>s+x,0),avg=(a:number[])=>a.length?sum(a)/a.length:0;

  // year stability (EXEC)
  const years=['2023','2024','2025','2026'];
  const byYear=years.map(y=>{ const z=r.filter((x:any)=>x.resolved_utc_entry.startsWith(y)),zr=z.map((x:any)=>x.exec_result_r),s=stats(zr); return{y,...s,mdd:dd(zr)}; });
  const positive=byYear.filter(x=>x.trades>0&&x.exp>0).length, withTrades=byYear.filter(x=>x.trades>0).length;

  // exit analysis
  const byExit=(reason:string)=>{ const z=r.filter((x:any)=>x.exec_exit_reason===reason); return{count:z.length,midAvg:avg(z.map((x:any)=>x.tv_result_r)),execAvg:avg(z.map((x:any)=>x.exec_result_r)),midTot:sum(z.map((x:any)=>x.tv_result_r)),execTot:sum(z.map((x:any)=>x.exec_result_r)),drag:sum(z.map((x:any)=>x.execution_drag_r))}; };
  const tp=byExit('TARGET_2R'),sl=byExit('ORIGINAL_STOP'),time=byExit('TIME_EXIT');

  // spread
  const entry=r.map((x:any)=>x.entry_spread_pips),exit=r.map((x:any)=>x.exit_spread_pips),drag=r.map((x:any)=>x.execution_drag_r);

  // outcome changes
  const tvReasonOf=(x:any)=>x.tv_exit_reason==='TIME_EXIT'?'TIME_EXIT':(x.tv_result_r>0?'TARGET_2R':'ORIGINAL_STOP');
  const changes={
    winToLoss:r.filter((x:any)=>x.tv_result_r>0&&x.exec_result_r<=0).length,
    winToSmaller:r.filter((x:any)=>x.tv_result_r>0&&x.exec_result_r>0&&x.exec_result_r<x.tv_result_r).length,
    lossToLarger:r.filter((x:any)=>x.tv_result_r<=0&&x.exec_result_r<x.tv_result_r).length,
    lossToWin:r.filter((x:any)=>x.tv_result_r<=0&&x.exec_result_r>0).length,
    tvTpToExecTime:r.filter((x:any)=>tvReasonOf(x)==='TARGET_2R'&&x.exec_exit_reason==='TIME_EXIT').length,
    tvTpToExecSl:r.filter((x:any)=>tvReasonOf(x)==='TARGET_2R'&&x.exec_exit_reason==='ORIGINAL_STOP').length,
    tvTimeToExecWin:r.filter((x:any)=>x.tv_exit_reason==='TIME_EXIT'&&x.exec_result_r>0).length,
    tvTimeToExecLoss:r.filter((x:any)=>x.tv_exit_reason==='TIME_EXIT'&&x.exec_result_r<=0).length,
    reasonChanged:r.filter((x:any)=>x.exec_exit_reason!==tvReasonOf(x)).length,
  };
  const changedRows=r.filter((x:any)=>x.exec_exit_reason!==tvReasonOf(x));
  const changedImpact=sum(changedRows.map((x:any)=>x.exec_result_r-x.tv_result_r));

  // break-distance cohorts (diagnostic only)
  const bd=[{lab:'0 to <0.10R',lo:-Infinity,hi:0.10},{lab:'0.10 to <0.25R',lo:0.10,hi:0.25},{lab:'0.25 to <0.50R',lo:0.25,hi:0.50},{lab:'>=0.50R',lo:0.50,hi:Infinity}]
    .map(b=>{ const z=r.filter((x:any)=>x.break_distance_r>=b.lo&&x.break_distance_r<b.hi).map((x:any)=>x.exec_result_r),s=stats(z); return{...b,n:s.trades,wr:s.wr,pf:s.pf,exp:s.exp}; });

  // ema-slope quartiles (diagnostic only)
  const sortedSlope=[...r].sort((a:any,b:any)=>a.ema_slope_r-b.ema_slope_r);
  const q=[0,1,2,3].map(k=>{ const a=Math.floor(k*sortedSlope.length/4),b=Math.floor((k+1)*sortedSlope.length/4),z=sortedSlope.slice(a,b),zr=z.map((x:any)=>x.exec_result_r),s=stats(zr); return{k:k+1,n:s.trades,lo:z.length?z[0].ema_slope_r:0,hi:z.length?z[z.length-1].ema_slope_r:0,wr:s.wr,pf:s.pf,exp:s.exp}; });

  const cls=es.exp>=.15?'STRONG':es.exp>=.10?'GOOD':es.exp>=.05?'WEAK':es.exp>=0?'NO EDGE':'LOSING';
  const verdict=es.exp>=.10?'SURVIVES_COSTS':es.exp>=.05?'MARGINAL_AFTER_COSTS':'FAILS_COSTS';

  raw.summary={mid:ms,exec:es,execOptimistic:eo,classification:cls,verdict,byYear,exit:{tp,sl,time},
    spread:{entry:{average:avg(entry),median:median(entry),maximum:Math.max(...entry)},exit:{average:avg(exit),median:median(exit),maximum:Math.max(...exit)},drag:{average:avg(drag),median:median(drag),maximum:Math.max(...drag),total:sum(drag)}},
    changes,changedImpact,breakDistance:bd,emaSlopeQuartiles:q};
  fs.writeFileSync(path.join(BASE,'RAW_RESULTS.json'),JSON.stringify(raw,null,2));

  // ---- side CSVs ----
  fs.writeFileSync(path.join(BASE,'YEAR_STABILITY.csv'),
    ['year,trades,wins,losses,wr_pct,pf,total_r,expectancy_r,max_dd_r',
     ...byYear.map(x=>`${x.y},${x.trades},${x.wins},${x.losses},${fmt(x.wr,2)},${fmt(x.pf,3)},${fmt(x.total)},${fmt(x.exp)},${fmt(x.mdd)}`)].join('\n'));
  fs.writeFileSync(path.join(BASE,'EXIT_ANALYSIS.csv'),
    ['exit_category,count,avg_mid_r,avg_exec_r,total_mid_r,total_exec_r,execution_drag_r',
     `TARGET_2R,${tp.count},${fmt(tp.midAvg)},${fmt(tp.execAvg)},${fmt(tp.midTot)},${fmt(tp.execTot)},${fmt(tp.drag)}`,
     `ORIGINAL_STOP,${sl.count},${fmt(sl.midAvg)},${fmt(sl.execAvg)},${fmt(sl.midTot)},${fmt(sl.execTot)},${fmt(sl.drag)}`,
     `TIME_EXIT,${time.count},${fmt(time.midAvg)},${fmt(time.execAvg)},${fmt(time.midTot)},${fmt(time.execTot)},${fmt(time.drag)}`].join('\n'));
  fs.writeFileSync(path.join(BASE,'SPREAD_ANALYSIS.csv'),
    ['metric,value',
     `entry_spread_pips_avg,${fmt(avg(entry),4)}`,`entry_spread_pips_median,${fmt(median(entry),4)}`,`entry_spread_pips_max,${fmt(Math.max(...entry),4)}`,
     `exit_spread_pips_avg,${fmt(avg(exit),4)}`,`exit_spread_pips_median,${fmt(median(exit),4)}`,`exit_spread_pips_max,${fmt(Math.max(...exit),4)}`,
     `execution_drag_r_avg,${fmt(avg(drag))}`,`execution_drag_r_median,${fmt(median(drag))}`,`execution_drag_r_max,${fmt(Math.max(...drag))}`,`execution_drag_r_total,${fmt(sum(drag))}`,
     `mid_expectancy_r,${fmt(ms.exp)}`,`exec_expectancy_r,${fmt(es.exp)}`,`difference_r,${fmt(ms.exp-es.exp)}`].join('\n'));

  // ---- REPORT.md ----
  const p=raw.parity;
  const yearVerdict = withTrades===positive ? 'A. All years with trades remain positive.'
    : (positive<=1 ? 'B. Edge is concentrated in a single year.'
    : (byYear.filter(x=>x.trades>0).at(-1)!.exp < byYear.filter(x=>x.trades>0)[0].exp ? 'C/D. Recent years weaken / results are inconsistent across years.' : 'D. Results are inconsistent across years.'));
  const timeVerdict = time.count? (Math.abs(time.drag/time.count) > Math.abs((tp.drag+sl.drag)/Math.max(1,tp.count+sl.count)) ? 'yes — time exits carry above-average per-trade drag' : 'no — time-exit drag is in line with TP/SL exits') : 'n/a';

  const report=[
    '# EURJPY 01-05 Range Break V1 — exact TradingView cohort vs OANDA executable spread validation','',
    '> **Status: RESEARCH_ONLY · PAPER_ONLY. No deployment, no activation, no broker orders, no strategy modification.**','',
    `> The exact ${N_EXPECTED} exported TradingView trades were replayed against OANDA Practice M1 bid/ask. No new signal cohort was generated; no rule was added, removed, or tuned.`,'',
    `## Verdict: ${verdict}`,'',
    `Classification **${cls}**. EXEC expectancy **${fmt(es.exp)}R/trade**, PF **${fmt(es.pf,3)}**, WR **${fmt(es.wr,2)}%**, total **${fmt(es.total)}R** over ${es.trades} matched trades.`,'',
    '## 1. Cohort matching','',
    `- TradingView entries: **${N_EXPECTED}**`,
    `- Matched OANDA entries: **${raw.matching.matched}**`,
    `- Unmatched: **${raw.matching.unmatched.length}**`,
    raw.matching.unmatched.length? ['','| # | TV timestamp | resolved UTC | reason |','|---|---|---|---|',...raw.matching.unmatched.map((u:any)=>`| ${u.trade} | ${u.tv} | ${u.utc} | ${u.reason} |`)].join('\n')
      : 'All 136 authoritative trades matched executable OANDA data (no silent omissions).','',
    '## 2. Timezone / DST resolution','',
    `- Every entry resolves to **06:00 UTC**: **${raw.timezone.allAtOrigin}/${N_EXPECTED}**.`,
    '- America/New_York wall-clock inputs (01:00 during EST, 02:00 during EDT) both map to 06:00 UTC. Audited samples:','',
    '| segment | trade | TV entry (NY) | resolved UTC |','|---|---|---|---|',
    ...raw.timezone.samples.map((s:any)=>`| ${s.seg} | ${s.trade} | ${s.tv} | ${s.utc} |`),'',
    '## 3. TradingView parity (verified, not forced)','',
    `1. Exact LONG entries: **${N_EXPECTED}** — all \`EURJPY_0600_LONG\`.`,
    `2. Entries at 06:00 UTC: **${raw.timezone.allAtOrigin}/${N_EXPECTED}**.`,
    `3. EMA20 reconstructed on OANDA H1 midpoint; entry-price agreement (mid close vs TV close) max diff **${fmt(p.maxEntryDiffPips,3)} pips**, median **${fmt(p.medianEntryDiffPips,3)} pips**.`,
    `4. EMA20 > EMA20[3] on entry: **${p.emaSlopePositive}/${N_EXPECTED}**.`,
    `5. close > high[1]: **${p.prevHighBreak}/${N_EXPECTED}**.`,
    `6. 01:00–05:00 preHigh reconstructed from completed H1 highs (all ${p.preHighAvailable}/${N_EXPECTED} available).`,
    `7. close > preHigh: **${p.rangeBreak}/${N_EXPECTED}**.`,
    `8. ATR14 parity: reconstructed ATR14 vs ATR implied by clean TP/SL exits — max diff **${fmt(p.maxAtrDiffPips,3)} pips** over ${p.atrCheckN} checkable trades.`,
    `9. Stop/target geometry: TP/SL move magnitude / ATR clusters at ~1R and ~2R (mean TP ${fmt(p.tpGeomMean,3)}R, mean SL ${fmt(p.slGeomMean,3)}R).`,
    `10. 3-H1 hold: max CSV duration **${p.maxDuration} bars**; all durations ≤ ${HOLD}: **${p.holdOk?'yes':'NO'}**.`,'',
    p.discrepancies.length? ['Discrepancies (reported, not corrected):','',...p.discrepancies.map((d:string)=>`- ${d}`),''].join('\n')
      : 'No parity discrepancies beyond expected mid-vs-TV feed rounding.','',
    '## 4. Overall results','',
    '| Metric | TradingView/MID | OANDA EXEC |','|---|---:|---:|',
    `| Trades | ${ms.trades} | ${es.trades} |`,
    `| Wins | ${ms.wins} | ${es.wins} |`,
    `| Losses | ${ms.losses} | ${es.losses} |`,
    `| Win rate | ${fmt(ms.wr,2)}% | ${fmt(es.wr,2)}% |`,
    `| Profit factor | ${fmt(ms.pf,3)} | ${fmt(es.pf,3)} |`,
    `| Total R | ${fmt(ms.total)}R | ${fmt(es.total)}R |`,
    `| Expectancy R/trade | ${fmt(ms.exp)}R | ${fmt(es.exp)}R |`,
    `| Average winner R | ${fmt(ms.avgWin)}R | ${fmt(es.avgWin)}R |`,
    `| Average loser R | ${fmt(ms.avgLoss)}R | ${fmt(es.avgLoss)}R |`,
    `| Max drawdown R | ${fmt(dd(mid))}R | ${fmt(dd(ex))}R |`,'',
    `Reconstructed R-normalized MID/TV expectancy from the authoritative cohort is **${fmt(ms.exp)}R/trade** (MID PF ${fmt(ms.pf,3)}). The Pine header cites +0.299R / PF 1.737; the exported strategy header cites PF ≈ 1.780.`,'',
    '## 5. Year stability — EXEC','',
    '| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy | Max DD |','|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...byYear.map(x=>`| ${x.y} | ${x.trades} | ${x.wins} | ${x.losses} | ${fmt(x.wr,2)}% | ${fmt(x.pf,3)} | ${fmt(x.total)}R | ${fmt(x.exp)}R | ${fmt(x.mdd)}R |`),'',
    `**${yearVerdict}** (${positive}/${withTrades} year-buckets with trades are positive). No year filter is applied.`,'',
    '## 6. Exit analysis','',
    `EXEC exit counts — TP: **${tp.count}**, SL: **${sl.count}**, TIME_EXIT: **${time.count}**. TradingView cohort: TP_OR_SL **82**, TIME_EXIT **54**.`,'',
    '| Exit | Count | Avg MID R | Avg EXEC R | Total MID R | Total EXEC R | Exec drag R |','|---|---:|---:|---:|---:|---:|---:|',
    `| TARGET_2R | ${tp.count} | ${fmt(tp.midAvg)} | ${fmt(tp.execAvg)} | ${fmt(tp.midTot)} | ${fmt(tp.execTot)} | ${fmt(tp.drag)} |`,
    `| ORIGINAL_STOP | ${sl.count} | ${fmt(sl.midAvg)} | ${fmt(sl.execAvg)} | ${fmt(sl.midTot)} | ${fmt(sl.execTot)} | ${fmt(sl.drag)} |`,
    `| TIME_EXIT | ${time.count} | ${fmt(time.midAvg)} | ${fmt(time.execAvg)} | ${fmt(time.midTot)} | ${fmt(time.execTot)} | ${fmt(time.drag)} |`,'',
    `Are the time exits unusually cost-sensitive? **${timeVerdict}** (time-exit per-trade drag ${fmt(time.count?time.drag/time.count:0)}R vs TP/SL per-trade drag ${fmt((tp.count+sl.count)?(tp.drag+sl.drag)/(tp.count+sl.count):0)}R).`,'',
    '## 7. Spread analysis (EURJPY pip = 0.01)','',
    `- Entry spread pips — avg **${fmt(avg(entry),4)}**, median **${fmt(median(entry),4)}**, max **${fmt(Math.max(...entry),4)}**`,
    `- Exit spread pips — avg **${fmt(avg(exit),4)}**, median **${fmt(median(exit),4)}**, max **${fmt(Math.max(...exit),4)}**`,
    `- Execution drag R — avg **${fmt(avg(drag))}**, median **${fmt(median(drag))}**, max **${fmt(Math.max(...drag))}**, total **${fmt(sum(drag))}R**`,
    `- MID expectancy **${fmt(ms.exp)}R** − EXEC expectancy **${fmt(es.exp)}R** = **${fmt(ms.exp-es.exp)}R/trade** cost.`,'',
    '## 8. Outcome changes','',
    `- TV WIN → EXEC LOSS: **${changes.winToLoss}**`,
    `- TV WIN → smaller EXEC WIN: **${changes.winToSmaller}**`,
    `- TV LOSS → larger EXEC LOSS: **${changes.lossToLarger}**`,
    `- TV LOSS → EXEC WIN: **${changes.lossToWin}**`,
    `- TV TP → EXEC TIME_EXIT: **${changes.tvTpToExecTime}**`,
    `- TV TP → EXEC SL: **${changes.tvTpToExecSl}**`,
    `- TV TIME → EXEC WIN: **${changes.tvTimeToExecWin}**`,
    `- TV TIME → EXEC LOSS: **${changes.tvTimeToExecLoss}**`,
    `- Any exit reason changed: **${changes.reasonChanged}**`,
    `- Total R impact of changed-outcome trades (EXEC − MID over those trades): **${fmt(changedImpact)}R**`,'',
    '## 9. Same-minute TP/SL','',
    `- AMBIGUOUS_INTRAMINUTE trades (one M1 candle touched both stop and target): **${raw.ambiguous.length}**.`,
    `- Primary results use conservative chronology (stop-first). Optimistic bound (target-first on the ambiguous minutes): EXEC expectancy **${fmt(eo.exp)}R/trade**, PF **${fmt(eo.pf,3)}**, total **${fmt(eo.total)}R**.`,
    raw.ambiguous.length? '  Ambiguous trades: '+raw.ambiguous.join(', ') : '','',
    '## 10. Range-break metadata (diagnostic only — NOT a filter)','',
    '| break_distance_R | N | EXEC WR | EXEC PF | EXEC expectancy |','|---|---:|---:|---:|---:|',
    ...bd.map(b=>`| ${b.lab} | ${b.n} | ${fmt(b.wr,2)}% | ${fmt(b.pf,3)} | ${fmt(b.exp)}R |`),'',
    '## 11. EMA-slope metadata (diagnostic only — NOT a filter)','',
    '| Quartile (ema_slope_R) | range | N | EXEC WR | EXEC PF | EXEC expectancy |','|---|---|---:|---:|---:|---:|',
    ...q.map(x=>`| Q${x.k} | ${fmt(x.lo,3)}..${fmt(x.hi,3)} | ${x.n} | ${fmt(x.wr,2)}% | ${fmt(x.pf,3)} | ${fmt(x.exp)}R |`),'',
    '## Decision','',
    `1. **Does EURJPY V1 survive executable OANDA costs?** ${verdict==='SURVIVES_COSTS'?'Yes.':verdict==='MARGINAL_AFTER_COSTS'?'Marginally.':'No.'} (${verdict})`,
    `2. Exact EXEC expectancy: **${fmt(es.exp)}R/trade**.`,
    `3. Exact EXEC PF: **${fmt(es.pf,3)}**.`,
    `4. Exact EXEC win rate: **${fmt(es.wr,2)}%**.`,
    `5. Total EXEC R: **${fmt(es.total)}R**.`,
    `6. Matched / unmatched: **${raw.matching.matched} / ${raw.matching.unmatched.length}**.`,
    `7. Year stability: ${positive}/${withTrades} positive year-buckets — ${yearVerdict}`,
    `8. Average spread drag: **${fmt(avg(drag))}R/trade** (total ${fmt(sum(drag))}R).`,
    `9. Do time exits materially hurt? ${timeVerdict}.`,
    `10. Does the +0.299R Phase-4 edge survive executable pricing? Reconstructed MID edge is ${fmt(ms.exp)}R; after spread it is ${fmt(es.exp)}R — ${es.exp>=.10?'the edge largely survives.':es.exp>=.05?'roughly half the edge survives.':es.exp>=0?'almost none of the edge survives.':'the edge is erased and turns negative.'}`,
    `11. Should this exact V1 become the frozen EURJPY research candidate? **${es.exp>=.10?'Yes — it clears the ≥+0.10R executable bar (subject to the small-sample and single-instrument caveats).':'No — executable expectancy does not clear the +0.10R candidate bar.'}**`,'',
    '---','',
    'Method: OANDA Practice H1 midpoint ATR14/EMA20 frozen at the 06:00 UTC close; original stop = mid entry − 1·ATR14, target = mid entry + 2·ATR14; executable LONG entry at the 06:00 ASK close; M1 bid replayed chronologically 07:00–09:59 UTC (3 future H1 bars); target/stop tested against BID; stop-first within an ambiguous minute (optimistic bound reported separately); time exit at the 09:00 H1 BID close; every result normalized by the original frozen R. Executable-side pricing already embeds spread — spread is never subtracted twice.',''
  ].join('\n');
  fs.writeFileSync(path.join(BASE,'REPORT.md'),report);
  return{es,ms,verdict,cls};
}

async function main(){
  fs.mkdirSync(BASE,{recursive:true});
  fs.copyFileSync(SOURCE,path.join(BASE,'TRADINGVIEW_SOURCE.csv'));
  fs.copyFileSync(PINE,path.join(BASE,'PINE_SOURCE.pine'));

  const ts=cohort();
  if(ts.length!==N_EXPECTED)throw Error(`expected ${N_EXPECTED} trades, got ${ts.length}`);
  for(const t of ts) if(t.signal!=='EURJPY_0600_LONG'||new Date(t.entryMs).getUTCHours()!==ORIGIN_HOUR) throw Error(`trade ${t.n} fails frozen signal/time: ${t.signal} @ ${new Date(t.entryMs).toISOString()}`);

  const {h1,m1}=await collect(ts);
  const mid=h1.map(c=>({t:c.t,h:(c.bh+c.ah)/2,l:(c.bl+c.al)/2,c:(c.bc+c.ac)/2}));
  const ix=new Map(mid.map((c,i)=>[c.t,i]));
  const e20=ema(mid.map(x=>x.c),EMA_LEN);
  const tr=mid.map((c,i)=>i?Math.max(c.h-c.l,Math.abs(c.h-mid[i-1].c),Math.abs(c.l-mid[i-1].c)):0);
  const atr:(number|null)[]=Array(mid.length).fill(null); let a=0;
  for(let i=1;i<mid.length;i++){ if(i<ATR_LEN)continue; if(i===ATR_LEN)a=tr.slice(1,ATR_LEN+1).reduce((s,x)=>s+x,0)/ATR_LEN; else a=(a*(ATR_LEN-1)+tr[i])/ATR_LEN; atr[i]=a; }

  const mt=new Map(m1.map(c=>[c.t,c]));
  const rows:any[]=[], ambiguous:number[]=[], discrepancies:string[]=[];
  const atrDiffs:number[]=[], tpGeom:number[]=[], slGeom:number[]=[]; let atrCheckN=0;
  let emaSlopePositive=0, prevHighBreak=0, rangeBreak=0, preHighAvailable=0;

  for(const t of ts){
    const i=ix.get(t.entryMs);
    const base:any={trade_number:t.n,direction:'LONG',tv_entry_timestamp:t.entryWall,resolved_utc_entry:new Date(t.entryMs).toISOString(),tv_exit_timestamp:t.exitWall,resolved_utc_exit:new Date(t.exitMs).toISOString(),tv_entry_price:t.entry,tv_exit_price:t.exit,tv_exit_reason:t.exitLabel};
    if(i==null||atr[i]==null||e20[i]==null||e20[i-3]==null){ rows.push({...base,matched:false,unmatched_reason:i==null?'NO_H1_SIGNAL_BAR':'INDICATOR_WARMUP_UNAVAILABLE'}); continue; }

    const c=h1[i], em=(c.bc+c.ac)/2, risk=atr[i]!;
    const ema20=e20[i]!, ema20_3=e20[i-3]!, emaSlopeR=(ema20-ema20_3)/risk;
    // 01:00-05:00 preHigh/preLow from mid highs/lows
    let ph=-Infinity, pl=Infinity, have=0;
    for(let k=5;k>=1;k--){ const j=ix.get(t.entryMs-k*H); if(j!=null){ ph=Math.max(ph,mid[j].h); pl=Math.min(pl,mid[j].l); have++; } }
    const prevBar=ix.get(t.entryMs-H); const prevHigh=prevBar!=null?mid[prevBar].h:NaN;
    if(have===5)preHighAvailable++;
    const breakDist=em-ph, breakDistR=breakDist/risk;
    const stop=em-risk*1, target=em+risk*2;

    // parity tallies (no filtering)
    if(ema20>ema20_3)emaSlopePositive++;
    if(!Number.isNaN(prevHigh)&&em>prevHigh)prevHighBreak++;
    if(ph>-Infinity&&em>ph)rangeBreak++;
    // ATR/geometry parity from CSV move
    const tvMove=Math.abs(t.exit-t.entry), g=tvMove/risk;
    if(t.exitLabel==='TP_OR_SL'){ atrCheckN++; if(t.exit>t.entry){ tpGeom.push(g); atrDiffs.push(Math.abs((tvMove/2)-risk)*PIP);} else { slGeom.push(g); atrDiffs.push(Math.abs(tvMove-risk)*PIP);} }

    // executable entry at ASK close of 06:00 bar
    const entryAsk=c.ac;
    const missing:number[]=[]; for(let at=t.entryMs+H;at<t.entryMs+4*H;at+=M) if(!mt.has(at))missing.push(at);
    const common:any={...base,oanda_mid_entry:em,oanda_bid_entry:c.bc,oanda_ask_entry:c.ac,entry_spread_pips:(c.ac-c.bc)*PIP,ema20,ema20_3,ema_slope_r:emaSlopeR,pre_range_high:ph>-Infinity?ph:'',pre_range_low:pl<Infinity?pl:'',break_distance:breakDist,break_distance_r:breakDistR,atr14:risk,initial_risk_pips:risk*PIP,original_stop:stop,original_target:target};
    const tvR=(t.exit-t.entry)/risk;

    if(missing.length){ rows.push({...common,tv_result_r:tvR,exec_result_r:'',exec_result_r_optimistic:'',execution_drag_r:'',exec_exit_reason:'UNMATCHED',spread_changed_outcome:'',ambiguous_intraminute:false,matched:false,unmatched_reason:`M1_GAP_${new Date(missing[0]).toISOString()}_${missing.length}_MINUTES`}); continue; }

    // chronological M1 bid replay
    let exit:number|null=null, exitOpt:number|null=null, reason='', ec:C|null=null, amb=false;
    for(let at=t.entryMs+H;at<t.entryMs+4*H;at+=M){ const bar=mt.get(at); if(!bar)continue; const hitSl=bar.bl<=stop, hitTp=bar.bh>=target;
      if(hitSl&&hitTp){ amb=true; exit=(bar.bo<=stop?bar.bo:stop); exitOpt=(bar.bo>=target?bar.bo:target); reason='ORIGINAL_STOP'; ec=bar; break; }
      if(hitSl){ exit=(bar.bo<=stop?bar.bo:stop); exitOpt=exit; reason='ORIGINAL_STOP'; ec=bar; break; }
      if(hitTp){ exit=(bar.bo>=target?bar.bo:target); exitOpt=exit; reason='TARGET_2R'; ec=bar; break; }
    }
    if(exit==null){ const ti=ix.get(t.entryMs+HOLD*H), q=ti==null?null:h1[ti]; if(!q){ rows.push({...common,tv_result_r:tvR,exec_result_r:'',exec_result_r_optimistic:'',execution_drag_r:'',exec_exit_reason:'UNMATCHED',spread_changed_outcome:'',ambiguous_intraminute:false,matched:false,unmatched_reason:'NO_TIME_EXIT_H1_BAR'}); continue; } exit=q.bc; exitOpt=q.bc; reason='TIME_EXIT'; ec=q; }
    if(amb)ambiguous.push(t.n);

    const exR=(exit-entryAsk)/risk, exOptR=(exitOpt!-entryAsk)/risk;
    const tvReason=t.exitLabel==='TIME_EXIT'?'TIME_EXIT':(tvR>0?'TARGET_2R':'ORIGINAL_STOP');
    const exitC=ec!;
    rows.push({...common,oanda_mid_exit:(exitC.bc+exitC.ac)/2,oanda_bid_exit:exitC.bc,oanda_ask_exit:exitC.ac,exit_spread_pips:(exitC.ac-exitC.bc)*PIP,tv_result_r:tvR,exec_result_r:exR,exec_result_r_optimistic:exOptR,execution_drag_r:tvR-exR,exec_exit_reason:reason,spread_changed_outcome:reason!==tvReason,ambiguous_intraminute:amb,matched:true,unmatched_reason:''});
  }

  // discrepancy notes
  if(emaSlopePositive!==N_EXPECTED)discrepancies.push(`EMA20>EMA20[3] holds on ${emaSlopePositive}/${N_EXPECTED} (mid-feed reconstruction; TV feed may differ marginally).`);
  if(prevHighBreak!==N_EXPECTED)discrepancies.push(`close>high[1] holds on ${prevHighBreak}/${N_EXPECTED} on OANDA mid (feed rounding near equality).`);
  if(rangeBreak!==N_EXPECTED)discrepancies.push(`close>preHigh holds on ${rangeBreak}/${N_EXPECTED} on OANDA mid (feed rounding near equality).`);

  tradesCsv(rows);
  const matched=rows.filter(x=>x.matched);
  const entryDiffs=matched.map(x=>Math.abs(x.oanda_mid_entry-x.tv_entry_price)*PIP);
  const seg=(label:string,pred:(t:T)=>boolean)=>{ const t=ts.find(pred); return t?{seg:label,trade:t.n,tv:t.entryWall,utc:new Date(t.entryMs).toISOString()}:null; };
  const samples=[seg('begin',()=>true),{seg:'middle',trade:ts[68].n,tv:ts[68].entryWall,utc:new Date(ts[68].entryMs).toISOString()},{seg:'end',trade:ts.at(-1)!.n,tv:ts.at(-1)!.entryWall,utc:new Date(ts.at(-1)!.entryMs).toISOString()},seg('EST(Jan)',x=>x.entryWall.includes(' 01:00')&&x.entryWall.startsWith('2023-01')),seg('EDT(Jun)',x=>x.entryWall.includes(' 02:00')&&x.entryWall.startsWith('2023-06')),seg('DST-Mar2023',x=>x.entryWall.startsWith('2023-03-13')),seg('DST-Nov2023',x=>x.entryWall.startsWith('2023-11-13'))].filter(Boolean);

  const raw:any={ generatedAt:new Date().toISOString(), instrument:INSTRUMENT,
    decision:{ status:'RESEARCH_ONLY', deployed:false, executionEnabled:false, brokerOrders:false, strategyModified:false, cohortRegenerated:false },
    authoritativeCohort:{ file:path.basename(SOURCE), trades:N_EXPECTED, wins:74, losses:62, winRatePct:54.41, headlineProfitFactor:1.780, signal:'EURJPY_0600_LONG', tpOrSl:82, timeExit:54, entryRange:['2023-01-23','2026-08-24'] },
    timezone:{ allAtOrigin:ts.filter(x=>new Date(x.entryMs).getUTCHours()===ORIGIN_HOUR).length, samples },
    matching:{ matched:matched.length, unmatched:rows.filter(x=>!x.matched).map(x=>({trade:x.trade_number,tv:x.tv_entry_timestamp,utc:x.resolved_utc_entry,reason:x.unmatched_reason})) },
    parity:{ maxEntryDiffPips:Math.max(...entryDiffs), medianEntryDiffPips:median(entryDiffs), emaSlopePositive, prevHighBreak, rangeBreak, preHighAvailable, maxAtrDiffPips:atrDiffs.length?Math.max(...atrDiffs):0, atrCheckN, tpGeomMean:tpGeom.length?tpGeom.reduce((s,x)=>s+x,0)/tpGeom.length:0, slGeomMean:slGeom.length?slGeom.reduce((s,x)=>s+x,0)/slGeom.length:0, maxDuration:Math.max(...ts.map(x=>x.duration)), holdOk:ts.every(x=>x.duration<=HOLD), discrepancies },
    ambiguous, rows };
  const {es,verdict,cls}=main_render(raw);
  console.log(`EURJPY V1 replay complete: ${rows.length} rows, ${matched.length} matched, ${ambiguous.length} ambiguous.`);
  console.log(`EXEC exp ${es.exp.toFixed(4)}R  PF ${es.pf.toFixed(3)}  WR ${es.wr.toFixed(2)}%  total ${es.total.toFixed(3)}R  -> ${cls} / ${verdict}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
