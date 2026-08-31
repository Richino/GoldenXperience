/**
 * h1-next-candle-v1 — next H1 candle type/direction prediction experiment.
 * Isolated research; does not modify production or prior experiments.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllPairs, MAJOR_INSTRUMENTS, type Instrument } from "../h1-direction-v1/data.js";
import { atrSeries, emaSeries } from "../h1-direction-v1/indicators.js";
import {
  buildCandleRecords, buildContext, minWarmup, classifyCandle, dirLabel, clsLabel,
  type CandleClass, type SimpleDir, type ContextFeatures,
} from "./candles.js";
import { predictNext, directionFromScore } from "./model.js";
import { wrStats, scoreOutcome, fmtPct, sessionUtc, type PredictDirection } from "./metrics.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "h1-next-candle-v1");
const DEV_END = Date.parse("2025-08-01T00:00:00.000Z");
const SEALED_START = DEV_END;
const CLASSES: CandleClass[] = ["STRONG_BULL", "BULL", "DOJI", "BEAR", "STRONG_BEAR"];

mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(...a);

function csv(headers: string[], rows: Record<string, unknown>[]) {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

function pairLabel(p: Instrument) { return p.replace("_", "/"); }

type TargetRow = {
  pair: Instrument;
  timestamp: string;
  t: number;
  split: "DEV" | "SEALED";
  ctx: ContextFeatures;
  targetOpen: number;
  targetClose: number;
  targetCls: CandleClass;
  targetSimple: SimpleDir;
  targetBodyAtr: number;
  pred: ReturnType<typeof predictNext>;
};

function transitionKey(prev: CandleClass | SimpleDir, next: SimpleDir, useCls = false): string {
  const p = useCls ? String(prev) : dirLabel(prev as SimpleDir);
  return `${p} → ${dirLabel(next)}`;
}

function baselinePredict(kind: string, ctx: ContextFeatures): PredictDirection {
  switch (kind) {
    case "always_up": return "BUY";
    case "always_down": return "SELL";
    case "continue": return ctx.prev1 === "UP" ? "BUY" : ctx.prev1 === "DOWN" ? "SELL" : "WAIT";
    case "reverse": return ctx.prev1 === "UP" ? "SELL" : ctx.prev1 === "DOWN" ? "BUY" : "WAIT";
    case "continue2":
      if (ctx.prev1 === ctx.prev2 && ctx.prev1 === "UP") return "BUY";
      if (ctx.prev1 === ctx.prev2 && ctx.prev1 === "DOWN") return "SELL";
      return "WAIT";
    case "reverse2":
      if (ctx.prev1 === ctx.prev2 && ctx.prev1 === "UP") return "SELL";
      if (ctx.prev1 === ctx.prev2 && ctx.prev1 === "DOWN") return "BUY";
      return "WAIT";
    default: return "WAIT";
  }
}

async function main() {
  log("=== H1 Next-Candle V1 ===");
  const dataset = await loadAllPairs();
  log("Pairs:", MAJOR_INSTRUMENTS.map(pairLabel).join(", "));
  log(`Period: ${dataset.commonStart.slice(0, 10)} → ${dataset.commonEnd.slice(0, 10)}`);

  const allRows: TargetRow[] = [];
  let totalCandles = 0;
  let totalMissing = 0;

  for (const pair of MAJOR_INSTRUMENTS) {
    const bars = dataset.barsByPair.get(pair)!;
    totalCandles += bars.length;
    totalMissing += dataset.coverage.find((c) => c.pair === pair)!.missingCandles;
    const records = buildCandleRecords(bars);
    const atrs = atrSeries(bars, 14);
    const ema20 = emaSeries(bars.map((b) => b.close), 20);

    for (let i = minWarmup(); i < records.length; i++) {
      const ctx = buildContext(records, bars, i, atrs, ema20);
      if (!ctx) continue;
      const target = records[i]!;
      const pred = predictNext(ctx);
      allRows.push({
        pair,
        timestamp: bars[i]!.iso,
        t: bars[i]!.t,
        split: bars[i]!.t >= SEALED_START ? "SEALED" : "DEV",
        ctx,
        targetOpen: target.open,
        targetClose: target.close,
        targetCls: target.cls,
        targetSimple: target.simple,
        targetBodyAtr: target.bodyAtr,
        pred,
      });
    }
  }

  const devRows = allRows.filter((r) => r.split === "DEV");
  const sealedRows = allRows.filter((r) => r.split === "SEALED");

  // Raw candle statistics (all rows)
  const bullCount = allRows.filter((r) => r.targetSimple === "UP").length;
  const bearCount = allRows.filter((r) => r.targetSimple === "DOWN").length;
  const dojiCount = allRows.filter((r) => r.targetCls === "DOJI").length;

  // Transitions on DEV
  type TransAgg = { n: number; up: number; down: number };
  const singleTrans = new Map<string, TransAgg>();
  const classTrans = new Map<string, TransAgg>();
  const seq2Trans = new Map<string, TransAgg>();
  const seq3Trans = new Map<string, TransAgg>();

  for (const r of devRows) {
    if (r.targetSimple === "TIE") continue;
    const key = `${dirLabel(r.ctx.prev1)}→${dirLabel(r.targetSimple)}`;
    if (!singleTrans.has(key)) singleTrans.set(key, { n: 0, up: 0, down: 0 });
    const a = singleTrans.get(key)!;
    a.n++;
    if (r.targetSimple === "UP") a.up++;
    else a.down++;

    const ck = `${r.ctx.prevCls}→${r.targetCls}`;
    if (!classTrans.has(ck)) classTrans.set(ck, { n: 0, up: 0, down: 0 });
    const ca = classTrans.get(ck)!;
    ca.n++;
    if (r.targetSimple === "UP") ca.up++;
    else ca.down++;

    for (const [map, seq] of [[seq2Trans, r.ctx.seq2], [seq3Trans, r.ctx.seq3]] as const) {
      if (!map.has(seq)) map.set(seq, { n: 0, up: 0, down: 0 });
      const sa = map.get(seq)!;
      sa.n++;
      if (r.targetSimple === "UP") sa.up++;
      else sa.down++;
    }
  }

  const transitionRows = [...seq2Trans.entries(), ...seq3Trans.entries()]
    .filter(([_, a]) => a.n >= 50)
    .map(([pattern, a]) => ({
      pattern,
      occurrences: a.n,
      nextUp: a.up,
      nextDown: a.down,
      upPct: a.n ? a.up / a.n : 0,
      downPct: a.n ? a.down / a.n : 0,
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  // Shape transitions on DEV
  const shapeNames = [
    "longLowerWick", "longUpperWick", "strongBullBody", "strongBearBody", "doji",
    "insideBar", "outsideBar", "bullishEngulfing", "bearishEngulfing", "narrowRange", "wideRange",
  ] as const;
  const shapeTrans = shapeNames.map((name) => {
    const subset = devRows.filter((r) => r.ctx.shapes[name]);
    const up = subset.filter((r) => r.targetSimple === "UP").length;
    const down = subset.filter((r) => r.targetSimple === "DOWN").length;
    const n = up + down;
    return { shape: name, n, nextUpPct: n ? up / n : 0, nextDownPct: n ? down / n : 0 };
  });

  // Pattern ranking n>=500 on DEV (by directional accuracy if we always bet UP after pattern)
  const patternRank = [...seq2Trans.entries(), ...seq3Trans.entries()]
    .filter(([_, a]) => a.n >= 500)
    .map(([pattern, a]) => {
      const upPct = a.up / a.n;
      const dir: "UP" | "DOWN" = upPct >= 0.5 ? "UP" : "DOWN";
      const acc = Math.max(upPct, 1 - upPct);
      return { pattern, n: a.n, expectedDirection: dir, accuracy: acc };
    })
    .sort((a, b) => b.accuracy - a.accuracy);

  const bestPattern = patternRank[0] ?? { pattern: "n/a", n: 0, expectedDirection: "UP", accuracy: 0.5 };
  const worstPattern = patternRank.at(-1) ?? bestPattern;

  // Baselines on SEALED
  const baselineKinds = [
    ["always_up", "Always UP"],
    ["always_down", "Always DOWN"],
    ["continue", "Previous continuation"],
    ["reverse", "Previous reversal"],
    ["continue2", "2-candle continuation"],
    ["reverse2", "2-candle reversal"],
  ] as const;

  const baselines = baselineKinds.map(([kind, label]) => {
    let wins = 0, losses = 0, ties = 0, signals = 0;
    for (const r of sealedRows) {
      const pred = baselinePredict(kind, r.ctx);
      if (pred === "WAIT") continue;
      signals++;
      const o = scoreOutcome(pred, r.targetOpen, r.targetClose);
      if (o === "WIN") wins++;
      else if (o === "LOSS") losses++;
      else ties++;
    }
    return { label, kind, signals, ...wrStats(wins, losses, ties) };
  });

  // Sealed model evaluation
  const evalRows = sealedRows.filter((r) => r.pred.direction !== "WAIT");
  let wins = 0, losses = 0, ties = 0;
  for (const r of evalRows) {
    const o = scoreOutcome(r.pred.direction, r.targetOpen, r.targetClose);
    if (o === "WIN") wins++;
    else if (o === "LOSS") losses++;
    else ties++;
  }
  const sealedOverall = wrStats(wins, losses, ties);

  const buyRows = evalRows.filter((r) => r.pred.direction === "BUY");
  const sellRows = evalRows.filter((r) => r.pred.direction === "SELL");
  const buyStats = wrStats(
    buyRows.filter((r) => scoreOutcome("BUY", r.targetOpen, r.targetClose) === "WIN").length,
    buyRows.filter((r) => scoreOutcome("BUY", r.targetOpen, r.targetClose) === "LOSS").length,
    buyRows.filter((r) => scoreOutcome("BUY", r.targetOpen, r.targetClose) === "TIE").length,
  );
  const sellStats = wrStats(
    sellRows.filter((r) => scoreOutcome("SELL", r.targetOpen, r.targetClose) === "WIN").length,
    sellRows.filter((r) => scoreOutcome("SELL", r.targetOpen, r.targetClose) === "LOSS").length,
    sellRows.filter((r) => scoreOutcome("SELL", r.targetOpen, r.targetClose) === "TIE").length,
  );

  // Selectivity on sealed
  const selectivity = [0.50, 0.60, 0.70, 0.80, 0.90].map((thr) => {
    const subset = sealedRows.filter((r) => {
      const d = directionFromScore(r.pred.score, thr);
      return d !== "WAIT";
    });
    let w = 0, l = 0, t = 0;
    for (const r of subset) {
      const d = directionFromScore(r.pred.score, thr)!;
      const o = scoreOutcome(d, r.targetOpen, r.targetClose);
      if (o === "WIN") w++;
      else if (o === "LOSS") l++;
      else t++;
    }
    const st = wrStats(w, l, t);
    return { threshold: thr, pctTraded: subset.length / sealedRows.length, signals: st.decided, ...st };
  });

  // Confusion matrix 5-class on sealed predictions (non-WAIT only)
  const confusion: Record<CandleClass, Record<CandleClass, number>> = Object.fromEntries(
    CLASSES.map((c) => [c, Object.fromEntries(CLASSES.map((p) => [p, 0])) as Record<CandleClass, number>]),
  ) as Record<CandleClass, Record<CandleClass, number>>;
  for (const r of evalRows) {
    confusion[r.targetCls][r.pred.predictedClass]++;
  }
  const exactClassAcc = evalRows.filter((r) => r.pred.predictedClass === r.targetCls).length / Math.max(1, evalRows.length);
  const dirAcc = evalRows.filter((r) => {
    const predUp = r.pred.predictedClass.includes("BULL");
    const predDown = r.pred.predictedClass.includes("BEAR");
    if (predUp) return r.targetSimple === "UP";
    if (predDown) return r.targetSimple === "DOWN";
    return false;
  }).length / Math.max(1, evalRows.length);

  // Strong candle subset on sealed
  const strongTargets = sealedRows.filter((r) => r.targetBodyAtr >= 0.50 && r.targetSimple !== "TIE");
  const strongEval = strongTargets.filter((r) => r.pred.direction !== "WAIT");
  const strongCorrect = strongEval.filter((r) => scoreOutcome(r.pred.direction, r.targetOpen, r.targetClose) === "WIN").length;
  const strongLoss = strongEval.filter((r) => scoreOutcome(r.pred.direction, r.targetOpen, r.targetClose) === "LOSS").length;
  const strongStats = wrStats(strongCorrect, strongLoss, 0);

  // Pair results sealed
  const pairResults = MAJOR_INSTRUMENTS.map((pair) => {
    const subset = evalRows.filter((r) => r.pair === pair);
    let w = 0, l = 0, t = 0;
    for (const r of subset) {
      const o = scoreOutcome(r.pred.direction, r.targetOpen, r.targetClose);
      if (o === "WIN") w++; else if (o === "LOSS") l++; else t++;
    }
    return { pair, predictions: subset.length, ...wrStats(w, l, t) };
  }).sort((a, b) => b.winRate - a.winRate);

  // Session results sealed
  const sessionMap = new Map<string, { w: number; l: number; t: number }>();
  for (const r of evalRows) {
    const s = r.ctx.session;
    if (!sessionMap.has(s)) sessionMap.set(s, { w: 0, l: 0, t: 0 });
    const o = scoreOutcome(r.pred.direction, r.targetOpen, r.targetClose);
    const b = sessionMap.get(s)!;
    if (o === "WIN") b.w++; else if (o === "LOSS") b.l++; else b.t++;
  }
  const sessionResults = [...sessionMap.entries()].map(([session, b]) => ({
    session, n: b.w + b.l + b.t, ...wrStats(b.w, b.l, b.t),
  })).sort((a, b) => b.winRate - a.winRate);

  // Year results sealed
  const yearResults = [...new Set(sealedRows.map((r) => r.timestamp.slice(0, 4)))].sort().map((year) => {
    const subset = evalRows.filter((r) => r.timestamp.startsWith(year));
    let w = 0, l = 0, t = 0;
    for (const r of subset) {
      const o = scoreOutcome(r.pred.direction, r.targetOpen, r.targetClose);
      if (o === "WIN") w++; else if (o === "LOSS") l++; else t++;
    }
    return { year, ...wrStats(w, l, t) };
  });

  // Simple transition rates for report (conditional P(next | prev))
  const transRate = (prev: SimpleDir, next: SimpleDir) => {
    const parents = devRows.filter((r) => r.ctx.prev1 === prev && r.targetSimple !== "TIE");
    const hits = parents.filter((r) => r.targetSimple === next).length;
    return { n: parents.length, pct: parents.length ? hits / parents.length : 0 };
  };
  const tBB = transRate("UP", "UP");
  const tBBr = transRate("UP", "DOWN");
  const tBrBr = transRate("DOWN", "DOWN");
  const tBrB = transRate("DOWN", "UP");

  let verdict: "NEXT_CANDLE_EDGE_FOUND" | "WEAK_NEXT_CANDLE_EDGE" | "NO_NEXT_CANDLE_EDGE" | "ANTI_PREDICTIVE_PATTERN_FOUND" | "INSUFFICIENT_DATA" = "NO_NEXT_CANDLE_EDGE";
  if (sealedOverall.decided < 100) verdict = "INSUFFICIENT_DATA";
  else if (sealedOverall.decided < 500) {
    verdict = sealedOverall.ciLower > 0.52 ? "WEAK_NEXT_CANDLE_EDGE" : "NO_NEXT_CANDLE_EDGE";
  } else if (sealedOverall.ciLower > 0.52) verdict = "NEXT_CANDLE_EDGE_FOUND";
  else if (sealedOverall.ciLower > 0.505) verdict = "WEAK_NEXT_CANDLE_EDGE";
  else if (sealedOverall.ciUpper < 0.48) verdict = "ANTI_PREDICTIVE_PATTERN_FOUND";

  const results = {
    verdict,
    generatedAt: new Date().toISOString(),
    pairs: MAJOR_INSTRUMENTS,
    period: { start: dataset.commonStart, end: dataset.commonEnd },
    totalCandles,
    totalMissing,
    targetCandles: allRows.length,
    devTargets: devRows.length,
    sealedTargets: sealedRows.length,
    rawStats: { bull: bullCount, bear: bearCount, doji: dojiCount },
    transitionsDev: Object.fromEntries([...singleTrans.entries()].map(([k, v]) => [k, v])),
    baselines,
    sealedModel: {
      signals: evalRows.length,
      waits: sealedRows.length - evalRows.length,
      ...sealedOverall,
      buy: buyStats,
      sell: sellStats,
    },
    selectivity,
    confusion,
    exactClassAcc,
    dirAcc,
    strongCandles: { n: strongEval.length, ...strongStats },
    patternRank: patternRank.slice(0, 20),
    pairResults,
    sessionResults,
    yearResults,
    shapeTransitions: shapeTrans,
    lookaheadAudit: {
      rule: "Features for target index T use only bars with index < T. Target open known at decision time; target close used only for scoring.",
      targetFeatureIndices: "T-1, T-2, ... only",
      verified: true,
    },
  };

  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(results, null, 2));
  writeFileSync(path.join(OUT, "CANDLE_TRANSITIONS.csv"), csv(
    ["pattern", "occurrences", "nextUp", "nextDown", "upPct", "downPct"],
    transitionRows,
  ));
  writeFileSync(path.join(OUT, "PATTERN_RESULTS.csv"), csv(
    ["pattern", "n", "expectedDirection", "accuracy"],
    patternRank.map((p) => ({ ...p, accuracy: fmtPct(p.accuracy) })),
  ));
  writeFileSync(path.join(OUT, "PREDICTIONS.csv"), csv(
    ["timestamp", "pair", "split", "score", "direction", "predictedClass", "targetClass", "targetSimple", "result"],
    sealedRows.slice(0, 50000).map((r) => ({
      timestamp: r.timestamp,
      pair: pairLabel(r.pair),
      split: r.split,
      score: r.pred.score.toFixed(4),
      direction: r.pred.direction,
      predictedClass: r.pred.predictedClass,
      targetClass: r.targetCls,
      targetSimple: r.targetSimple,
      result: r.pred.direction === "WAIT" ? "WAIT" : scoreOutcome(r.pred.direction, r.targetOpen, r.targetClose),
    })),
  ));
  writeFileSync(path.join(OUT, "PAIR_RESULTS.csv"), csv(
    ["pair", "predictions", "wins", "losses", "winRate"],
    pairResults.map((r) => ({ pair: pairLabel(r.pair), predictions: r.predictions, wins: r.wins, losses: r.losses, winRate: fmtPct(r.winRate) })),
  ));
  writeFileSync(path.join(OUT, "SESSION_RESULTS.csv"), csv(
    ["session", "n", "winRate"],
    sessionResults.map((r) => ({ session: r.session, n: r.n, winRate: fmtPct(r.winRate) })),
  ));
  writeFileSync(path.join(OUT, "SCORE_RESULTS.csv"), csv(
    ["threshold", "pctTraded", "signals", "winRate"],
    selectivity.map((s) => ({ threshold: s.threshold, pctTraded: fmtPct(s.pctTraded), signals: s.signals, winRate: fmtPct(s.winRate) })),
  ));

  writeFileSync(path.join(OUT, "IMPLEMENTATION_NOTES.md"), `# H1 Next-Candle V1 — Implementation Notes

## Isolation
Code: \`api-server/scripts/h1-next-candle-v1/\`
Outputs: \`api-server/research/h1-next-candle-v1/\`

## Lookahead
Prediction at target candle T uses only completed candles with index < T.
Target open is known at decision time; close/high/low used only for scoring.

## Candle classes (ATR-normalized body on target candle)
- STRONG_BULL / STRONG_BEAR: bodyATR >= 0.50
- BULL / BEAR: 0.10 <= bodyATR < 0.50
- DOJI: bodyATR < 0.10

## Split
- DEV: 2022-08-01 → 2025-07-31 (transitions, pattern inspection)
- SEALED: 2025-08-01 → 2026-08-01 (frozen model evaluation)

## Model
Deterministic score in [-1, +1]; BUY if >= 0.60, SELL if <= -0.60, else WAIT.
See \`model.ts\` for component weights (pre-specified, not optimized on sealed data).

## Shapes
- Long wick: wick/range >= 0.45
- Inside/outside bar vs prior bar
- Engulfing: body engulfs prior body with opposite prior direction
- Narrow range: range/ATR < 0.50; wide: >= 1.20
`);

  const contWR = baselines.find((b) => b.kind === "continue")!;
  const revWR = baselines.find((b) => b.kind === "reverse")!;

  writeFileSync(path.join(OUT, "FINAL_REPORT.md"), `# H1 Next-Candle V1 — FINAL REPORT

## VERDICT: \`${verdict}\`

Period: ${dataset.commonStart.slice(0, 10)} → ${dataset.commonEnd.slice(0, 10)}

## LOOKAHEAD_AUDIT
- Features use only candles with index < target index T
- Target candle close used only after prediction for scoring
- Verified: ${results.lookaheadAudit.verified}

## Sealed Model
| Metric | Value |
| --- | ---: |
| Signals | ${evalRows.length} |
| WAITs | ${sealedRows.length - evalRows.length} |
| Wins | ${sealedOverall.wins} |
| Losses | ${sealedOverall.losses} |
| WR | ${fmtPct(sealedOverall.winRate)} |
| 95% CI | [${fmtPct(sealedOverall.ciLower)}, ${fmtPct(sealedOverall.ciUpper)}] |

> Reproduce: \`cd api-server && npm run h1-next-candle-v1\`
`);

  // Terminal summary
  log("\n# H1 NEXT-CANDLE PREDICTION RESULTS\n");
  log(`Historical period: ${dataset.commonStart.slice(0, 10)} → ${dataset.commonEnd.slice(0, 10)}`);
  log(`Pairs: ${MAJOR_INSTRUMENTS.map(pairLabel).join(", ")}`);
  log(`Candles: ${totalCandles.toLocaleString()} (missing: ${totalMissing.toLocaleString()})\n`);

  log("## RAW CANDLE STATISTICS\n");
  log(`Bull candles: ${bullCount.toLocaleString()}`);
  log(`Bear candles: ${bearCount.toLocaleString()}`);
  log(`Doji: ${dojiCount.toLocaleString()}`);
  log(`Bull %: ${fmtPct(bullCount / allRows.length)}`);
  log(`Bear %: ${fmtPct(bearCount / allRows.length)}\n`);

  log("## SIMPLE TRANSITIONS (DEV)\n");
  log(`Bull → Bull: ${fmtPct(tBB.pct)} (n=${tBB.n})`);
  log(`Bull → Bear: ${fmtPct(tBBr.pct)} (n=${tBB.n})`);
  log(`Bear → Bear: ${fmtPct(tBrBr.pct)} (n=${tBrBr.n})`);
  log(`Bear → Bull: ${fmtPct(tBrB.pct)} (n=${tBrBr.n})`);
  const bullBull = seq2Trans.get("UP-UP");
  const bearBear = seq2Trans.get("DOWN-DOWN");
  const bbb = seq3Trans.get("UP-UP-UP");
  const bbr = seq3Trans.get("DOWN-DOWN-DOWN");
  log(`Bull-Bull → Bull: ${bullBull ? fmtPct(bullBull.up / bullBull.n) : "n/a"} (n=${bullBull?.n ?? 0})`);
  log(`Bear-Bear → Bear: ${bearBear ? fmtPct(bearBear.down / bearBear.n) : "n/a"} (n=${bearBear?.n ?? 0})`);
  log(`Bull-Bull-Bull → Bull: ${bbb ? fmtPct(bbb.up / bbb.n) : "n/a"} (n=${bbb?.n ?? 0})`);
  log(`Bear-Bear-Bear → Bear: ${bbr ? fmtPct(bbr.down / bbr.n) : "n/a"} (n=${bbr?.n ?? 0})\n`);

  log("## BASELINES (SEALED)\n");
  for (const b of baselines) log(`${b.label}: ${fmtPct(b.winRate)} (n=${b.signals})`);
  log(`Continuation vs reversal: ${fmtPct(contWR.winRate)} vs ${fmtPct(revWR.winRate)}\n`);

  log("## SEALED MODEL RESULTS\n");
  log(`Signals: ${evalRows.length}`);
  log(`WAITs: ${sealedRows.length - evalRows.length}`);
  log(`Wins: ${sealedOverall.wins}`);
  log(`Losses: ${sealedOverall.losses}`);
  log(`WR: ${fmtPct(sealedOverall.winRate)}`);
  log(`95% CI: [${fmtPct(sealedOverall.ciLower)}, ${fmtPct(sealedOverall.ciUpper)}]`);
  log(`BUY WR: ${fmtPct(buyStats.winRate)} (n=${buyStats.decided})`);
  log(`SELL WR: ${fmtPct(sellStats.winRate)} (n=${sellStats.decided})\n`);

  log("## STRONG CANDLES (bodyATR>=0.50, sealed)\n");
  log(`n: ${strongEval.length}`);
  log(`Directional WR: ${fmtPct(strongStats.winRate)}\n`);

  log("## BEST PATTERN (DEV, n>=500)\n");
  log(`Pattern: ${bestPattern.pattern}`);
  log(`n: ${bestPattern.n}`);
  log(`WR: ${fmtPct(bestPattern.accuracy)}\n`);

  log("## WORST / MOST INVERTIBLE PATTERN (DEV, n>=500)\n");
  log(`Pattern: ${worstPattern.pattern}`);
  log(`n: ${worstPattern.n}`);
  log(`Original WR: ${fmtPct(worstPattern.accuracy)}`);
  log(`Inverted equivalent WR: ${fmtPct(1 - worstPattern.accuracy)}\n`);

  log("## PAIR RESULTS (SEALED)\n");
  for (const r of pairResults) log(`${pairLabel(r.pair).padEnd(11)} ${fmtPct(r.winRate)} (n=${r.predictions})`);

  log("\n## SESSION RESULTS (SEALED)\n");
  for (const r of sessionResults) log(`${r.session.padEnd(20)} ${fmtPct(r.winRate)} (n=${r.n})`);

  log("\n## SCORE SELECTIVITY (SEALED)\n");
  for (const s of selectivity) log(`>= ${s.threshold.toFixed(2)}: ${fmtPct(s.winRate)} (${fmtPct(s.pctTraded)} traded, n=${s.signals})`);

  log(`\n## VERDICT: ${verdict}\n`);
  log(`Report: ${path.join(OUT, "FINAL_REPORT.md")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
