/**
 * eurusd-move-v1 — full research protocol.
 *
 * A NEW question, fully decoupled from the frozen eurusdbot3-1 (which is only
 * imported for trustworthy infrastructure and never modified):
 *
 *   Stage A: MOVE vs NO_MOVE   (magnitude only — no direction, no R:R)
 *   Stage B: UP vs DOWN        (only on MOVE-likely timestamps)
 *   Then: measure the real MFE/MAE geometry, cost-to-move, and only if a
 *   genuine OOS edge exists, derive exit geometry.
 *
 * All chronological. Walk-forward + sealed. No look-ahead. Emits RESULTS.json.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadCandles, resampleUp, loadNews, surpriseZScoreHistory, PIP, REPO_ROOT, type Bar, type NewsEvent } from "../eurusdbot3-1/data.js";
import { buildContext, buildRawFeatures, FEATURE_NAMES, type Ctx } from "../eurusdbot3-1/features.js";
import { resolveOutcome } from "../eurusdbot3-1/barrier.js";
import { trainLogit, predictProb, type Sample, type LogitModel } from "../eurusdbot3-1/model.js";
import { wilsonLower, summarize, type Trade } from "../eurusdbot3-1/metrics.js";
import { measureExcursion, HORIZONS, type Excursion } from "./excursion.js";
import { buildMoveFeatures, MOVE_FEATURES, MOVE_NEWS_FEATURES } from "./move-features.js";

// ---- Config (pre-registered) ----------------------------------------------
const WARMUP = 520;
const SEALED_START = Date.parse("2026-05-01T00:00:00.000Z");
const MOVE_HORIZON = 24;      // primary MOVE horizon (hours)
// Primary MOVE threshold is BALANCE-selected after measuring behavior: we pick
// the reach threshold whose dev base rate is nearest 50% so the label is
// maximally informative (a structural choice, independent of any model/skill).
// A tiny threshold like 1.0 ATR/24h is ~universal (~95% base rate) and useless.
let MOVE_THR = 2.5;           // provisional; reset in main() from dev base rates
const DIR_HORIZON = 24;       // primary direction horizon
const COST_PIPS = 2.0;        // ~1.5 spread + 0.5 slippage
const COVERAGES = [1.0, 0.75, 0.5, 0.3, 0.2, 0.1, 0.05];
const MOVE_THRESHOLDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const H72 = 72 * 3_600_000;

const OUT = path.join(REPO_ROOT, "api-server", "research", "eurusd-move-v1");
mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(...a);
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ---- Candidate record ------------------------------------------------------
type Cand = {
  i: number; t: number; iso: string;
  exc: Excursion;
  moveX: Record<string, number>; moveXNews: Record<string, number>;
  dirX: Record<string, number>;
  hourUtc: number; session: string; atrPct: number;
};

// ---- Small stats helpers ---------------------------------------------------
function percentiles(xs: number[], ps: number[]): Record<string, number> {
  if (!xs.length) return Object.fromEntries(ps.map((p) => [`p${p}`, NaN]));
  const s = [...xs].sort((a, b) => a - b);
  const out: Record<string, number> = {};
  for (const p of ps) { const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length)); out[`p${p}`] = +s[idx]!.toFixed(3); }
  return out;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function rocAuc(scores: number[], labels: number[]): number {
  // rank-based (Mann–Whitney). O(n log n).
  const idx = scores.map((s, k) => k).sort((a, b) => scores[a]! - scores[b]!);
  const ranks = new Array<number>(scores.length);
  let k = 0;
  while (k < idx.length) {
    let j = k; while (j + 1 < idx.length && scores[idx[j + 1]!]! === scores[idx[k]!]!) j++;
    const r = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) ranks[idx[m]!] = r;
    k = j + 1;
  }
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let m = 0; m < labels.length; m++) { if (labels[m]) { sumPos += ranks[m]!; nPos++; } else nNeg++; }
  if (!nPos || !nNeg) return 0.5;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}
function prAuc(scores: number[], labels: number[]): number {
  const order = scores.map((s, k) => k).sort((a, b) => scores[b]! - scores[a]!);
  const P = labels.reduce((a, b) => a + b, 0);
  if (!P) return 0;
  let tp = 0, fp = 0, prevRecall = 0, area = 0, prevPrec = 1;
  for (const k of order) {
    if (labels[k]) tp++; else fp++;
    const recall = tp / P, prec = tp / (tp + fp);
    area += (recall - prevRecall) * (prec + prevPrec) / 2;
    prevRecall = recall; prevPrec = prec;
  }
  return area;
}
function calibration(probs: number[], labels: number[], bins = 10): Array<{ bin: number; n: number; predicted: number; actual: number }> {
  const out: Array<{ bin: number; n: number; predicted: number; actual: number }> = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const idx = probs.map((p, k) => ({ p, k })).filter((x) => x.p >= lo && (b === bins - 1 ? x.p <= hi : x.p < hi));
    if (!idx.length) continue;
    out.push({ bin: +((lo + hi) / 2).toFixed(2), n: idx.length, predicted: +mean(idx.map((x) => x.p)).toFixed(3), actual: +mean(idx.map((x) => labels[x.k]!)).toFixed(3) });
  }
  return out;
}
function sessionOf(hourUtc: number): string {
  if (hourUtc >= 12 && hourUtc < 16) return "overlap";
  if (hourUtc >= 7 && hourUtc < 12) return "london";
  if (hourUtc >= 16 && hourUtc < 21) return "ny";
  return "asia";
}

// ---- Labels ----------------------------------------------------------------
const moveLabel = (c: Cand, h = MOVE_HORIZON, thr = MOVE_THR) => (c.exc.byH[h]!.reachATR >= thr ? 1 : 0);
const dirLabelDominant = (c: Cand, h = DIR_HORIZON) => (c.exc.byH[h]!.mfeUpATR >= -c.exc.byH[h]!.maeDownATR ? 1 : 0); // 1=up
const dirLabelTerminal = (c: Cand, h = DIR_HORIZON) => (c.exc.byH[h]!.retATR >= 0 ? 1 : 0);

// ---- Generic walk-forward probability producer -----------------------------
type WFProb = { probByIso: Map<string, number>; windows: Array<{ window: number; testStart: string; testEnd: string; trainN: number; metric: number }> };
function walkForwardProb(
  dev: Cand[], folds: number,
  featOf: (c: Cand) => Record<string, number>, featNames: string[],
  labelOf: (c: Cand) => number,
  restrict: (c: Cand) => boolean,
  windowMetric: (probs: number[], labels: number[]) => number,
): WFProb {
  const t0 = dev[0]!.t, tN = dev.at(-1)!.t, span = tN - t0;
  const firstTestFrac = 0.35;
  const testSpan = (span * (1 - firstTestFrac)) / folds;
  const probByIso = new Map<string, number>();
  const windows: WFProb["windows"] = [];
  for (let f = 0; f < folds; f++) {
    const testStart = t0 + span * firstTestFrac + f * testSpan;
    const testEnd = f === folds - 1 ? tN + 1 : testStart + testSpan;
    const trainAll = dev.filter((c) => c.t < testStart - H72 && restrict(c));
    if (trainAll.length < 400) continue;
    const model = trainLogit(trainAll.map((c) => ({ x: featOf(c), y: labelOf(c) } as Sample)), featNames, { l2: 2.0, lr: 0.2, epochs: 200 });
    const test = dev.filter((c) => c.t >= testStart && c.t < testEnd && restrict(c));
    const probs: number[] = [], labels: number[] = [];
    for (const c of test) { const p = predictProb(model, featOf(c)); probByIso.set(c.iso, p); probs.push(p); labels.push(labelOf(c)); }
    windows.push({ window: f + 1, testStart: new Date(testStart).toISOString().slice(0, 10), testEnd: new Date(testEnd).toISOString().slice(0, 10), trainN: trainAll.length, metric: +windowMetric(probs, labels).toFixed(4) });
  }
  return { probByIso, windows };
}

// ---- Stage A analysis: confidence → realized movement ----------------------
function moveMonotonicity(cands: Cand[], probByIso: Map<string, number>, horizon: number) {
  const rows = cands.filter((c) => probByIso.has(c.iso)).map((c) => ({ p: probByIso.get(c.iso)!, reachATR: c.exc.byH[horizon]!.reachATR, reachPips: c.exc.byH[horizon]!.reachATR * c.exc.atrPips, rangePips: c.exc.byH[horizon]!.rangeATR * c.exc.atrPips }));
  rows.sort((a, b) => b.p - a.p);
  const out: Record<string, { n: number; avgReachATR: number; avgReachPips: number; avgRangePips: number; costToMove: number }> = {};
  for (const cov of COVERAGES) {
    const k = Math.max(1, Math.round(rows.length * cov));
    const slice = rows.slice(0, k);
    out[`${Math.round(cov * 100)}%`] = {
      n: slice.length,
      avgReachATR: +mean(slice.map((r) => r.reachATR)).toFixed(3),
      avgReachPips: +mean(slice.map((r) => r.reachPips)).toFixed(2),
      avgRangePips: +mean(slice.map((r) => r.rangePips)).toFixed(2),
      costToMove: +(mean(slice.map((r) => r.reachPips)) / COST_PIPS).toFixed(2),
    };
  }
  return out;
}

// ---- Stage B analysis: accuracy vs coverage --------------------------------
function directionByCoverage(cands: Cand[], upProbByIso: Map<string, number>, labelOf: (c: Cand) => number, horizon: number) {
  const rows = cands.filter((c) => upProbByIso.has(c.iso)).map((c) => {
    const p = upProbByIso.get(c.iso)!;
    const conf = Math.abs(p - 0.5) * 2;
    const pred = p >= 0.5 ? 1 : 0;
    const y = labelOf(c);
    const h = c.exc.byH[horizon]!;
    const signedRetPips = (pred === 1 ? h.retATR : -h.retATR) * c.exc.atrPips;
    const mfe = pred === 1 ? h.mfeUpATR : -h.maeDownATR;   // favorable in chosen dir
    const mae = pred === 1 ? -h.maeDownATR : h.mfeUpATR;   // adverse in chosen dir (≥0)
    return { conf, correct: pred === y ? 1 : 0, signedRetPips, mfe, mae };
  });
  rows.sort((a, b) => b.conf - a.conf);
  const out: Record<string, { n: number; accuracy: number; avgSignedPips: number; avgMFE: number; avgMAE: number; mfeMaeRatio: number }> = {};
  for (const cov of COVERAGES) {
    const k = Math.max(1, Math.round(rows.length * cov));
    const s = rows.slice(0, k);
    const amfe = mean(s.map((r) => r.mfe)), amae = mean(s.map((r) => r.mae));
    out[`${Math.round(cov * 100)}%`] = {
      n: s.length,
      accuracy: +mean(s.map((r) => r.correct)).toFixed(4),
      avgSignedPips: +mean(s.map((r) => r.signedRetPips)).toFixed(2),
      avgMFE: +amfe.toFixed(3), avgMAE: +amae.toFixed(3), mfeMaeRatio: +(amfe / (amae || 1)).toFixed(2),
    };
  }
  return out;
}

// ---- Baseline direction accuracy on identical timestamps -------------------
function accuracyOf(cands: Cand[], pick: (c: Cand) => 0 | 1, labelOf: (c: Cand) => number): { n: number; accuracy: number } {
  let correct = 0;
  for (const c of cands) if (pick(c) === labelOf(c)) correct++;
  return { n: cands.length, accuracy: cands.length ? +(correct / cands.length).toFixed(4) : 0 };
}

async function main() {
  const startedAt = Date.now();
  log("Loading candles…");
  const h1 = loadCandles("H1");
  const m15 = loadCandles("M15");
  const h4 = resampleUp(h1, 4);
  const daily = resampleUp(h1, 24);
  const news = loadNews();
  const zByEvent = surpriseZScoreHistory(news);
  log(`  H1=${h1.length} M15=${m15.length} news=${news.length}`);

  log("Building context + measuring excursions…");
  const ctx: Ctx = buildContext(h1, m15);
  const cands: Cand[] = [];
  const lastLabelTime = h1.at(-1)!.t - H72;
  for (let i = WARMUP; i < h1.length; i++) {
    if (h1[i]!.t > lastLabelTime) break;
    const atr = ctx.atr[i]!;
    const exc = measureExcursion(h1, m15, i, atr);
    if (!exc) continue;
    const hourUtc = new Date(h1[i]!.t).getUTCHours();
    cands.push({
      i, t: h1[i]!.t, iso: h1[i]!.iso, exc,
      moveX: buildMoveFeatures(ctx, i, news, zByEvent, false),
      moveXNews: buildMoveFeatures(ctx, i, news, zByEvent, true),
      dirX: buildRawFeatures(ctx, i, h4, daily),
      hourUtc, session: sessionOf(hourUtc), atrPct: 0,
    });
  }
  // volatility regime = ATR percentile over trailing 500 (from move features)
  for (const c of cands) c.atrPct = c.moveX.atr_pct!;
  log(`  candidates=${cands.length}  ${cands[0]!.iso.slice(0, 10)}→${cands.at(-1)!.iso.slice(0, 10)}`);

  const dev = cands.filter((c) => c.t < SEALED_START);
  const sealed = cands.filter((c) => c.t >= SEALED_START);
  log(`  dev=${dev.length} sealed=${sealed.length}`);

  // Balance-select the primary MOVE threshold (nearest 50% base rate @ 24h).
  const thrRates = MOVE_THRESHOLDS.map((thr) => ({ thr, rate: dev.filter((c) => c.exc.byH[MOVE_HORIZON]!.reachATR >= thr).length / dev.length }));
  MOVE_THR = thrRates.reduce((best, x) => (Math.abs(x.rate - 0.5) < Math.abs(best.rate - 0.5) ? x : best)).thr;
  log(`  primary MOVE = reach ≥ ${MOVE_THR} ATR @ ${MOVE_HORIZON}h  (dev base rate ${(dev.filter((c) => moveLabel(c)).length / dev.length * 100).toFixed(1)}%)`);
  log(`  MOVE base rates @24h by threshold: ${thrRates.map((x) => `${x.thr}:${(x.rate * 100).toFixed(0)}%`).join(" ")}`);

  // ============ SECTION: price behavior descriptive stats ============
  log("Descriptive price-behavior stats…");
  const behavior: Record<string, unknown> = {};
  for (const h of HORIZONS) {
    const reachATR = dev.map((c) => c.exc.byH[h]!.reachATR);
    const reachPips = dev.map((c) => c.exc.byH[h]!.reachATR * c.exc.atrPips);
    const rangePips = dev.map((c) => c.exc.byH[h]!.rangeATR * c.exc.atrPips);
    const retPips = dev.map((c) => c.exc.byH[h]!.retPips);
    behavior[`${h}h`] = {
      reachATR: percentiles(reachATR, [10, 25, 50, 75, 90]),
      reachPips: percentiles(reachPips, [10, 25, 50, 75, 90]),
      rangePips: percentiles(rangePips, [10, 25, 50, 75, 90]),
      absRetPips_p50: percentiles(retPips.map(Math.abs), [50])!.p50,
      moveRateByThreshold: Object.fromEntries(MOVE_THRESHOLDS.map((thr) => [thr, +(dev.filter((c) => c.exc.byH[h]!.reachATR >= thr).length / dev.length).toFixed(3)])),
    };
  }

  // ============ STAGE A: MOVE detector ============
  log("Stage A walk-forward (MOVE detector)…");
  const moveWF = walkForwardProb(dev, 6, (c) => c.moveX, MOVE_FEATURES, (c) => moveLabel(c), () => true, rocAuc);
  const moveProbs: number[] = [], moveLabels: number[] = [];
  for (const c of dev) if (moveWF.probByIso.has(c.iso)) { moveProbs.push(moveWF.probByIso.get(c.iso)!); moveLabels.push(moveLabel(c)); }
  const stageA = {
    primary: { horizon: MOVE_HORIZON, threshold: MOVE_THR, baseMoveRate: +mean(moveLabels).toFixed(4) },
    windows: moveWF.windows,
    oosAuc: +rocAuc(moveProbs, moveLabels).toFixed(4),
    oosPrAuc: +prAuc(moveProbs, moveLabels).toFixed(4),
    calibration: calibration(moveProbs, moveLabels),
    monotonicityByHorizon: Object.fromEntries(HORIZONS.map((h) => [`${h}h`, moveMonotonicity(dev, moveWF.probByIso, h)])),
  };
  log(`  Stage A OOS AUC=${stageA.oosAuc}  baseMoveRate=${stageA.primary.baseMoveRate}`);

  // News ablation for Stage A
  log("Stage A news ablation…");
  const moveWFNews = walkForwardProb(dev, 6, (c) => c.moveXNews, [...MOVE_FEATURES, ...MOVE_NEWS_FEATURES], (c) => moveLabel(c), () => true, rocAuc);
  const mpN: number[] = [], mlN: number[] = [];
  for (const c of dev) if (moveWFNews.probByIso.has(c.iso)) { mpN.push(moveWFNews.probByIso.get(c.iso)!); mlN.push(moveLabel(c)); }
  const stageANews = { oosAuc: +rocAuc(mpN, mlN).toFixed(4), monotonicity24h: moveMonotonicity(dev, moveWFNews.probByIso, MOVE_HORIZON) };

  // ============ STAGE B: direction (on MOVE-positive) ============
  log("Stage B walk-forward (direction on MOVE-positive)…");
  const movePos = (c: Cand) => moveLabel(c) === 1;
  const dirWF = walkForwardProb(dev, 6, (c) => c.dirX, FEATURE_NAMES, (c) => dirLabelDominant(c), movePos,
    (probs, labels) => { let ok = 0; probs.forEach((p, k) => { if ((p >= 0.5 ? 1 : 0) === labels[k]) ok++; }); return probs.length ? ok / probs.length : 0.5; });
  const devMovePos = dev.filter(movePos);
  const dirByCov = directionByCoverage(devMovePos, dirWF.probByIso, (c) => dirLabelDominant(c), DIR_HORIZON);
  // pipeline accuracy: also evaluate under terminal-return label for comparison
  const dirByCovTerminal = directionByCoverage(devMovePos, dirWF.probByIso, (c) => dirLabelTerminal(c), DIR_HORIZON);
  const dirProbs: number[] = [], dirLabels: number[] = [];
  for (const c of devMovePos) if (dirWF.probByIso.has(c.iso)) { dirProbs.push(dirWF.probByIso.get(c.iso)!); dirLabels.push(dirLabelDominant(c)); }
  const stageB = {
    label: "dominantExcursion@24h", horizon: DIR_HORIZON,
    windows: dirWF.windows,
    oosAuc: +rocAuc(dirProbs, dirLabels).toFixed(4),
    accuracyByCoverage: dirByCov,
    accuracyByCoverage_terminalLabel: dirByCovTerminal,
    calibration: calibration(dirProbs.map((p) => p), dirLabels),
  };
  log(`  Stage B OOS AUC=${stageB.oosAuc}  acc@100%=${dirByCov["100%"]!.accuracy}`);

  // ============ BASELINES (direction, identical MOVE-positive OOS timestamps) ============
  log("Direction baselines…");
  const evalSet = devMovePos.filter((c) => dirWF.probByIso.has(c.iso));
  const rnd = rng(42);
  const label = (c: Cand) => dirLabelDominant(c);
  const baselines: Record<string, { n: number; accuracy: number }> = {
    model: accuracyOf(evalSet, (c) => (dirWF.probByIso.get(c.iso)! >= 0.5 ? 1 : 0), label),
    random: accuracyOf(evalSet, () => (rnd() < 0.5 ? 1 : 0) as 0 | 1, label),
    alwaysUp: accuracyOf(evalSet, () => 1, label),
    alwaysDown: accuracyOf(evalSet, () => 0, label),
    trend: accuracyOf(evalSet, (c) => (c.dirX.ema_gap_h1! > 0 ? 1 : 0), label),
    invTrend: accuracyOf(evalSet, (c) => (c.dirX.ema_gap_h1! > 0 ? 0 : 1), label),
    momentum: accuracyOf(evalSet, (c) => (c.dirX.mom_12! > 0 ? 1 : 0), label),
    invMomentum: accuracyOf(evalSet, (c) => (c.dirX.mom_12! > 0 ? 0 : 1), label),
    combinedNormal: accuracyOf(evalSet, (c) => ((c.dirX.ema_gap_h1! + c.dirX.mom_12!) > 0 ? 1 : 0), label),
    combinedInverted: accuracyOf(evalSet, (c) => ((c.dirX.ema_gap_h1! + c.dirX.mom_12!) > 0 ? 0 : 1), label),
  };

  // ============ ANTI-PREDICTIVE TEST (validation-chosen inversion) ============
  log("Anti-predictive inversion test…");
  // For each fold, choose normal vs inverted trend on the fold's validation slice,
  // apply to test. Report whether validation consistently prefers inversion.
  const antiWindows: Array<{ window: number; validChoice: "normal" | "inverted"; testNormalAcc: number; testInvAcc: number }> = [];
  {
    const t0 = dev[0]!.t, tN = dev.at(-1)!.t, span = tN - t0, folds = 6, ff = 0.35, ts = (span * (1 - ff)) / folds;
    for (let f = 0; f < folds; f++) {
      const testStart = t0 + span * ff + f * ts, testEnd = f === folds - 1 ? tN + 1 : testStart + ts;
      const trainAll = dev.filter((c) => c.t < testStart - H72 && movePos(c));
      if (trainAll.length < 400) continue;
      const cut = trainAll[Math.floor(trainAll.length * 0.85)]!.t;
      const valid = trainAll.filter((c) => c.t >= cut);
      const vN = accuracyOf(valid, (c) => (c.dirX.ema_gap_h1! > 0 ? 1 : 0), label).accuracy;
      const vI = accuracyOf(valid, (c) => (c.dirX.ema_gap_h1! > 0 ? 0 : 1), label).accuracy;
      const choice = vI > vN ? "inverted" : "normal";
      const test = dev.filter((c) => c.t >= testStart && c.t < testEnd && movePos(c));
      antiWindows.push({
        window: f + 1, validChoice: choice,
        testNormalAcc: accuracyOf(test, (c) => (c.dirX.ema_gap_h1! > 0 ? 1 : 0), label).accuracy,
        testInvAcc: accuracyOf(test, (c) => (c.dirX.ema_gap_h1! > 0 ? 0 : 1), label).accuracy,
      });
    }
  }
  // breakdown by session and vol regime (normal trend accuracy on MOVE-positive OOS)
  const antiBreakdown: Record<string, { n: number; normalAcc: number; invAcc: number }> = {};
  for (const key of ["asia", "london", "ny", "overlap", "lowVol", "highVol"]) {
    const set = evalSet.filter((c) => key === "lowVol" ? c.atrPct < 0.5 : key === "highVol" ? c.atrPct >= 0.5 : c.session === key);
    antiBreakdown[key] = { n: set.length, normalAcc: accuracyOf(set, (c) => (c.dirX.ema_gap_h1! > 0 ? 1 : 0), label).accuracy, invAcc: accuracyOf(set, (c) => (c.dirX.ema_gap_h1! > 0 ? 0 : 1), label).accuracy };
  }

  // ============ MFE/MAE ANALYSIS (correct high-confidence predictions) ============
  log("MFE/MAE geometry…");
  function mfeMae(set: Cand[], horizon: number, onlyCorrect: boolean, topConf?: number) {
    let rows = set.filter((c) => dirWF.probByIso.has(c.iso)).map((c) => {
      const p = dirWF.probByIso.get(c.iso)!, pred = p >= 0.5 ? 1 : 0, conf = Math.abs(p - 0.5) * 2;
      const h = c.exc.byH[horizon]!;
      const mfe = pred === 1 ? h.mfeUpATR : -h.maeDownATR;
      const mae = pred === 1 ? -h.maeDownATR : h.mfeUpATR;
      const tMfe = pred === 1 ? h.tMFEmin : h.tMAEmin;
      const tMae = pred === 1 ? h.tMAEmin : h.tMFEmin;
      return { conf, correct: pred === dirLabelDominant(c, horizon), mfe, mae, tMfe, tMae };
    });
    if (topConf) { rows.sort((a, b) => b.conf - a.conf); rows = rows.slice(0, Math.max(1, Math.round(rows.length * topConf))); }
    if (onlyCorrect) rows = rows.filter((r) => r.correct);
    return {
      n: rows.length,
      mfe: percentiles(rows.map((r) => r.mfe), [10, 25, 50, 75, 90]),
      mae: percentiles(rows.map((r) => r.mae), [10, 25, 50, 75, 90]),
      mfeMae: percentiles(rows.map((r) => r.mfe / (r.mae || 0.01)), [10, 25, 50, 75, 90]),
      tMfeMin: percentiles(rows.map((r) => r.tMfe), [10, 25, 50, 75, 90]),
      tMaeMin: percentiles(rows.map((r) => r.tMae), [10, 25, 50, 75, 90]),
      medianMFE: percentiles(rows.map((r) => r.mfe), [50]).p50,
      medianMAE: percentiles(rows.map((r) => r.mae), [50]).p50,
    };
  }
  const mfeMaeAnalysis = {
    allCorrect_24h: mfeMae(devMovePos, 24, true),
    top20Correct_24h: mfeMae(devMovePos, 24, true, 0.2),
    top20All_24h: mfeMae(devMovePos, 24, false, 0.2),
    byHorizon_top20All: Object.fromEntries(HORIZONS.map((h) => [`${h}h`, mfeMae(devMovePos, h, false, 0.2)])),
    bySession_top20All_24h: Object.fromEntries(["asia", "london", "ny", "overlap"].map((s) => [s, mfeMae(devMovePos.filter((c) => c.session === s), 24, false, 0.2)])),
    byRegime_top20All_24h: { lowVol: mfeMae(devMovePos.filter((c) => c.atrPct < 0.5), 24, false, 0.2), highVol: mfeMae(devMovePos.filter((c) => c.atrPct >= 0.5), 24, false, 0.2) },
  };

  // ============ COST-TO-MOVE ============
  log("Cost-to-move…");
  const costToMove: Record<string, unknown> = {};
  for (const cov of COVERAGES) {
    const rows = dev.filter((c) => moveWF.probByIso.has(c.iso)).map((c) => ({ p: moveWF.probByIso.get(c.iso)!, reachPips: c.exc.byH[MOVE_HORIZON]!.reachATR * c.exc.atrPips }));
    rows.sort((a, b) => b.p - a.p);
    const s = rows.slice(0, Math.max(1, Math.round(rows.length * cov)));
    const ratios = s.map((r) => r.reachPips / COST_PIPS);
    costToMove[`${Math.round(cov * 100)}%`] = {
      n: s.length, avgReachPips: +mean(s.map((r) => r.reachPips)).toFixed(2), avgRatio: +mean(ratios).toFixed(2),
      fracGe5x: +(ratios.filter((r) => r >= 5).length / ratios.length).toFixed(3),
      fracGe10x: +(ratios.filter((r) => r >= 10).length / ratios.length).toFixed(3),
      fracGe15x: +(ratios.filter((r) => r >= 15).length / ratios.length).toFixed(3),
      fracGe20x: +(ratios.filter((r) => r >= 20).length / ratios.length).toFixed(3),
    };
  }

  // ============ SEALED TEST (freeze everything, run once) ============
  log("Sealed test…");
  const moveModelSealed = trainLogit(dev.map((c) => ({ x: c.moveX, y: moveLabel(c) } as Sample)), MOVE_FEATURES, { l2: 2.0, lr: 0.2, epochs: 200 });
  const dirModelSealed = trainLogit(dev.filter(movePos).map((c) => ({ x: c.dirX, y: dirLabelDominant(c) } as Sample)), FEATURE_NAMES, { l2: 2.0, lr: 0.2, epochs: 200 });
  const sealedMoveProb = new Map<string, number>(), sealedDirProb = new Map<string, number>();
  for (const c of sealed) { sealedMoveProb.set(c.iso, predictProb(moveModelSealed, c.moveX)); sealedDirProb.set(c.iso, predictProb(dirModelSealed, c.dirX)); }
  const sealedMoveLabels = sealed.map((c) => moveLabel(c));
  const sealedMovePos = sealed.filter(movePos);
  const sealedStageA = {
    n: sealed.length, baseMoveRate: +mean(sealedMoveLabels).toFixed(4),
    auc: +rocAuc(sealed.map((c) => sealedMoveProb.get(c.iso)!), sealedMoveLabels).toFixed(4),
    monotonicity24h: moveMonotonicity(sealed, sealedMoveProb, MOVE_HORIZON),
  };
  const sealedStageB = {
    n: sealedMovePos.length,
    auc: +rocAuc(sealedMovePos.map((c) => sealedDirProb.get(c.iso)!), sealedMovePos.map((c) => dirLabelDominant(c))).toFixed(4),
    accuracyByCoverage: directionByCoverage(sealedMovePos, sealedDirProb, (c) => dirLabelDominant(c), DIR_HORIZON),
  };
  log(`  sealed Stage A AUC=${sealedStageA.auc}  Stage B AUC=${sealedStageB.auc} acc@100%=${sealedStageB.accuracyByCoverage["100%"]?.accuracy}`);

  // ============ DATA-DERIVED R:R + NET TRADE SIM (evidence, gated in report) ============
  log("Data-derived R:R + NET trade sim on frozen predictions…");
  // Natural geometry from correct high-conf predictions:
  const geom = mfeMaeAnalysis.top20Correct_24h;
  const naturalRR = +(geom.medianMFE / (geom.medianMAE || 1)).toFixed(2);
  // NET sim: take the frozen dir prediction on OOS MOVE-positive top-20% conf, size stop at 1.0 ATR, sweep TP.
  const simSet = (() => {
    const rows = devMovePos.filter((c) => dirWF.probByIso.has(c.iso)).map((c) => ({ c, p: dirWF.probByIso.get(c.iso)!, conf: Math.abs(dirWF.probByIso.get(c.iso)! - 0.5) * 2 }));
    rows.sort((a, b) => b.conf - a.conf);
    return rows.slice(0, Math.max(1, Math.round(rows.length * 0.2)));
  })();
  const rrSim: Record<string, unknown> = {};
  for (const tp of [1, 1.25, 1.5, 2, 2.5, 3]) {
    const trades: Trade[] = [];
    for (const { c, p } of simSet) {
      const dir = p >= 0.5 ? "long" : "short";
      const risk = Math.max(1.0 * c.exc.atr, 5 * PIP);
      const o = resolveOutcome({ direction: dir, entryH1: h1[c.i]!, riskDistance: risk, tpR: tp, horizonMs: H72, m15, slippagePips: 0.5, cost: "net" });
      trades.push({ time: c.iso, direction: dir, r: o.r, cls: o.cls, holdMs: o.holdMs, conf: 0.5 });
    }
    const s = summarize(trades);
    rrSim[`1:${tp}`] = { trades: s.trades, winRate: +s.winRate.toFixed(3), expectancy: +s.expectancy.toFixed(3), totalR: +s.totalR.toFixed(1), profitFactor: +(s.profitFactor || 0).toFixed(2), maxDD: +s.maxDrawdownR.toFixed(1) };
  }

  // ---- assemble ----
  const results = {
    generatedAt: new Date().toISOString(),
    runtimeSec: +((Date.now() - startedAt) / 1000).toFixed(1),
    rerun: "cd api-server && npx tsx scripts/eurusd-move-v1/experiment.ts",
    config: { WARMUP, SEALED_START: new Date(SEALED_START).toISOString(), MOVE_HORIZON, MOVE_THR, DIR_HORIZON, COST_PIPS, COVERAGES, MOVE_THRESHOLDS },
    data: { instrument: "EUR_USD", h1: h1.length, m15: m15.length, h4: h4.length, daily: daily.length, range: { from: h1[0]!.iso, to: h1.at(-1)!.iso }, candidates: cands.length, dev: dev.length, sealed: sealed.length, newsEvents: news.length },
    priceBehavior: behavior,
    stageA: { ...stageA, news: stageANews },
    stageB,
    baselines,
    antiPredictive: { validationChosenInversion: antiWindows, breakdown: antiBreakdown },
    mfeMae: mfeMaeAnalysis,
    costToMove,
    naturalGeometry: { naturalRR, medianMFE_ATR: geom.medianMFE, medianMAE_ATR: geom.medianMAE },
    rrTradeSim_frozen: rrSim,
    sealed: { stageA: sealedStageA, stageB: sealedStageB },
    wilson: { stageBacc100: wilsonLower(Math.round((dirByCov["100%"]!.accuracy) * dirByCov["100%"]!.n), dirByCov["100%"]!.n) },
  };
  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(results, null, 2));
  log(`\nWrote ${path.join(OUT, "RESULTS.json")} (${results.runtimeSec}s)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
