import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { fetchHistory, resolveSignal, type FrozenSignal, type TradeAudit } from "./validate-executable-costs";
import type { ResearchCandle } from "../src/lib/oanda/client";

const OUT = resolve(process.cwd(), "../api-server/research-v2/exit-duration-experiment");
const SOURCE = resolve(process.cwd(), "../api-server/research-v2/executable-cost-validation/RESULTS.json");
const PAIRS = ["EUR_USD", "USD_JPY", "GBP_USD", "AUD_USD"] as const;
const VARIANTS = ["CONTROL", "4H", "6H", "8H", "12H", "NO_TIMEOUT"] as const;
type Variant = typeof VARIANTS[number];
type Pair = typeof PAIRS[number];
type Result = NonNullable<ReturnType<typeof resolveSignal>>;
type Replay = { trade: TradeAudit; variant: Variant; result: Result | null; midpoint: Result | null };
type Prior = { period: { requestedFrom: string; requestedToExclusive: string; from: string; to: string; candles: number }; trades: TradeAudit[]; executableGeometry: FrozenSignal["executableGeometry"] };
const POLICY = {
  minimumTrades: 50, minimumChangedTrades: 20, minimumExpectancyGainR: 0.03,
  minimumProfitFactorGain: 0.05, minimumMaterialYearTrades: 10,
  minimumImprovingYears: 2, minimumImprovingYearFraction: 2 / 3,
  maximumDrawdownIncreaseR: 2, minimumLeaveOneYearOutGainR: 0,
  choice: "Shortest finite duration meeting every criterion; no timeout only if it passes and no finite duration passes. Highest historical expectancy is descriptive only.",
};
const avg = (a: number[]) => a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? (b[Math.floor((b.length - 1) / 2)]! + b[Math.floor(b.length / 2)]!) / 2 : null; };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fmt = (n: number | null | undefined, d = 3) => n == null ? "n/a" : n.toFixed(d);
const pct = (n: number | null | undefined) => n == null ? "n/a" : `${(100 * n).toFixed(1)}%`;
const csv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => JSON.stringify(v == null ? "" : String(v));
  return [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n") + "\n";
};

export function signalFor(trade: TradeAudit, geometry: Prior["executableGeometry"], variant: Variant): FrozenSignal {
  const barMs = trade.pair === "GBP_USD" ? 30 * 60_000 : 60 * 60_000;
  const hours = variant === "CONTROL" ? trade.pair === "EUR_USD" ? null : 3
    : variant === "NO_TIMEOUT" ? null : Number(variant.replace("H", ""));
  return {
    pair: trade.pair, strategy: trade.strategy, version: trade.version,
    timeframe: trade.pair === "GBP_USD" ? "M30" : "H1", barMs,
    maxHoldBars: hours === null ? null : hours * 60 * 60_000 / barMs,
    signalTimestamp: trade.signalTimestamp, decisionTime: trade.decisionTime,
    direction: trade.direction, midEntry: trade.midEntry, atr: trade.atr,
    midStop: geometry === "MIDPOINT_LEVELS" ? trade.stop : trade.midEntry + (trade.direction === "long" ? -trade.atr : trade.atr),
    midTarget: geometry === "MIDPOINT_LEVELS" ? trade.target : trade.midEntry + (trade.direction === "long" ? 2 * trade.atr : -2 * trade.atr),
    executableGeometry: geometry, confidenceTag: trade.confidenceTag, origin: trade.origin,
  };
}

function stats(rows: Replay[]) {
  const closed = rows.filter((r): r is Replay & { result: Result } => r.result !== null);
  const values = closed.map(r => r.result.resultR);
  const wins = values.filter(r => r > 0), losses = values.filter(r => r < 0);
  const sum = (a: number[]) => a.reduce((s, r) => s + r, 0);
  const tp = closed.filter(r => r.result.exitReason === "TP");
  const sl = closed.filter(r => r.result.exitReason === "SL");
  const time = closed.filter(r => r.result.exitReason === "TIME_EXIT");
  // Realized equity curve: aggregate simultaneous closes, so tie order cannot manufacture drawdown.
  const closes = new Map<string, number>();
  for (const row of closed) closes.set(row.result.exitTimestamp, (closes.get(row.result.exitTimestamp) ?? 0) + row.result.resultR);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const [, delta] of [...closes.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))) {
    equity += delta; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  const directionExp = (side: string) => avg(closed.filter(r => r.trade.direction === side).map(r => r.result.resultR));
  return {
    entries: rows.length, n: closed.length, censored: rows.length - closed.length,
    wins: wins.length, nonPositive: values.length - wins.length, winRate: values.length ? wins.length / values.length : null,
    tp: tp.length, tpPct: values.length ? tp.length / values.length : null,
    full2RTp: tp.filter(r => r.result.resultR >= 2 - 1e-9).length,
    sl: sl.length, slPct: values.length ? sl.length / values.length : null,
    timeExit: time.length, timePct: values.length ? time.length / values.length : null,
    averageTimeExitR: avg(time.map(r => r.result.resultR)), averageWinR: avg(wins), averageLossR: avg(losses),
    profitFactor: sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
    expectancyR: avg(values), medianR: median(values), totalR: sum(values), maxDrawdownR,
    averageHoldingHours: avg(closed.map(r => (Date.parse(r.result.exitTimestamp) - Date.parse(r.trade.decisionTime)) / 3_600_000)),
    longExpectancyR: directionExp("long"), shortExpectancyR: directionExp("short"),
    averageSpreadPips: avg(rows.map(r => r.trade.spreadPips)), medianSpreadPips: median(rows.map(r => r.trade.spreadPips)),
    midpointWinnersToExecutableNonPositive: closed.filter(r => r.midpoint && r.midpoint.resultR > 0 && r.result.resultR <= 0).length,
    midpointWinnersToExecutableNegative: closed.filter(r => r.midpoint && r.midpoint.resultR > 0 && r.result.resultR < 0).length,
    midpointCensored: rows.filter(r => !r.midpoint).length,
    ambiguousSameBar: closed.filter(r => r.result.ambiguousSameBar).length,
  };
}

function pairedMonthBootstrap(rows: { row: Replay; baseline: Replay }[]) {
  const months = new Map<string, number[]>();
  for (const { row, baseline } of rows) {
    const key = row.trade.signalTimestamp.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), row.result!.resultR - baseline.result!.resultR]);
  }
  const buckets = [...months.values()];
  if (!buckets.length) return null;
  let seed = 90304;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const draws: number[] = [];
  for (let b = 0; b < 5000; b++) {
    let total = 0, n = 0;
    for (let m = 0; m < buckets.length; m++) {
      const bucket = buckets[Math.floor(random() * buckets.length)]!;
      total += bucket.reduce((s, v) => s + v, 0); n += bucket.length;
    }
    draws.push(total / n);
  }
  draws.sort((a, b) => a - b);
  return { months: buckets.length, resamples: 5000, seed: 90304, lower95: draws[124]!, upper95: draws[4874]!,
    interpretation: "Descriptive paired month-cluster bootstrap; not adjusted for the multiple exit comparisons and not a support-policy gate." };
}

function comparison(control: Replay[], alternative: Replay[]) {
  const matched = alternative.flatMap((row, i) => row.result && control[i]!.result ? [{ row, baseline: control[i]! }] : []);
  const deltas = matched.map(({ row, baseline }) => row.result!.resultR - baseline.result!.resultR);
  const changed = matched.filter(({ row, baseline }) => Math.abs(row.result!.resultR - baseline.result!.resultR) > 1e-9 || row.result!.exitTimestamp !== baseline.result!.exitTimestamp);
  const time = matched.filter(({ baseline }) => baseline.result!.exitReason === "TIME_EXIT");
  const saved = time.filter(({ baseline }) => baseline.result!.resultR > 0);
  const materialYears = [2023, 2024, 2025, 2026].filter(year => matched.filter(r => r.row.trade.year === year).length >= POLICY.minimumMaterialYearTrades);
  const yearlyDelta = Object.fromEntries([2023, 2024, 2025, 2026].map(year => [year, {
    n: matched.filter(r => r.row.trade.year === year).length,
    deltaR: avg(matched.filter(r => r.row.trade.year === year).map(({ row, baseline }) => row.result!.resultR - baseline.result!.resultR)),
  }]));
  const leaveOneYearOut = Object.fromEntries(materialYears.map(year => [year, avg(matched.filter(r => r.row.trade.year !== year).map(({ row, baseline }) => row.result!.resultR - baseline.result!.resultR))]));
  const baselineMetrics = stats(matched.map(r => r.baseline)), altMetrics = stats(matched.map(r => r.row));
  const improvingYears = materialYears.filter(year => (yearlyDelta[year]!.deltaR ?? 0) > 0.001).length;
  const failures: string[] = [];
  if (alternative.some(r => !r.result)) failures.push("CENSORED_TRADES");
  if (matched.length < POLICY.minimumTrades) failures.push("SMALL_SAMPLE");
  if (changed.length < POLICY.minimumChangedTrades) failures.push("FEW_AFFECTED_TRADES");
  if ((avg(deltas) ?? -Infinity) < POLICY.minimumExpectancyGainR) failures.push("SMALL_EXPECTANCY_GAIN");
  if (altMetrics.profitFactor === null || baselineMetrics.profitFactor === null || altMetrics.profitFactor - baselineMetrics.profitFactor < POLICY.minimumProfitFactorGain) failures.push("SMALL_PF_GAIN");
  if (improvingYears < POLICY.minimumImprovingYears || improvingYears / materialYears.length < POLICY.minimumImprovingYearFraction) failures.push("YEAR_INSTABILITY");
  if (Object.values(leaveOneYearOut).some(v => v === null || v <= POLICY.minimumLeaveOneYearOutGainR)) failures.push("YEAR_DEPENDENCE");
  if (altMetrics.maxDrawdownR > baselineMetrics.maxDrawdownR + POLICY.maximumDrawdownIncreaseR) failures.push("DRAWDOWN_DETERIORATION");
  return {
    matchedN: matched.length, changedTrades: changed.length, pairedExpectancyGainR: avg(deltas),
    extraTargets: altMetrics.tp - baselineMetrics.tp, extraFull2RTargets: altMetrics.full2RTp - baselineMetrics.full2RTp,
    controlTimeExits: time.length, controlTimeExitToTp: time.filter(r => r.row.result!.exitReason === "TP").length,
    controlTimeExitToSl: time.filter(r => r.row.result!.exitReason === "SL").length,
    positiveControlTimeExits: saved.length, positiveControlTimeExitToSl: saved.filter(r => r.row.result!.exitReason === "SL").length,
    positiveControlTimeExitToNonPositive: saved.filter(r => r.row.result!.resultR <= 0).length,
    matchedControlExpectancyR: baselineMetrics.expectancyR, matchedAlternativeExpectancyR: altMetrics.expectancyR,
    yearlyDelta, leaveOneYearOut, improvingYears, materialYears, failures, supported: failures.length === 0,
    pairedMonthBootstrap: pairedMonthBootstrap(matched),
  };
}

async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  await mkdir(resolve(OUT, "data"), { recursive: true });
  // Written before any new replay results are calculated; never fitted to results.
  await writeFile(resolve(OUT, "PROTOCOL.json"), JSON.stringify({ variants: VARIANTS, supportPolicy: POLICY, source: SOURCE, frozenCohort: true }, null, 2));
  const sourceText = await readFile(SOURCE, "utf8");
  const source = JSON.parse(sourceText) as { pairs: Record<Pair, Prior> };
  const all: Record<string, unknown> = {}, tables: string[] = [], summary: Record<string, unknown>[] = [], metricRows: Record<string, unknown>[] = [];
  for (const pair of PAIRS) {
    const prior = source.pairs[pair];
    const cache = resolve(OUT, "data", `${pair}-MBA.json`);
    let candles: ResearchCandle[];
    try { const cached = JSON.parse(await readFile(cache, "utf8")); assert.deepEqual(cached.period, prior.period); candles = cached.candles; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      console.log(`Fetching original ${pair} window.`);
      candles = await fetchHistory(pair, pair === "GBP_USD" ? "M30" : "H1", prior.period.requestedFrom, prior.period.requestedToExclusive);
      await writeFile(cache, JSON.stringify({ period: prior.period, candles }));
    }
    // The formerly forming final bar is complete on a later fetch; retain the
    // original last completed timestamp, not the wall-clock request boundary.
    candles = candles.filter(bar => Date.parse(bar.time) >= Date.parse(prior.period.from) && Date.parse(bar.time) <= Date.parse(prior.period.to));
    assert.equal(candles.length, prior.period.candles, `${pair}: original candle count changed`);
    const byTime = new Map(candles.map(c => [c.time, c]));
    const replays = Object.fromEntries(VARIANTS.map(variant => [variant, prior.trades.map(trade => {
      const signal = signalFor(trade, prior.executableGeometry, variant);
      const bar = byTime.get(trade.signalTimestamp);
      assert.ok(bar, `${pair}: missing signal bar`);
      assert.equal(bar.ask.close, trade.ask); assert.equal(bar.bid.close, trade.bid); assert.equal(bar.mid.close, trade.midEntry);
      return { trade, variant, result: resolveSignal(signal, candles, "executable"), midpoint: resolveSignal(signal, candles, "midpoint") };
    })])) as Record<Variant, Replay[]>;
    for (const row of replays.CONTROL) {
      assert.ok(row.result, `${pair}: unresolved control`);
      assert.equal(row.result.exitReason, row.trade.exitReason);
      assert.equal(row.result.exitTimestamp, row.trade.exitTimestamp);
      assert.ok(Math.abs(row.result.exitPrice - row.trade.exitPrice) < 1e-10);
      assert.ok(Math.abs(row.result.resultR - row.trade.executableResultR) < 1e-9);
      assert.ok(row.midpoint && Math.abs(row.midpoint.resultR - row.trade.midResultR) < 1e-9);
    }
    const analyses = Object.fromEntries(VARIANTS.map(variant => [variant, {
      metrics: stats(replays[variant]),
      year: Object.fromEntries([2023, 2024, 2025, 2026].map(year => [year, stats(replays[variant].filter(r => r.trade.year === year))])),
      comparison: comparison(replays.CONTROL, replays[variant]),
    }])) as Record<Variant, { metrics: ReturnType<typeof stats>; year: Record<string, ReturnType<typeof stats>>; comparison: ReturnType<typeof comparison> }>;
    if (pair === "EUR_USD") assert.deepEqual(analyses.CONTROL.metrics, analyses.NO_TIMEOUT.metrics);
    const best = VARIANTS.reduce((a, b) => (analyses[b].metrics.expectancyR ?? -Infinity) > (analyses[a].metrics.expectancyR ?? -Infinity) + 1e-10 ? b : a, "CONTROL" as Variant);
    const screenCandidates = VARIANTS.filter(v => v !== "CONTROL" && analyses[v].comparison.supported);
    // Additional uncertainty audit is disclosed separately from the original
    // historical screen. It can withhold a recommendation, never tune an exit.
    const supported = screenCandidates.filter(v => (analyses[v].comparison.pairedMonthBootstrap?.lower95 ?? -Infinity) > 0);
    const selected = pair === "EUR_USD" ? "CONTROL" : supported[0] ?? "CONTROL";
    const recommendation = pair === "EUR_USD" ? "KEEP_CURRENT"
      : selected === "NO_TIMEOUT" ? "NO_TIMEOUT_SUPPORTED" : selected !== "CONTROL" ? "LONGER_EXIT_SUPPORTED"
      : best === "CONTROL" ? "KEEP_CURRENT" : "INCONCLUSIVE";
    const baseline = analyses.CONTROL.metrics, bestMetrics = analyses[best].metrics;
    summary.push({ pair, currentExp: baseline.expectancyR, bestExit: best, bestExitExp: bestMetrics.expectancyR,
      currentPF: baseline.profitFactor, bestPF: bestMetrics.profitFactor, currentTpPct: baseline.tpPct, bestTpPct: bestMetrics.tpPct,
      recommendation, selectedExit: selected, forwardTestCandidate: pair === "EUR_USD" ? null : screenCandidates[0] ?? null });
    const rows = VARIANTS.map(variant => {
      const m = analyses[variant].metrics;
      const c = analyses[variant].comparison;
      const classification = variant === "CONTROL" || (pair === "EUR_USD" && variant === "NO_TIMEOUT") ? "KEEP_CURRENT"
        : c.supported && (c.pairedMonthBootstrap?.lower95 ?? -Infinity) > 0 ? variant === "NO_TIMEOUT" ? "NO_TIMEOUT_SUPPORTED" : "LONGER_EXIT_SUPPORTED"
        : (c.pairedExpectancyGainR ?? 0) <= 0 && !m.censored ? "KEEP_CURRENT" : "INCONCLUSIVE";
      metricRows.push({ pair, variant, classification, ...m });
      Object.assign(analyses[variant], { classification });
      return `| ${pair} | ${variant} | ${m.n} | ${pct(m.tpPct)} | ${pct(m.slPct)} | ${pct(m.timePct)} | ${pct(m.winRate)} | ${fmt(m.averageWinR)} | ${fmt(m.averageLossR)} | ${fmt(m.profitFactor)} | ${fmt(m.expectancyR)} | ${fmt(m.totalR)} | ${fmt(m.maxDrawdownR)} |`;
    });
    const detail = VARIANTS.map(v => {
      const a = analyses[v], m = a.metrics, c = a.comparison;
      const years = Object.entries(a.year).filter(([, x]) => x.n).map(([year, x]) => `${year}: N=${x.n}, PF=${fmt(x.profitFactor)}, EXP=${fmt(x.expectancyR)}R, delta=${fmt(c.yearlyDelta[Number(year)]!.deltaR)}R`).join("; ");
      return `### ${v}\n\nTP ${m.tp} (${pct(m.tpPct)}), of which full +2R=${m.full2RTp}; SL ${m.sl}; TIME ${m.timeExit}; average TIME=${fmt(m.averageTimeExitR)}R; median trade=${fmt(m.medianR)}R; holding=${fmt(m.averageHoldingHours)} hours; LONG/SHORT EXP=${fmt(m.longExpectancyR)}/${fmt(m.shortExpectancyR)}R; spread avg/median=${fmt(m.averageSpreadPips)}/${fmt(m.medianSpreadPips)} pips; midpoint winner to executable loss=${m.midpointWinnersToExecutableNegative}; censored=${m.censored}.\n\n${years}.\n\nCompared with CONTROL: changed ${c.changedTrades} trades; paired gain ${fmt(c.pairedExpectancyGainR)}R/trade; extra targets ${c.extraTargets}; control TIME exits becoming TP/SL=${c.controlTimeExitToTp}/${c.controlTimeExitToSl}; positive control TIME exits becoming SL=${c.positiveControlTimeExitToSl}. ${v === "CONTROL" ? "Baseline." : `Support checks: ${c.failures.join(", ") || "all passed"}.`} Paired month-bootstrap 95% interval for gain: [${fmt(c.pairedMonthBootstrap?.lower95)}, ${fmt(c.pairedMonthBootstrap?.upper95)}]R. Matched N=${c.matchedN}; matched control/variant EXP=${fmt(c.matchedControlExpectancyR)}/${fmt(c.matchedAlternativeExpectancyR)}R.`;
    }).join("\n\n");
    tables.push(`## ${pair}: ${recommendation}\n\n| PAIR | MAX HOLD | N | TP% | SL% | TIME% | WR | AVG WIN R | AVG LOSS R | PF | EXP R | TOTAL R | MAX DD |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\nHistorical maximum: ${best}. Evidence-supported selection: ${selected}.\n\n${detail}`);
    const audit = VARIANTS.flatMap(v => replays[v].map(r => ({ ...r.trade, variant: v,
      variantExitTimestamp: r.result?.exitTimestamp, variantExitReason: r.result?.exitReason,
      variantExitPrice: r.result?.exitPrice, variantResultR: r.result?.resultR,
      variantMidpointR: r.midpoint?.resultR, censored: !r.result,
      pairedDeltaR: r.result ? r.result.resultR - r.trade.executableResultR : null,
    })));
    await writeFile(resolve(OUT, `${pair.toLowerCase()}-trades.csv`), csv(audit));
    all[pair] = { period: prior.period, candlesSha256: hash(JSON.stringify(candles)), controlParity: "ALL_TRADES_MATCH", analyses, recommendation, selected, historicalScreenCandidates: screenCandidates, bestHistorical: best };
    console.log(`${pair}: ${recommendation}; current=${fmt(baseline.expectancyR)}R, best=${best} ${fmt(bestMetrics.expectancyR)}R, selected=${selected}`);
  }
  const caveats = [
    "Entries, their direction, ATR and price geometry are the exact saved prior cohort; independent legs remain even if longer holds overlap. No new signals are admitted or removed. This isolates exits, not executable portfolio position limits.",
    "EURUSD CONTROL already has no timeout. Other CONTROL durations are three hours (3 H1 bars; GBPUSD 6 M30 bars). GBPUSD 4/6/8/12 hours map to 8/12/16/24 future M30 bars.",
    "Same original OANDA historical windows were re-fetched and cached, with all saved midpoint and executable control trades reproduced. The original raw candle bytes were not retained, so byte-for-byte equality to the earlier pull cannot be proved.",
    "USDJPY/AUDUSD freeze ATR and place barriers around executable entry. EURUSD/GBPUSD retain frozen absolute midpoint barriers, so their executable TP can be below +2R. Both target hits and full +2R hits are reported; changing these barriers would confound this experiment.",
    "Results inherit original EURUSD Pine parity caveat (142 vs supplied 146 winners), inferred GBPUSD date boundary, and previously inspected historical sample. This is not untouched out-of-sample validation.",
    "Uses original strategy-timeframe stop-first OHLC semantics and exact barrier fills. No tick latency, gap slippage, financing or commissions were added. Holding hours use bar-close exit timestamps and can overstate within-bar touch time. Maximum drawdown is realized closed-trade R with simultaneous exits aggregated, not mark-to-market drawdown.",
    "Finite timeouts require consecutive scheduled bars as in the original resolver. Missing future candles and unresolved no-timeout trades are censored, never assigned a fabricated outcome. Support is withheld for censored variants; paired comparisons use common closed trades.",
    "Historical spread is embedded in executable quotes, never deducted twice. Per-variant midpoint replays serve only to count cost-induced winner-to-loser changes.",
    "Support policy was fixed before duration results: at least 50 trades, 20 affected trades, +0.03R/trade and +0.05 PF, at least two improving material years and two-thirds of material years improving, positive leave-one-year-out gain, no more than 2R extra realized drawdown, and no censoring. These are conservative decision heuristics, not statistical proof. No parameter search beyond the six requested variants.",
    "After the initial historical screen, an additional paired month-cluster bootstrap uncertainty audit was added (5000 draws, fixed seed). It was not predeclared. Final support is withheld where its 95% interval includes zero, even when the initial screen passes. This stricter evidential review changes no duration or strategy parameter. No interval excludes zero here; multiplicity-adjusted evidence would be weaker still.",
  ];
  const summaryTable = `| PAIR | CURRENT EXP | BEST EXIT EXP | CURRENT PF | BEST PF | CURRENT TP% | BEST TP% | RECOMMENDATION |\n|---|---:|---|---:|---:|---:|---:|---|\n` + summary.map(s => `| ${s.pair} | ${fmt(s.currentExp as number)} | ${s.bestExit}: ${fmt(s.bestExitExp as number)} | ${fmt(s.currentPF as number)} | ${fmt(s.bestPF as number)} | ${pct(s.currentTpPct as number)} | ${pct(s.bestTpPct as number)} | ${s.recommendation} |`).join("\n");
  await writeFile(resolve(OUT, "RESULTS.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sourceSha256: hash(sourceText), policy: POLICY, caveats, pairs: all, summary }, null, 2));
  await writeFile(resolve(OUT, "variant-summary.csv"), csv(metricRows));
  await writeFile(resolve(OUT, "pair-summary.csv"), csv(summary));
  const conclusions = [
    "EUR/USD — KEEP_CURRENT. There is no existing timeout to extend. The tiny historical gain from imposing eight hours does not support a change. Its target payoff below +2R comes from the retained entry/barrier geometry, not premature time exits.",
    "USD/JPY — INCONCLUSIVE after the uncertainty audit. Four hours is the shortest extension passing the initial historical screen; 12 hours is only the historical maximum. Longer holds improve aggregate expectancy in multiple years, though 2025 deteriorates and the short side does not share the gain. Only 25 time-exited trades drive the comparison. The four-hour gain has a descriptive 95% month-bootstrap interval of -0.061R to +0.145R, which includes no improvement. Retain the current exit and use four hours only as a candidate for a frozen forward-shadow comparison.",
    "GBP/USD — INCONCLUSIVE; retain the current exit. Only five trades are affected. Three eventually reach their target and two hit the stop; the small pooled improvement is insufficient to infer a durable benefit. Six hours, eight hours, twelve hours and no timeout are identical in this cohort.",
    "AUD/USD — INCONCLUSIVE for a longer finite exit; retain the current exit. The eight-hour historical gain disappears when 2026 is excluded. Removing the timeout raises full +2R target hits from 38 to 71, but also sends 21 previously positive time exits to -1R, reduces expectancy, and increases realized drawdown from 11.74R to 19R. More full targets do not imply a better strategy.",
    "Portfolio recommendation: keep all deployed exit settings as they are. The only next candidate supported by this historical screen is USD/JPY CONTROL versus four hours in a separately frozen forward-shadow test, with both directions retained. Do not apply a blanket longer hold or remove all time exits. Longer overlapping positions, capital usage, correlation, and mark-to-market drawdown require a portfolio execution simulation before any rollout.",
  ];
  await writeFile(resolve(OUT, "FINAL_REPORT.md"), `# EXIT-DURATION EXPERIMENT\n\n${summaryTable}\n\nBEST is descriptive, not an automatic recommendation.\n\n## Plain-English conclusions\n\n${conclusions.join("\n\n")}\n\n${tables.join("\n\n")}\n\n## Methodology and limits\n\n${caveats.map(s => `- ${s}`).join("\n")}\n\nPer-variant classifications and all metrics are in variant-summary.csv; full year-level metrics, paired changes and bootstrap intervals are in RESULTS.json.\n\nNo production strategies, risk settings, positions or deployments were changed. NZDUSD was not evaluated.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(error => { console.error(error); process.exitCode = 1; });
