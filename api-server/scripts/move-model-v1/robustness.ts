/**
 * MOVE_MODEL — robustness / triviality checks.
 *
 * The headline run reported very high AUC that rises with horizon. Two effects
 * can manufacture exactly that WITHOUT any genuine "when will it move" skill:
 *   (A) the label normalizes future excursion by the INSTANTANEOUS ATR14_T,
 *       which is also small precisely when a move is "due" — a denominator
 *       artifact; and
 *   (B) EUR/USD has a strong intraday VOLATILITY CLOCK (quiet Asia -> active
 *       London/NY), so a model that only learns the hour-of-day looks skilful.
 *
 * This script controls for both:
 *   - a SEASONAL baseline P(MOVE | half-hour-of-day) — the honest null for (B);
 *   - the same model re-fit on a STABLE-denominator label (excursion / slow vol)
 *     and on a RAW-PIPS label, to test (A);
 *   - a GBT with the clock + ATR level REMOVED, to isolate any residual edge.
 *
 * Decision rule: a genuine MOVE edge must beat the seasonal baseline by a
 * meaningful AUC margin, and must survive the stable-denominator / raw-pips
 * relabelings. If the margin collapses, the apparent edge is an artifact.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  ROOT, HORIZONS, FEATURES, buildSamples, csv, evaluate,
  loadBars, loadNews, predictGBT, trainGBT, type Sample,
} from "./lib.js";

const OUT = path.join(ROOT, "api-server", "research-v2", "MOVE_MODEL");
const ms = (iso: string) => Date.parse(iso + "T00:00:00Z");
const barMs = 15 * 60_000;
const MODEL_FROM = ms("2020-01-01"), MODEL_TO = ms("2026-08-01"), FINAL_FROM = ms("2026-02-01");
const DEV_TO = ms("2024-07-01");
const FOLDS = [
  ["2022-01-01", "2022-07-01"], ["2022-07-01", "2023-01-01"], ["2023-01-01", "2023-07-01"],
  ["2023-07-01", "2024-01-01"], ["2024-01-01", "2024-07-01"], ["2024-07-01", "2025-01-01"],
  ["2025-01-01", "2025-07-01"], ["2025-07-01", "2026-01-01"],
].map(([a, b]) => ({ from: ms(a!), to: ms(b!), label: `${a}..${b}` }));
const LABELS = ["instant_atr", "slow_vol", "raw_pips"] as const;
type LabelKind = typeof LABELS[number];

function labelValue(s: Sample, hIdx: number, kind: LabelKind) {
  return kind === "instant_atr" ? s.norm[hIdx]! : kind === "slow_vol" ? s.normSlow[hIdx]! : s.excPips[hIdx]!;
}
const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; };
function subsample<T>(rows: T[], cap: number): T[] {
  if (rows.length <= cap) return rows; const stride = rows.length / cap; const out: T[] = [];
  for (let k = 0; k < cap; k += 1) out.push(rows[Math.floor(k * stride)]!); return out;
}
// seasonal baseline: P(MOVE | half-hour bucket) learned on train
function seasonalProbs(train: { s: Sample; y: number }[], test: { s: Sample; y: number }[]) {
  const sum = new Array(48).fill(0), cnt = new Array(48).fill(0);
  for (const r of train) { sum[r.s.hourBucket] += r.y; cnt[r.s.hourBucket] += 1; }
  const base = train.reduce((a, r) => a + r.y, 0) / Math.max(1, train.length);
  const rate = sum.map((sm, i) => (cnt[i] ? sm / cnt[i] : base));
  return test.map((r) => rate[r.s.hourBucket]!);
}

console.log("Loading + building samples...");
const bars = loadBars("backtest-legacy-expanded/candles/EUR_USD_M15.json");
const h1 = loadBars("backtest-legacy-expanded/candles/EUR_USD_H1.json");
const m5 = loadBars("backtest-breakout-m5/candles/EUR_USD_M5.json");
const news = loadNews();
const samples = buildSamples(bars, h1, m5, news, MODEL_FROM, MODEL_TO);
console.log(`samples=${samples.length}`);

const clockIdx = new Set(FEATURES.map((f, i) => (f.group === "time" || f.name === "atr_pips" || f.name === "atr14_56" ? i : -1)).filter((i) => i >= 0));
const noClockIdx = FEATURES.map((_, i) => i).filter((i) => !clockIdx.has(i));

const rows: Record<string, unknown>[] = [];
const HSET = [{ label: "60m", idx: 3 - 1 }, { label: "120m", idx: 4 - 1 }]; // 60m, 120m

for (const H of HSET) {
  const hIdx = HORIZONS.findIndex((h) => h.label === H.label);
  const usable = samples.filter((s) => s.contiguous[hIdx]);
  for (const kind of LABELS) {
    // threshold = median of the dev-train label values -> ~balanced classes, no leakage
    const devTrain = usable.filter((s) => s.t < DEV_TO - HORIZONS[hIdx]!.bars * barMs);
    const thr = median(devTrain.map((s) => labelValue(s, hIdx, kind)));
    const mk = (s: Sample) => ({ s, y: labelValue(s, hIdx, kind) >= thr ? 1 : 0 });
    const all = usable.map(mk);
    const sliceR = (from: number, to: number) => all.filter((r) => r.s.t >= from && r.s.t < to);

    // walk-forward: seasonal baseline vs GBT-full
    const seasonalAucs: number[] = [], gbtAucs: number[] = [];
    for (const fold of FOLDS) {
      const tr = sliceR(MODEL_FROM, fold.from - HORIZONS[hIdx]!.bars * barMs);
      const te = sliceR(fold.from, fold.to);
      if (tr.length < 1000 || te.length < 200) continue;
      const yTe = te.map((r) => r.y);
      const seas = evaluate(seasonalProbs(tr, te), yTe).auc;
      const trS = subsample(tr, 40_000);
      const gbtM = trainGBT(trS.map((r) => r.s.x), trS.map((r) => r.y), { rounds: 100, depth: 3, lr: 0.1 });
      const gbt = evaluate(te.map((r) => predictGBT(gbtM, r.s.x)), yTe).auc;
      seasonalAucs.push(seas); gbtAucs.push(gbt);
      rows.push({ horizon: H.label, label: kind, scope: "fold", fold: fold.label, thr: Number(thr.toFixed(5)), moveRate: yTe.reduce((a, b) => a + b, 0) / yTe.length, seasonal_auc: seas, gbt_auc: gbt, incremental: gbt - seas });
    }

    // final holdout: seasonal, GBT-full, GBT without clock+ATR-level
    const trF = sliceR(MODEL_FROM, FINAL_FROM - HORIZONS[hIdx]!.bars * barMs);
    const teF = sliceR(FINAL_FROM, MODEL_TO);
    const yF = teF.map((r) => r.y);
    const seasF = evaluate(seasonalProbs(trF, teF), yF).auc;
    const trFS = subsample(trF, 45_000);
    const gbtFull = trainGBT(trFS.map((r) => r.s.x), trFS.map((r) => r.y), { rounds: 120, depth: 3, lr: 0.1 });
    const aucFull = evaluate(teF.map((r) => predictGBT(gbtFull, r.s.x)), yF).auc;
    const gbtNoClock = trainGBT(trFS.map((r) => noClockIdx.map((i) => r.s.x[i]!)), trFS.map((r) => r.y), { rounds: 120, depth: 3, lr: 0.1 });
    const aucNoClock = evaluate(teF.map((r) => predictGBT(gbtNoClock, noClockIdx.map((i) => r.s.x[i]!))), yF).auc;
    rows.push({ horizon: H.label, label: kind, scope: "final", fold: "holdout", thr: Number(thr.toFixed(5)), moveRate: yF.reduce((a, b) => a + b, 0) / yF.length, seasonal_auc: seasF, gbt_auc: aucFull, incremental: aucFull - seasF, gbt_noclock_auc: aucNoClock, incremental_noclock: aucNoClock - seasF });
    const mAuc = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    console.log(`${H.label} ${kind}: WF seasonal=${mAuc(seasonalAucs).toFixed(3)} gbt=${mAuc(gbtAucs).toFixed(3)} incr=${(mAuc(gbtAucs) - mAuc(seasonalAucs)).toFixed(3)} | FINAL seasonal=${seasF.toFixed(3)} gbt=${aucFull.toFixed(3)} incr=${(aucFull - seasF).toFixed(3)} noClock=${aucNoClock.toFixed(3)}`);
  }
}

writeFileSync(path.join(OUT, "ROBUSTNESS_RESULTS.csv"), csv(rows));
console.log(`\nWrote ${path.join(OUT, "ROBUSTNESS_RESULTS.csv")}`);
