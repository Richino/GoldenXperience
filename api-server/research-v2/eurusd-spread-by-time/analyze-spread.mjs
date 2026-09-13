// EUR/USD spread-by-time analysis from OANDA BID/ASK data.
// Research only. No strategy created/modified.
import fs from 'fs';
import path from 'path';

const OUT = process.argv[2];
const PIP = 0.0001;

// ---- ET conversion with correct EST/EDT DST handling via Intl ----
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
});
// cache ET parts per unique epoch-minute isn't needed; compute per-bar.
const WD = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
function etParts(iso){
  const d = new Date(iso);
  const parts = etFmt.formatToParts(d);
  let wd, hh;
  for (const p of parts){ if(p.type==='weekday') wd=p.value; if(p.type==='hour') hh=parseInt(p.value,10); }
  if (hh===24) hh=0;
  return { dow: WD[wd], hour: hh };
}

// ---- collect spread samples: array of {hour, dow, spreadPips} ----
function loadM5(file){
  const raw = JSON.parse(fs.readFileSync(file,'utf8'));
  const bars = raw.bars;
  const out = [];
  for (const b of bars){
    if (b.bidClose==null || b.askClose==null) continue;
    const spread = (b.askClose - b.bidClose)/PIP;
    if (!isFinite(spread) || spread < 0) continue;
    if (spread > 50) continue; // guard against obvious data errors (>50 pip)
    const { hour, dow } = etParts(b.closeTime);
    if (dow===6) continue; // Saturday: market closed
    out.push({ hour, dow, spread });
  }
  return out;
}

function loadM1(file){
  const raw = JSON.parse(fs.readFileSync(file,'utf8'));
  const cs = raw.candles;
  const out = [];
  for (const c of cs){
    const bc = parseFloat(c.bid.c), ac = parseFloat(c.ask.c);
    if (!isFinite(bc)||!isFinite(ac)) continue;
    const spread = (ac-bc)/PIP;
    if (spread<0 || spread>50) continue;
    const { hour, dow } = etParts(c.time);
    if (dow===6) continue;
    out.push({ hour, dow, spread });
  }
  return out;
}

// ---- stats helpers ----
function quantile(sorted, q){
  if (sorted.length===0) return NaN;
  const idx = (sorted.length-1)*q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo===hi) return sorted[lo];
  return sorted[lo] + (sorted[hi]-sorted[lo])*(idx-lo);
}
function stats(arr){
  const n = arr.length;
  if (n===0) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const sum = arr.reduce((a,b)=>a+b,0);
  const mean = sum/n;
  const varr = arr.reduce((a,b)=>a+(b-mean)*(b-mean),0)/n;
  const std = Math.sqrt(varr);
  const median = quantile(s,0.5);
  const p90 = quantile(s,0.90);
  const p99 = quantile(s,0.99);
  const min = s[0], max = s[n-1];
  const cv = mean>0 ? std/mean : 0;
  // spike rate: fraction of obs above 2.0 pips (a materially costly spread)
  const spike2 = arr.filter(x=>x>2.0).length/n;
  // fraction above 2x median (relative spike)
  const spikeRel = arr.filter(x=>x> 2*median).length/n;
  return { n, mean, median, p90, p99, min, max, std, cv, spike2, spikeRel };
}

function r(x,d=3){ return Number(x.toFixed(d)); }

function analyze(samples, label){
  // by hour
  const byHour = Array.from({length:24}, ()=>[]);
  const byDow = Array.from({length:7}, ()=>[]);
  const byHD = {}; // key `${dow}-${hour}`
  for (const s of samples){
    byHour[s.hour].push(s.spread);
    byDow[s.dow].push(s.spread);
    const k = `${s.dow}-${s.hour}`;
    (byHD[k] ||= []).push(s.spread);
  }
  const hourStats = byHour.map((a,h)=>({hour:h, ...stats(a)}));
  const dowStats = byDow.map((a,d)=>({dow:d, ...stats(a)}));
  const hdStats = Object.entries(byHD).map(([k,a])=>{
    const [dow,hour]=k.split('-').map(Number);
    return {dow,hour,...stats(a)};
  });
  return { label, hourStats, dowStats, hdStats, total: samples.length };
}

// ---- ET hour label 12h AM/PM ----
function hourLabel(h){
  const ampm = h<12 ? 'AM':'PM';
  let hr = h%12; if(hr===0) hr=12;
  return `${hr} ${ampm}`;
}
function hourRange(h){ // "h:00-h+1:00 ET"
  return `${hourLabel(h)}–${hourLabel((h+1)%24)}`;
}

// ---- continuous windows (circular over 24 ET hours), weighted by n ----
function windowStats(hourStats, size){
  // aggregate mean weighted by n over consecutive hours; also combined P90 approx via pooled?
  // We need pooled percentiles -> recompute from raw not available here; approximate window avg (obs-weighted mean) and worst-hour p90.
  const res=[];
  for (let start=0; start<24; start++){
    let totN=0, totSum=0, worstP90=0, worstMax=0, sumSpike=0;
    const hrs=[];
    for (let k=0;k<size;k++){
      const h=(start+k)%24;
      const hs=hourStats[h];
      if(!hs||!hs.n){ totN=0; break; }
      totN+=hs.n; totSum+=hs.mean*hs.n;
      worstP90=Math.max(worstP90, hs.p90);
      worstMax=Math.max(worstMax, hs.max);
      sumSpike+=hs.spike2*hs.n;
      hrs.push(h);
    }
    if(!totN) continue;
    res.push({ start, size, hrs, avg: totSum/totN, n: totN, worstP90, worstMax, spikeRate: sumSpike/totN });
  }
  res.sort((a,b)=>a.avg-b.avg);
  return res;
}

// ---- run ----
const m5 = loadM5('backtest-breakout-m5/candles/EUR_USD_M5.json');
const m1 = loadM1('api-server/research-v2/four-family-v2-201-trades/cache/EUR_USD-M1.json');
const A = analyze(m5, 'M5-3yr');
const Am1 = analyze(m1, 'M1-3wk');

fs.mkdirSync(OUT,{recursive:true});

// write hourly CSV
function writeHourly(fname, hourStats){
  const rows=['hour_et_24,time_et_12h,avg_pips,median_pips,p90_pips,p99_pips,min_pips,max_pips,std_pips,cv,spike_rate_gt2pip,rel_spike_rate,n'];
  for(const h of hourStats){
    if(!h.n) { rows.push(`${h.hour},${hourLabel(h.hour)},NA,NA,NA,NA,NA,NA,NA,NA,NA,NA,0`); continue; }
    rows.push([h.hour,hourLabel(h.hour),r(h.mean),r(h.median),r(h.p90),r(h.p99),r(h.min),r(h.max),r(h.std),r(h.cv),r(h.spike2,4),r(h.spikeRel,4),h.n].join(','));
  }
  fs.writeFileSync(path.join(OUT,fname), rows.join('\n')+'\n');
}
writeHourly('hourly_et_M5_3yr.csv', A.hourStats);
writeHourly('hourly_et_M1_3wk.csv', Am1.hourStats);

// day of week
const DOWN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function writeDow(fname, dowStats){
  const rows=['dow,day,avg_pips,median_pips,p90_pips,max_pips,std_pips,cv,n'];
  for(const d of dowStats){ if(!d.n) continue;
    rows.push([d.dow,DOWN[d.dow],r(d.mean),r(d.median),r(d.p90),r(d.max),r(d.std),r(d.cv),d.n].join(','));
  }
  fs.writeFileSync(path.join(OUT,fname), rows.join('\n')+'\n');
}
writeDow('dayofweek_et_M5_3yr.csv', A.dowStats);

// hour + dow
function writeHD(fname, hdStats){
  const rows=['dow,day,hour_et_24,time_et_12h,avg_pips,median_pips,p90_pips,max_pips,cv,n'];
  hdStats.sort((a,b)=> a.dow-b.dow || a.hour-b.hour);
  for(const x of hdStats){ if(!x.n) continue;
    rows.push([x.dow,DOWN[x.dow],x.hour,hourLabel(x.hour),r(x.mean),r(x.median),r(x.p90),r(x.max),r(x.cv),x.n].join(','));
  }
  fs.writeFileSync(path.join(OUT,fname), rows.join('\n')+'\n');
}
writeHD('hour_dayofweek_et_M5_3yr.csv', A.hdStats);

// ranked hours low->high
const ranked=[...A.hourStats].filter(h=>h.n).sort((a,b)=>a.mean-b.mean);
{
  const rows=['rank,time_et_12h,hour_et_24,avg_pips,median_pips,p90_pips,cv,spike_rate_gt2pip,n'];
  ranked.forEach((h,i)=>rows.push([i+1,hourLabel(h.hour),h.hour,r(h.mean),r(h.median),r(h.p90),r(h.cv),r(h.spike2,4),h.n].join(',')));
  fs.writeFileSync(path.join(OUT,'ranked_hours_et_M5_3yr.csv'), rows.join('\n')+'\n');
}

// windows
const w1=windowStats(A.hourStats,1);
const w2=windowStats(A.hourStats,2);
const w3=windowStats(A.hourStats,3);

// consistency score: among hours, rank by composite of mean + p90 + cv (normalized)
const valid=A.hourStats.filter(h=>h.n);
const meanArr=valid.map(h=>h.mean), p90Arr=valid.map(h=>h.p90), cvArr=valid.map(h=>h.cv);
function nz(v,arr){const mn=Math.min(...arr),mx=Math.max(...arr);return mx>mn?(v-mn)/(mx-mn):0;}
const consistency=valid.map(h=>({
  hour:h.hour, mean:h.mean, p90:h.p90, cv:h.cv, spike2:h.spike2, n:h.n,
  // lower is better; weight avg 0.45, p90 0.35, cv 0.20
  score: 0.45*nz(h.mean,meanArr)+0.35*nz(h.p90,p90Arr)+0.20*nz(h.cv,cvArr)
})).sort((a,b)=>a.score-b.score);

// dump JSON summary
const summary={
  source_primary:'backtest-breakout-m5/candles/EUR_USD_M5.json (OANDA M5 bid/ask)',
  source_corroborating:'four-family-v2-201-trades/cache/EUR_USD-M1.json (OANDA M1 bid/ask)',
  m5_range:'2023-08-28 to 2026-08-27',
  m1_range:'2026-08-16 to 2026-09-05',
  spread_def:'askClose - bidClose per bar, in pips (1 pip=0.0001); Saturday excluded; spreads>50pip dropped as errors',
  m5_total_obs:A.total, m1_total_obs:Am1.total,
  ranked_hours_low_to_high: ranked.map(h=>({time_et:hourLabel(h.hour),hour24:h.hour,avg:r(h.mean),median:r(h.median),p90:r(h.p90),cv:r(h.cv),spike2:r(h.spike2,4),n:h.n})),
  cheapest_1h: {time_et:hourRange(w1[0].start), avg:r(w1[0].avg), p90:r(w1[0].worstP90), n:w1[0].n},
  cheapest_2h: {time_et:`${hourLabel(w2[0].start)}–${hourLabel((w2[0].start+2)%24)}`, hours:w2[0].hrs.map(hourLabel), avg:r(w2[0].avg), worstP90:r(w2[0].worstP90), n:w2[0].n},
  cheapest_3h: {time_et:`${hourLabel(w3[0].start)}–${hourLabel((w3[0].start+3)%24)}`, hours:w3[0].hrs.map(hourLabel), avg:r(w3[0].avg), worstP90:r(w3[0].worstP90), n:w3[0].n},
  most_consistent_hours: consistency.slice(0,6).map(c=>({time_et:hourLabel(c.hour),avg:r(c.mean),p90:r(c.p90),cv:r(c.cv),spike2:r(c.spike2,4),score:r(c.score),n:c.n})),
  avoid_hours: [...A.hourStats].filter(h=>h.n).sort((a,b)=>b.spike2-a.spike2).slice(0,6).map(h=>({time_et:hourLabel(h.hour),avg:r(h.mean),p90:r(h.p90),max:r(h.max),spike_rate_gt2pip:r(h.spike2,4),n:h.n})),
  top2_windows_2h: w2.slice(0,5).map(w=>({time_et:`${hourLabel(w.start)}–${hourLabel((w.start+2)%24)}`,avg:r(w.avg),worstP90:r(w.worstP90),n:w.n})),
  top_windows_3h: w3.slice(0,5).map(w=>({time_et:`${hourLabel(w.start)}–${hourLabel((w.start+3)%24)}`,avg:r(w.avg),worstP90:r(w.worstP90),n:w.n})),
};
fs.writeFileSync(path.join(OUT,'SUMMARY.json'), JSON.stringify(summary,null,2));

// print key results to console
console.log('M5 total obs:',A.total,' M1 total obs:',Am1.total);
console.log('\nRANKED HOURS (ET) low->high avg spread:');
ranked.forEach((h,i)=>console.log(`${String(i+1).padStart(2)}. ${hourLabel(h.hour).padStart(5)}  avg=${r(h.mean).toFixed(3)}  med=${r(h.median).toFixed(2)}  p90=${r(h.p90).toFixed(2)}  cv=${r(h.cv).toFixed(2)}  spike>2p=${(h.spike2*100).toFixed(1)}%  n=${h.n}`));
console.log('\nCheapest 1h:',JSON.stringify(summary.cheapest_1h));
console.log('Cheapest 2h:',JSON.stringify(summary.cheapest_2h));
console.log('Cheapest 3h:',JSON.stringify(summary.cheapest_3h));
console.log('\nMost consistent:',JSON.stringify(summary.most_consistent_hours,null,0));
console.log('\nAvoid (highest spike rate):',JSON.stringify(summary.avoid_hours,null,0));
console.log('\nDay of week:');
A.dowStats.forEach(d=>{if(d.n)console.log(`  ${DOWN[d.dow]}: avg=${r(d.mean).toFixed(3)} med=${r(d.median).toFixed(2)} p90=${r(d.p90).toFixed(2)} n=${d.n}`);});
