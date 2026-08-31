/**
 * V5-SWING — does moving to swing horizon (wide stops, multi-day holds) rescue the
 * cost-bound intraday engine? Same features, heads, WAIT, split, and walk-forward
 * discipline as V5; only the geometry and hold change. Research-only. No mirror math.
 *
 * Hypothesis under test: spread is fixed in pips, so a ~5x wider stop cuts cost/R ~5x.
 * That helps ONLY if the (tiny, +0.066R) gross directional edge survives the longer
 * horizon. This run measures gross vs net at swing horizon directly.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCandidates, trainHeads, scoreAndThreshold, replay, resolveOutcomeGeo, isEligible,
  stats, breakdowns, marketDays, rowsIn, addUtcMonths, geoKey, ARCHS,
  TRAIN, VALIDATION, TEST, WINDOW_FROM, CALIBRATION_MONTHS,
  WALKFORWARD_STEP_MONTHS, WALKFORWARD_MIN_TRAIN_MONTHS,
  type Geo, type V5Trade,
} from "./experiment.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v5-swing");

const SWING_GEOMETRIES: Geo[] = [
  { stopAtr: 3, rr: 1.5 }, { stopAtr: 3, rr: 2.0 }, { stopAtr: 3, rr: 2.5 },
  { stopAtr: 5, rr: 1.5 }, { stopAtr: 5, rr: 2.0 }, { stopAtr: 5, rr: 2.5 },
  { stopAtr: 8, rr: 1.5 }, { stopAtr: 8, rr: 2.0 }, { stopAtr: 8, rr: 2.5 },
];
const SWING_MAX_HOLD_BARS = 192; // ~2 trading days of M15
const COVERAGES = [0.10, 0.20, 0.35];
const CONFIDENCES = [0.0, 0.10];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pf = (xs: number[]) => {
  const gp = xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -xs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return gl ? gp / gl : Infinity;
};
const round = (v: unknown): unknown =>
  typeof v === "number" ? (Number.isFinite(v) ? Number(v.toFixed(6)) : String(v))
  : Array.isArray(v) ? v.map(round)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]))
  : v;

function main() {
  mkdirSync(OUTPUT, { recursive: true });
  console.log("Building SWING candidates (wide stops 3/5/8 ATR, 2-day hold)...");
  const { candidates, bars, series } = buildCandidates({ geometries: SWING_GEOMETRIES, maxHoldBars: SWING_MAX_HOLD_BARS });
  const valRows = rowsIn(candidates, VALIDATION);
  const testRows = rowsIn(candidates, TEST);
  const trainRows = rowsIn(candidates, TRAIN);
  const trainValRows = candidates.filter((c) => c.time >= TRAIN.from && c.time < TEST.from);
  const valDays = marketDays(valRows), testDays = marketDays(testRows);

  // ---- selection on VALIDATION only ----
  const grid: Array<{ arch: string; geo: Geo; coverage: number; confidence: number; summary: any; trades: V5Trade[] }> = [];
  const calForVal = rowsIn(candidates, { from: addUtcMonths(VALIDATION.from, -CALIBRATION_MONTHS), to: VALIDATION.from });
  let seed = 0x51ed5;
  for (const arch of ARCHS) {
    for (const geo of SWING_GEOMETRIES) {
      const heads = trainHeads(trainRows, arch, geo, (seed += 8191));
      for (const coverage of COVERAGES) {
        const scored = scoreAndThreshold(valRows, calForVal, heads, coverage);
        for (const confidence of CONFIDENCES) {
          const trades = replay(scored, geo, confidence);
          grid.push({ arch: arch.name, geo, coverage, confidence, trades, summary: stats(trades, valDays) });
        }
      }
    }
  }
  const robust = (r: any) => r.summary.expectancyR - 0.5 * (r.summary.expectancy95.upper - r.summary.expectancyR) / 1.96;
  const eligibleArms = grid.filter((r) => r.summary.trades >= 20 && r.summary.profitFactor > 1);
  const pool = eligibleArms.length ? eligibleArms : grid.filter((r) => r.summary.trades >= 20);
  const selected = [...pool].sort((a, b) => robust(b) - robust(a) || b.summary.profitFactor - a.summary.profitFactor)[0]!;
  const selArch = ARCHS.find((a) => a.name === selected.arch)!;
  console.log(`Selected arch=${selected.arch} geo=${geoKey(selected.geo)} coverage=${selected.coverage} conf=${selected.confidence}`);

  // ---- TEST once ----
  const testHeads = trainHeads(trainValRows, selArch, selected.geo, 0x7e57 ^ 0x1234);
  const calForTest = rowsIn(candidates, { from: addUtcMonths(TEST.from, -CALIBRATION_MONTHS), to: TEST.from });
  const testScored = scoreAndThreshold(testRows, calForTest, testHeads, selected.coverage);
  const testTrades = replay(testScored, selected.geo, selected.confidence);

  // ---- walk-forward + inline gross/net/direction/news diagnosis ----
  const key = geoKey(selected.geo);
  const wfTrades: V5Trade[] = [];
  const wfFolds: any[] = [];
  const rec = { net: [] as number[], gross: [] as number[], opp: [] as number[], pickedBetter: 0, newsAgree: 0, newsN: 0 };
  let foldSeed = 0x9e37;
  for (
    let foldStart = addUtcMonths(WINDOW_FROM, WALKFORWARD_MIN_TRAIN_MONTHS);
    foldStart < TEST.to;
    foldStart = addUtcMonths(foldStart, WALKFORWARD_STEP_MONTHS)
  ) {
    const foldEnd = Math.min(TEST.to, addUtcMonths(foldStart, WALKFORWARD_STEP_MONTHS));
    const trainFold = candidates.filter((c) => c.time >= WINDOW_FROM && c.time < foldStart);
    const evalFold = candidates.filter((c) => c.time >= foldStart && c.time < foldEnd);
    if (trainFold.length < 200 || !evalFold.length) continue;
    const heads = trainHeads(trainFold, selArch, selected.geo, (foldSeed += 7919));
    const calFold = candidates.filter((c) => c.time >= addUtcMonths(foldStart, -CALIBRATION_MONTHS) && c.time < foldStart);
    const scored = scoreAndThreshold(evalFold, calFold.length ? calFold : trainFold, heads, selected.coverage);
    const trades = replay(scored, selected.geo, selected.confidence);
    wfTrades.push(...trades);
    wfFolds.push({ fold: `${new Date(foldStart).toISOString().slice(0, 10)}..${new Date(foldEnd).toISOString().slice(0, 10)}`, ...stats(trades, marketDays(evalFold)) });
    // diagnosis: replay gating again to capture candidate-level gross/opposite/news
    const perDay = new Map<string, number>(); let locked = -Infinity;
    for (const row of [...scored].sort((a, b) => a.time - b.time)) {
      if (!isEligible(row) || row.rankScore < row.threshold || row.directionConfidence < selected.confidence) continue;
      if (row.time < locked || (perDay.get(row.day) ?? 0) >= 3) continue;
      const o = row.outcomes.get(key)!;
      const chosen = row.direction === 1 ? o.long : o.short;
      const opp = row.direction === 1 ? o.short : o.long;
      rec.net.push(chosen.r);
      rec.gross.push(resolveOutcomeGeo(bars, series, row.index, row.direction, selected.geo, true, SWING_MAX_HOLD_BARS).r);
      rec.opp.push(opp.r);
      if ((row.direction === 1 ? 1 : -1) === (o.long.r >= o.short.r ? 1 : -1)) rec.pickedBetter += 1;
      const signed = row.longX[20]!;
      if (Math.abs(signed) > 1e-9) {
        rec.newsN += 1;
        const gl = resolveOutcomeGeo(bars, series, row.index, 1, selected.geo, true, SWING_MAX_HOLD_BARS).r;
        const gs = resolveOutcomeGeo(bars, series, row.index, -1, selected.geo, true, SWING_MAX_HOLD_BARS).r;
        if ((signed > 0 ? 1 : -1) === (gl >= gs ? 1 : -1)) rec.newsAgree += 1;
      }
      perDay.set(row.day, (perDay.get(row.day) ?? 0) + 1); locked = chosen.exitTime;
    }
  }
  const wfDays = marketDays(candidates.filter((c) => c.time >= addUtcMonths(WINDOW_FROM, WALKFORWARD_MIN_TRAIN_MONTHS) && c.time < TEST.to));
  const n = rec.net.length;
  const diagnosis = {
    walkForwardTrades: n,
    grossExpectancy: +mean(rec.gross).toFixed(4),
    netExpectancy: +mean(rec.net).toFixed(4),
    avgCostPerTradeR: +(mean(rec.gross) - mean(rec.net)).toFixed(4),
    grossPF: +Number(pf(rec.gross)).toFixed(3),
    netPF: +Number(pf(rec.net)).toFixed(3),
    modelPickedBetterExecutableSide: +(rec.pickedBetter / Math.max(1, n)).toFixed(3),
    oppositeNetExpectancy: +mean(rec.opp).toFixed(4),
    newsSignPredictsBetterSideRate: +(rec.newsAgree / Math.max(1, rec.newsN)).toFixed(3),
  };

  const testSummary = stats(testTrades, testDays);
  const wfSummary = stats(wfTrades, wfDays);
  const verdict =
    testSummary.expectancyR > 0 && testSummary.profitFactor > 1 && wfSummary.expectancyR > 0 && wfSummary.profitFactor > 1
      ? (testSummary.expectancy95.lower > 0 ? "POSITIVE_ON_TEST_AND_WALKFORWARD_RESEARCH_ONLY" : "POSITIVE_BUT_TEST_INTERVAL_CROSSES_ZERO")
      : "NO_ROBUST_EDGE_AT_SWING_HORIZON";

  const report = round({
    generatedAt: new Date().toISOString(),
    verdict,
    horizon: { maxHoldBars: SWING_MAX_HOLD_BARS, approxMaxHoldDays: SWING_MAX_HOLD_BARS / 96, geometriesTested: SWING_GEOMETRIES.map(geoKey) },
    selection: { arch: selected.arch, geometry: key, coverage: selected.coverage, minDirectionConfidence: selected.confidence, validationSummary: selected.summary },
    results: {
      train: { summary: stats(replay(scoreAndThreshold(trainRows, trainRows, trainHeads(trainRows, selArch, selected.geo, 0x1234), selected.coverage), selected.geo, selected.confidence), marketDays(trainRows)) },
      validation: { summary: selected.summary },
      test: { summary: testSummary, breakdowns: breakdowns(testTrades, testDays) },
      walkForward: { summary: wfSummary, folds: wfFolds, breakdowns: breakdowns(wfTrades, wfDays) },
    },
    diagnosis,
  }) as any;
  writeFileSync(path.join(OUTPUT, "RESULTS.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.test.json"), JSON.stringify(testTrades, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.walkforward.json"), JSON.stringify(wfTrades, null, 2));
  console.log(JSON.stringify({ verdict, selection: report.selection && { arch: selected.arch, geometry: key, coverage: selected.coverage, confidence: selected.confidence },
    test: report.results.test.summary, walkForward: report.results.walkForward.summary, diagnosis }, null, 2));
}
main();
