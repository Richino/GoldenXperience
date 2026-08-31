/**
 * robustness_2y.mjs — out-of-sample robustness across the last 2 years.
 *
 * Reads the per-window TRADES.csv files produced by run.mjs (one per quarterly
 * anchor), reconstructs confirmation flags, and searches for any frequent-trade
 * configuration whose directional bias PERSISTS across every window. Honest:
 * ranks by worst-window edge, so a config only scores if it holds up everywhere.
 *
 * Usage: node robustness_2y.mjs <dir1> <dir2> ...   (each dir has TRADES.csv + label)
 */
import fs from "node:fs";
import path from "node:path";

const dirs = process.argv.slice(2);
const windows = dirs.map((d) => {
  const lines = fs.readFileSync(path.join(d, "TRADES.csv"), "utf8").trim().split("\n");
  const H = lines[0].split(",");
  const idx = Object.fromEntries(H.map((h, i) => [h, i]));
  const rows = lines.slice(1).map((l) => l.split(","));
  const label = path.basename(d);
  const days = new Set(rows.map((p) => p[idx.day])).size;
  return { label, idx, rows, days };
});

const has = (idx, p, v) => p[idx.variants].split("|").includes(v);
function wr(idx, list) {
  let w = 0, l = 0; for (const p of list) { const r = p[idx.result]; if (r === "WIN") w++; else if (r === "LOSS") l++; }
  const d = w + l; return { d, w, l, wr: d ? w / d : 0 };
}

const conf = [["HA", "C"], ["Stoch", "D"], ["CCI", "E"], ["ADX", "F"]];
const sessions = [null, "Asia", "London", "London/NY overlap", "New York"];
const dirs2 = [null, "UP", "DOWN"];
const symbols = [null, ...new Set(windows[0].rows.map((p) => p[windows[0].idx.symbol]))];

function selectFrom(win, req, s, d, sym, bb3) {
  const { idx, rows } = win;
  let list = rows.filter((p) => has(idx, p, "A") && req.every(([, v]) => has(idx, p, v)));
  if (s) list = list.filter((p) => p[idx.session] === s);
  if (d) list = list.filter((p) => p[idx.direction] === d);
  if (sym) list = list.filter((p) => p[idx.symbol] === sym);
  if (bb3) list = list.filter((p) => p[idx.bbEvent].startsWith("BB3"));
  return wr(idx, list);
}

const MIN_PER_DAY = 5; // "frequent" = >=5 decided per day in EVERY window
const cand = [];
for (let mask = 0; mask < 16; mask++) {
  const req = conf.filter((_, i) => mask & (1 << i));
  for (const s of sessions) for (const d of dirs2) for (const sym of symbols) for (const bb3 of [false, true]) {
    const perWin = windows.map((w) => ({ label: w.label, days: w.days, ...selectFrom(w, req, s, d, sym, bb3) }));
    // require frequent trades in every window
    if (perWin.some((x) => x.d < MIN_PER_DAY * x.days)) continue;
    // consistency of LOSS bias: min loss-rate across windows (want high => persistent loss)
    const lossRates = perWin.map((x) => 1 - x.wr);
    const minLoss = Math.min(...lossRates);
    const minWin = Math.min(...perWin.map((x) => x.wr));
    const totalDec = perWin.reduce((a, x) => a + x.d, 0);
    const label = [req.map((x) => x[0]).join("+") || "BBonly", sym, s, d, bb3 && "BB3"].filter(Boolean).join(" ");
    cand.push({ label, perWin, minLoss, minWin, totalDec });
  }
}

function show(title, list) {
  console.log("\n=== " + title + " ===");
  for (const c of list) {
    const rates = c.perWin.map((x) => `${x.label}:${(x.wr * 100).toFixed(0)}%(n${x.d})`).join("  ");
    console.log(`${c.label.padEnd(30)} | worstLoss=${(c.minLoss * 100).toFixed(1)}% worstWin=${(c.minWin * 100).toFixed(1)}% | ${rates}`);
  }
}
// Best persistent LOSS config (want highest worst-window loss rate)
show("most persistent LOSS bias (ranked by worst-window loss rate)",
  [...cand].sort((a, b) => b.minLoss - a.minLoss).slice(0, 8));
// Best persistent WIN config
show("most persistent WIN bias (ranked by worst-window win rate)",
  [...cand].sort((a, b) => b.minWin - a.minWin).slice(0, 8));
console.log(`\nconfigs meeting frequency floor in ALL ${windows.length} windows: ${cand.length}`);
