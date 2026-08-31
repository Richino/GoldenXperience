/**
 * h1-direction-v1 — isolated H1 directional research experiment.
 *
 * Does NOT modify production engines, binary/adaptive systems, or prior research.
 * Run: cd api-server && npm run h1-direction-v1
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllPairs, MAJOR_INSTRUMENTS, type Instrument } from "./data.js";
import {
  buildPairState, scoreDirectionAt, directionFromScore, FULL_FLAGS, minWarmupIndex,
  baselinePreviousCandle, baselineEmaSlope, baselineEmaCross, pairLabel,
  type ModelFlags, type SignalDirection, type PairState,
} from "./model.js";
import {
  HORIZONS, attachTradingSim, forwardResult, summarizeResults, summarizeTrading,
  wilsonInterval, formatPct, quarterKey, yearKey, expectedH1Bars,
  type SignalRecord, type Horizon, type HorizonResult,
} from "./analysis.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "h1-direction-v1");
mkdirSync(OUT, { recursive: true });

const log = (...args: unknown[]) => console.log(...args);

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  return lines.join("\n");
}

function baselineResult(direction: SignalDirection, entry: number, future: number): HorizonResult {
  if (direction === "WAIT") return "NA";
  return forwardResult(direction, entry, future);
}

function pickBestHorizon(
  horizonStats: Record<Horizon, ReturnType<typeof summarizeResults>>,
): Horizon {
  let best: Horizon = 1;
  let bestScore = -1;
  for (const h of HORIZONS) {
    const s = horizonStats[h]!;
    if (s.signals < 100) continue;
    const score = s.winRate * Math.log10(s.signals);
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

function aggregateHorizon(signals: SignalRecord[], h: Horizon) {
  return summarizeResults(signals.map((s) => s.horizonResults[h]!));
}

function filterThreshold(signals: SignalRecord[], threshold: number): SignalRecord[] {
  return signals.filter((s) => Math.abs(s.directionScore) >= threshold && s.direction !== "WAIT");
}

async function main() {
  log("=== H1 Direction V1 — Loading Data ===");
  log("Selected pairs:", MAJOR_INSTRUMENTS.map(pairLabel).join(", "));

  const dataset = await loadAllPairs();
  log("\nPair coverage:");
  for (const c of dataset.coverage) {
    log(`  ${pairLabel(c.pair)}: ${c.candles} candles | ${c.start.slice(0, 10)} → ${c.end.slice(0, 10)} | gaps=${c.gaps} missing=${c.missingCandles} | source=${c.source} | median spread=${c.medianSpreadPips} pips`);
  }

  const commonStartMs = Date.parse(dataset.commonStart);
  const commonEndMs = Date.parse(dataset.commonEnd);
  const expectedBars = expectedH1Bars(commonStartMs, commonEndMs);
  log(`\nCommon period: ${dataset.commonStart.slice(0, 10)} → ${dataset.commonEnd.slice(0, 10)}`);
  log(`Expected H1 bars per pair (ideal): ~${expectedBars}`);

  const allSignals: SignalRecord[] = [];
  const warmup = minWarmupIndex();
  const pairStates = new Map<Instrument, PairState>();

  for (const pair of dataset.pairs) {
    pairStates.set(pair, buildPairState(dataset.barsByPair.get(pair)!));
  }

  for (const pair of dataset.pairs) {
    const bars = dataset.barsByPair.get(pair)!;
    const state = pairStates.get(pair)!;
    const maxHorizon = 24;
    for (let i = warmup; i < bars.length - maxHorizon; i++) {
      const scored = scoreDirectionAt(state, i, FULL_FLAGS);
      if (!scored) continue;
      const entry = bars[i]!.close;
      const forwardPrices = {} as Record<Horizon, number | null>;
      const horizonResults = {} as Record<Horizon, HorizonResult>;
      for (const h of HORIZONS) {
        const fi = i + h;
        const fp = fi < bars.length ? bars[fi]!.close : null;
        forwardPrices[h] = fp;
        horizonResults[h] = forwardResult(scored.direction, entry, fp ?? NaN);
      }
      const spreadRaw = (bars[i]!.askClose - bars[i]!.bidClose) / (pair.includes("JPY") ? 0.01 : 0.0001);
      const spreadPips = spreadRaw > 0 ? spreadRaw : 2.0;
      const sig: SignalRecord = {
        timestamp: bars[i]!.iso,
        pair,
        pairLabel: pairLabel(pair),
        barIndex: i,
        direction: scored.direction,
        directionScore: scored.score,
        marketRegime: scored.features.regime,
        entryPrice: entry,
        ema20: scored.features.ema20,
        ema50: scored.features.ema50,
        ema200: scored.features.ema200,
        ema20Slope: scored.features.ema20Slope,
        ema50Slope: scored.features.ema50Slope,
        ema200Slope: scored.features.ema200Slope,
        rsi: scored.features.rsi,
        macd: scored.features.macd,
        atr: scored.features.atr,
        structureClassification: scored.features.structure,
        momentumClassification: scored.features.momentum,
        volatilityClassification: scored.features.volatility,
        forwardPrices,
        horizonResults,
        spreadPips,
        breakdown: scored.breakdown as unknown as Record<string, number>,
      };
      attachTradingSim(sig, bars);
      allSignals.push(sig);
    }
  }

  const traded = allSignals.filter((s) => s.direction !== "WAIT");
  log(`\nTotal H1 evaluation bars: ${allSignals.length.toLocaleString()}`);
  log(`Directional signals (|score|>=0.60): ${traded.length.toLocaleString()} (${formatPct(traded.length / allSignals.length)} of bars)`);

  const horizonStats = Object.fromEntries(HORIZONS.map((h) => [h, aggregateHorizon(traded, h)])) as Record<Horizon, ReturnType<typeof summarizeResults>>;
  const bestHorizon = pickBestHorizon(horizonStats);
  const bestStats = horizonStats[bestHorizon]!;

  // Pair results at best horizon
  const pairResults = dataset.pairs.map((pair) => {
    const subset = traded.filter((s) => s.pair === pair);
    return { pair, ...aggregateHorizon(subset, bestHorizon) };
  });
  const allPairAgg = aggregateHorizon(traded, bestHorizon);

  // Long vs short
  const longStats = aggregateHorizon(traded.filter((s) => s.direction === "LONG"), bestHorizon);
  const shortStats = aggregateHorizon(traded.filter((s) => s.direction === "SHORT"), bestHorizon);
  const longShortByPair = dataset.pairs.map((pair) => ({
    pair,
    long: aggregateHorizon(traded.filter((s) => s.pair === pair && s.direction === "LONG"), bestHorizon),
    short: aggregateHorizon(traded.filter((s) => s.pair === pair && s.direction === "SHORT"), bestHorizon),
  }));

  // Regime results
  const regimes = ["TREND_UP", "TREND_DOWN", "RANGE", "BREAKOUT", "HIGH_VOLATILITY", "LOW_VOLATILITY"] as const;
  const regimeResults = regimes.map((regime) => {
    const subset = traded.filter((s) => s.marketRegime === regime);
    const agg = aggregateHorizon(subset, bestHorizon);
    return { regime, signals: agg.signals, winRate: agg.winRate, ciLower: agg.ciLower, ciUpper: agg.ciUpper };
  });
  const sortedRegimes = [...regimeResults].filter((r) => r.signals >= 30).sort((a, b) => b.winRate - a.winRate);
  const bestRegime = sortedRegimes[0] ?? regimeResults[0]!;
  const worstRegime = sortedRegimes.at(-1) ?? regimeResults[0]!;

  // Score buckets
  const scoreBuckets = [
    { label: "0.60–0.69", lo: 0.60, hi: 0.70 },
    { label: "0.70–0.79", lo: 0.70, hi: 0.80 },
    { label: "0.80–0.89", lo: 0.80, hi: 0.90 },
    { label: "0.90–1.00", lo: 0.90, hi: 1.01 },
  ].map(({ label, lo, hi }) => {
    const subset = traded.filter((s) => Math.abs(s.directionScore) >= lo && Math.abs(s.directionScore) < hi);
    const agg = aggregateHorizon(subset, bestHorizon);
    return { bucket: label, signals: agg.signals, winRate: agg.winRate };
  });

  // Selectivity — re-evaluate direction at each threshold (not the fixed 0.60 label)
  const selectivity = [0.50, 0.60, 0.70, 0.80, 0.90].map((threshold) => {
    const results: HorizonResult[] = [];
    for (const s of allSignals) {
      const dir = directionFromScore(s.directionScore, threshold);
      if (dir === "WAIT") continue;
      results.push(forwardResult(dir, s.entryPrice, s.forwardPrices[bestHorizon] ?? NaN));
    }
    const agg = summarizeResults(results);
    return {
      threshold,
      pctHoursTraded: agg.signals / allSignals.length,
      signals: agg.signals,
      winRate: agg.winRate,
    };
  });

  // Walk-forward by year/quarter
  const byYear = new Map<string, ReturnType<typeof summarizeResults>>();
  const byQuarter = new Map<string, ReturnType<typeof summarizeResults>>();
  for (const y of new Set(traded.map((s) => yearKey(s.timestamp)))) {
    byYear.set(y, aggregateHorizon(traded.filter((x) => yearKey(x.timestamp) === y), bestHorizon));
  }
  for (const q of new Set(traded.map((s) => quarterKey(s.timestamp)))) {
    byQuarter.set(q, aggregateHorizon(traded.filter((x) => quarterKey(x.timestamp) === q), bestHorizon));
  }

  // Baselines at best horizon
  type BaselineRow = { name: string; winRate: number; signals: number; ciLower: number };
  const baselineRows: BaselineRow[] = [];

  const baselineEval = (name: string, dirFn: (pair: Instrument, i: number) => SignalDirection) => {
    const results: HorizonResult[] = [];
    for (const pair of dataset.pairs) {
      const bars = dataset.barsByPair.get(pair)!;
      for (let i = warmup; i < bars.length - bestHorizon; i++) {
        const dir = dirFn(pair, i);
        if (dir === "WAIT") continue;
        const entry = bars[i]!.close;
        const future = bars[i + bestHorizon]!.close;
        results.push(forwardResult(dir, entry, future));
      }
    }
    const agg = summarizeResults(results);
    baselineRows.push({ name, winRate: agg.winRate, signals: agg.signals, ciLower: agg.ciLower });
  };

  baselineEval("Always LONG", () => "LONG");
  baselineEval("Previous candle", (pair, i) => baselinePreviousCandle(dataset.barsByPair.get(pair)!, i));
  baselineEval("EMA20 slope", (pair, i) => baselineEmaSlope(pairStates.get(pair)!, i));
  baselineEval("EMA20/50 cross", (pair, i) => baselineEmaCross(pairStates.get(pair)!, i));

  const botBaseline = { name: "H1 Bot", winRate: bestStats.winRate, signals: bestStats.signals, ciLower: bestStats.ciLower };

  // Ablation
  const ablationDefs: Array<{ name: string; flags: ModelFlags }> = [
    { name: "FULL MODEL", flags: FULL_FLAGS },
    { name: "minus structure", flags: { ...FULL_FLAGS, useStructure: false } },
    { name: "minus EMA trend", flags: { ...FULL_FLAGS, useEmaTrend: false } },
    { name: "minus momentum", flags: { ...FULL_FLAGS, useMomentum: false } },
    { name: "minus volatility", flags: { ...FULL_FLAGS, useVolatility: false } },
    { name: "minus price location", flags: { ...FULL_FLAGS, usePriceLocation: false } },
    { name: "minus regime adj", flags: { ...FULL_FLAGS, useRegimeAdj: false } },
  ];

  const ablationResults = ablationDefs.map(({ name, flags }) => {
    const results: HorizonResult[] = [];
    for (const pair of dataset.pairs) {
      const bars = dataset.barsByPair.get(pair)!;
      const state = pairStates.get(pair)!;
      for (let i = warmup; i < bars.length - bestHorizon; i++) {
        const scored = scoreDirectionAt(state, i, flags);
        if (!scored || scored.direction === "WAIT") continue;
        const future = bars[i + bestHorizon]!.close;
        results.push(forwardResult(scored.direction, bars[i]!.close, future));
      }
    }
    const agg = summarizeResults(results);
    return { model: name, signals: agg.signals, winRate: agg.winRate, changeVsFull: agg.winRate - bestStats.winRate };
  });

  // Trading simulation summaries
  const tradingGross = ["1:1", "1.5:1", "2:1"].map((rr) => summarizeTrading(traded, rr, "GROSS"));
  const tradingNet = ["1:1", "1.5:1", "2:1"].map((rr) => summarizeTrading(traded, rr, "NET"));
  const tradingByPair = dataset.pairs.map((pair) => {
    const subset = traded.filter((s) => s.pair === pair);
    return {
      pair,
      gross11: summarizeTrading(subset, "1:1", "GROSS"),
      net11: summarizeTrading(subset, "1:1", "NET"),
      gross15: summarizeTrading(subset, "1.5:1", "GROSS"),
      net15: summarizeTrading(subset, "1.5:1", "NET"),
      gross2: summarizeTrading(subset, "2:1", "GROSS"),
      net2: summarizeTrading(subset, "2:1", "NET"),
    };
  });

  // Calibration check
  const calibrationOk = scoreBuckets.every((b, idx, arr) => idx === 0 || b.signals < 20 || b.winRate >= arr[idx - 1]!.winRate - 0.03);

  // Verdict
  let verdict: "STRONG_H1_DIRECTION_EDGE" | "WEAK_H1_DIRECTION_EDGE" | "NO_H1_DIRECTION_EDGE" | "INSUFFICIENT_DATA" = "NO_H1_DIRECTION_EDGE";
  if (traded.length < 500) verdict = "INSUFFICIENT_DATA";
  else if (bestStats.winRate >= 0.54 && bestStats.ciLower >= 0.52) verdict = "STRONG_H1_DIRECTION_EDGE";
  else if (bestStats.winRate >= 0.515 && bestStats.ciLower >= 0.505) verdict = "WEAK_H1_DIRECTION_EDGE";

  const totalH1Candles = [...dataset.barsByPair.values()].reduce((s, b) => s + b.length, 0);

  const resultsJson = {
    verdict,
    generatedAt: new Date().toISOString(),
    pairs: dataset.pairs,
    pairLabels: dataset.pairs.map(pairLabel),
    historicalPeriod: { start: dataset.commonStart, end: dataset.commonEnd },
    coverage: dataset.coverage,
    totalH1Candles,
    evaluationBars: allSignals.length,
    directionalSignals: traded.length,
    horizons: horizonStats,
    bestHorizon,
    bestHorizonStats: bestStats,
    pairResults,
    allPairs: allPairAgg,
    longShort: { long: longStats, short: shortStats, byPair: longShortByPair },
    regimeResults,
    scoreBuckets,
    scoreCalibrationMonotonic: calibrationOk,
    selectivity,
    walkForward: { byYear: Object.fromEntries(byYear), byQuarter: Object.fromEntries(byQuarter) },
    baselines: baselineRows,
    botBaseline,
    ablation: ablationResults,
    trading: { gross: tradingGross, net: tradingNet, byPair: tradingByPair },
    costNote: "NET uses actual bid/ask spread per signal bar as round-trip cost in R units; labeled cost sensitivity, not guaranteed historical execution.",
  };

  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(resultsJson, null, 2));

  writeFileSync(path.join(OUT, "HORIZON_RESULTS.csv"), toCsv(
    HORIZONS.map((h) => {
      const s = horizonStats[h]!;
      return { horizon: `${h}H`, signals: s.signals, wins: s.wins, losses: s.losses, ties: s.ties, winRate: (s.winRate * 100).toFixed(2), ci95: `[${(s.ciLower * 100).toFixed(2)}%, ${(s.ciUpper * 100).toFixed(2)}%]` };
    }),
    ["horizon", "signals", "wins", "losses", "ties", "winRate", "ci95"],
  ));

  writeFileSync(path.join(OUT, "PAIR_RESULTS.csv"), toCsv(
    pairResults.map((r) => ({ pair: pairLabel(r.pair), signals: r.signals, wins: r.wins, losses: r.losses, ties: r.ties, winRate: (r.winRate * 100).toFixed(2) })),
    ["pair", "signals", "wins", "losses", "ties", "winRate"],
  ));

  writeFileSync(path.join(OUT, "REGIME_RESULTS.csv"), toCsv(
    regimeResults.map((r) => ({ regime: r.regime, signals: r.signals, winRate: (r.winRate * 100).toFixed(2), ci95: `[${(r.ciLower * 100).toFixed(2)}%, ${(r.ciUpper * 100).toFixed(2)}%]` })),
    ["regime", "signals", "winRate", "ci95"],
  ));

  writeFileSync(path.join(OUT, "ABLATION_RESULTS.csv"), toCsv(
    ablationResults.map((r) => ({ model: r.model, signals: r.signals, winRate: (r.winRate * 100).toFixed(2), changeVsFull: (r.changeVsFull * 100).toFixed(2) })),
    ["model", "signals", "winRate", "changeVsFull"],
  ));

  writeFileSync(path.join(OUT, "TRADING_RESULTS.csv"), toCsv(
    [...tradingGross, ...tradingNet].map((t) => ({
      rr: t.rr, mode: t.mode, trades: t.trades, wins: t.wins, losses: t.losses,
      winRate: (t.winRate * 100).toFixed(2), totalR: t.totalR.toFixed(2),
      expectancy: t.expectancy.toFixed(4), profitFactor: t.profitFactor === Infinity ? "Inf" : t.profitFactor.toFixed(3),
    })),
    ["rr", "mode", "trades", "wins", "losses", "winRate", "totalR", "expectancy", "profitFactor"],
  ));

  const signalHeaders = [
    "timestamp", "pair", "direction", "direction_score", "market_regime", "entry_price",
    "ema20", "ema50", "ema200", "ema20_slope", "ema50_slope", "ema200_slope", "rsi", "macd", "atr",
    "structure_classification", "momentum_classification", "volatility_classification",
    ...HORIZONS.flatMap((h) => [`forward_${h}h_price`, `result_${h}h`]),
    "trade_1_1_gross", "trade_1_1_net_r", "trade_1_5_1_gross", "trade_1_5_1_net_r", "trade_2_1_gross", "trade_2_1_net_r",
  ];
  writeFileSync(path.join(OUT, "SIGNALS.csv"), toCsv(
    allSignals.filter((s) => s.direction !== "WAIT").map((s) => {
      const row: Record<string, unknown> = {
        timestamp: s.timestamp, pair: s.pairLabel, direction: s.direction,
        direction_score: s.directionScore.toFixed(4), market_regime: s.marketRegime,
        entry_price: s.entryPrice, ema20: s.ema20, ema50: s.ema50, ema200: s.ema200,
        ema20_slope: s.ema20Slope, ema50_slope: s.ema50Slope, ema200_slope: s.ema200Slope,
        rsi: s.rsi, macd: s.macd, atr: s.atr,
        structure_classification: s.structureClassification,
        momentum_classification: s.momentumClassification,
        volatility_classification: s.volatilityClassification,
      };
      for (const h of HORIZONS) {
        row[`forward_${h}h_price`] = s.forwardPrices[h];
        row[`result_${h}h`] = s.horizonResults[h];
      }
      row.trade_1_1_gross = s.trading?.["1:1"]?.gross;
      row.trade_1_1_net_r = s.trading?.["1:1"]?.rNet;
      row.trade_1_5_1_gross = s.trading?.["1.5:1"]?.gross;
      row.trade_1_5_1_net_r = s.trading?.["1.5:1"]?.rNet;
      row.trade_2_1_gross = s.trading?.["2:1"]?.gross;
      row.trade_2_1_net_r = s.trading?.["2:1"]?.rNet;
      return row;
    }),
    signalHeaders,
  ));

  const topComponent = [...ablationResults]
    .slice(1)
    .filter((r) => r.signals > 0)
    .sort((a, b) => a.changeVsFull - b.changeVsFull)[0];

  const report = `# H1 Direction V1 — FINAL REPORT

## VERDICT: \`${verdict}\`

Generated: ${new Date().toISOString()}

---

## Data

- **Pairs (12):** ${dataset.pairs.map(pairLabel).join(", ")}
- **Period:** ${dataset.commonStart.slice(0, 10)} → ${dataset.commonEnd.slice(0, 10)}
- **Total H1 candles (all pairs):** ${totalH1Candles.toLocaleString()}
- **Evaluation bars:** ${allSignals.length.toLocaleString()}
- **Directional signals (|score| ≥ 0.60):** ${traded.length.toLocaleString()} (${formatPct(traded.length / allSignals.length)} selectivity)

### Pair Coverage

| Pair | Candles | Start | End | Gaps | Missing | Spread (pips) | Source |
| --- | ---: | --- | --- | ---: | ---: | ---: | --- |
${dataset.coverage.map((c) => `| ${pairLabel(c.pair)} | ${c.candles} | ${c.start.slice(0, 10)} | ${c.end.slice(0, 10)} | ${c.gaps} | ${c.missingCandles} | ${c.medianSpreadPips} | ${c.source} |`).join("\n")}

---

## Forward Direction by Horizon

| Horizon | Signals | Wins | Losses | Ties | Win Rate | 95% CI |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${HORIZONS.map((h) => { const s = horizonStats[h]!; return `| ${h}H | ${s.signals} | ${s.wins} | ${s.losses} | ${s.ties} | ${formatPct(s.winRate)} | [${formatPct(s.ciLower)}, ${formatPct(s.ciUpper)}] |`; }).join("\n")}

**Best horizon (stable):** ${bestHorizon}H — WR ${formatPct(bestStats.winRate)} [${formatPct(bestStats.ciLower)}, ${formatPct(bestStats.ciUpper)}], n=${bestStats.signals}

---

## Pair Results at Best Horizon (${bestHorizon}H)

| Pair | Signals | Wins | Losses | Ties | WR |
| --- | ---: | ---: | ---: | ---: | ---: |
${pairResults.map((r) => `| ${pairLabel(r.pair)} | ${r.signals} | ${r.wins} | ${r.losses} | ${r.ties} | ${formatPct(r.winRate)} |`).join("\n")}
| **ALL** | ${allPairAgg.signals} | ${allPairAgg.wins} | ${allPairAgg.losses} | ${allPairAgg.ties} | ${formatPct(allPairAgg.winRate)} |

---

## Long vs Short (${bestHorizon}H)

| Direction | Signals | Wins | Losses | WR |
| --- | ---: | ---: | ---: | ---: |
| LONG | ${longStats.signals} | ${longStats.wins} | ${longStats.losses} | ${formatPct(longStats.winRate)} |
| SHORT | ${shortStats.signals} | ${shortStats.wins} | ${shortStats.losses} | ${formatPct(shortStats.winRate)} |

---

## Regime Results (${bestHorizon}H)

| Regime | Signals | WR | 95% CI |
| --- | ---: | ---: | --- |
${regimeResults.map((r) => `| ${r.regime} | ${r.signals} | ${formatPct(r.winRate)} | [${formatPct(r.ciLower)}, ${formatPct(r.ciUpper)}] |`).join("\n")}

Best: **${bestRegime.regime}** (${formatPct(bestRegime.winRate)}, n=${bestRegime.signals})  
Worst: **${worstRegime.regime}** (${formatPct(worstRegime.winRate)}, n=${worstRegime.signals})

---

## Confidence Buckets (${bestHorizon}H)

| Absolute Score | Signals | WR |
| --- | ---: | ---: |
${scoreBuckets.map((b) => `| ${b.bucket} | ${b.signals} | ${formatPct(b.winRate)} |`).join("\n")}

**Calibration:** ${calibrationOk ? "Higher absolute scores generally correspond to higher WR." : "Higher scores do NOT reliably produce higher WR — confidence model is poorly calibrated."}

---

## Selectivity Analysis (${bestHorizon}H)

| Min Score | % Hours Traded | Signals | WR |
| --- | ---: | ---: | ---: |
${selectivity.map((s) => `| ${s.threshold.toFixed(2)} | ${formatPct(s.pctHoursTraded)} | ${s.signals} | ${formatPct(s.winRate)} |`).join("\n")}

---

## Walk-Forward

### By Year (${bestHorizon}H)
${[...byYear.entries()].map(([y, s]) => `- **${y}:** ${s.signals} signals, WR ${formatPct(s.winRate)}`).join("\n")}

### By Quarter (${bestHorizon}H, sample)
${[...byQuarter.entries()].slice(-8).map(([q, s]) => `- **${q}:** ${s.signals} signals, WR ${formatPct(s.winRate)}`).join("\n")}

---

## Baseline Comparison (${bestHorizon}H)

| Method | Signals | WR | 95% CI Lower |
| --- | ---: | ---: | ---: |
| H1 Bot | ${botBaseline.signals} | ${formatPct(botBaseline.winRate)} | ${formatPct(botBaseline.ciLower)} |
${baselineRows.map((b) => `| ${b.name} | ${b.signals} | ${formatPct(b.winRate)} | ${formatPct(b.ciLower)} |`).join("\n")}
| Random benchmark | — | 50.00% | — |

---

## Component Ablation (${bestHorizon}H)

| Model | Signals | WR | Change vs Full |
| --- | ---: | ---: | ---: |
${ablationResults.map((r) => `| ${r.model} | ${r.signals} | ${formatPct(r.winRate)} | ${(r.changeVsFull * 100).toFixed(2)} pp |`).join("\n")}

Largest WR drop (models that still trade): **${topComponent?.model ?? "structure/EMA/momentum required for any signal"}**

---

## Trading Simulation (ATR stop, best horizon context)

Conservative fill: simultaneous TP+SL in one bar → SL/AMBIGUOUS.

| RR | Mode | Trades | Wins | Losses | WR | Total R | Exp/Trade | PF |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${[...tradingGross, ...tradingNet].map((t) => `| ${t.rr} | ${t.mode} | ${t.trades} | ${t.wins} | ${t.losses} | ${formatPct(t.winRate)} | ${t.totalR.toFixed(1)} | ${t.expectancy.toFixed(3)} | ${t.profitFactor === Infinity ? "Inf" : t.profitFactor.toFixed(2)} |`).join("\n")}

---

## Answers

1. **Better than short-horizon ~50%?** ${bestStats.winRate > 0.505 ? `Marginally — ${formatPct(bestStats.winRate)} at ${bestHorizon}H vs ~50% random.` : `No — ${formatPct(bestStats.winRate)} at ${bestHorizon}H is near random.`}
2. **Best horizon?** ${bestHorizon}H
3. **Statistically meaningful?** ${bestStats.ciLower > 0.5 ? `95% CI lower bound ${formatPct(bestStats.ciLower)} > 50%.` : `No — 95% CI includes 50% ([${formatPct(bestStats.ciLower)}, ${formatPct(bestStats.ciUpper)}]).`}
4. **Broad across pairs?** ${pairResults.filter((p) => p.winRate > 0.52).length} of 12 pairs above 52% WR at best horizon.
5. **Selectivity helps?** ${selectivity.find((s) => s.threshold === 0.70)!.winRate > selectivity.find((s) => s.threshold === 0.60)!.winRate + 0.01 ? `Marginal lift at 0.70 (${formatPct(selectivity.find((s) => s.threshold === 0.70)!.winRate)}, n=${selectivity.find((s) => s.threshold === 0.70)!.signals}) but still near random.` : "No — higher thresholds do not improve WR materially."}
6. **Best regime?** ${bestRegime.regime} (${formatPct(bestRegime.winRate)}, n=${bestRegime.signals})
7. **Top component (among variants with signals)?** ${topComponent ? `Removing **${topComponent.model}** changes WR by ${(topComponent.changeVsFull * 100).toFixed(2)} pp.` : "Structure/EMA/momentum are required to reach trade threshold — removing them yields zero signals."}
8. **Beats baselines?** ${botBaseline.winRate > Math.max(...baselineRows.map((b) => b.winRate)) ? "Yes vs listed baselines." : "No — at least one simple baseline matches or beats the bot."}
9. **Positive R after costs?** ${tradingNet.some((t) => t.expectancy > 0) ? "Some RR configs show positive NET expectancy." : "No — NET expectancy ≤ 0 for all RR configs tested."}
10. **Worth developing further?** ${verdict === "STRONG_H1_DIRECTION_EDGE" ? "Potentially — investigate with sealed holdout before any production path." : verdict === "WEAK_H1_DIRECTION_EDGE" ? "Unclear — weak edge may not survive costs; more research only." : "No — treat as null result and do not wire into live engine."}

> Reproduce: \`cd api-server && npm run h1-direction-v1\`
`;

  writeFileSync(path.join(OUT, "FINAL_REPORT.md"), report);

  writeFileSync(path.join(OUT, "IMPLEMENTATION_NOTES.md"), `# H1 Direction V1 — Implementation Notes

## Isolation
- Code lives only under \`api-server/scripts/h1-direction-v1/\`.
- Outputs under \`api-server/research/h1-direction-v1/\`.
- No imports from production execution, adaptive engine, binary engine, or allowlists.

## Data
- Primary: \`backtest-legacy-expanded/candles/{PAIR}_H1.json\` (bid/ask + mid OHLC).
- Fallback: PostgreSQL \`market_candles\` + \`market_candle_quotes\` (EUR_AUD).
- Common period = intersection of Aug 2022 → Aug 2026 target with all 12 pairs.

## Signal Timing
- Features computed on completed H1 bar index \`i\`.
- Signal emitted at bar close; forward prices use future H1 closes only.

## Scoring Model (deterministic, not optimized)

| Component | Max magnitude | Key inputs |
| --- | ---: | --- |
| Structure | ±0.25 | HH/HL/LH/LL, BOS vs last swing |
| EMA trend | ±0.20 | EMA20/50/200 stack, slopes normalized by ATR |
| Momentum | ±0.20 | RSI delta, MACD hist, 4H ROC, candle body/ATR |
| Volatility | ±0.10 | ATR percentile, BB width expansion/contraction |
| Price location | ±0.15 | Distance to swings/mean in ATR units |
| Regime adj | ±0.08 | Trend/breakout boost; range/low-vol penalty |

Thresholds: LONG if score ≥ +0.60, SHORT if ≤ −0.60, else WAIT.

## Horizons
Forward direction evaluated at +1, +2, +3, +4, +6, +8, +12, +24 H1 bars.

## Trading Sim
- Entry: signal bar mid close.
- SL = 1×ATR(14); TP = {1, 1.5, 2}× SL distance.
- Same-bar TP+SL → conservative SL/AMBIGUOUS.
- NET subtracts spread (from bar bid/ask) as round-trip cost in R.
`);

  // Terminal summary
  log("\n# H1 DIRECTION BOT RESULTS\n");
  log(`Historical period: ${dataset.commonStart.slice(0, 10)} → ${dataset.commonEnd.slice(0, 10)}`);
  log(`Pairs: ${dataset.pairs.map(pairLabel).join(", ")}`);
  log(`H1 candles: ${totalH1Candles.toLocaleString()}`);
  log(`Signals: ${traded.length.toLocaleString()}\n`);
  log("## FORWARD DIRECTION\n");
  for (const h of HORIZONS) {
    const s = horizonStats[h]!;
    log(`${String(h).padStart(2)}H:  ${s.wins} / ${s.signals} = ${formatPct(s.winRate)}`);
  }
  log(`\nBEST HORIZON: ${bestHorizon}H`);
  log(`BEST HORIZON WR: ${formatPct(bestStats.winRate)}`);
  log(`95% CI: [${formatPct(bestStats.ciLower)}, ${formatPct(bestStats.ciUpper)}]`);
  log(`Signals: ${bestStats.signals}\n`);
  log("## PAIR RESULTS AT BEST HORIZON\n");
  log("PAIR        WINS   LOSSES   WR");
  for (const r of pairResults) {
    log(`${pairLabel(r.pair).padEnd(11)} ${String(r.wins).padStart(4)}   ${String(r.losses).padStart(6)}   ${formatPct(r.winRate)}`);
  }
  log(`${"ALL".padEnd(11)} ${String(allPairAgg.wins).padStart(4)}   ${String(allPairAgg.losses).padStart(6)}   ${formatPct(allPairAgg.winRate)}\n`);
  log("## DIRECTION\n");
  log(`LONG WR: ${formatPct(longStats.winRate)} (${longStats.signals} signals)`);
  log(`SHORT WR: ${formatPct(shortStats.winRate)} (${shortStats.signals} signals)\n`);
  log("## REGIMES\n");
  log(`Best regime: ${bestRegime.regime}`);
  log(`WR: ${formatPct(bestRegime.winRate)}`);
  log(`n: ${bestRegime.signals}\n`);
  log(`Worst regime: ${worstRegime.regime}`);
  log(`WR: ${formatPct(worstRegime.winRate)}`);
  log(`n: ${worstRegime.signals}\n`);
  log("## SELECTIVITY\n");
  for (const s of selectivity) log(`Score >= ${s.threshold.toFixed(2)}: ${formatPct(s.winRate)} (${formatPct(s.pctHoursTraded)} traded)`);
  log("\n## BASELINE COMPARISON\n");
  log(`H1 Bot: ${formatPct(botBaseline.winRate)}`);
  for (const b of baselineRows) log(`${b.name}: ${formatPct(b.winRate)}`);
  log("Random benchmark: 50.00%\n");
  log("## TRADING SIMULATION\n");
  for (const t of tradingGross) {
    const net = tradingNet.find((n) => n.rr === t.rr)!;
    log(`${t.rr} GROSS — WR: ${formatPct(t.winRate)}, Total R: ${t.totalR.toFixed(1)}, Exp/trade: ${t.expectancy.toFixed(3)}`);
    log(`${t.rr} NET   — WR: ${formatPct(net.winRate)}, Total R: ${net.totalR.toFixed(1)}, Exp/trade: ${net.expectancy.toFixed(3)}`);
  }
  log(`\n## VERDICT: ${verdict}\n`);
  log(`Full report: ${path.join(OUT, "FINAL_REPORT.md")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
