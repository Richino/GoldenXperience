/**
 * Apply the v2 confidence model as a FILTER on legacy trades.
 * Rule: take the legacy trade (baseline direction + baseline R) only when
 *   (a) model.picked === trade.actualDirection  (model agrees with stack)
 *   AND
 *   (b) |pLong - 0.5| >= threshold  (model is confident enough)
 *
 * Compare OOS across:
 *   - baseline (take all legacy)
 *   - model-flip (take all, use model pick)
 *   - filter-agree at several thresholds
 *
 * Also break out by (with vs without) XAU_USD to see whether the edge is real
 * or just gold.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RES = path.join(serviceRoot, "research-v2", "legacy-direction-confidence-v2-backtest-legacy-expanded", "RESULTS.json");
const summary = JSON.parse(readFileSync(RES, "utf8")) as {
  oosRows: Array<{
    pair: string; decisionTime: string; actualDirection: "long" | "short";
    actualResultR: number; pLong: number; picked: "long" | "short"; impliedR: number;
  }>;
};

type Row = typeof summary.oosRows[number];
const ALL = summary.oosRows;
const FX = ALL.filter((r) => r.pair !== "XAU_USD");
const XAU = ALL.filter((r) => r.pair === "XAU_USD");

const stats = (rows: Row[], predicate: (r: Row) => boolean, useModelPick = false) => {
  const kept = rows.filter(predicate);
  if (!kept.length) return { n: 0, w: 0, totalR: 0, wr: 0, exp: 0 };
  let totalR = 0, w = 0;
  for (const r of kept) {
    const R = useModelPick ? r.impliedR : r.actualResultR;
    totalR += R;
    if (R > 0) w++;
  }
  return { n: kept.length, w, totalR, wr: 100 * w / kept.length, exp: totalR / kept.length };
};

const line = (label: string, s: { n: number; wr: number; totalR: number; exp: number }) =>
  `  ${label.padEnd(38)} n=${String(s.n).padStart(4)}  wr=${s.wr.toFixed(1).padStart(5)}%  totalR=${(s.totalR >= 0 ? "+" : "") + s.totalR.toFixed(2).padStart(7)}  expR/trade=${s.exp.toFixed(4).padStart(8)}`;

const runOn = (label: string, rows: Row[]) => {
  console.log(`\n=== ${label}  (n=${rows.length}) ===`);
  console.log(line("baseline (take all)", stats(rows, () => true)));
  console.log(line("model pick (take all, invert if disagree)", stats(rows, () => true, true)));
  console.log();
  console.log(`  --- filter: only trades where model AGREES with stack + confidence threshold ---`);
  for (const t of [0.00, 0.05, 0.10, 0.15, 0.20]) {
    const s = stats(rows, (r) => r.picked === r.actualDirection && Math.abs(r.pLong - 0.5) >= t);
    console.log(line(`agree & |P-0.5|>=${t.toFixed(2)}`, s));
  }
  console.log();
  console.log(`  --- alt: model DISAGREES (inversion filter, for comparison) ---`);
  for (const t of [0.00, 0.05, 0.10]) {
    const s = stats(rows, (r) => r.picked !== r.actualDirection && Math.abs(r.pLong - 0.5) >= t, true);
    console.log(line(`disagree & |P-0.5|>=${t.toFixed(2)} (take model pick)`, s));
  }
};

runOn("ALL 12 pairs — OOS", ALL);
runOn("FX ONLY (drop XAU_USD) — OOS", FX);
runOn("XAU_USD ONLY — OOS", XAU);

process.exit(0);
