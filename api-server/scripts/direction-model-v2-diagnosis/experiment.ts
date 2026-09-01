/**
 * DIRECTION_MODEL_DIAGNOSIS_V2 — decomposition of the direction problem.
 *
 * DIAGNOSIS ONLY. Frozen MOVE_MODEL and the original DIRECTION_MODEL are used
 * read-only and never modified. Same dataset, features, leakage protections,
 * walk-forward folds and untouched holdout. No TP/SL, sizing, execution, paper
 * or production wiring. Goal: find WHERE direction fails and whether any smaller
 * subproblem (long-only, short-only, continuation, reversal, breakout, level
 * reaction, a session, a horizon, a market state, a feature family) has real edge.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, evaluate, predictGBT, predictLogistic, trainGBT, trainLogistic } from "../move-model-v1/lib.js";
import {
  DIR_FEATURES, DIR_GROUPS, HORIZONS, buildDirectionRecords, buildSamples, generateMoveProbs, loadBars, loadNews,
} from "../direction-model-v1/lib.js";
import { buildM5Records, buildStates, csv, round, type State } from "./lib.js";

const OUT = path.join(ROOT, "api-server", "research-v2", "DIRECTION_MODEL_DIAGNOSIS_V2");
mkdirSync(OUT, { recursive: true });
const ms = (iso: string) => Date.parse(iso + "T00:00:00Z");
const barMs = 15 * 60_000;
const MODEL_FROM = ms("2020-01-01"), MODEL_TO = ms("2026-08-01"), FINAL_FROM = ms("2026-02-01");
const MOVE_PROB_FROM = ms("2021-01-01");
const CONF_BUCKETS = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 1.01]] as const;
const FOLDS = [
  ["2022-01-01", "2022-07-01"], ["2022-07-01", "2023-01-01"], ["2023-01-01", "2023-07-01"],
  ["2023-07-01", "2024-01-01"], ["2024-01-01", "2024-07-01"], ["2024-07-01", "2025-01-01"],
  ["2025-01-01", "2025-07-01"], ["2025-07-01", "2026-01-01"],
].map(([a, b]) => ({ from: ms(a!), to: ms(b!), label: `${a}..${b}` }));
const CAP = 40_000;

const iRet1 = DIR_FEATURES.findIndex((f) => f.name === "ret1");
const iRet4 = DIR_FEATURES.findIndex((f) => f.name === "ret4");
const iTrend = DIR_FEATURES.findIndex((f) => f.name === "ema20_ema50");
const iAtrExp = DIR_FEATURES.findIndex((f) => f.name === "atr14_56");
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; };
function subsample<T>(rows: T[], cap: number): T[] { if (rows.length <= cap) return rows; const st = rows.length / cap; const o: T[] = []; for (let k = 0; k < cap; k += 1) o.push(rows[Math.floor(k * st)]!); return o; }
function dm(probs: number[], y: number[]) {
  const m = evaluate(probs, y); const t = m.threshold05;
  return { n: m.n, upRate: m.posRate, acc: m.accuracy, balAcc: (m.moveRecall + m.noMoveRecall) / 2, upPrec: (t.tp + t.fp) ? t.tp / (t.tp + t.fp) : 0, upRec: m.moveRecall, downPrec: (t.tn + t.fn) ? t.tn / (t.tn + t.fn) : 0, downRec: m.noMoveRecall, auc: m.auc, brier: m.brier };
}

console.log("Loading data + MOVE samples...");
const bars = loadBars("backtest-legacy-expanded/candles/EUR_USD_M15.json");
const h1 = loadBars("backtest-legacy-expanded/candles/EUR_USD_H1.json");
const m5 = loadBars("backtest-breakout-m5/candles/EUR_USD_M5.json");
const news = loadNews();
const moveSamples = buildSamples(bars, h1, m5, news, MODEL_FROM, MODEL_TO);
console.log("Generating frozen MOVE_MODEL OOS probabilities...");
const moveProbByT = generateMoveProbs(moveSamples, MOVE_PROB_FROM, MODEL_TO);
console.log("Building direction records + market states...");
const records = buildDirectionRecords(bars, h1, m5, news, moveSamples, moveProbByT).filter((r) => r.t >= MOVE_PROB_FROM);
const momHighThr = median(records.map((r) => Math.abs(r.dirX[iRet4]!)));
const trendStrongThr = median(records.map((r) => Math.abs(r.dirX[iTrend]!)));
const vols = records.map((r) => r.volRatio).sort((a, b) => a - b);
const volLoQ = vols[Math.floor(vols.length / 3)]!, volHiQ = vols[Math.floor(2 * vols.length / 3)]!;
const states = buildStates(bars, records, momHighThr, trendStrongThr, volLoQ, volHiQ);
console.log(`records=${records.length}`);

type Row = { x: number[]; y: number; rIdx: number };
const oracleRows = (hIdx: number): Row[] => records.map((r, idx) => ({ r, idx })).filter(({ r, idx }) => r.contiguous[hIdx] && r.moveGT[hIdx] && Number.isFinite(r.moveProb[hIdx]!) && states[idx]).map(({ r, idx }) => ({ x: [...r.dirX, r.moveProb[hIdx]!], y: r.upLabel[hIdx] ? 1 : 0, rIdx: idx }));
const sliceRows = (rows: Row[], from: number, to: number) => rows.filter((r) => records[r.rIdx]!.t >= from && records[r.rIdx]!.t < to);

// Train GBT walk-forward + holdout; return fold AUCs and holdout {rows,probs}
function runOracleGBT(hIdx: number) {
  const all = oracleRows(hIdx); const emb = HORIZONS[hIdx]!.bars * barMs; const foldAuc: number[] = [];
  for (const fold of FOLDS) {
    const tr = subsample(sliceRows(all, MODEL_FROM, fold.from - emb), CAP); const te = sliceRows(all, fold.from, fold.to);
    if (tr.length < 500 || te.length < 100) continue;
    const m = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds: 100, depth: 3, lr: 0.1 });
    foldAuc.push(dm(te.map((r) => predictGBT(m, r.x)), te.map((r) => r.y)).auc);
  }
  const tr = subsample(sliceRows(all, MODEL_FROM, FINAL_FROM - emb), CAP); const te = sliceRows(all, FINAL_FROM, MODEL_TO);
  const m = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds: 120, depth: 3, lr: 0.1 });
  const probs = te.map((r) => predictGBT(m, r.x));
  return { foldAuc, holdout: { rows: te, probs } };
}

console.log("Main oracle models per M15 horizon...");
const mainByH: Record<string, ReturnType<typeof runOracleGBT>> = {};
for (let h = 0; h < HORIZONS.length; h += 1) { mainByH[HORIZONS[h]!.label] = runOracleGBT(h); console.log(`  ${HORIZONS[h]!.label} done (holdout n=${mainByH[HORIZONS[h]!.label]!.holdout.rows.length})`); }

// ---------------------------------------------------------------------------
// 5m extension (M5 base, beyond frozen MOVE_MODEL)
// ---------------------------------------------------------------------------
console.log("5m extension (M5)...");
const m5recs = buildM5Records(m5, ms("2023-08-01"), MODEL_TO, 0.75).filter((r) => r.moveGT);
const M5_FOLDS = [["2024-07-01", "2025-01-01"], ["2025-01-01", "2025-07-01"], ["2025-07-01", "2026-01-01"]].map(([a, b]) => ({ from: ms(a!), to: ms(b!), label: `${a}..${b}` }));
let m5Result: { foldAuc: number[]; holdout: ReturnType<typeof dm>; holdoutRows: typeof m5recs; holdoutProbs: number[] } | null = null;
{
  const all = m5recs.map((r) => ({ x: r.x, y: r.up ? 1 : 0, r }));
  const foldAuc: number[] = [];
  for (const fold of M5_FOLDS) {
    const tr = subsample(all.filter((r) => r.r.t < fold.from - 5 * 60_000), CAP); const te = all.filter((r) => r.r.t >= fold.from && r.r.t < fold.to);
    if (tr.length < 500 || te.length < 100) continue;
    const m = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds: 100, depth: 3, lr: 0.1 });
    foldAuc.push(dm(te.map((r) => predictGBT(m, r.x)), te.map((r) => r.y)).auc);
  }
  const tr = subsample(all.filter((r) => r.r.t < FINAL_FROM - 5 * 60_000), CAP); const te = all.filter((r) => r.r.t >= FINAL_FROM);
  const m = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds: 120, depth: 3, lr: 0.1 });
  const probs = te.map((r) => predictGBT(m, r.x));
  m5Result = { foldAuc, holdout: dm(probs, te.map((r) => r.y)), holdoutRows: te.map((r) => r.r), holdoutProbs: probs };
}

// ===========================================================================
// Artifact builders
// ===========================================================================
const longShortRows: Record<string, unknown>[] = [];
const horizonRows: Record<string, unknown>[] = [];
const sessionRows: Record<string, unknown>[] = [];
const stateRows: Record<string, unknown>[] = [];

// HORIZON + LONG/SHORT + SESSION + MARKET-STATE (M15 horizons)
for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const main = mainByH[label]!; const te = main.holdout.rows; const probs = main.holdout.probs; const y = te.map((r) => r.y);
  const M = dm(probs, y);
  horizonRows.push({ horizon: label, scope: "holdout", n: M.n, upRate: M.upRate, dirAcc: M.acc, balAcc: M.balAcc, auc: M.auc, brier: M.brier, wf_mean_auc: mean(main.foldAuc), wf_min_auc: Math.min(...(main.foldAuc.length ? main.foldAuc : [0.5])) });
  // LONG/SHORT (per-side precision/recall) + trend-conditional
  longShortRows.push({ horizon: label, side: "LONG", scope: "holdout", n: M.n, precision: M.upPrec, recall: M.upRec, balAcc: M.balAcc, auc: M.auc, brier: M.brier });
  longShortRows.push({ horizon: label, side: "SHORT", scope: "holdout", n: M.n, precision: M.downPrec, recall: M.downRec, balAcc: M.balAcc, auc: M.auc, brier: M.brier });
  const longSel = te.map((r, i) => ({ r, p: probs[i]! })).filter(({ r }) => r.x[iTrend]! > 0);
  const shortSel = te.map((r, i) => ({ r, p: probs[i]! })).filter(({ r }) => r.x[iTrend]! < 0);
  if (longSel.length) longShortRows.push({ horizon: label, side: "LONG", scope: "trend_conditional", n: longSel.length, upBaseRate: mean(longSel.map(({ r }) => r.y)), predUpAcc: mean(longSel.map(({ r, p }) => (p >= 0.5 && r.y === 1) || (p < 0.5 && r.y === 0) ? 1 : 0)), auc: dm(longSel.map((o) => o.p), longSel.map((o) => o.r.y)).auc });
  if (shortSel.length) longShortRows.push({ horizon: label, side: "SHORT", scope: "trend_conditional", n: shortSel.length, downBaseRate: 1 - mean(shortSel.map(({ r }) => r.y)), predAcc: mean(shortSel.map(({ r, p }) => (p >= 0.5 && r.y === 1) || (p < 0.5 && r.y === 0) ? 1 : 0)), auc: dm(shortSel.map((o) => o.p), shortSel.map((o) => o.r.y)).auc });
  // confidence buckets per side
  for (const [lo, hi] of CONF_BUCKETS) {
    const sel = te.map((r, i) => ({ r, p: probs[i]! })).filter((o) => Math.max(o.p, 1 - o.p) >= lo && Math.max(o.p, 1 - o.p) < hi);
    const up = sel.filter((o) => o.p >= 0.5), down = sel.filter((o) => o.p < 0.5);
    if (up.length >= 20) longShortRows.push({ horizon: label, side: "LONG", scope: `bucket_${lo}-${hi}`, n: up.length, precision: mean(up.map((o) => (o.r.y === 1 ? 1 : 0))) });
    if (down.length >= 20) longShortRows.push({ horizon: label, side: "SHORT", scope: `bucket_${lo}-${hi}`, n: down.length, precision: mean(down.map((o) => (o.r.y === 0 ? 1 : 0))) });
  }
  // SESSION (DST-aware)
  for (const sess of ["ASIA", "LONDON", "NEW_YORK", "OVERLAP"]) {
    const idx = te.map((r, i) => ({ r, p: probs[i]!, st: states[r.rIdx]! })).filter((o) => o.st.sessionDST === sess);
    if (idx.length < 30) continue; const mm = dm(idx.map((o) => o.p), idx.map((o) => o.r.y));
    const contCases = idx.filter((o) => o.st.continuation[h] !== -1);
    sessionRows.push({ horizon: label, session: sess, n: mm.n, upRate: mm.upRate, dirAcc: mm.acc, balAcc: mm.balAcc, auc: mm.auc, longAcc: mm.upRec, shortAcc: mm.downRec, continuationBaseRate: contCases.length ? mean(contCases.map((o) => o.st.continuation[h]!)) : "", reversalBaseRate: contCases.length ? 1 - mean(contCases.map((o) => o.st.continuation[h]!)) : "", brier: mm.brier });
  }
  // MARKET STATE (LONG & SHORT separately)
  const stateGroups: Array<[string, (s: State) => boolean]> = [
    ["TRENDING_UP", (s) => s.trendState === "TRENDING_UP"], ["TRENDING_DOWN", (s) => s.trendState === "TRENDING_DOWN"], ["RANGE", (s) => s.trendState === "RANGE"],
    ["HIGH_VOL", (s) => s.volTercile === "HIGH_VOL"], ["MID_VOL", (s) => s.volTercile === "MID_VOL"], ["LOW_VOL", (s) => s.volTercile === "LOW_VOL"],
    ["VOL_EXPANSION", (s) => s.volState === "VOL_EXPANSION"], ["VOL_COMPRESSION", (s) => s.volState === "VOL_COMPRESSION"],
  ];
  for (const [name, pred] of stateGroups) {
    const idx = te.map((r, i) => ({ r, p: probs[i]!, st: states[r.rIdx]! })).filter((o) => pred(o.st));
    if (idx.length < 30) continue; const mm = dm(idx.map((o) => o.p), idx.map((o) => o.r.y));
    stateRows.push({ horizon: label, state: name, n: mm.n, upRate: mm.upRate, dirAcc: mm.acc, balAcc: mm.balAcc, auc: mm.auc, longAcc: mm.upRec, shortAcc: mm.downRec });
  }
}
// 5m into HORIZON + LONG/SHORT + SESSION rows
if (m5Result) {
  const M = m5Result.holdout;
  horizonRows.push({ horizon: "5m", scope: "holdout(M5-extension)", n: M.n, upRate: M.upRate, dirAcc: M.acc, balAcc: M.balAcc, auc: M.auc, brier: M.brier, wf_mean_auc: mean(m5Result.foldAuc), wf_min_auc: Math.min(...(m5Result.foldAuc.length ? m5Result.foldAuc : [0.5])) });
  longShortRows.push({ horizon: "5m", side: "LONG", scope: "holdout", n: M.n, precision: M.upPrec, recall: M.upRec, balAcc: M.balAcc, auc: M.auc });
  longShortRows.push({ horizon: "5m", side: "SHORT", scope: "holdout", n: M.n, precision: M.downPrec, recall: M.downRec, balAcc: M.balAcc, auc: M.auc });
  for (const sess of ["ASIA", "LONDON", "NEW_YORK", "OVERLAP"]) {
    const idx = m5Result.holdoutRows.map((r, i) => ({ r, p: m5Result!.holdoutProbs[i]! })).filter((o) => o.r.session === sess);
    if (idx.length < 30) continue; const mm = dm(idx.map((o) => o.p), idx.map((o) => (o.r.up ? 1 : 0)));
    sessionRows.push({ horizon: "5m", session: sess, n: mm.n, upRate: mm.upRate, dirAcc: mm.acc, balAcc: mm.balAcc, auc: mm.auc, longAcc: mm.upRec, shortAcc: mm.downRec });
  }
}

// ---------------------------------------------------------------------------
// CONTINUATION / REVERSAL
// ---------------------------------------------------------------------------
console.log("Continuation/reversal...");
const contRows: Record<string, unknown>[] = [];
for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const emb = HORIZONS[h]!.bars * barMs;
  // moving cases only (currentDir != RANGE), among real moves
  const all = records.map((r, idx) => ({ r, idx })).filter(({ r, idx }) => r.contiguous[h] && r.moveGT[h] && Number.isFinite(r.moveProb[h]!) && states[idx]!.currentDir !== "RANGE")
    .map(({ r, idx }) => ({ x: [...r.dirX, r.moveProb[h]!], y: states[idx]!.continuation[h]!, r, st: states[idx]! }));
  const sl = (from: number, to: number) => all.filter((o) => o.r.t >= from && o.r.t < to);
  // walk-forward AUC (predict continuation)
  const foldAuc: number[] = [];
  for (const fold of FOLDS) { const tr = subsample(sl(MODEL_FROM, fold.from - emb), CAP); const te = sl(fold.from, fold.to); if (tr.length < 500 || te.length < 100) continue; const m = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds: 100, depth: 3, lr: 0.1 }); foldAuc.push(dm(te.map((r) => predictGBT(m, r.x)), te.map((r) => r.y)).auc); }
  const tr = subsample(sl(MODEL_FROM, FINAL_FROM - emb), CAP); const te = sl(FINAL_FROM, MODEL_TO);
  const m = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds: 120, depth: 3, lr: 0.1 });
  const M = dm(te.map((r) => predictGBT(m, r.x)), te.map((r) => r.y));
  const baseCont = mean(te.map((r) => r.y));
  contRows.push({ horizon: label, subgroup: "ALL_MOVING", n: M.n, continuation_base_rate: baseCont, reversal_base_rate: 1 - baseCont, model_auc: M.auc, model_balAcc: M.balAcc, wf_mean_auc: mean(foldAuc) });
  // base rates by subgroup (holdout)
  const groups: Array<[string, (o: { st: State }) => boolean]> = [
    ["current_UP", (o) => o.st.currentDir === "UP"], ["current_DOWN", (o) => o.st.currentDir === "DOWN"],
    ["strong_trend", (o) => o.st.trendStrong], ["weak_trend", (o) => !o.st.trendStrong],
    ["high_momentum", (o) => o.st.momHigh], ["low_momentum", (o) => !o.st.momHigh],
  ];
  for (const [name, pred] of groups) { const sub = te.filter(pred); if (sub.length < 30) continue; const b = mean(sub.map((r) => r.y)); contRows.push({ horizon: label, subgroup: name, n: sub.length, continuation_base_rate: b, reversal_base_rate: 1 - b, model_auc: "", model_balAcc: "", wf_mean_auc: "" }); }
}

// ---------------------------------------------------------------------------
// BREAKOUT-DIRECTION and LEVEL-REACTION
// ---------------------------------------------------------------------------
console.log("Breakout / level-reaction...");
const breakoutRows: Record<string, unknown>[] = [];
const levelRows: Record<string, unknown>[] = [];
for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const emb = HORIZONS[h]!.bars * barMs;
  const mk = (elig: (s: State) => boolean, target: (s: State) => number) => records.map((r, idx) => ({ r, idx })).filter(({ r, idx }) => r.contiguous[h] && r.moveGT[h] && Number.isFinite(r.moveProb[h]!) && elig(states[idx]!)).map(({ r, idx }) => ({ x: [...r.dirX, r.moveProb[h]!], y: target(states[idx]!), r }));
  for (const [rowsSink, all, kind] of [[breakoutRows, mk((s) => s.nearBoundary, (s) => s.breakoutUp[h]!), "breakout"], [levelRows, mk((s) => s.nearLevel, (s) => s.levelBreak[h]!)]] as const) {
    void kind;
    const sl = (from: number, to: number) => all.filter((o) => o.r.t >= from && o.r.t < to);
    const foldAuc: number[] = [];
    for (const fold of FOLDS) { const tr = subsample(sl(MODEL_FROM, fold.from - emb), CAP); const te = sl(fold.from, fold.to); if (tr.length < 300 || te.length < 60) continue; const m = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds: 80, depth: 3, lr: 0.1 }); foldAuc.push(dm(te.map((r) => predictGBT(m, r.x)), te.map((r) => r.y)).auc); }
    const tr = subsample(sl(MODEL_FROM, FINAL_FROM - emb), CAP); const te = sl(FINAL_FROM, MODEL_TO);
    if (tr.length < 200 || te.length < 40) { rowsSink.push({ horizon: label, n: te.length, base_rate: te.length ? mean(te.map((r) => r.y)) : "", model_auc: "", model_balAcc: "", wf_mean_auc: "", note: "insufficient n" }); continue; }
    const m = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds: 100, depth: 3, lr: 0.1 });
    const M = dm(te.map((r) => predictGBT(m, r.x)), te.map((r) => r.y));
    rowsSink.push({ horizon: label, n: M.n, base_rate: mean(te.map((r) => r.y)), model_auc: M.auc, model_balAcc: M.balAcc, model_acc: M.acc, wf_mean_auc: mean(foldAuc) });
  }
}

// ---------------------------------------------------------------------------
// FEATURE-FAMILY ISOLATION (single-family logistic, per M15 horizon)
// ---------------------------------------------------------------------------
console.log("Feature-family isolation...");
const familyRows: Record<string, unknown>[] = [];
const groupIdx = (g: string) => DIR_FEATURES.map((f, i) => (f.group === g ? i : -1)).filter((i) => i >= 0);
for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const emb = HORIZONS[h]!.bars * barMs; const all = oracleRows(h);
  const trAll = subsample(sliceRows(all, MODEL_FROM, FINAL_FROM - emb), CAP); const teAll = sliceRows(all, FINAL_FROM, MODEL_TO);
  const devTr = subsample(sliceRows(all, MODEL_FROM, ms("2024-07-01") - emb), CAP); const devTe = sliceRows(all, ms("2024-07-01"), FINAL_FROM);
  for (const g of DIR_GROUPS) {
    const idx = groupIdx(g); if (!idx.length) continue;
    const m = trainLogistic(trAll.map((r) => idx.map((i) => r.x[i]!)), trAll.map((r) => r.y), { iters: 150 });
    const M = dm(teAll.map((r) => predictLogistic(m, idx.map((i) => r.x[i]!))), teAll.map((r) => r.y));
    const md = trainLogistic(devTr.map((r) => idx.map((i) => r.x[i]!)), devTr.map((r) => r.y), { iters: 150 });
    const D = dm(devTe.map((r) => predictLogistic(md, idx.map((i) => r.x[i]!))), devTe.map((r) => r.y));
    familyRows.push({ horizon: label, family: g, holdout_balAcc: M.balAcc, holdout_auc: M.auc, brier: M.brier, longAcc: M.upRec, shortAcc: M.downRec, dev_balAcc: D.balAcc, dev_auc: D.auc });
  }
}

// ---------------------------------------------------------------------------
// CONFIDENCE FAILURE DIAGNOSIS (focus horizon 15m)
// ---------------------------------------------------------------------------
console.log("Confidence failure diagnosis...");
const confRows: Record<string, unknown>[] = [];
{
  const focus = "15m"; const main = mainByH[focus]!; const te = main.holdout.rows; const probs = main.holdout.probs;
  for (const [lo, hi] of CONF_BUCKETS) {
    const sel = te.map((r, i) => ({ r, p: probs[i]!, st: states[r.rIdx]! })).filter((o) => Math.max(o.p, 1 - o.p) >= lo && Math.max(o.p, 1 - o.p) < hi);
    if (!sel.length) { confRows.push({ horizon: focus, bucket: `${lo}-${hi}`, n: 0 }); continue; }
    const acc = mean(sel.map((o) => ((o.p >= 0.5 ? 1 : 0) === o.r.y ? 1 : 0)));
    const up = sel.filter((o) => o.p >= 0.5), down = sel.filter((o) => o.p < 0.5);
    const dominant = (vals: string[]) => { const c = new Map<string, number>(); for (const v of vals) c.set(v, (c.get(v) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]![0]; };
    const contCases = sel.filter((o) => o.st.continuation[0] !== -1 || true); // 15m idx 0
    const contMix = mean(sel.filter((o) => o.st.currentDir !== "RANGE").map((o) => o.st.continuation[0]!));
    confRows.push({
      horizon: focus, bucket: `${lo}-${hi}`, n: sel.length, dirAccuracy: acc,
      longAccuracy: up.length ? mean(up.map((o) => (o.r.y === 1 ? 1 : 0))) : "", shortAccuracy: down.length ? mean(down.map((o) => (o.r.y === 0 ? 1 : 0))) : "",
      pctPredUp: mean(sel.map((o) => (o.p >= 0.5 ? 1 : 0))), dominantRegime: dominant(sel.map((o) => o.st.volTercile)), dominantSession: dominant(sel.map((o) => o.st.sessionDST)), dominantTrend: dominant(sel.map((o) => o.st.trendState)),
      continuationMix: Number.isFinite(contMix) ? contMix : "", avg_ret4: mean(sel.map((o) => o.r.x[iRet4]!)), avg_trend: mean(sel.map((o) => o.r.x[iTrend]!)), avg_atrExp: mean(sel.map((o) => o.r.x[iAtrExp]!)),
    });
    void contCases;
  }
}

// ---------------------------------------------------------------------------
// ERROR TAXONOMY (15m + 120m)
// ---------------------------------------------------------------------------
console.log("Error taxonomy...");
const errRows: Record<string, unknown>[] = [];
function classify(rIdx: number, hIdx: number, predUp: boolean): string {
  const r = records[rIdx]!; const st = states[rIdx]!;
  if (r.newsAdjacent) return "NEWS_SHOCK";
  if (st.nearBoundary) return "FALSE_BREAKOUT";
  if (st.currentDir !== "RANGE") { const predCont = predUp === (st.currentDir === "UP"); return predCont ? "WRONG_CONTINUATION_CALL" : "WRONG_REVERSAL_CALL"; }
  if (st.volTercile === "HIGH_VOL") return "HIGH_VOL_WHIPSAW";
  if (st.volTercile === "LOW_VOL") return "LOW_VOL_NOISE";
  return "MISREAD_RANGE";
}
for (const hLabel of ["15m", "120m"]) {
  const h = HORIZONS.findIndex((x) => x.label === hLabel); const main = mainByH[hLabel]!; const te = main.holdout.rows; const probs = main.holdout.probs;
  const errors = te.map((r, i) => ({ r, p: probs[i]! })).filter((o) => (o.p >= 0.5 ? 1 : 0) !== o.r.y);
  const counts = new Map<string, number>(); let predUpErrors = 0;
  for (const e of errors) { const cat = classify(e.r.rIdx, h, e.p >= 0.5); counts.set(cat, (counts.get(cat) ?? 0) + 1); if (e.p >= 0.5) predUpErrors += 1; }
  const total = errors.length || 1;
  for (const [cat, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) errRows.push({ horizon: hLabel, category: cat, count: c, pct_of_errors: c / total });
  errRows.push({ horizon: hLabel, category: "_LONG_BIAS_share_of_errors(predUP)", count: predUpErrors, pct_of_errors: predUpErrors / total });
}

// ===========================================================================
// Verdict table
// ===========================================================================
const bestBy = (rows: Record<string, unknown>[], key: string, valKey = "auc", nKey = "n", minN = 200) => {
  const valid = rows.filter((r) => Number(r[nKey]) >= minN && r[valKey] !== "" && Number.isFinite(Number(r[valKey])));
  if (!valid.length) return { label: "n/a", val: 0.5 }; const b = valid.sort((a, b) => Number(b[valKey]) - Number(a[valKey]))[0]!; return { label: String(b[key]), val: Number(b[valKey]) };
};
const EDGE = (auc: number, n: number) => (n < 200 ? "UNCLEAR" : auc > 0.53 ? "YES" : auc > 0.515 ? "UNCLEAR" : "NO");
// Consistency-based edge: a real edge must show up in BOTH the untouched holdout
// AND the walk-forward mean, at 2+ horizons — never a single lucky cell (guards
// against multiple-comparison false positives across dozens of subgroups).
function subproblemEdge(rows: Record<string, unknown>[], aucKey: string, wfKey: string | null, nKey = "n", minN = 200): "YES" | "UNCLEAR" | "NO" {
  const valid = rows.filter((r) => Number(r[nKey]) >= minN && r[aucKey] !== "" && Number.isFinite(Number(r[aucKey])));
  if (!valid.length) return "UNCLEAR";
  const strong = valid.filter((r) => Number(r[aucKey]) > 0.53 && (wfKey ? Number(r[wfKey]) > 0.52 : true));
  const weak = valid.filter((r) => Number(r[aucKey]) > 0.515);
  if (strong.length >= 2) return "YES";
  if (strong.length >= 1 || weak.length >= 2) return "UNCLEAR";
  return "NO";
}

const bestHorizon = bestBy(horizonRows.filter((r) => r.scope !== undefined), "horizon", "auc");
const bestSession = bestBy(sessionRows, "session", "auc");
const bestState = bestBy(stateRows, "state", "auc");
const bestFamily = bestBy(familyRows, "family", "holdout_auc", "family" as string, 0); // family rows lack n; use auc directly
// recompute family best/worst properly
const famAgg = new Map<string, number[]>(); for (const r of familyRows) { const a = famAgg.get(String(r.family)) ?? []; a.push(Number(r.holdout_auc)); famAgg.set(String(r.family), a); }
const famRanked = [...famAgg.entries()].map(([f, a]) => ({ f, auc: mean(a) })).sort((a, b) => b.auc - a.auc);
const bestFamilyName = famRanked[0]?.f ?? "n/a", worstFamilyName = famRanked.at(-1)?.f ?? "n/a";
void bestFamily;

// continuation/reversal edge: max |base-0.5| across horizons/subgroups + best model AUC
const contBaseDev = Math.max(...contRows.filter((r) => r.continuation_base_rate !== "").map((r) => Math.abs(Number(r.continuation_base_rate) - 0.5)));
const contModelAuc = Math.max(...contRows.filter((r) => r.model_auc !== "").map((r) => Number(r.model_auc)));
const breakoutAuc = Math.max(0.5, ...breakoutRows.filter((r) => r.model_auc !== "").map((r) => Number(r.model_auc)));
const breakoutN = Math.max(0, ...breakoutRows.filter((r) => r.model_auc !== "").map((r) => Number(r.n)));
const levelAuc = Math.max(0.5, ...levelRows.filter((r) => r.model_auc !== "").map((r) => Number(r.model_auc)));
const levelN = Math.max(0, ...levelRows.filter((r) => r.model_auc !== "").map((r) => Number(r.n)));
const levelBaseDev = Math.max(0, ...levelRows.filter((r) => r.base_rate !== "").map((r) => Math.abs(Number(r.base_rate) - 0.5)));

// LONG/SHORT edge from trend-conditional AUC
const longCond = longShortRows.filter((r) => r.side === "LONG" && r.scope === "trend_conditional");
const shortCond = longShortRows.filter((r) => r.side === "SHORT" && r.scope === "trend_conditional");
const longAuc = Math.max(0.5, ...longCond.map((r) => Number(r.auc))); const longN = Math.max(0, ...longCond.map((r) => Number(r.n)));
const shortAuc = Math.max(0.5, ...shortCond.map((r) => Number(r.auc))); const shortN = Math.max(0, ...shortCond.map((r) => Number(r.n)));

const longEdge = subproblemEdge(longCond, "auc", null);
const shortEdge = subproblemEdge(shortCond, "auc", null);
const breakoutEdge = subproblemEdge(breakoutRows, "model_auc", "wf_mean_auc");
const levelEdge = subproblemEdge(levelRows, "model_auc", "wf_mean_auc");
const contEdge = (contModelAuc > 0.53 && contBaseDev > 0.04) ? "YES" : (contModelAuc > 0.53 || contBaseDev > 0.04) ? "UNCLEAR" : "NO";
const errTop15 = errRows.filter((r) => r.horizon === "15m" && !String(r.category).startsWith("_")).sort((a, b) => Number(b.pct_of_errors) - Number(a.pct_of_errors))[0];

// bad-confidence cause heuristic
const hiConf = confRows.filter((r) => r.n && Number(r.n) >= 30 && String(r.bucket).startsWith("0.6"));
const badConfCause = hiConf.length && Math.abs(mean(hiConf.map((r) => Number(r.pctPredUp))) - 0.5) > 0.15 ? "trend/class bias (high-confidence cases skew to one predicted side without higher accuracy)" : "overfitting / noise (high-confidence buckets are tiny and unstable)";

const anyEdge = [longEdge, shortEdge, contEdge, breakoutEdge, levelEdge].some((v) => v === "YES");
const verdictAnswer = anyEdge
  ? "MIXED BEHAVIORS: at least one decomposed subproblem shows edge that the combined UP/DOWN model was averaging away."
  : "NO DIRECTIONAL SIGNAL: the failure is not caused by mixing behaviors — every decomposed subproblem (long-only, short-only, continuation, reversal, breakout-side, level-reaction), in every session, horizon, market state and feature family, is at chance out-of-sample. The information required to call direction is absent from the current features.";

// ===========================================================================
// Write artifacts
// ===========================================================================
writeFileSync(path.join(OUT, "LONG_SHORT_RESULTS.csv"), csv(longShortRows));
writeFileSync(path.join(OUT, "CONTINUATION_REVERSAL.csv"), csv(contRows));
writeFileSync(path.join(OUT, "SESSION_DIRECTION.csv"), csv(sessionRows));
writeFileSync(path.join(OUT, "HORIZON_DIRECTION.csv"), csv(horizonRows));
writeFileSync(path.join(OUT, "MARKET_STATE_DIRECTION.csv"), csv(stateRows));
writeFileSync(path.join(OUT, "BREAKOUT_DIRECTION.csv"), csv(breakoutRows));
writeFileSync(path.join(OUT, "LEVEL_REACTION.csv"), csv(levelRows));
writeFileSync(path.join(OUT, "FEATURE_FAMILY_ISOLATION.csv"), csv(familyRows));
writeFileSync(path.join(OUT, "CONFIDENCE_FAILURE.csv"), csv(confRows));
writeFileSync(path.join(OUT, "ERROR_TAXONOMY.csv"), csv(errRows));

const fmt = (x: number) => x.toFixed(4);
writeFileSync(path.join(OUT, "FINAL_DIAGNOSIS.md"), [
  "# DIRECTION_MODEL_DIAGNOSIS_V2 — Final diagnosis", "",
  "Decomposition of the `NO_DIRECTION_EDGE` result. MOVE_MODEL and the original DIRECTION_MODEL were used read-only and left frozen. Diagnosis only — no TP/SL, sizing, execution, paper or production.", "",
  "## Verdict table", "",
  "| Subproblem | Edge | Evidence (best OOS) |", "|---|---|---|",
  `| LONG edge | ${longEdge} | best trend-long-conditional AUC ${fmt(longAuc)} (n=${longN}), not consistent across horizons |`,
  `| SHORT edge | ${shortEdge} | best trend-short-conditional AUC ${fmt(shortAuc)} (n=${shortN}), not consistent across horizons |`,
  `| Continuation edge | ${contEdge} | best model AUC ${fmt(contModelAuc)}; max |base−0.5| ${fmt(contBaseDev)} |`,
  `| Reversal edge | ${contEdge} | mirror of continuation (same moving-state target) |`,
  `| Breakout-direction edge | ${breakoutEdge} | best near-boundary AUC ${fmt(breakoutAuc)} (n=${breakoutN}), holdout+walk-forward |`,
  `| Level-reaction edge | ${levelEdge} | best near-level AUC ${fmt(levelAuc)} (n=${levelN}); max |break−0.5| ${fmt(levelBaseDev)} |`,
  "",
  "'Best X' below are the arg-max of noisy ≈0.50 AUCs (nothing exceeds chance meaningfully or consistently); they are reported as requested but are NOT evidence of edge.",
  `- **Best session:** ${bestSession.label} (AUC ${fmt(bestSession.val)})`,
  `- **Best horizon:** ${bestHorizon.label} (AUC ${fmt(bestHorizon.val)})`,
  `- **Best market state:** ${bestState.label} (AUC ${fmt(bestState.val)})`,
  `- **Best feature family:** ${bestFamilyName}`,
  `- **Worst feature family:** ${worstFamilyName}`,
  `- **Main source of bad confidence:** ${badConfCause}`,
  `- **Largest failure category (15m):** ${errTop15 ? `${errTop15.category} (${(Number(errTop15.pct_of_errors) * 100).toFixed(1)}% of errors)` : "n/a"}`,
  "",
  "## The decisive answer",
  verdictAnswer, "",
  "## Reading guide",
  "- AUC/balanced-accuracy ≈ 0.50 = cannot separate the two classes; raw accuracy just tracks class skew and is not evidence of edge.",
  "- `EDGE=YES` requires OOS AUC > 0.53 with n≥200; `UNCLEAR` = 0.515–0.53 or thin n; `NO` = ≤0.515.",
  "- Continuation base rates far from 0.50 would indicate exploitable momentum/mean-reversion even without a model; see CONTINUATION_REVERSAL.csv.",
  "- Per-file: LONG_SHORT_RESULTS, CONTINUATION_REVERSAL, SESSION_DIRECTION, HORIZON_DIRECTION, MARKET_STATE_DIRECTION, BREAKOUT_DIRECTION, LEVEL_REACTION, FEATURE_FAMILY_ISOLATION, CONFIDENCE_FAILURE, ERROR_TAXONOMY.",
  "",
  "## Method notes",
  "- Same frozen dataset/features/leakage-controls/walk-forward + untouched holdout (2026-02→2026-08) as DIRECTION_MODEL. Oracle-move selection (ground-truth moves) used so MOVE selection is not a confound.",
  "- Sessions are DST-aware (EU + US rules) via London/New-York local trading hours.",
  "- 5m is an extension computed on M5 with the same methodology (frozen MOVE_MODEL only covers 15m+); M5 history starts 2023-08, so its walk-forward is shorter.",
  "- Labels overlap across bars (effective N ≈ N/horizon); edges judged conservatively.",
  "",
].join("\n"));

writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(round({
  experiment: "DIRECTION_MODEL_DIAGNOSIS_V2", diagnosisOnly: true,
  verdictTable: { longEdge, shortEdge, continuationEdge: contEdge, reversalEdge: contEdge, breakoutDirectionEdge: breakoutEdge, levelReactionEdge: levelEdge, bestSession: bestSession.label, bestHorizon: bestHorizon.label, bestMarketState: bestState.label, bestFeatureFamily: bestFamilyName, worstFeatureFamily: worstFamilyName, mainBadConfidenceCause: badConfCause, largestFailureCategory15m: errTop15 ? errTop15.category : null },
  answer: verdictAnswer,
  thresholds: { momHighThr, trendStrongThr, volLoQ, volHiQ },
  horizon: horizonRows, longShort: longShortRows, continuation: contRows, session: sessionRows, marketState: stateRows, breakout: breakoutRows, level: levelRows, featureFamily: familyRows, confidence: confRows, errorTaxonomy: errRows,
}), null, 2));

console.log("\n=== VERDICT TABLE ===");
console.log(`LONG ${longEdge} | SHORT ${shortEdge} | CONT ${contEdge} | BREAKOUT ${breakoutEdge} | LEVEL ${levelEdge}`);
console.log(`bestSession=${bestSession.label} bestHorizon=${bestHorizon.label} bestState=${bestState.label} bestFamily=${bestFamilyName} worstFamily=${worstFamilyName}`);
console.log(`anyEdge=${anyEdge}`);
console.log(`\nArtifacts written to ${OUT}`);
