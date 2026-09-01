import fs from "node:fs";
const base = "C:/Users/arche/Desktop/code/GoldenXperience/api-server/research-v2/eurusd-neural-day-v4";
const dev = JSON.parse(fs.readFileSync(base + "/TRADES.development.json", "utf8"));
const val = JSON.parse(fs.readFileSync(base + "/TRADES.historical-check.json", "utf8"));
const hourOf = (t) => new Date(t).getUTCHours();

function stats(trades, days) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const rs = trades.map(t => t.resultR);
  const total = rs.reduce((a, b) => a + b, 0);
  const exp = total / n;
  const wins = trades.filter(t => t.resultR > 0);
  const losses = trades.filter(t => t.resultR <= 0);
  const gp = wins.reduce((a, t) => a + t.resultR, 0);
  const gl = -losses.reduce((a, t) => a + t.resultR, 0);
  const variance = n > 1 ? rs.reduce((a, r) => a + (r - exp) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / n);
  let peak = 0, cum = 0, mdd = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  const targets = trades.filter(t => t.outcome === "TARGET").length;
  return {
    n, tradesPerDay: days ? +(n / days).toFixed(3) : null,
    total: +total.toFixed(3), exp: +exp.toFixed(4),
    winRate: +(wins.length / n * 100).toFixed(2),
    targetRate: +(targets / n * 100).toFixed(2),
    avgWin: +(wins.length ? gp / wins.length : 0).toFixed(4),
    avgLoss: +(losses.length ? -gl / losses.length : 0).toFixed(4),
    pf: gl ? +(gp / gl).toFixed(4) : Infinity,
    maxDD: +mdd.toFixed(3),
    exp95: [+(exp - 1.96 * se).toFixed(4), +(exp + 1.96 * se).toFixed(4)],
  };
}
const daysOf = (trades) => new Set(trades.map(t => t.entryTime.slice(0,10))).size;
// market-day denominators from baseline (approx via period). Use trading days present in each period's candidate set is ideal,
// but for tradesPerDay we use the SAME market-day denominator the engine used. Approx from baseline exp: dev 109/0.421=259, val 100/0.386=259.
const DEV_DAYS = 259, VAL_DAYS = 259;

// PREDECLARED GATE (frozen on development, before viewing validation-by-hour):
// Keep only entries with UTC hour >= 13. Rationale: development expectancy is
// negative for the 11:00 and 12:00 UTC decisions (London/NY lunch lull) and
// positive for the 13:00-15:45 UTC New York cash session. Structural time gate,
// not a fit to the model's own (anti-calibrated) score/margin.
const GATE = (t) => hourOf(t.entryTime) >= 13;

console.log("=== BASELINE (no gate) ===");
console.log("DEV ", JSON.stringify(stats(dev, DEV_DAYS)));
console.log("VAL ", JSON.stringify(stats(val, VAL_DAYS)));

console.log("\n=== GATED: hour>=13 ===");
const devG = dev.filter(GATE), valG = val.filter(GATE);
console.log("DEV ", JSON.stringify(stats(devG, DEV_DAYS)));
console.log("VAL ", JSON.stringify(stats(valG, VAL_DAYS)));
console.log("DEV removed:", dev.length - devG.length, " VAL removed:", val.length - valG.length);

console.log("\n=== VALIDATION by hour (revealed AFTER gate frozen) ===");
for (const h of [11,12,13,14,15]) {
  const seg = val.filter(t=>hourOf(t.entryTime)===h);
  if (!seg.length) { console.log("h"+h,"n=0"); continue; }
  console.log("h"+h, "n="+seg.length, "exp="+(seg.reduce((a,t)=>a+t.resultR,0)/seg.length).toFixed(3), "wr="+(seg.filter(t=>t.resultR>0).length/seg.length*100).toFixed(0)+"%");
}

// Alternative thresholds for transparency (NOT selected)
console.log("\n=== Alternative hour thresholds (transparency) ===");
for (const thr of [12,13,14]) {
  const g = (t)=>hourOf(t.entryTime)>=thr;
  console.log(`hour>=${thr}: DEV`, JSON.stringify(stats(dev.filter(g),DEV_DAYS)));
  console.log(`hour>=${thr}: VAL`, JSON.stringify(stats(val.filter(g),VAL_DAYS)));
}
