/**
 * loss_search.mjs — loss-maximizing configuration search over the logged signals.
 *
 * Reads TRADES.csv (all 28,432 base signals), reconstructs each confirmation
 * flag from variant membership (A=BB2-rej base, C=+HA, D=+Stoch, E=+CCI, F=+ADX),
 * and scans confirmation stacks x extension x session x direction for the
 * configuration whose WIN rate is lowest (loss rate highest). Reproducible;
 * changes no state.
 *
 * Usage: node loss_search.mjs [outDir]
 */
import fs from "node:fs";
import path from "node:path";

const DIR = "research/binary-double-bollinger-1m-v1";
const OUT = process.argv[2] || DIR;
const lines = fs.readFileSync(path.join(DIR, "TRADES.csv"), "utf8").trim().split("\n");
const H = lines[0].split(",");
const idx = Object.fromEntries(H.map((h, i) => [h, i]));
const rows = lines.slice(1).map((l) => l.split(","));
const A = rows.filter((p) => p[idx.variants].split("|").includes("A"));
const has = (p, v) => p[idx.variants].split("|").includes(v);

function stat(list) {
  let w = 0, ls = 0, t = 0;
  for (const p of list) { const r = p[idx.result]; if (r === "WIN") w++; else if (r === "LOSS") ls++; else t++; }
  const d = w + ls, wr = d ? w / d : 0, z = 1.959963984540054;
  let lo = 0, hi = 0;
  if (d) { const z2 = z * z, dn = 1 + z2 / d, c = wr + z2 / (2 * d), m = z * Math.sqrt((wr * (1 - wr) + z2 / (4 * d)) / d); lo = (c - m) / dn; hi = (c + m) / dn; }
  return { n: list.length, decided: d, wins: w, losses: ls, ties: t, wr, wrCiLo: lo, wrCiHi: hi, lossRate: 1 - wr };
}

const conf = [["HA", "C"], ["Stoch", "D"], ["CCI", "E"], ["ADX", "F"]];
const sessions = [null, "Asia", "London", "London/NY overlap", "New York"];
const dirs = [null, "UP", "DOWN"];
const all = [];
for (let mask = 1; mask < 16; mask++) {
  const req = conf.filter((_, i) => mask & (1 << i));
  for (const bb3 of [false, true]) for (const s of sessions) for (const d of dirs) {
    let list = A.filter((p) => req.every(([, v]) => has(p, v)));
    if (bb3) list = list.filter((p) => p[idx.bbEvent].startsWith("BB3"));
    if (s) list = list.filter((p) => p[idx.session] === s);
    if (d) list = list.filter((p) => p[idx.direction] === d);
    all.push({ confirmations: req.map((x) => x[0]), bb3, session: s, direction: d, ...stat(list) });
  }
}

// loss-maximizing config at several minimum-sample floors
const report = {};
for (const minN of [0, 20, 60, 100, 200]) {
  const best = all.filter((r) => r.decided >= minN).sort((a, b) => b.lossRate - a.lossRate)[0];
  report[`minDecided_${minN}`] = best;
}
fs.writeFileSync(path.join(OUT, "LOSS_SEARCH.json"), JSON.stringify(report, null, 2));
for (const [k, r] of Object.entries(report)) {
  console.log(`${k}: [${r.confirmations.join("+")}]${r.bb3 ? "+BB3" : ""}${r.session ? " " + r.session : ""}${r.direction ? " " + r.direction : ""} -> loss ${(r.lossRate * 100).toFixed(1)}% (WR ${(r.wr * 100).toFixed(1)}%, n=${r.decided}, W${r.wins}/L${r.losses}/T${r.ties}, WR CI ${(r.wrCiLo * 100).toFixed(1)}-${(r.wrCiHi * 100).toFixed(1)})`);
}
