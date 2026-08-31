import fs from "node:fs";
const base = "C:/Users/arche/Desktop/code/GoldenXperience/api-server/research-v2/eurusd-neural-day-v4";
const dev = JSON.parse(fs.readFileSync(base + "/TRADES.development.json", "utf8"));
const val = JSON.parse(fs.readFileSync(base + "/TRADES.historical-check.json", "utf8"));

const hourOf = (t) => new Date(t).getUTCHours();
const minOf = (t) => new Date(t).getUTCMinutes();
const dowOf = (t) => new Date(t).getUTCDay();

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const rs = trades.map(t => t.resultR);
  const total = rs.reduce((a, b) => a + b, 0);
  const exp = total / n;
  const wins = trades.filter(t => t.resultR > 0);
  const losses = trades.filter(t => t.resultR <= 0);
  const gp = wins.reduce((a, t) => a + t.resultR, 0);
  const gl = -losses.reduce((a, t) => a + t.resultR, 0);
  const avgWin = wins.length ? gp / wins.length : 0;
  const avgLoss = losses.length ? -gl / losses.length : 0;
  const variance = n > 1 ? rs.reduce((a, r) => a + (r - exp) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / n);
  // max drawdown on the R equity curve
  let peak = 0, cum = 0, mdd = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  return {
    n, total: +total.toFixed(3), exp: +exp.toFixed(4),
    winRate: +(wins.length / n).toFixed(4),
    avgWin: +avgWin.toFixed(4), avgLoss: +avgLoss.toFixed(4),
    pf: gl ? +(gp / gl).toFixed(4) : Infinity,
    maxDD: +mdd.toFixed(3),
    exp95: [+(exp - 1.96 * se).toFixed(4), +(exp + 1.96 * se).toFixed(4)],
  };
}

console.log("=== BASELINE ===");
console.log("DEV  ", JSON.stringify(stats(dev)));
console.log("VAL  ", JSON.stringify(stats(val)));

console.log("\n=== VALIDATION loss diagnosis (descriptive only) ===");
const vStops = val.filter(t => t.outcome === "STOP");
const vTime = val.filter(t => t.outcome === "TIME_EXIT");
const vTarget = val.filter(t => t.outcome === "TARGET");
console.log("STOPs:", vStops.length, "avg holdMin", +(vStops.reduce((a,t)=>a+t.holdMinutes,0)/vStops.length).toFixed(1), "avg R", +(vStops.reduce((a,t)=>a+t.resultR,0)/vStops.length).toFixed(3));
// same-candle / fast stops
const stop1 = vStops.filter(t => t.holdMinutes <= 15).length;
const stop2 = vStops.filter(t => t.holdMinutes <= 30).length;
console.log("  stopped within 15min:", stop1, " within 30min:", stop2, " (of "+vStops.length+")");
console.log("TIME_EXITs:", vTime.length, "avg R", +(vTime.reduce((a,t)=>a+t.resultR,0)/vTime.length).toFixed(3),
  " positive:", vTime.filter(t=>t.resultR>0).length, " negative:", vTime.filter(t=>t.resultR<=0).length);
console.log("  TIME_EXIT R breakdown:", vTime.map(t=>+t.resultR.toFixed(2)).sort((a,b)=>a-b).join(", "));
console.log("TARGETs:", vTarget.length, "avg R", +(vTarget.reduce((a,t)=>a+t.resultR,0)/vTarget.length).toFixed(3));

// Pre-trade feature availability
const feats = ["score","margin","spreadAtr","newsDistanceMinutes"];
function quantileTable(trades, key, extractor) {
  const withVal = trades.map(t => ({ v: extractor(t), r: t.resultR })).filter(x => x.v != null && Number.isFinite(x.v));
  withVal.sort((a, b) => a.v - b.v);
  const q = 4;
  const rows = [];
  for (let i = 0; i < q; i++) {
    const lo = Math.floor(i * withVal.length / q);
    const hi = Math.floor((i + 1) * withVal.length / q);
    const seg = withVal.slice(lo, hi);
    if (!seg.length) continue;
    const exp = seg.reduce((a, x) => a + x.r, 0) / seg.length;
    const wr = seg.filter(x => x.r > 0).length / seg.length;
    rows.push(`Q${i+1} [${seg[0].v.toFixed(3)}..${seg[seg.length-1].v.toFixed(3)}] n=${seg.length} exp=${exp.toFixed(3)} wr=${(wr*100).toFixed(0)}%`);
  }
  return rows;
}
console.log("\n=== DEVELOPMENT quartile expectancy by pre-trade feature ===");
for (const f of feats) {
  console.log(`-- ${f} --`);
  for (const row of quantileTable(dev, f, t => t[f])) console.log("   " + row);
}
console.log("-- hour --");
for (const row of quantileTable(dev, "hour", t => hourOf(t.entryTime))) console.log("   " + row);

// direction split
console.log("\n=== DEVELOPMENT by direction ===");
for (const d of ["LONG","SHORT"]) {
  console.log(d, JSON.stringify(stats(dev.filter(t=>t.direction===d))));
}
console.log("\n=== DEVELOPMENT by hour ===");
const hours = [...new Set(dev.map(t=>hourOf(t.entryTime)))].sort((a,b)=>a-b);
for (const h of hours) {
  const seg = dev.filter(t=>hourOf(t.entryTime)===h);
  console.log("h"+h, "n="+seg.length, "exp="+(seg.reduce((a,t)=>a+t.resultR,0)/seg.length).toFixed(3), "wr="+(seg.filter(t=>t.resultR>0).length/seg.length*100).toFixed(0)+"%");
}
