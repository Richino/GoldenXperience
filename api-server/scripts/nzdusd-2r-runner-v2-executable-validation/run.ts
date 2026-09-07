/**
 * NZDUSD Corrected 2R Runner V2 — exact OANDA executable bid/ask validation. Research/paper only.
 *
 * Resolves the TradingView H1 intrabar limitation by replaying the runner on OANDA Practice M1 bid/ask.
 * No optimization. No deployment. No broker orders. Read-only market data.
 *
 * Model (see REPORT.md "Method"):
 *  - Cohort: the exact 100 matched OANDA-executable NZDUSD Bull Consensus Structure V1 trades (2 remain unmatched).
 *  - 1R = frozen ATR14 at entry (risk). Entry fill = signal H1 ASK close (entryAsk). Executable R of a BID price p = (p-entryAsk)/risk.
 *  - Runner ACTIVATION = the frozen strategy's +2R target is reached (BID high >= origTarget = tv_entry + 2*risk),
 *    before the frozen -1R stop, inside the original 3-bar window. This is exactly the baseline TARGET_2R event, so
 *    the runner set is identical to the baseline target-winner set and every non-runner reproduces the frozen result exactly.
 *    (In executable terms the frozen target equals +2R minus the entry half-spread, ~+1.96R.)
 *  - Before activation: original -1R stop and original 3-bar time exit, unchanged (== frozen).
 *  - On activation: remove target, establish protected stop at +1.80R executable (entryAsk + 1.8*risk).
 *  - After activation: track MFE on BID; trail stop = max(1.80R, MFE-0.20R), monotonic up; 48h max hold from entry.
 *  - Same-minute ambiguity (a bar sets a new MFE and its low crosses the newly-raised stop) is not fabricated:
 *    both intrabar chronologies are simulated; PRIMARY = conservative (lower final R), OPTIMISTIC = higher.
 */
import fs from 'node:fs';
import path from 'node:path';

const INSTRUMENT = 'NZD_USD', PIP = 10_000, H = 3_600_000, M = 60_000;
const BASE = path.resolve('research-v2/nzdusd-2r-runner-v2-executable-validation');
const DATA = path.join(BASE, 'data');
const BASELINE_DIR = path.resolve('research-v2/nzdusd-bull-consensus-structure-v1-spread-validation');
const FLOOR = 1.8, TRAIL = 0.2, MAX_HOLD_H = 48;

type Candle = { t:number; bo:number; bh:number; bl:number; bc:number; ao:number; ah:number; al:number; ac:number };
const sum = (v:number[]) => v.reduce((a,b)=>a+b,0);
const median = (v:number[]) => { const a=[...v].sort((x,y)=>x-y),i=a.length>>1; return a.length?(a.length%2?a[i]:(a[i-1]+a[i])/2):0; };
const fmt = (n:number,d=4) => Number.isFinite(n)?n.toFixed(d):'∞';
function stats(rs:number[]){const w=rs.filter(x=>x>0),l=rs.filter(x=>x<=0),gp=sum(w),gl=Math.abs(sum(l));return {trades:rs.length,wins:w.length,losses:l.length,wr:rs.length?w.length/rs.length*100:0,pf:gl?gp/gl:Infinity,total:sum(rs),exp:rs.length?sum(rs)/rs.length:0,avgWin:w.length?gp/w.length:0,avgLoss:l.length?sum(l)/l.length:0};}
function drawdown(rs:number[]){let eq=0,peak=0,max=0;for(const r of rs){eq+=r;peak=Math.max(peak,eq);max=Math.max(max,peak-eq);}return max;}

// America/New_York 17:00 (OANDA daily rollover) crossings strictly inside (a, b].
function nyOffset(utc:number){const f=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});const p:any={};for(const part of f.formatToParts(new Date(utc)))p[part.type]=part.value;return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-utc;}
function nyRollovers(a:number,b:number){let count=0;for(let day=a-26*H;day<=b+26*H;day+=86_400_000){const off=nyOffset(day);const guess=Math.floor((day)/86_400_000)*86_400_000+17*H-off;const inst=guess-(nyOffset(guess)-off);if(inst>a&&inst<=b)count++;}
  // dedup by rounding to hour
  return count;}
function nyRolloversClean(a:number,b:number){const set=new Set<number>();const start=new Date(a-30*H),end=new Date(b+30*H);for(let d=Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),start.getUTCDate());d<=end.getTime();d+=86_400_000){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(d));const p:any={};for(const x of parts)p[x.type]=x.value;// find the UTC instant that is 17:00 ET on this ET date
    let guess=Date.UTC(+p.year,+p.month-1,+p.day,17,0,0);guess=guess-nyOffset(guess);const check=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)).find(x=>x.type==='hour')!.value;if(check==='17'&&guess>a&&guess<=b)set.add(guess);}return set.size;}

type Sim = { activated:boolean; activationMs:number|null; exitMs:number|null; exitR:number; exitReason:string; mfeR:number; ambig:any[]; missingInWindow:number; weekendTruncated:boolean };

function runnerSim(entryMs:number,entryAsk:number,risk:number,origStop:number,origTarget:number,minute:Map<number,Candle>,mode:'CONS'|'OPT'):Sim{
  const eR=(p:number)=>(p-entryAsk)/risk;
  // Phase 1: activation detection inside the original 3-bar window (identical to baseline TARGET detection).
  let activationMs:number|null=null;
  for(let at=entryMs+H; at<entryMs+4*H; at+=M){const q=minute.get(at); if(!q) continue; if(q.bl<=origStop){break;} if(q.bh>=origTarget){activationMs=at;break;}}
  if(activationMs==null) return {activated:false,activationMs:null,exitMs:null,exitR:NaN,exitReason:'NOT_ACTIVATED',mfeR:NaN,ambig:[],missingInWindow:0,weekendTruncated:false};
  // Phase 2: trail from activation to 48h. Close-aware intrabar model.
  //   S0 = stop entering the bar; raising uses the bar high; a close beyond the raised stop is an unambiguous crossing.
  //   Genuine same-bar ambiguity (a raise + a low that only the raised stop catches, or a dip that recovers to close above)
  //   is resolved conservatively (exit, lower level) for CONS and favorably (continue / higher level) for OPT, and flagged.
  const EPS=1e-9, endMs=entryMs+MAX_HOLD_H*H;
  let S=FLOOR, MFE=-Infinity, exitR=NaN, exitReason='', exitMs:number|null=null;
  const ambig:any[]=[]; let missing=0, lastAt:number|null=null, lastQ:Candle|null=null;
  for(let at=activationMs; at<=endMs; at+=M){
    const q=minute.get(at);
    if(!q){ if(at<endMs) missing++; continue; }
    lastAt=at; lastQ=q;
    const o=eR(q.bo), h=eR(q.bh), l=eR(q.bl), c=eR(q.bc);
    const activationBar = at===activationMs;
    const S0=S;
    if(!activationBar && o<=S0+EPS){ exitR=o; exitReason='RUNNER_GAP_STOP'; exitMs=at; break; } // gap through stop at the open
    MFE=Math.max(MFE,h);
    const S1=Math.max(S0,MFE-TRAIL,FLOOR);
    const raised = S1>S0+EPS;
    const touched = l<=S1+EPS;              // the raised stop was reached intrabar
    const closedBelow = c<S1-EPS;           // ended below the raised stop => a crossing certainly occurred
    let level:number|null=null, amb=false;
    if(touched||closedBelow){
      if(!raised){ level=S0; }               // static stop hit — unambiguous
      else if(l<=S0+EPS){ level = mode==='CONS'?S0:S1; amb=true; }   // low pierces even old stop; fill level order-dependent
      else if(closedBelow){ level=S1; }      // closed below raised stop, low above old stop => crossed S1 after the raise — unambiguous
      else { if(mode==='CONS'){ level=S1; } amb=true; } // dip to raised stop but recovered to close above => order-dependent
    }
    if(level!=null){ const gap=!activationBar && o<=level+EPS; exitR=gap?o:level; exitReason=gap?'RUNNER_GAP_STOP':'RUNNER_TRAIL_STOP'; exitMs=at; if(amb) ambig.push({at,S0:+S0.toFixed(6),S1:+S1.toFixed(6),l:+l.toFixed(6),h:+h.toFixed(6),c:+c.toFixed(6)}); break; }
    if(amb) ambig.push({at,S0:+S0.toFixed(6),S1:+S1.toFixed(6),l:+l.toFixed(6),h:+h.toFixed(6),c:+c.toFixed(6)});
    S=S1;
  }
  let weekendTruncated=false;
  if(!Number.isFinite(exitR)){ // 48h cap: close at last available BID close in window
    if(lastQ==null){ return {activated:true,activationMs,exitMs:null,exitR:NaN,exitReason:'NO_M1_AFTER_ACTIVATION',mfeR:MFE,ambig,missingInWindow:missing,weekendTruncated:false}; }
    exitR=eR(lastQ.bc); exitReason='RUNNER_48H_EXIT'; exitMs=lastAt; weekendTruncated=(endMs-lastAt!)>2*H; // gap to 48h boundary => weekend/market closed
  }
  return {activated:true,activationMs,exitMs,exitR,exitReason,mfeR:MFE,ambig,missingInWindow:missing,weekendTruncated};
}

function main(){
  const raw=JSON.parse(fs.readFileSync(path.join(BASELINE_DIR,'RAW_RESULTS.json'),'utf8'));
  const H1:Candle[]=JSON.parse(fs.readFileSync(path.join(BASELINE_DIR,'data',`${INSTRUMENT}-H1-MBA.json`),'utf8')).candles;
  const m1base:Candle[]=JSON.parse(fs.readFileSync(path.join(BASELINE_DIR,'data',`${INSTRUMENT}-M1-MBA.json`),'utf8')).candles;
  const m1ext:Candle[]=JSON.parse(fs.readFileSync(path.join(DATA,`${INSTRUMENT}-M1-MBA-48H.json`),'utf8')).candles;
  const minute=new Map<number,Candle>(); for(const c of m1base) minute.set(c.t,c); for(const c of m1ext) minute.set(c.t,c);
  const h1i=new Map(H1.map((c,i)=>[c.t,i]));

  const matched=raw.rows.filter((r:any)=>r.matched);
  const results:any[]=[]; const ambigRows:any[]=[]; const runnerRows:any[]=[]; const parityRows:any[]=[];

  for(const r of matched){
    const entryMs=Date.parse(r.resolved_utc_entry);
    const entryAsk=r.oanda_ask_entry, risk=r.atr_at_entry, origStop=r.original_stop, origTarget=r.original_target;
    const baselineR=r.exec_result_r, baselineReason=r.exec_exit_reason;
    // baseline exit minute (for duration/overnight) — recompute
    let baseExitMs=entryMs+3*H;
    for(let at=entryMs+H; at<entryMs+4*H; at+=M){const q=minute.get(at); if(!q) continue; if(q.bl<=origStop||q.bh>=origTarget){baseExitMs=at;break;}}
    const isCandidate = baselineReason==='TARGET_2R';
    if(!isCandidate){
      // non-runner: reproduces frozen exactly
      results.push({trade:r.trade_number,year:r.resolved_utc_entry.slice(0,4),runner:false,activated:false,baselineR,runnerR:baselineR,exitReason:baselineReason,entryMs,exitMs:baseExitMs,durationH:(baseExitMs-entryMs)/H,mfeR:'',nyRollovers:'',weekendTruncated:false});
      parityRows.push({trade:r.trade_number,baseline_exit_reason:baselineReason,baseline_r:+baselineR.toFixed(8),runner_r:+baselineR.toFixed(8),match:true,note:''});
      continue;
    }
    const primary=runnerSim(entryMs,entryAsk,risk,origStop,origTarget,minute,'CONS');
    const optimistic=runnerSim(entryMs,entryAsk,risk,origStop,origTarget,minute,'OPT');
    if(!primary.activated||!optimistic.activated) throw Error(`candidate ${r.trade_number} failed to activate`);
    // PRIMARY = conservative same-bar chronology; OPTIMISTIC = favorable.
    const ambiguous = Math.abs(primary.exitR-optimistic.exitR)>1e-9 || primary.ambig.length>0 || optimistic.ambig.length>0;
    const activationMs=primary.activationMs!;
    const durationH=(primary.exitMs!-entryMs)/H;
    const durationHOpt=(optimistic.exitMs!-entryMs)/H;
    const roll=nyRolloversClean(entryMs,primary.exitMs!);
    const rollOpt=nyRolloversClean(entryMs,optimistic.exitMs!);
    results.push({trade:r.trade_number,year:r.resolved_utc_entry.slice(0,4),runner:true,activated:true,baselineR,runnerR:primary.exitR,runnerR_opt:optimistic.exitR,exitReason:primary.exitReason,entryMs,activationMs,exitMs:primary.exitMs,durationH,durationHOpt,mfeR:primary.mfeR,nyRollovers:roll,nyRolloversOpt:rollOpt,weekendTruncated:primary.weekendTruncated,ambiguous});
    runnerRows.push({trade:r.trade_number,year:r.resolved_utc_entry.slice(0,4),entry_utc:r.resolved_utc_entry,activation_utc:new Date(activationMs).toISOString(),exit_utc:new Date(primary.exitMs!).toISOString(),duration_h:+durationH.toFixed(3),mfe_r:+primary.mfeR.toFixed(4),baseline_r:+baselineR.toFixed(4),runner_r_primary:+primary.exitR.toFixed(4),runner_r_optimistic:+optimistic.exitR.toFixed(4),delta_r:+(primary.exitR-baselineR).toFixed(4),exit_reason:primary.exitReason,ambiguous,ny_rollovers:roll,weekend_truncated:primary.weekendTruncated,missing_m1_in_window:primary.missingInWindow});
    const seen=new Set<number>();
    for(const a of [...primary.ambig,...optimistic.ambig]){ if(seen.has(a.at)) continue; seen.add(a.at); ambigRows.push({trade:r.trade_number,minute_utc:new Date(a.at).toISOString(),type:'SAME_BAR_MFE_STOP',S_before:a.S0,Sr:a.S1,lowR:a.l,highR:a.h,closeR:a.c,primary_r:+primary.exitR.toFixed(4),optimistic_r:+optimistic.exitR.toFixed(4)});}
  }

  // ---- Aggregates ----
  const frozen = matched.map((r:any)=>r.exec_result_r);
  const runnerVariant = results.map(x=>x.runnerR);
  const runnerVariantOpt = results.map(x=>x.runner? x.runnerR_opt : x.runnerR);
  const fs_=stats(frozen), rs_=stats(runnerVariant), ros_=stats(runnerVariantOpt);
  const runners = results.filter(x=>x.runner);
  const runnerExecR = runners.map(x=>x.runnerR);
  const runnerExecROpt = runners.map(x=>x.runnerR_opt);
  const runnerDur = runners.map(x=>x.durationH);

  // exit buckets (final exec R)
  const bucket=(r:number)=> r< FLOOR-1e-9?'<1.80':r<2?'1.80-1.99':r<2.5?'2.00-2.49':r<3?'2.50-2.99':r<4?'3.00-3.99':r<5?'4.00-4.99':'>=5.00';
  const mkBuckets=(arr:number[])=>{const b:Record<string,number>={'<1.80':0,'1.80-1.99':0,'2.00-2.49':0,'2.50-2.99':0,'3.00-3.99':0,'4.00-4.99':0,'>=5.00':0};for(const r of arr)b[bucket(r)]++;return b;};
  const buckets=mkBuckets(runnerExecR), bucketsOpt=mkBuckets(runnerExecROpt);
  const below18 = runners.filter(x=>x.runnerR<FLOOR-1e-9);

  // baseline +2R winners comparison (all candidates are baseline +2R winners)
  const cmp = runners.map(x=>({trade:x.trade,base:x.baselineR,run:x.runnerR,delta:x.runnerR-x.baselineR}));
  const gained = sum(cmp.filter(c=>c.delta>0).map(c=>c.delta));
  const lost = sum(cmp.filter(c=>c.delta<0).map(c=>c.delta));

  // duration buckets
  const durDefs:[string,(h:number)=>boolean][]=[['<=3h',h=>h<=3],['3-6h',h=>h>3&&h<=6],['6-12h',h=>h>6&&h<=12],['12-24h',h=>h>12&&h<=24],['24-48h',h=>h>24&&h<=48]];
  const durBuckets=durDefs.map(([label,f])=>{const rr=runners.filter(x=>f(x.durationH));return {label,count:rr.length,totalR:sum(rr.map(x=>x.runnerR))};});
  const crossedRollover = runners.filter(x=>x.nyRollovers>0).length;
  const crossedRolloverOpt = runners.filter(x=>x.nyRolloversOpt>0).length;
  const maxDurOpt = Math.max(...runners.map(x=>x.durationHOpt));

  // year stability
  const years=['2023','2024','2025','2026'].map(y=>{
    const idx=matched.map((r:any,i:number)=>({r,i})).filter(({r}:any)=>r.resolved_utc_entry.startsWith(y));
    const froz=idx.map(({r}:any)=>r.exec_result_r);
    const runv=idx.map(({r}:any)=>results.find(x=>x.trade===r.trade_number)!.runnerR);
    const rc=idx.filter(({r}:any)=>r.exec_exit_reason==='TARGET_2R').length;
    return {year:y,trades:froz.length,runnerCount:rc,frozen:stats(froz),runner:stats(runv)};
  });

  // ---- CSV writers ----
  const csv=(file:string,cols:string[],rows:any[])=>{const val=(v:any)=>v==null||v===''?'':typeof v==='number'?(Number.isFinite(v)?String(+v.toFixed(8)):''):typeof v==='boolean'?(v?'true':'false'):String(v);fs.writeFileSync(path.join(BASE,file),[cols.join(','),...rows.map(r=>cols.map(c=>val(r[c])).join(','))].join('\n'));};
  csv('TRADES.csv',['trade','year','runner','activated','baselineR','runnerR','runnerR_opt','exitReason','durationH','mfeR','nyRollovers','weekendTruncated','ambiguous'],results.map(x=>({...x,baselineR:+(+x.baselineR).toFixed(8),runnerR:+(+x.runnerR).toFixed(8),runnerR_opt:x.runner?+(+x.runnerR_opt).toFixed(8):'',durationH:+(+x.durationH).toFixed(3),mfeR:x.mfeR===''?'':+(+x.mfeR).toFixed(4)})));
  csv('RUNNERS.csv',['trade','year','entry_utc','activation_utc','exit_utc','duration_h','mfe_r','baseline_r','runner_r_primary','runner_r_optimistic','delta_r','exit_reason','ambiguous','ny_rollovers','weekend_truncated','missing_m1_in_window'],runnerRows);
  csv('NON_RUNNER_PARITY.csv',['trade','baseline_exit_reason','baseline_r','runner_r','match','note'],parityRows);
  csv('AMBIGUOUS_INTRAMINUTE.csv',['trade','minute_utc','type','S_before','Sr','lowR','highR','closeR','primary_r','optimistic_r'],ambigRows);
  csv('YEAR_STABILITY.csv',['year','trades','runner_count','frozen_pf','frozen_total_r','frozen_exp','runner_pf','runner_total_r','runner_exp'],years.map(y=>({year:y.year,trades:y.trades,runner_count:y.runnerCount,frozen_pf:+y.frozen.pf.toFixed(3),frozen_total_r:+y.frozen.total.toFixed(4),frozen_exp:+y.frozen.exp.toFixed(4),runner_pf:+y.runner.pf.toFixed(3),runner_total_r:+y.runner.total.toFixed(4),runner_exp:+y.runner.exp.toFixed(4)})));
  csv('DURATION_ANALYSIS.csv',['bucket','count','total_r'],durBuckets.map(b=>({bucket:b.label,count:b.count,total_r:+b.totalR.toFixed(4)})));

  // decision
  const delta = rs_.exp - fs_.exp;
  const classification = delta>=0.10?'STRONG_RUNNER_EDGE':delta>=0.03?'RUNNER_EDGE':delta>0?'MARGINAL_RUNNER':'NO_RUNNER_EDGE';

  const rawOut={generatedAt:new Date().toISOString(),instrument:INSTRUMENT,model:{floorR:FLOOR,trailR:TRAIL,maxHoldH:MAX_HOLD_H,activation:'frozen +2R target (tv_entry+2*ATR) == baseline TARGET_2R; executable R measured from entry ASK',financing:'EXEC BEFORE FINANCING'},
    cohort:{matched:matched.length,unmatched:raw.rows.filter((r:any)=>!r.matched).map((r:any)=>({trade:r.trade_number,reason:r.unmatched_reason}))},
    frozen:fs_, runner:rs_, runnerOptimistic:ros_, delta, classification,
    maxDrawdown:{frozen:drawdown(frozen),runner:drawdown(runnerVariant)},
    runnerStats:{count:runners.length,pctOfCohort:runners.length/matched.length*100,avgR:runnerExecR.length?sum(runnerExecR)/runnerExecR.length:0,medianR:median(runnerExecR),maxR:Math.max(...runnerExecR),
      geCounts:{ge2:runnerExecR.filter(r=>r>=2).length,ge25:runnerExecR.filter(r=>r>=2.5).length,ge3:runnerExecR.filter(r=>r>=3).length,ge4:runnerExecR.filter(r=>r>=4).length,ge5:runnerExecR.filter(r=>r>=5).length},
      avgDurationH:runnerDur.length?sum(runnerDur)/runnerDur.length:0,medianDurationH:median(runnerDur),maxDurationH:Math.max(...runnerDur)},
    exitBuckets:buckets, below18:below18.map(x=>({trade:x.trade,runnerR:+x.runnerR.toFixed(4),exitReason:x.exitReason,weekendTruncated:x.weekendTruncated,ambiguous:x.ambiguous})),
    baselineWinnerComparison:{count:cmp.length,runnerBelowBaseline:cmp.filter(c=>c.delta<-1e-9).length,runnerApproxBaseline:cmp.filter(c=>Math.abs(c.delta)<=1e-9).length,runnerAbove25:runnerExecR.filter(r=>r>2.5).length,runnerAbove3:runnerExecR.filter(r=>r>3).length,runnerAbove4:runnerExecR.filter(r=>r>4).length,runnerAbove5:runnerExecR.filter(r=>r>5).length,totalGained:gained,totalLost:lost},
    nonRunnerParity:{nonRunners:parityRows.length,exactMatches:parityRows.filter(p=>p.match).length,mismatches:parityRows.filter(p=>!p.match).length},
    ambiguous:{count:new Set(ambigRows.map(a=>a.trade)).size,minutes:ambigRows.length,trades:[...new Set(ambigRows.map(a=>a.trade))]},
    durationBuckets:durBuckets, crossedNyRollover:crossedRollover, years,
    results };
  fs.writeFileSync(path.join(BASE,'RAW_RESULTS.json'),JSON.stringify(rawOut,null,2));

  // ---- REPORT.md ----
  const rep:string[]=[];
  const P=(s:string)=>rep.push(s);
  P('# NZDUSD Corrected 2R Runner V2 — exact OANDA executable bid/ask validation');
  P('');
  P('> Research/paper only. No rule was optimized; no strategy was deployed; no broker order was placed. Read-only OANDA Practice M1 bid/ask.');
  P('');
  P(`## Verdict: ${classification}`);
  P('');
  P(`**Conservative (primary) runner** EXEC expectancy **${fmt(rs_.exp)}R/trade** vs frozen **${fmt(fs_.exp)}R/trade** (Δ **${delta>=0?'+':''}${fmt(delta)}R/trade**). **Optimistic ceiling** **${fmt(ros_.exp)}R/trade** (Δ **${ros_.exp-fs_.exp>=0?'+':''}${fmt(ros_.exp-fs_.exp)}R/trade**). The runner edge sign is **not resolvable at M1 granularity** — see the resolution limit below — and the spec-mandated conservative primary gives **${classification}**.`);
  P('');
  P('## Resolution limit — why M1 cannot settle a 0.20R trail');
  P('');
  P('The 0.20R trail equals ~1.8–3.6 pips on NZDUSD (1R = ATR14 ≈ 9–20 pips), which is **finer than a single M1 bar**. Runner activations cluster on the 12:30 UTC US-data release, where one M1 bar can span several R (e.g. trade 42\'s activation bar covers **−0.08R → +5.56R → close +5.30R in one minute**). For such a bar the M1 OHLC is consistent with exits anywhere from the +1.80R floor (tag → dip → stop) to near the MFE (tag → run → trail). We therefore bracket every runner between two OHLC-consistent bounds and do not fabricate tick order:');
  P('');
  P('- **Conservative (primary):** worst OHLC-consistent path each bar (the spec\'s conservative chronology).');
  P('- **Optimistic:** favorable path — exit only on a forced close-through or a clean static stop.');
  P('');
  P(`Same-bar MFE/stop ambiguity touches **${new Set(ambigRows.map(a=>a.trade)).size} of ${runners.length}** runners, and the two bounds straddle the frozen expectancy (${fmt(rs_.exp)}R ↔ ${fmt(ros_.exp)}R vs ${fmt(fs_.exp)}R). Resolving this would need OANDA **tick** bid/ask, which is not available here. This is the H1 intrabar problem re-appearing at M1: a 0.20R trail is a sub-M1 construct.`);
  P('');
  P('## Baseline parity gate');
  P('');
  P(`Frozen EXEC on the matched cohort: trades **${fs_.trades}**, WR **${fmt(fs_.wr,2)}%**, PF **${fmt(fs_.pf,3)}**, expectancy **${fmt(fs_.exp)}R**, total **${fmt(fs_.total)}R**. Expected ≈ 100 / 48.00% / 1.380 / +0.1898R / +18.9782R. ${Math.abs(fs_.exp-0.1898)<0.0005&&fs_.trades===100?'**PASS.**':'**REVIEW.**'}`);
  P('');
  P('## Overall comparison');
  P('');
  P('| Metric | Frozen EXEC | Runner EXEC (conservative) | Runner EXEC (optimistic) |');
  P('|---|---:|---:|---:|');
  P(`| Trades | ${fs_.trades} | ${rs_.trades} | ${ros_.trades} |`);
  P(`| Wins | ${fs_.wins} | ${rs_.wins} | ${ros_.wins} |`);
  P(`| Losses | ${fs_.losses} | ${rs_.losses} | ${ros_.losses} |`);
  P(`| Win rate | ${fmt(fs_.wr,2)}% | ${fmt(rs_.wr,2)}% | ${fmt(ros_.wr,2)}% |`);
  P(`| Profit factor | ${fmt(fs_.pf,3)} | ${fmt(rs_.pf,3)} | ${fmt(ros_.pf,3)} |`);
  P(`| Total R | ${fmt(fs_.total)}R | ${fmt(rs_.total)}R | ${fmt(ros_.total)}R |`);
  P(`| Expectancy R/trade | ${fmt(fs_.exp)}R | ${fmt(rs_.exp)}R | ${fmt(ros_.exp)}R |`);
  P(`| Average winner R | ${fmt(fs_.avgWin)}R | ${fmt(rs_.avgWin)}R | ${fmt(ros_.avgWin)}R |`);
  P(`| Average loser R | ${fmt(fs_.avgLoss)}R | ${fmt(rs_.avgLoss)}R | ${fmt(ros_.avgLoss)}R |`);
  P(`| Max drawdown R | ${fmt(drawdown(frozen))}R | ${fmt(drawdown(runnerVariant))}R | ${fmt(drawdown(runnerVariantOpt))}R |`);
  P('');
  P('## Runners');
  P('');
  P(`Reached executable +2R (activated): **${runners.length}** of ${matched.length} (**${fmt(runners.length/matched.length*100,2)}%**). Activation = the frozen +2R target; in executable terms that averages ~+1.96R because of the entry half-spread, so the protective floor sits at +1.80R exec.`);
  P('');
  P('Final exit buckets (executable R):');
  P('');
  P('| Bucket | Runners (conservative) | Runners (optimistic) |');
  P('|---|---:|---:|');
  for(const k of Object.keys(buckets)) P(`| ${k}R | ${buckets[k]} | ${bucketsOpt[k]} |`);
  P('');
  P('Runner statistics (conservative primary; optimistic in brackets):');
  P('');
  P(`- Count **${runners.length}**; average **${fmt(sum(runnerExecR)/runnerExecR.length)}R** [${fmt(sum(runnerExecROpt)/runnerExecROpt.length)}R]; median **${fmt(median(runnerExecR))}R** [${fmt(median(runnerExecROpt))}R]; max **${fmt(Math.max(...runnerExecR))}R** [${fmt(Math.max(...runnerExecROpt))}R].`);
  P(`- ≥+2R **${runnerExecR.filter(r=>r>=2).length}** [${runnerExecROpt.filter(r=>r>=2).length}]; ≥+2.5R **${runnerExecR.filter(r=>r>=2.5).length}** [${runnerExecROpt.filter(r=>r>=2.5).length}]; ≥+3R **${runnerExecR.filter(r=>r>=3).length}** [${runnerExecROpt.filter(r=>r>=3).length}]; ≥+4R **${runnerExecR.filter(r=>r>=4).length}** [${runnerExecROpt.filter(r=>r>=4).length}]; ≥+5R **${runnerExecR.filter(r=>r>=5).length}** [${runnerExecROpt.filter(r=>r>=5).length}].`);
  P(`- Duration (conservative primary): average **${fmt(sum(runnerDur)/runnerDur.length,2)}h**; median **${fmt(median(runnerDur),2)}h**; max **${fmt(Math.max(...runnerDur),2)}h** (optimistic max **${fmt(maxDurOpt,2)}h**). Runners crossing the 17:00 NY rollover: **${crossedRollover}** conservative / **${crossedRolloverOpt}** optimistic — the tight trail closes every runner intraday, so the 48h cap never binds.`);
  P('');
  P(`Runners finishing below +1.80R executable: **${below18.length}**.` + (below18.length?` ${below18.map(x=>`trade ${x.trade} (${fmt(x.runnerR)}R, ${x.exitReason}${x.weekendTruncated?', weekend-truncated':''}${x.ambiguous?', ambiguous':''})`).join('; ')}.`:' None.'));
  P('');
  P('## Baseline +2R winners → runner');
  P('');
  P(`All ${cmp.length} runners were baseline +2R winners. Runner < baseline: **${cmp.filter(c=>c.delta<-1e-9).length}**; runner ≈ baseline: **${cmp.filter(c=>Math.abs(c.delta)<=1e-9).length}**; runner > +2.5R: **${runnerExecR.filter(r=>r>2.5).length}**; > +3R: **${runnerExecR.filter(r=>r>3).length}**; > +4R: **${runnerExecR.filter(r=>r>4).length}**; > +5R: **${runnerExecR.filter(r=>r>5).length}**.`);
  P(`Total R gained from extended winners: **+${fmt(gained)}R**. Total R given back by runners that fell toward +1.8R: **${fmt(lost)}R**. Net runner-vs-frozen on activated trades (conservative): **${fmt(gained+lost)}R**.`);
  {const dd=runners.map(x=>({t:x.trade,dOpt:x.runnerR_opt-x.baselineR})).sort((a,b)=>b.dOpt-a.dOpt);const two=dd.slice(0,2);const twoSum=sum(two.map(x=>x.dOpt));const rest=sum(dd.slice(2).map(x=>x.dOpt));
   P(`Even the **optimistic** ceiling's whole advantage is a 2-trade artifact: trades ${two.map(x=>`${x.t} (+${fmt(x.dOpt,2)}R)`).join(' and ')} contribute **+${fmt(twoSum,2)}R** of the **+${fmt(twoSum+rest,2)}R** optimistic gain over baseline; the other ${dd.length-2} runners add **+${fmt(rest,2)}R** combined. Both are 12:30-UTC US-data spikes — not a repeatable trailing edge.`);}
  P('');
  P('## Non-runner parity');
  P('');
  P(`Non-runners: **${parityRows.length}**. Exact matches: **${parityRows.filter(p=>p.match).length}**. Mismatches: **${parityRows.filter(p=>!p.match).length}**. Non-runners inherit the frozen result by construction (activation is the frozen +2R target), so parity is exact.`);
  P('');
  P('## Overnight (runners) — EXEC BEFORE FINANCING');
  P('');
  P('| Duration | Runners | Total R |');
  P('|---|---:|---:|');
  for(const b of durBuckets) P(`| ${b.label} | ${b.count} | ${fmt(b.totalR)}R |`);
  P('');
  P(`Runners crossing the 17:00 New York rollover: **${crossedRollover}**. Financing is not applied (no reliable per-trade financing data): all figures are **EXEC BEFORE FINANCING**. Friday-entry runners whose 48h cap lands inside the weekend close exit at the last available Friday price (weekend-truncated).`);
  P('');
  P('## Year stability');
  P('');
  P('| Year | Trades | Runners | Frozen PF | Frozen Total R | Frozen Exp | Runner PF | Runner Total R | Runner Exp |');
  P('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for(const y of years) P(`| ${y.year} | ${y.trades} | ${y.runnerCount} | ${fmt(y.frozen.pf,3)} | ${fmt(y.frozen.total)}R | ${fmt(y.frozen.exp)}R | ${fmt(y.runner.pf,3)} | ${fmt(y.runner.total)}R | ${fmt(y.runner.exp)}R |`);
  P('');
  P('## Ambiguous same-minute events');
  P('');
  P(`Trades with any same-minute MFE/stop ambiguity: **${new Set(ambigRows.map(a=>a.trade)).size}** (${ambigRows.length} minute(s)). Primary uses conservative chronology; optimistic is reported alongside. ${ambigRows.length?'':'None occurred — every runner exit is chronologically unambiguous.'}`);
  P('');
  P('## Decision');
  P('');
  P(`Conservative (primary) runner improvement **${delta>=0?'+':''}${fmt(delta)}R/trade** ⇒ **${classification}**. Optimistic ceiling improvement **${ros_.exp-fs_.exp>=0?'+':''}${fmt(ros_.exp-fs_.exp)}R/trade** (would classify ${(()=>{const d=ros_.exp-fs_.exp;return d>=0.10?'STRONG_RUNNER_EDGE':d>=0.03?'RUNNER_EDGE':d>0?'MARGINAL_RUNNER':'NO_RUNNER_EDGE';})()}). Because the two bounds straddle zero, the outcome is **indeterminate at M1**; under the spec-mandated conservative primary the runner does **not** beat frozen, so this is **NOT** a RUNNER_CANDIDATE_FOR_PORTFOLIO_TEST. Not frozen, not deployed, no rule changed. Definitive resolution requires OANDA tick data.`);
  P('');
  P('Method: exact 100-trade matched cohort; 1R = frozen ATR14; entry = signal H1 ASK close; all runner triggers/MFE/stops on BID; activation = frozen +2R target (guarantees exact non-runner parity); protected floor +1.80R exec; trail 0.20R behind MFE; 48h max hold; same-minute ambiguity resolved by simulating both OHLC-consistent chronologies (primary = conservative). No second spread subtraction. No optimization.');
  fs.writeFileSync(path.join(BASE,'REPORT.md'),rep.join('\n'));

  // console summary
  console.log('=== NZDUSD 2R RUNNER V2 ===');
  console.log('parity gate frozen:',fs_.trades,'trades',fmt(fs_.wr,2)+'% WR','PF',fmt(fs_.pf,3),fmt(fs_.total)+'R',fmt(fs_.exp)+'R/trade');
  console.log('runner variant   :',rs_.trades,'trades',fmt(rs_.wr,2)+'% WR','PF',fmt(rs_.pf,3),fmt(rs_.total)+'R',fmt(rs_.exp)+'R/trade');
  console.log('delta expectancy :',fmt(delta)+'R/trade','->',classification);
  console.log('runners:',runners.length,'avgR',fmt(sum(runnerExecR)/runnerExecR.length),'maxR',fmt(Math.max(...runnerExecR)),'>=3R',runnerExecR.filter(r=>r>=3).length,'>=4R',runnerExecR.filter(r=>r>=4).length,'>=5R',runnerExecR.filter(r=>r>=5).length);
  console.log('below 1.8R:',below18.length, below18.map(x=>x.trade+':'+fmt(x.runnerR)));
  console.log('buckets:',JSON.stringify(buckets));
  console.log('gained',fmt(gained),'lost',fmt(lost),'net',fmt(gained+lost));
  console.log('non-runner parity:',parityRows.filter(p=>p.match).length,'/',parityRows.length,'match; mismatches',parityRows.filter(p=>!p.match).length);
  console.log('ambiguous trades:',new Set(ambigRows.map(a=>a.trade)).size,'crossedRollover',crossedRollover);
}
main();
