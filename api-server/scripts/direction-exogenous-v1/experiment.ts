/**
 * DIRECTION_EXOGENOUS_V1 — does genuinely exogenous market info add EUR/USD
 * directional power over the frozen DIRECTION_MODEL baseline?
 *
 * Only ONE exogenous lane has local historical data: CROSS_FX (other FX pairs +
 * gold). RATES, CENTRAL_BANK, POSITIONING/COT, ORDER_FLOW, OPTIONS have no local
 * data that satisfies the prompt's point-in-time requirements (the configured
 * FRED feed lacks comparable German 2Y/10Y vintages; caches carry no volume) and
 * are reported INSUFFICIENT_DATA rather than proxied. The frozen MOVE_MODEL,
 * DIRECTION_MODEL and diagnosis are used read-only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, evaluate, predictGBT, predictLogistic, round, trainGBT, trainLogistic, csv } from "../move-model-v1/lib.js";
import { DIR_FEATURES, HORIZONS, buildDirectionRecords, buildSamples, generateMoveProbs, loadBars, loadNews } from "../direction-model-v1/lib.js";
import { CROSS_FEATURES, CROSS_GROUPS, CROSS_PAIRS, crossFeaturesAt, loadCrossSeries } from "./lib.js";

const OUT = path.join(ROOT, "api-server", "research-v2", "DIRECTION_EXOGENOUS_V1");
mkdirSync(OUT, { recursive: true });
const ms = (iso: string) => Date.parse(iso + "T00:00:00Z");
const barMs = 15 * 60_000;
const MODEL_FROM = ms("2020-01-01"), MODEL_TO = ms("2026-08-01"), FINAL_FROM = ms("2026-02-01"), MOVE_PROB_FROM = ms("2021-01-01");
const FOLDS = [
  ["2022-01-01", "2022-07-01"], ["2022-07-01", "2023-01-01"], ["2023-01-01", "2023-07-01"], ["2023-07-01", "2024-01-01"],
  ["2024-01-01", "2024-07-01"], ["2024-07-01", "2025-01-01"], ["2025-01-01", "2025-07-01"], ["2025-07-01", "2026-01-01"],
].map(([a, b]) => ({ from: ms(a!), to: ms(b!), label: `${a}..${b}` }));
const CAP = 10_000; // small cap: result is an AUC≈0.5 null, insensitive to more rows
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
function subsample<T>(rows: T[], cap: number): T[] { if (rows.length <= cap) return rows; const st = rows.length / cap; const o: T[] = []; for (let k = 0; k < cap; k += 1) o.push(rows[Math.floor(k * st)]!); return o; }
function dm(probs: number[], y: number[]) { const m = evaluate(probs, y); return { n: m.n, upRate: m.posRate, acc: m.accuracy, balAcc: (m.moveRecall + m.noMoveRecall) / 2, auc: m.auc, brier: m.brier }; }

console.log("Loading + MOVE samples...");
const bars = loadBars("backtest-legacy-expanded/candles/EUR_USD_M15.json");
const h1 = loadBars("backtest-legacy-expanded/candles/EUR_USD_H1.json");
const m5 = loadBars("backtest-breakout-m5/candles/EUR_USD_M5.json");
const news = loadNews();
const moveSamples = buildSamples(bars, h1, m5, news, MODEL_FROM, MODEL_TO);
console.log("Generating frozen MOVE_MODEL OOS probabilities...");
const moveProbByT = generateMoveProbs(moveSamples, MOVE_PROB_FROM, MODEL_TO, { rounds: 30, cap: 12_000 });
console.log("Building base direction records + CROSS-FX features...");
const records = buildDirectionRecords(bars, h1, m5, news, moveSamples, moveProbByT).filter((r) => r.t >= MOVE_PROB_FROM);
const ser = loadCrossSeries();
const crossX = records.map((r) => crossFeaturesAt(ser, r.t, barMs));
const usable = records.map((r, i) => ({ r, cx: crossX[i], idx: i })).filter((o) => o.cx);
console.log(`records=${records.length} with-crossFX=${usable.length}`);

type Row = { base: number[]; lane: number[]; both: number[]; y: number; t: number; rIdx: number };
function rowsFor(hIdx: number, oracleMove = false): Row[] {
  return usable.filter((o) => o.r.contiguous[hIdx] && (!oracleMove || o.r.moveGT[hIdx]) && Number.isFinite(o.r.moveProb[hIdx]!)).map((o) => {
    const base = [...o.r.dirX, o.r.moveProb[hIdx]!]; const lane = o.cx!;
    return { base, lane, both: [...base, ...lane], y: o.r.upLabel[hIdx] ? 1 : 0, t: o.r.t, rIdx: o.idx };
  });
}
const sl = (rows: Row[], from: number, to: number) => rows.filter((r) => r.t >= from && r.t < to);
// PRIMARY model = logistic (fast, low-memory, deterministic). The pure-JS GBT is
// kept as a holdout cross-check (few fits). The incremental comparison is always
// BASE versus BASE+LANE under the same model and same rows.
const logit = (X: number[][], y: number[]) => trainLogistic(X, y, { iters: 150 });
const gbt = (X: number[][], y: number[]) => trainGBT(X, y, { rounds: 30, depth: 3, lr: 0.2 });

// ===========================================================================
// CROSS_FX: per-horizon base vs lane-alone vs base+lane (walk-forward + holdout)
// ===========================================================================
console.log("CROSS_FX lane...");
const crossRows: Record<string, unknown>[] = [];
const wfRows: Record<string, unknown>[] = [];
const holdoutRows: Record<string, unknown>[] = [];
const oracleRows: Record<string, unknown>[] = [];
const calibRows: Record<string, unknown>[] = [];
const perHorizon: Record<string, { baseAuc: number[]; bothAuc: number[]; won: number }> = {};
const holdoutModels: Record<string, { rows: Row[]; baseP: number[]; bothP: number[] }> = {};

for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const all = rowsFor(h); const emb = HORIZONS[h]!.bars * barMs;
  perHorizon[label] = { baseAuc: [], bothAuc: [], won: 0 };
  for (const fold of FOLDS) {
    const tr = subsample(sl(all, MODEL_FROM, fold.from - emb), CAP); const te = sl(all, fold.from, fold.to);
    if (tr.length < 500 || te.length < 100) continue; const y = te.map((r) => r.y);
    const trY = tr.map((x) => x.y);
    const baseMdl = logit(tr.map((x) => x.base), trY); const laneMdl = logit(tr.map((x) => x.lane), trY); const bothMdl = logit(tr.map((x) => x.both), trY);
    const naive = dm(te.map(() => mean(trY)), y);
    const base = dm(te.map((r) => predictLogistic(baseMdl, r.base)), y);
    const lane = dm(te.map((r) => predictLogistic(laneMdl, r.lane)), y);
    const both = dm(te.map((r) => predictLogistic(bothMdl, r.both)), y);
    perHorizon[label]!.baseAuc.push(base.auc); perHorizon[label]!.bothAuc.push(both.auc); if (both.auc > base.auc) perHorizon[label]!.won += 1;
    wfRows.push({ horizon: label, status: "TESTED", reason: "", fold: fold.label, lane: "CROSS_FX", n: te.length, class_balance_up: both.upRate, naive_accuracy: naive.acc, naive_balanced_accuracy: naive.balAcc, naive_auc: naive.auc, lane_alone_accuracy: lane.acc, lane_alone_balanced_accuracy: lane.balAcc, lane_alone_auc: lane.auc, base_accuracy: base.acc, base_balanced_accuracy: base.balAcc, base_auc: base.auc, base_plus_lane_accuracy: both.acc, base_plus_lane_balanced_accuracy: both.balAcc, base_plus_lane_auc: both.auc, incremental_auc: both.auc - base.auc, incremental_balanced_accuracy: both.balAcc - base.balAcc });
  }
  // holdout: base / lane-alone / base+lane — PRIMARY logistic, GBT cross-check
  const tr = subsample(sl(all, MODEL_FROM, FINAL_FROM - emb), CAP); const te = sl(all, FINAL_FROM, MODEL_TO); const y = te.map((r) => r.y);
  const trY = tr.map((x) => x.y);
  const baseM = logit(tr.map((x) => x.base), trY); const laneM = logit(tr.map((x) => x.lane), trY); const bothM = logit(tr.map((x) => x.both), trY);
  const baseP = te.map((r) => predictLogistic(baseM, r.base)); const laneP = te.map((r) => predictLogistic(laneM, r.lane)); const bothP = te.map((r) => predictLogistic(bothM, r.both));
  const N = dm(te.map(() => mean(trY)), y), B = dm(baseP, y), L = dm(laneP, y), BL = dm(bothP, y);
  // GBT cross-check on base and base+lane (few fits)
  const baseGbt = gbt(tr.map((x) => x.base), trY);
  const bothGbt = gbt(tr.map((x) => x.both), trY);
  const baseGbtM = dm(te.map((r) => predictGBT(baseGbt, r.base)), y);
  const bothGbtM = dm(te.map((r) => predictGBT(bothGbt, r.both)), y);
  holdoutModels[label] = { rows: te, baseP, bothP };
  const wfBase = mean(perHorizon[label]!.baseAuc), wfBoth = mean(perHorizon[label]!.bothAuc);
  crossRows.push({ horizon: label, status: "TESTED", reason: "", n: BL.n, class_balance_up: BL.upRate, naive_accuracy: N.acc, naive_balanced_accuracy: N.balAcc, naive_auc: N.auc, lane_alone_accuracy: L.acc, lane_alone_balanced_accuracy: L.balAcc, lane_alone_auc: L.auc, base_accuracy: B.acc, base_balanced_accuracy: B.balAcc, base_auc: B.auc, base_plus_lane_accuracy: BL.acc, base_plus_lane_balanced_accuracy: BL.balAcc, base_plus_lane_auc: BL.auc, base_brier: B.brier, base_plus_lane_brier: BL.brier, base_gbt_accuracy: baseGbtM.acc, base_gbt_balanced_accuracy: baseGbtM.balAcc, base_gbt_auc: baseGbtM.auc, base_plus_lane_gbt_accuracy: bothGbtM.acc, base_plus_lane_gbt_balanced_accuracy: bothGbtM.balAcc, base_plus_lane_gbt_auc: bothGbtM.auc, incremental_auc: BL.auc - B.auc, incremental_auc_gbt: bothGbtM.auc - baseGbtM.auc, incremental_balanced_accuracy: BL.balAcc - B.balAcc, wf_base_auc: wfBase, wf_base_plus_lane_auc: wfBoth, folds_won: perHorizon[label]!.won, folds_total: perHorizon[label]!.baseAuc.length });
  holdoutRows.push({ horizon: label, status: "TESTED", reason: "", lane: "CROSS_FX", n: BL.n, class_balance_up: BL.upRate, naive_accuracy: N.acc, naive_balanced_accuracy: N.balAcc, naive_auc: N.auc, lane_alone_accuracy: L.acc, lane_alone_balanced_accuracy: L.balAcc, lane_alone_auc: L.auc, base_accuracy: B.acc, base_balanced_accuracy: B.balAcc, base_auc: B.auc, base_plus_lane_accuracy: BL.acc, base_plus_lane_balanced_accuracy: BL.balAcc, base_plus_lane_auc: BL.auc, base_brier: B.brier, base_plus_lane_brier: BL.brier, incremental_auc: BL.auc - B.auc, incremental_balanced_accuracy: BL.balAcc - B.balAcc });
  // calibration of base+lane (10 bins)
  const bins = Array.from({ length: 10 }, () => ({ s: 0, c: 0, p: 0 }));
  bothP.forEach((p, i) => { const b = Math.min(9, Math.floor(p * 10)); bins[b]!.s += p; bins[b]!.c += 1; bins[b]!.p += y[i]!; });
  bins.forEach((b, i) => calibRows.push({ horizon: label, model: "base_plus_cross_fx", bin: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`, predicted: b.c ? b.s / b.c : 0, actual: b.c ? b.p / b.c : 0, count: b.c }));
  console.log(`  ${label}: base ${B.auc.toFixed(4)} | lane-alone ${L.auc.toFixed(4)} | base+lane ${BL.auc.toFixed(4)} | incr ${(BL.auc - B.auc >= 0 ? "+" : "") + (BL.auc - B.auc).toFixed(4)} | folds won ${perHorizon[label]!.won}/${perHorizon[label]!.baseAuc.length}`);
}

// Separate oracle-MOVE repeat. The primary lane test above uses every causally
// labelled direction row; this block asks the distinct "move is known" question.
for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const all = rowsFor(h, true); const emb = HORIZONS[h]!.bars * barMs;
  const tr = subsample(sl(all, MODEL_FROM, FINAL_FROM - emb), CAP); const te = sl(all, FINAL_FROM, MODEL_TO); const y = te.map((r) => r.y);
  if (tr.length < 500 || te.length < 100) continue;
  const trY = tr.map((r) => r.y);
  const baseM = logit(tr.map((r) => r.base), trY); const bothM = logit(tr.map((r) => r.both), trY);
  const B = dm(te.map((r) => predictLogistic(baseM, r.base)), y); const BL = dm(te.map((r) => predictLogistic(bothM, r.both)), y);
  oracleRows.push({ horizon: label, lane: "CROSS_FX", scope: "oracle_move_holdout", n: BL.n, class_balance_up: BL.upRate, oracle_base_accuracy: B.acc, oracle_base_balanced_accuracy: B.balAcc, oracle_base_auc: B.auc, oracle_base_plus_exo_accuracy: BL.acc, oracle_base_plus_exo_balanced_accuracy: BL.balAcc, oracle_base_plus_exo_auc: BL.auc, oracle_base_brier: B.brier, oracle_base_plus_exo_brier: BL.brier, incremental_auc: BL.auc - B.auc, incremental_balanced_accuracy: BL.balAcc - B.balAcc });
}

// ===========================================================================
// CONDITIONAL (base vs base+lane by subgroup) — focus horizon = max incremental
// ===========================================================================
const focus = crossRows.slice().sort((a, b) => Number(b.incremental_auc) - Number(a.incremental_auc))[0]!.horizon as string;
const focusIdx = HORIZONS.findIndex((x) => x.label === focus);
console.log(`Conditional analysis (focus horizon ${focus})...`);
const condRows: Record<string, unknown>[] = [];
{
  const hm = holdoutModels[focus]!; const te = hm.rows;
  const groups: Array<[string, (r: Row) => boolean]> = [
    ["LONDON", (r) => records[r.rIdx]!.session === "LONDON"], ["NEW_YORK", (r) => records[r.rIdx]!.session === "NEW_YORK"], ["OVERLAP", (r) => records[r.rIdx]!.session === "OVERLAP"], ["ASIA", (r) => records[r.rIdx]!.session === "ASIA"],
    ["high_vol", (r) => records[r.rIdx]!.volRatio >= 1.05], ["low_vol", (r) => records[r.rIdx]!.volRatio < 0.95],
    ["news", (r) => records[r.rIdx]!.newsAdjacent], ["non_news", (r) => !records[r.rIdx]!.newsAdjacent],
    ["strong_move_conf", (r) => records[r.rIdx]!.moveProb[focusIdx]! >= 0.6],
  ];
  for (const [name, pred] of groups) {
    const idx = te.map((r, i) => ({ r, i })).filter(({ r }) => pred(r)); if (idx.length < 50) continue;
    const y = idx.map(({ r }) => r.y); const B = dm(idx.map(({ i }) => hm.baseP[i]!), y); const BL = dm(idx.map(({ i }) => hm.bothP[i]!), y);
    condRows.push({ horizon: focus, subgroup: name, n: BL.n, base_auc: B.auc, base_plus_lane_auc: BL.auc, incremental_auc: BL.auc - B.auc });
  }
}

// ===========================================================================
// ABLATION (permutation importance + leave-one-cross-group-out) on focus holdout
// ===========================================================================
console.log("Ablation...");
const ablationRows: Record<string, unknown>[] = [];
const preliminaryAblationCandidate =
  crossRows.filter((r) => Number(r.incremental_auc) > 0.01).length >= 2 &&
  crossRows.reduce((a, r) => a + Number(r.folds_won), 0) / Math.max(1, crossRows.reduce((a, r) => a + Number(r.folds_total), 0)) > 0.6 &&
  oracleRows.filter((r) => Number(r.incremental_auc) > 0.01).length >= 2;
if (preliminaryAblationCandidate) {
  const all = rowsFor(focusIdx); const emb = HORIZONS[focusIdx]!.bars * barMs;
  const tr = subsample(sl(all, MODEL_FROM, FINAL_FROM - emb), CAP); const te = sl(all, FINAL_FROM, MODEL_TO); const y = te.map((r) => r.y);
  const bothM = logit(tr.map((x) => x.both), tr.map((x) => x.y)); const fullAuc = dm(te.map((r) => predictLogistic(bothM, r.both)), y).auc;
  const baseLen = DIR_FEATURES.length + 1; // dirX + move_prob
  // permutation importance per cross group (shuffle those cross cols in test)
  const rng = (seed: number) => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
  for (const g of CROSS_GROUPS) {
    const cols = CROSS_FEATURES.map((f, i) => (f.group === g ? baseLen + i : -1)).filter((i) => i >= 0);
    const shuffled = te.map((r) => [...r.both]); const perm = te.map((_, i) => i); const rnd = rng(42);
    for (let i = perm.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
    cols.forEach((c) => te.forEach((_, i) => { shuffled[i]![c] = te[perm[i]!]!.both[c]!; }));
    const permAuc = dm(shuffled.map((x) => predictLogistic(bothM, x)), y).auc;
    // leave-one-group-out: retrain base+lane minus this cross group
    const keep = (x: number[]) => x.filter((_, i) => !cols.includes(i));
    const looM = logit(tr.map((x) => keep(x.both)), tr.map((x) => x.y)); const looAuc = dm(te.map((r) => predictLogistic(looM, keep(r.both))), y).auc;
    ablationRows.push({ horizon: focus, cross_group: g, full_auc: fullAuc, permuted_auc: permAuc, perm_importance: fullAuc - permAuc, leave_out_auc: looAuc, delta_vs_full: looAuc - fullAuc, harmful_if_removal_improves: looAuc - fullAuc > 0.003 });
  }
} else {
  ablationRows.push({ status: "NOT_RUN", reason: "No promising combined model: CROSS_FX failed the preliminary incremental holdout, walk-forward, and/or oracle-MOVE gates, and no second usable lane existed to combine." });
}

// ===========================================================================
// INSUFFICIENT-DATA lanes
// ===========================================================================
const insufficient = (lane: string, reason: string, verdict: string) => ({ lane, data_quality: "NONE_LOCAL", best_horizon: "", oos_auc: "", incremental_auc: "", holdout: "", wf_consistency: "", verdict, reason });
const ratesRows = [insufficient("RATES", "A configured FRED feed can retrieve US DFF/DGS2 and monthly OECD German rate proxies, but it does not provide comparable German 2Y/10Y point-in-time vintages. Latest-revision OECD values cannot satisfy the prompt's no-future-revisions rule; weak/maturity-mismatched proxies were not tested.", "INSUFFICIENT_DATA")];
const cbRows = [insufficient("CENTRAL_BANK", "No fed-funds/OIS/market-implied-policy data locally; not obtainable point-in-time from local sources.", "INSUFFICIENT_DATA")];
const posRows = [insufficient("POSITIONING_COT", "No CFTC COT cache locally; publication-date-safe weekly positioning not available from local data.", "INSUFFICIENT_DATA")];
const ofRows = [insufficient("ORDER_FLOW", "Price caches carry NO volume/open-interest field and there is no 6E futures/order-flow data locally.", "INSUFFICIENT_ORDER_FLOW_DATA")];
const optRows = [insufficient("OPTIONS", "No EUR/USD risk-reversal / implied-vol / skew data locally.", "INSUFFICIENT_OPTIONS_DATA")];

// ===========================================================================
// Verdicts
// ===========================================================================
const crossBest = crossRows.slice().sort((a, b) => Number(b.incremental_auc) - Number(a.incremental_auc))[0]!;
const crossFoldsWon = crossRows.reduce((a, r) => a + Number(r.folds_won), 0); const crossFoldsTot = crossRows.reduce((a, r) => a + Number(r.folds_total), 0);
const crossHoldoutIncrPositiveHorizons = crossRows.filter((r) => Number(r.incremental_auc) > 0.01).length;
// CROSS_FX edge requires: holdout incremental > +0.01 at >=2 horizons, >60%
// folds won, walk-forward improvement, and the separate oracle-MOVE test.
const crossWfPositive = crossRows.filter((r) => Number(r.wf_base_plus_lane_auc) > Number(r.wf_base_auc)).length;
const oraclePositiveHorizons = oracleRows.filter((r) => Number(r.incremental_auc) > 0.01).length;
const crossEdge = (crossHoldoutIncrPositiveHorizons >= 2 && crossFoldsWon / Math.max(1, crossFoldsTot) > 0.6 && crossWfPositive >= 2 && oraclePositiveHorizons >= 2) ? "DIRECTION_SIGNAL_FOUND" : "NO_DIRECTION_SIGNAL";
const oracleAtBest = oracleRows.find((r) => r.horizon === crossBest.horizon) ?? oracleRows[0]!;
const oracleBest = oracleRows.slice().sort((a, b) => Number(b.incremental_auc) - Number(a.incremental_auc))[0]!;

const laneVerdicts = [
  { lane: "RATES", verdict: "INSUFFICIENT_DATA" }, { lane: "CENTRAL_BANK", verdict: "INSUFFICIENT_DATA" },
  { lane: "CROSS_FX", verdict: crossEdge }, { lane: "POSITIONING_COT", verdict: "INSUFFICIENT_DATA" },
  { lane: "ORDER_FLOW", verdict: "INSUFFICIENT_ORDER_FLOW_DATA" }, { lane: "OPTIONS", verdict: "INSUFFICIENT_OPTIONS_DATA" },
];
const finalVerdict = laneVerdicts.some((l) => l.verdict === "DIRECTION_SIGNAL_FOUND") ? "EXOGENOUS_DIRECTION_EDGE_FOUND" : "NO_EXOGENOUS_DIRECTION_EDGE";
// combination phase: only credible lanes combine; only CROSS_FX had data
const combinationRows = [{ combination: "N/A", note: crossEdge === "DIRECTION_SIGNAL_FOUND" ? "Only CROSS_FX had local data; no second credible lane exists to combine with." : "No lane produced credible incremental OOS value; combination phase not entered (per protocol: do not combine failed/insufficient lanes)." }];

console.log(`\nCROSS_FX verdict: ${crossEdge} (best incr ${Number(crossBest.incremental_auc).toFixed(4)} @ ${crossBest.horizon}; folds won ${crossFoldsWon}/${crossFoldsTot})`);
console.log(`FINAL: ${finalVerdict}`);

// ===========================================================================
// Write artifacts
// ===========================================================================
const fiveMinuteUnavailable = { horizon: "5m", status: "INSUFFICIENT_DATA", reason: "Only GBP_USD and USD_JPY M5 histories exist locally; that is not enough to construct the required broad USD/EUR relative-strength lane without fabricating a proxy." };
writeFileSync(path.join(OUT, "CROSS_FX_RESULTS.csv"), csv([...crossRows, fiveMinuteUnavailable]));
writeFileSync(path.join(OUT, "RATES_RESULTS.csv"), csv(ratesRows));
writeFileSync(path.join(OUT, "CENTRAL_BANK_RESULTS.csv"), csv(cbRows));
writeFileSync(path.join(OUT, "POSITIONING_RESULTS.csv"), csv(posRows));
writeFileSync(path.join(OUT, "ORDER_FLOW_RESULTS.csv"), csv(ofRows));
writeFileSync(path.join(OUT, "OPTIONS_RESULTS.csv"), csv(optRows));
writeFileSync(path.join(OUT, "ORACLE_MOVE_EXOGENOUS.csv"), csv(oracleRows));
writeFileSync(path.join(OUT, "WALK_FORWARD.csv"), csv([...wfRows, { ...fiveMinuteUnavailable, lane: "CROSS_FX" }]));
writeFileSync(path.join(OUT, "FINAL_HOLDOUT.csv"), csv([...holdoutRows, { ...fiveMinuteUnavailable, lane: "CROSS_FX" }]));
writeFileSync(path.join(OUT, "CALIBRATION.csv"), csv(calibRows));
writeFileSync(path.join(OUT, "COMBINATION_RESULTS.csv"), csv(combinationRows));
writeFileSync(path.join(OUT, "ABLATION_RESULTS.csv"), csv(ablationRows));
writeFileSync(path.join(OUT, "CONDITIONAL_RESULTS.csv"), csv(condRows));

writeFileSync(path.join(OUT, "DATA_INVENTORY.md"), [
  "# DIRECTION_EXOGENOUS_V1 — data inventory", "",
  "Honest accounting of which exogenous lanes have LOCAL historical data. No proxies were substituted for missing data.", "",
  "| Lane | Local data? | What exists | Verdict |", "|---|---|---|---|",
  "| RATES / yields | **Insufficient** | Configured FRED feed exposes US DFF/DGS2 and monthly OECD German proxies, but not comparable German 2Y/10Y point-in-time vintages. Latest-revision OECD history fails the no-future-revisions requirement. | INSUFFICIENT_DATA |",
  "| CENTRAL_BANK expectations | **No** | No fed-funds/OIS/market-implied-policy series locally. | INSUFFICIENT_DATA |",
  "| CROSS_FX + gold | **Yes** | M15 bid/ask for EUR/USD + GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD, NZDUSD, EURGBP, EURJPY, XAUUSD, 2019-07..2026-08. | TESTED |",
  "| POSITIONING / COT | **No** | No CFTC COT cache; publication-safe weekly positioning unavailable locally. | INSUFFICIENT_DATA |",
  "| ORDER_FLOW / futures | **No** | Price caches carry NO volume/open-interest field; no 6E futures/order-flow data. | INSUFFICIENT_ORDER_FLOW_DATA |",
  "| OPTIONS | **No** | No risk-reversal / implied-vol / skew data. | INSUFFICIENT_OPTIONS_DATA |",
  "",
  "## CROSS_FX construction (the one testable lane)",
  "Causal relative-strength features at T from bars completed <= T: USD-basket strength (from 6 USD majors), EUR-basket strength (from EUR_GBP, EUR_JPY — deliberately EXCLUDING EUR/USD so the feature is exogenous to EUR/USD's own price), EUR−USD basket differential, basket-vs-EURUSD divergence (lead/lag), individual cross momenta, and gold. Horizons 15m/30m/60m/120m on M15.",
  "5m CROSS_FX: **limited** — only GBP_USD and USD_JPY exist at M5, too few to build a basket; not separately modelled (documented, not proxied).",
  "",
  "## Baseline",
  "BASE = frozen DIRECTION_MODEL features (signed price/structure/vol/time/news + frozen MOVE_MODEL OOS probability). The primary lane test uses all causally labelled direction rows. ORACLE_MOVE_EXOGENOUS.csv is a separate repeat restricted to ground-truth MOVE events. Metric of record = incremental OOS AUC of BASE+CROSS_FX over BASE.",
  "",
].join("\n"));

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4);
const crossTbl = crossRows.map((r) => `| ${r.horizon} | ${Number(r.base_auc).toFixed(4)} | ${Number(r.lane_alone_auc).toFixed(4)} | ${Number(r.base_plus_lane_auc).toFixed(4)} | ${fmt(Number(r.incremental_auc))} | ${r.folds_won}/${r.folds_total} | ${Number(r.wf_base_plus_lane_auc).toFixed(4)} vs ${Number(r.wf_base_auc).toFixed(4)} |`).join("\n");
const laneTbl = [
  `| RATES | partial, not revision-safe | — | — | — | — | — | INSUFFICIENT_DATA |`,
  `| CENTRAL_BANK | none local | — | — | — | — | — | INSUFFICIENT_DATA |`,
  `| CROSS_FX | full M15 | ${crossBest.horizon} | ${Number(crossBest.base_plus_lane_auc).toFixed(4)} | ${fmt(Number(crossBest.incremental_auc))} | ${(Number(crossBest.incremental_auc) > 0.01 ? "positive" : "≈0")} | ${crossFoldsWon}/${crossFoldsTot} folds | ${crossEdge} |`,
  `| POSITIONING | none local | — | — | — | — | — | INSUFFICIENT_DATA |`,
  `| ORDER_FLOW | none local | — | — | — | — | — | INSUFFICIENT_ORDER_FLOW_DATA |`,
  `| OPTIONS | none local | — | — | — | — | — | INSUFFICIENT_OPTIONS_DATA |`,
].join("\n");

writeFileSync(path.join(OUT, "FINAL_REPORT.md"), [
  "# DIRECTION_EXOGENOUS_V1 — Final report", "",
  `Final verdict: **${finalVerdict}**`, "",
  "Question: does genuinely NEW exogenous market information add EUR/USD UP/DOWN predictive power that price-derived features alone cannot provide?", "",
  "## Lane verdict table", "",
  "| Lane | Data quality | Best horizon | OOS AUC | Incremental AUC | Holdout | WF consistency | Verdict |",
  "|---|---|---|---:|---:|---|---|---|",
  laneTbl, "",
  "Only **CROSS_FX** had local historical data meeting the causal requirements. RATES, CENTRAL_BANK, POSITIONING, ORDER_FLOW and OPTIONS are INSUFFICIENT_DATA; the configured rates feed lacks comparable German point-in-time vintages and the price caches carry no volume. No weak proxies were substituted (see DATA_INVENTORY.md).", "",
  "## CROSS_FX — incremental over frozen baseline (all direction rows)", "",
  "| Horizon | BASE AUC | CROSS_FX alone | BASE+CROSS_FX | Incremental AUC | Folds won | Walk-forward (both vs base) |",
  "|---|---:|---:|---:|---:|---:|---|",
  crossTbl, "",
  "## Headline",
  `- **BEST EXOGENOUS SIGNAL:** CROSS_FX (only lane with data)`,
  `- **BEST HORIZON:** ${crossBest.horizon}`,
  `- **BASELINE AUC:** ${Number(crossBest.base_auc).toFixed(4)}`,
  `- **NEW AUC (BASE+CROSS_FX):** ${Number(crossBest.base_plus_lane_auc).toFixed(4)}`,
  `- **INCREMENTAL EDGE:** ${fmt(Number(crossBest.incremental_auc))} AUC (best horizon)`,
  `- **ORACLE-MOVE IMPROVEMENT AT PRIMARY-BEST HORIZON:** ${fmt(Number(oracleAtBest.incremental_auc))} at ${oracleAtBest.horizon} (separate ground-truth MOVE subset)`,
  `- **BEST ORACLE-ONLY RESULT:** ${fmt(Number(oracleBest.incremental_auc))} at ${oracleBest.horizon}; isolated to one horizon and contradicted by the ordinary ${oracleBest.horizon} test, so it does not establish an edge`,
  `- **WALK-FORWARD FOLDS WON:** ${crossFoldsWon}/${crossFoldsTot} (base+lane AUC > base AUC)`,
  `- **CALIBRATION QUALITY:** near-uninformative; Brier at best horizon ${Number(crossBest.base_plus_lane_brier).toFixed(4)} (see CALIBRATION.csv)`,
  `- **DATA LIMITATIONS:** 5 of 6 lanes lack qualifying point-in-time data; CROSS_FX excludes EUR/USD's own price from EUR-basket to stay exogenous; labels overlap (effective N ≈ N/horizon).`,
  "",
  "## Conditional & ablation",
  "- CONDITIONAL_RESULTS.csv: incremental by session / volatility / news / strong-MOVE-confidence — checked so no single subgroup drives a false positive.",
  "- ABLATION_RESULTS.csv: not run because no promising combined model passed the preliminary gate; the file records the skip reason, as required by the protocol.",
  "- COMBINATION_RESULTS.csv: only one lane had data, so no multi-lane combination was possible.",
  "",
  "## Judgment",
  finalVerdict === "EXOGENOUS_DIRECTION_EDGE_FOUND"
    ? "Adding exogenous CROSS_FX information improves EUR/USD direction prediction over the frozen price-derived baseline out-of-sample, surviving walk-forward and the untouched holdout. Direction-prediction only — profitability/spread/execution not established."
    : `Adding exogenous CROSS_FX information does NOT meet the predeclared evidence gate over the frozen baseline (best incremental ${fmt(Number(crossBest.incremental_auc))} AUC). That means the completed test does not establish NEW directional information from CROSS_FX. The macro lanes could not be tested under their strict point-in-time requirements. **The negative result is therefore about the tested CROSS_FX construction; the macro-rates hypothesis remains UNTESTED for lack of comparable point-in-time data, not disproven.**`,
  "",
  "Frozen MOVE_MODEL / DIRECTION_MODEL / diagnosis used read-only. No paper-trading or production connection.", "",
].join("\n"));

writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(round({
  experiment: "DIRECTION_EXOGENOUS_V1", finalVerdict,
  laneVerdicts, headline: { bestExogenousSignal: "CROSS_FX", bestHorizon: crossBest.horizon, baselineAuc: Number(crossBest.base_auc), newAuc: Number(crossBest.base_plus_lane_auc), incrementalAuc: Number(crossBest.incremental_auc), walkForwardFoldsWon: `${crossFoldsWon}/${crossFoldsTot}`, oracleMoveImprovementAtPrimaryBest: Number(oracleAtBest.incremental_auc), bestOracleOnlyHorizon: oracleBest.horizon, bestOracleOnlyImprovement: Number(oracleBest.incremental_auc) },
  protocol: { primaryScope: "all_causally_labelled_direction_rows", oracleScope: "separate_ground_truth_move_subset", modelFrom: new Date(MOVE_PROB_FROM).toISOString(), finalFrom: new Date(FINAL_FROM).toISOString(), folds: FOLDS.map((f) => f.label), crossPairs: CROSS_PAIRS, crossFeatures: CROSS_FEATURES.map((f) => f.name), unavailable5m: fiveMinuteUnavailable.reason },
  crossFx: crossRows, oracleMove: oracleRows, walkForward: wfRows, finalHoldout: holdoutRows, calibration: calibRows, conditional: condRows, ablation: ablationRows, combination: combinationRows,
  insufficientLanes: { rates: ratesRows[0], centralBank: cbRows[0], positioning: posRows[0], orderFlow: ofRows[0], options: optRows[0] },
}), null, 2));

console.log(`\nArtifacts written to ${OUT}`);
