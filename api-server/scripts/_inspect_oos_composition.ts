import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(serviceRoot, "..");
const RES = path.join(serviceRoot, "research-v2", "legacy-direction-confidence-v2-backtest-legacy-expanded", "RESULTS.json");

const summary = JSON.parse(readFileSync(RES, "utf8")) as {
  is: { from: string; to: string; n: number };
  oos: { from: string; to: string; n: number };
  oosRows: Array<{ pair: string; decisionTime: string; actualResultR: number }>;
};

console.log(`IS window : ${summary.is.from}  →  ${summary.is.to}   n=${summary.is.n}`);
console.log(`OOS window: ${summary.oos.from}  →  ${summary.oos.to}   n=${summary.oos.n}`);

// per-pair OOS baseline
const byPair = new Map<string, { n: number; w: number; totalR: number }>();
for (const r of summary.oosRows) {
  const p = byPair.get(r.pair) ?? { n: 0, w: 0, totalR: 0 };
  p.n++;
  p.totalR += r.actualResultR;
  if (r.actualResultR > 0) p.w++;
  byPair.set(r.pair, p);
}
console.log(`\nOOS baseline by pair (legacy strategy, EMA-stack pick):`);
console.log(`  pair       n   winrate   totalR`);
const arr = [...byPair.entries()].sort((a, b) => b[1].totalR - a[1].totalR);
let cum = 0;
for (const [pair, s] of arr) {
  console.log(`  ${pair.padEnd(9)}${String(s.n).padStart(4)}    ${(100 * s.w / s.n).toFixed(1).padStart(5)}%   ${s.totalR >= 0 ? "+" : ""}${s.totalR.toFixed(2).padStart(7)}`);
  cum += s.totalR;
}
console.log(`  ${"TOTAL".padEnd(9)}                    ${cum >= 0 ? "+" : ""}${cum.toFixed(2)}`);

// Now compare to IS baseline. Load the full trades.json.
const trades = (JSON.parse(readFileSync(path.join(REPO_ROOT, "backtest-legacy-expanded", "trades.json"), "utf8")) as { trades: Array<{ pair: string; decisionTime: string; resultR: number | null }> }).trades;
const isFromMs = Date.parse(summary.is.from);
const isToMs = Date.parse(summary.is.to);
const oosFromMs = Date.parse(summary.oos.from);

const isPair = new Map<string, { n: number; w: number; totalR: number }>();
for (const t of trades) {
  if (t.resultR === null) continue;
  const ts = Date.parse(t.decisionTime);
  if (ts >= isFromMs && ts <= isToMs) {
    const p = isPair.get(t.pair) ?? { n: 0, w: 0, totalR: 0 };
    p.n++; p.totalR += t.resultR; if (t.resultR > 0) p.w++;
    isPair.set(t.pair, p);
  }
}
console.log(`\nIS baseline by pair (older window):`);
console.log(`  pair       n   winrate   totalR`);
const isArr = [...isPair.entries()].sort((a, b) => b[1].totalR - a[1].totalR);
let isCum = 0;
for (const [pair, s] of isArr) {
  console.log(`  ${pair.padEnd(9)}${String(s.n).padStart(4)}    ${(100 * s.w / s.n).toFixed(1).padStart(5)}%   ${s.totalR >= 0 ? "+" : ""}${s.totalR.toFixed(2).padStart(7)}`);
  isCum += s.totalR;
}
console.log(`  ${"TOTAL".padEnd(9)}                    ${isCum >= 0 ? "+" : ""}${isCum.toFixed(2)}`);

process.exit(0);
