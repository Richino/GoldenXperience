/**
 * walkforward.mjs — honest anti-overfitting test.
 *
 * TRAIN on 6 windows (2024-08 .. 2025-11): exhaustively search configs, pick the
 * highest binary win rate that trades frequently. Then evaluate THAT config,
 * unchanged, on 3 TEST windows (2026-02/05/08) it never saw. Real improvement
 * survives the split; overfit noise collapses.
 */
import fs from "node:fs";
const SP = process.argv[2];
const TRAIN = ["2024-08", "2024-11", "2025-02", "2025-05", "2025-08", "2025-11"];
const TEST = ["2026-02", "2026-05", "2026-08"];

function load(k) {
  const Ls = fs.readFileSync(`${SP}/w_${k}/TRADES.csv`, "utf8").trim().split("\n");
  const H = Ls[0].split(","); const idx = Object.fromEntries(H.map((h, i) => [h, i]));
  const out = [];
  for (const l of Ls.slice(1)) {
    const p = l.split(",");
    if (!p[idx.variants].split("|").includes("A")) continue;
    if (p[idx.result] === "TIE") continue;
    out.push({ win: p[idx.result] === "WIN" ? 1 : 0, sym: p[idx.symbol], dir: p[idx.direction],
      sess: p[idx.session], hr: +p[idx.hourUtc], bb: p[idx.bb] || p[idx.bbEvent], K: +p[idx.stochK],
      cci: +p[idx.cci], adx: +p[idx.adx], hasC: p[idx.variants].split("|").includes("C"),
      hasD: p[idx.variants].split("|").includes("D"), hasE: p[idx.variants].split("|").includes("E"),
      hasF: p[idx.variants].split("|").includes("F"), days: p[idx.day] });
  }
  return out;
}
const data = Object.fromEntries([...TRAIN, ...TEST].map((k) => [k, load(k)]));
function wrOf(list) { const n = list.length; return { n, wr: n ? list.reduce((a, x) => a + x.win, 0) / n : 0 }; }
function daysIn(k) { return new Set(data[k].map((x) => x.days)).size; }

// build candidate predicate space
const confKeys = [["C", (x) => x.hasC], ["D", (x) => x.hasD], ["E", (x) => x.hasE], ["F", (x) => x.hasF]];
const sessions = [null, "Asia", "London", "London/NY overlap", "New York"];
const dirs = [null, "UP", "DOWN"];
const syms = [null, ...new Set(data[TRAIN[0]].map((x) => x.sym))];
const adxG = [null, ["adx>25", (x) => x.adx > 25], ["adx>40", (x) => x.adx > 40]];
const stochG = [null, ["Kextreme", (x) => (x.dir === "UP" ? x.K < 20 : x.K > 80)]];

const cands = [];
for (let m = 0; m < 16; m++) {
  const reqs = confKeys.filter((_, i) => m & (1 << i));
  for (const s of sessions) for (const d of dirs) for (const sy of syms) for (const ag of adxG) for (const sg of stochG) {
    const pred = (x) => reqs.every(([, f]) => f(x)) && (!s || x.sess === s) && (!d || x.dir === d) && (!sy || x.sym === sy) && (!ag || ag[1](x)) && (!sg || sg[1](x));
    // train frequency floor: >=5 decided/day in every train window
    let ok = true, trainW = 0, trainN = 0;
    for (const k of TRAIN) { const list = data[k].filter(pred); if (list.length < 5 * daysIn(k)) { ok = false; break; } trainN += list.length; trainW += list.reduce((a, x) => a + x.win, 0); }
    if (!ok) continue;
    const label = [reqs.map((r) => r[0]).join("+") || "BB", sy, s, d, ag && ag[0], sg && sg[0]].filter(Boolean).join(" ");
    cands.push({ label, pred, trainWr: trainW / trainN, trainN });
  }
}
cands.sort((a, b) => b.trainWr - a.trainWr);
console.log(`candidates meeting train frequency floor: ${cands.length}\n`);
console.log("Top 5 by TRAIN win rate, then their TEST (unseen) win rate:\n");
for (const c of cands.slice(0, 5)) {
  let testW = 0, testN = 0; const per = [];
  for (const k of TEST) { const list = data[k].filter(c.pred); const r = wrOf(list); per.push(`${k}:${(r.wr * 100).toFixed(1)}%`); testW += list.reduce((a, x) => a + x.win, 0); testN += list.length; }
  const testWr = testN ? testW / testN : 0;
  console.log(`${c.label.padEnd(30)} TRAIN=${(c.trainWr * 100).toFixed(1)}% (n${c.trainN})  ->  TEST=${(testWr * 100).toFixed(1)}% (n${testN})  [${per.join(" ")}]`);
}
console.log("\nbreak-even @92% payout = 52.08%");
