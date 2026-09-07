import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvConfig } from "@next/env";

import type { ResearchCandle } from "../src/lib/oanda/client";

import {
  BAR_MS,
  CONFIG,
  PIP,
  STRATEGY_ID,
  STRATEGY_NAME,
  STRATEGY_VERSION,
  SYMBOL,
  TIMEFRAME,
  evaluateTrace,
  freezeCohort,
  levelsFor,
  resolveTrade,
  signalsFromTrace,
  type FrozenSignal,
  type ResolvedTrade,
} from "./eurusd-15m-trend-pullback-reclaim";

const OUT = resolve(process.cwd(), "../api-server/research-v2/eurusd-15m-trend-pullback-reclaim-v1-validation");
const WARMUP_M15 = "2022-07-01T00:00:00.000Z";
const WARMUP_D = "2021-01-01T00:00:00.000Z";
const FROM = "2023-01-01T00:00:00.000Z";
const TO = "2026-09-05T00:00:00.000Z";
const TV_FROM = "2025-01-01T00:00:00.000Z";
const TV_HEADLINE = {
  n: 113,
  winRate: 0.4071,
  profitFactor: 1.47,
  year: {
    2025: { winRate: 0.4444, profitFactor: 1.598 },
    2026: { winRate: 0.3953, profitFactor: 1.432 },
  },
} as const;

type ExitReason = "TP" | "SL";
type Verdict = "SURVIVES" | "MARGINAL" | "FAILS_COSTS" | "FAILS_EDGE" | "PARITY_FAILED";
type ClosedTrade = {
  signal: FrozenSignal;
  year: number;
  spreadPips: number;
  spreadToAtr: number;
  executableEntry: number;
  executableStop: number;
  executableTarget: number;
  midpoint: ResolvedTrade;
  executable: ResolvedTrade | null;
  holdingMs: number;
};

type Metrics = {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancyR: number | null;
  totalR: number;
  maxDrawdownR: number;
  tp: number;
  sl: number;
  averageHoldingHours: number | null;
  medianHoldingHours: number | null;
};

function mean(values: readonly number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: readonly number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function percentile(values: readonly number[], pct: number) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(pct * ordered.length) - 1))]!;
}

function maxDrawdownR(results: readonly number[]) {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const result of results) {
    equity += result;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return dd;
}

function metrics(rows: readonly { resultR: number; exitReason: ExitReason; holdingMs?: number }[]): Metrics {
  const wins = rows.filter((row) => row.resultR > 0);
  const losses = rows.filter((row) => row.resultR < 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.resultR, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.resultR, 0));
  const totalR = rows.reduce((sum, row) => sum + row.resultR, 0);
  const holds = rows.map((row) => row.holdingMs).filter((value): value is number => value != null);
  return {
    n: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? wins.length / rows.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancyR: rows.length ? totalR / rows.length : null,
    totalR,
    maxDrawdownR: maxDrawdownR(rows.map((row) => row.resultR)),
    tp: rows.filter((row) => row.exitReason === "TP").length,
    sl: rows.filter((row) => row.exitReason === "SL").length,
    averageHoldingHours: mean(holds.map((value) => value / 3_600_000)),
    medianHoldingHours: median(holds.map((value) => value / 3_600_000)),
  };
}

function yearOf(timestamp: string) {
  return new Date(timestamp).getUTCFullYear();
}

function inRange(timestamp: string, from: string, toExclusive: string) {
  const time = Date.parse(timestamp);
  return time >= Date.parse(from) && time < Date.parse(toExclusive);
}

function round(value: number | null, digits = 6) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function pct(value: number | null) {
  return value == null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function fmt(value: number | null, digits = 3) {
  return value == null ? "n/a" : value.toFixed(digits);
}

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: readonly Record<string, unknown>[]) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]!);
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
}

async function fetchFrame(granularity: "M15" | "D", warmup: string) {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const file = resolve(OUT, "data", `${SYMBOL}-${granularity}-MBA.json`);
  let rows: ResearchCandle[] = [];
  let cursor = TO;
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { warmup: string; to: string; candles: ResearchCandle[] };
    if (saved.warmup === warmup && saved.to === TO) {
      rows = saved.candles;
      if (rows.length) cursor = new Date(Math.min(...rows.map((row) => Date.parse(row.time)))).toISOString();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const seen = new Map(rows.map((row) => [row.time, row]));
  let stall = 0;
  let pages = 0;
  while (Date.parse(cursor) > Date.parse(warmup) && stall < 3) {
    let batch: ResearchCandle[] = [];
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        batch = await getResearchCandles(SYMBOL, granularity, 5_000, { to: cursor });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_500 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
    if (!batch.length) break;
    const earliest = [...batch].sort((left, right) => Date.parse(left.time) - Date.parse(right.time))[0]!.time;
    for (const candle of batch) {
      if (candle.complete && Date.parse(candle.time) < Date.parse(TO)) seen.set(candle.time, candle);
    }
    if (Date.parse(earliest) >= Date.parse(cursor) - 1) {
      stall += 1;
      cursor = new Date(Date.parse(earliest) - 1_000).toISOString();
      continue;
    }
    stall = 0;
    cursor = new Date(Date.parse(earliest) - 1).toISOString();
    pages += 1;
    rows = [...seen.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
    console.error(`${granularity}: ${rows.length} completed MBA bars; oldest ${rows[0]?.time}`);
    if (pages % 5 === 0 || Date.parse(earliest) <= Date.parse(warmup)) {
      await writeFile(file, JSON.stringify({ warmup, to: TO, candles: rows }));
    }
    if (Date.parse(earliest) <= Date.parse(warmup)) break;
  }
  const complete = [...seen.values()]
    .filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(warmup) && Date.parse(candle.time) < Date.parse(TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  await writeFile(file, JSON.stringify({ warmup, to: TO, candles: complete }));
  return complete;
}

function closeTrades(signals: readonly FrozenSignal[], candles: readonly ResearchCandle[]) {
  const cohort = freezeCohort(signals, candles, "midpoint", { ambiguityPolicy: "stop_first", targetGapPolicy: "no_improvement" });
  const closed: ClosedTrade[] = [];
  let unresolved = 0;
  let missingExecutable = 0;
  for (const signal of cohort.accepted) {
    const midpoint = resolveTrade(signal, candles, "midpoint", { ambiguityPolicy: "stop_first", targetGapPolicy: "no_improvement" });
    if (!midpoint) {
      unresolved += 1;
      continue;
    }
    const signalBar = candles.find((candle) => candle.time === signal.signalTimestamp);
    if (!signalBar) {
      missingExecutable += 1;
      continue;
    }
    const executable = resolveTrade(signal, candles, "executable", { ambiguityPolicy: "stop_first", targetGapPolicy: "no_improvement" });
    if (!executable) missingExecutable += 1;
    const levels = levelsFor(signal, signalBar, "executable");
    closed.push({
      signal,
      year: yearOf(signal.signalTimestamp),
      spreadPips: (signalBar.ask.close - signalBar.bid.close) / PIP,
      spreadToAtr: (signalBar.ask.close - signalBar.bid.close) / signal.atr,
      executableEntry: levels.entry,
      executableStop: levels.stop,
      executableTarget: levels.target,
      midpoint,
      executable,
      holdingMs: Date.parse(midpoint.exitTimestamp) - Date.parse(signal.decisionTime),
    });
  }
  return { raw: signals.length, accepted: cohort.accepted.length, skipped: cohort.skipped.length, unresolved, missingExecutable, closed };
}

function midMetrics(rows: readonly ClosedTrade[]) {
  return metrics(rows.map((row) => ({ resultR: row.midpoint.resultR, exitReason: row.midpoint.exitReason, holdingMs: row.holdingMs })));
}

function execMetrics(rows: readonly ClosedTrade[]) {
  const ready = rows.filter((row) => row.executable);
  return metrics(ready.map((row) => ({
    resultR: row.executable!.resultR,
    exitReason: row.executable!.exitReason,
    holdingMs: Date.parse(row.executable!.exitTimestamp) - Date.parse(row.signal.decisionTime),
  })));
}

function byYear(rows: readonly ClosedTrade[], kind: "mid" | "exec") {
  return Object.fromEntries([2023, 2024, 2025, 2026].map((year) => {
    const selected = rows.filter((row) => row.year === year);
    return [year, kind === "mid" ? midMetrics(selected) : execMetrics(selected)];
  }));
}

function byDirection(rows: readonly ClosedTrade[], kind: "mid" | "exec") {
  return Object.fromEntries((["long", "short"] as const).map((direction) => {
    const selected = rows.filter((row) => row.signal.direction === direction);
    return [direction, kind === "mid" ? midMetrics(selected) : execMetrics(selected)];
  }));
}

function parityAssessment(overlap: readonly ClosedTrade[]) {
  const full = midMetrics(overlap);
  const y2025 = midMetrics(overlap.filter((row) => row.year === 2025));
  const y2026 = midMetrics(overlap.filter((row) => row.year === 2026));
  const tail = overlap.slice(-TV_HEADLINE.n);
  const tailMetrics = midMetrics(tail);
  const tail2025 = midMetrics(tail.filter((row) => row.year === 2025));
  const tail2026 = midMetrics(tail.filter((row) => row.year === 2026));
  const wrClose = (actual: number | null, expected: number) => actual != null && Math.abs(actual - expected) <= 0.05;
  const pfClose = (actual: number | null, expected: number) => actual != null && Math.abs(actual - expected) <= 0.20;
  const tailMatches = tail.length === TV_HEADLINE.n
    && wrClose(tailMetrics.winRate, TV_HEADLINE.winRate)
    && pfClose(tailMetrics.profitFactor, TV_HEADLINE.profitFactor);
  const yearCountPlausible = y2026.n >= 60 && y2026.n <= 120;
  const passed = (tailMatches || (wrClose(full.winRate, TV_HEADLINE.winRate) && pfClose(full.profitFactor, TV_HEADLINE.profitFactor)))
    && yearCountPlausible;
  return {
    passed,
    note: passed
      ? "Overlapping TradingView sample is close enough on the last-113 / 2026-count gate; full 2025 is not required to match because TradingView did not load the entire year."
      : "Material midpoint mismatch versus the TradingView 2025-2026 headline. Executable cost conclusions withheld.",
    expected: TV_HEADLINE,
    overlap: { overall: full, y2025, y2026 },
    last113: { overall: tailMetrics, y2025: tail2025, y2026: tail2026, first: tail[0]?.signal.signalTimestamp ?? null, last: tail.at(-1)?.signal.signalTimestamp ?? null },
    first20: overlap.slice(0, 20).map((row) => ({
      signalTimestamp: row.signal.signalTimestamp,
      decisionTime: row.signal.decisionTime,
      direction: row.signal.direction,
      midEntry: row.signal.midEntry,
      atr: row.signal.atr,
      stop: row.signal.midStop,
      target: row.signal.midTarget,
    })),
  };
}

function classify(mid: Metrics, exec: Metrics, execYears: Record<string, Metrics>): Verdict {
  if (mid.n < 20 || mid.expectancyR == null || mid.profitFactor == null || mid.expectancyR <= 0 || mid.profitFactor <= 1) {
    return "FAILS_EDGE";
  }
  if (exec.expectancyR == null || exec.profitFactor == null || exec.expectancyR <= 0 || exec.profitFactor <= 1) {
    return "FAILS_COSTS";
  }
  const materialPositiveYears = Object.values(execYears).filter((row) => row.n >= 8 && (row.expectancyR ?? 0) > 0).length;
  return exec.profitFactor > 1.05 && exec.expectancyR > 0.03 && materialPositiveYears >= 2 ? "SURVIVES" : "MARGINAL";
}

function yearlyTable(midYears: Record<string, Metrics>, execYears: Record<string, Metrics>) {
  return [2023, 2024, 2025, 2026].map((year) => {
    const mid = midYears[year]!;
    const exec = execYears[year]!;
    const cost = mid.expectancyR != null && exec.expectancyR != null ? mid.expectancyR - exec.expectancyR : null;
    return {
      YEAR: year, N: mid.n, MID_PF: round(mid.profitFactor, 3), MID_EXP: round(mid.expectancyR, 3),
      EXEC_WR: round(exec.winRate, 4), EXEC_PF: round(exec.profitFactor, 3), EXEC_EXP: round(exec.expectancyR, 3),
      COST_PER_TRADE: round(cost, 3),
    };
  });
}

async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  if (!process.env.OANDA_REQUEST_TIMEOUT_MS || Number(process.env.OANDA_REQUEST_TIMEOUT_MS) < 60_000) {
    process.env.OANDA_REQUEST_TIMEOUT_MS = "120000";
  }
  await mkdir(resolve(OUT, "data"), { recursive: true });
  console.error("Fetching EUR_USD D MBA warmup...");
  const daily = await fetchFrame("D", WARMUP_D);
  console.error("Fetching EUR_USD M15 MBA history...");
  const m15 = await fetchFrame("M15", WARMUP_M15);
  if (!daily.length || !m15.length) throw new Error("Required OANDA MBA history is missing.");

  const traced = evaluateTrace(m15, daily);
  if (traced.error) throw new Error(traced.error);
  const rawSignals = signalsFromTrace(m15, traced.rows).filter((signal) => inRange(signal.signalTimestamp, FROM, TO));
  const full = closeTrades(rawSignals, m15);
  const overlapClosed = full.closed.filter((row) => inRange(row.signal.signalTimestamp, TV_FROM, TO));
  const overlap = {
    raw: rawSignals.filter((signal) => inRange(signal.signalTimestamp, TV_FROM, TO)).length,
    accepted: overlapClosed.length,
    unresolved: full.unresolved,
    closed: overlapClosed,
  };
  const parity = parityAssessment(overlap.closed);
  const mid = midMetrics(full.closed);
  const midYears = byYear(full.closed, "mid");
  const midDirection = byDirection(full.closed, "mid");
  const tvLike = freezeCohort(
    rawSignals.filter((signal) => inRange(signal.signalTimestamp, TV_FROM, TO)),
    m15, "midpoint", { ambiguityPolicy: "tradingview_path", targetGapPolicy: "fill_open" },
  );
  const tvLikeMetrics = metrics(tvLike.accepted.flatMap((signal) => {
    const resolved = resolveTrade(signal, m15, "midpoint", { ambiguityPolicy: "tradingview_path", targetGapPolicy: "fill_open" });
    return resolved ? [{ resultR: resolved.resultR, exitReason: resolved.exitReason }] : [];
  }));

  const protocol = {
    strategyId: STRATEGY_ID, name: STRATEGY_NAME, version: STRATEGY_VERSION, symbol: SYMBOL, timeframe: TIMEFRAME,
    frozen: true, productionStrategyModified: false, deployed: false, ordersPlaced: false,
    rules: CONFIG,
    dailyDirection: "previous completed OANDA D candle only; EMA20/EMA50 and close taken from that bar",
    entry: "confirmed M15 midpoint close",
    executionOfficial: "stop-first ambiguity; adverse stop gaps fill at the worse open; target gaps get no improvement",
    executable: "signals remain midpoint; long ask in / bid out; short bid in / ask out; 1 ATR / 2 ATR rebuilt from frozen midpoint ATR around the executable entry",
    period: { from: FROM, toExclusive: TO, warmupM15: WARMUP_M15, warmupD: WARMUP_D },
  };

  if (!parity.passed) {
    const artifact = {
      generatedAt: new Date().toISOString(), protocol,
      data: { m15: m15.length, daily: daily.length, m15From: m15[0]?.time, m15To: m15.at(-1)?.time, dailyFrom: daily[0]?.time, dailyTo: daily.at(-1)?.time },
      parity, midpointFull: mid, midpointYears: midYears, midpointDirection: midDirection,
      overlapRaw: overlap.raw, overlapAccepted: overlap.accepted, tvLikeOverlap: tvLikeMetrics,
      verdict: "PARITY_FAILED" as Verdict,
    };
    await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
    await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    await writeFile(resolve(OUT, "FINAL_REPORT.md"), [
      "# EUR/USD 15m Trend Pullback Reclaim V1 — VALIDATION STOPPED",
      "",
      "Midpoint parity versus the supplied TradingView 2025-2026 headline failed materially. Executable cost conclusions are withheld. Frozen rules were not changed.",
      "",
      `Overlap raw setups ${overlap.raw}; accepted after no-pyramiding ${overlap.accepted}; unresolved ${overlap.unresolved}.`,
      "",
      `| Window | N | WR | PF | EXP R |`,
      `|---|---:|---:|---:|---:|`,
      `| TV headline | ${TV_HEADLINE.n} | ${pct(TV_HEADLINE.winRate)} | ${fmt(TV_HEADLINE.profitFactor)} | n/a |`,
      `| OANDA 2025-2026 overlap | ${parity.overlap.overall.n} | ${pct(parity.overlap.overall.winRate)} | ${fmt(parity.overlap.overall.profitFactor)} | ${fmt(parity.overlap.overall.expectancyR)} |`,
      `| Last 113 overlap trades | ${parity.last113.overall.n} | ${pct(parity.last113.overall.winRate)} | ${fmt(parity.last113.overall.profitFactor)} | ${fmt(parity.last113.overall.expectancyR)} |`,
      `| 2025 overlap | ${parity.overlap.y2025.n} | ${pct(parity.overlap.y2025.winRate)} | ${fmt(parity.overlap.y2025.profitFactor)} | ${fmt(parity.overlap.y2025.expectancyR)} |`,
      `| 2026 overlap | ${parity.overlap.y2026.n} | ${pct(parity.overlap.y2026.winRate)} | ${fmt(parity.overlap.y2026.profitFactor)} | ${fmt(parity.overlap.y2026.expectancyR)} |`,
      "",
      "First 20 overlap entries:",
      "",
      ...parity.first20.map((row, index) => `${index + 1}. ${row.signalTimestamp} ${row.direction} @ ${row.midEntry.toFixed(5)}`),
      "",
      "NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.",
      "",
    ].join("\n"));
    console.log(JSON.stringify({ verdict: "PARITY_FAILED", parity, midpointFull: mid, outputDirectory: OUT }, null, 2));
    return;
  }

  const executableReady = full.closed.filter((row) => row.executable);
  if (executableReady.length !== full.closed.length) {
    throw new Error(`Fail closed: ${full.closed.length - executableReady.length} midpoint trades missing executable MBA resolution.`);
  }
  const exec = execMetrics(full.closed);
  const execYears = byYear(full.closed, "exec");
  const execDirection = byDirection(full.closed, "exec");
  const verdict = classify(mid, exec, execYears);
  const spreads = full.closed.map((row) => row.spreadPips);
  const spreadAtr = full.closed.map((row) => row.spreadToAtr);
  const winnerFlips = full.closed.filter((row) => row.midpoint.resultR > 0 && (row.executable?.resultR ?? 0) <= 0).length;
  const costPerTrade = mid.expectancyR != null && exec.expectancyR != null ? mid.expectancyR - exec.expectancyR : null;
  const years = (Date.parse(TO) - Date.parse(FROM)) / (365.2425 * 24 * 60 * 60_000);
  const yearRows = yearlyTable(midYears, execYears);
  const trades = full.closed.map((row) => ({
    signalTimestamp: row.signal.signalTimestamp, decisionTime: row.signal.decisionTime, year: row.year,
    direction: row.signal.direction, midEntry: row.signal.midEntry, atr: row.signal.atr,
    midStop: row.signal.midStop, midTarget: row.signal.midTarget,
    executableEntry: row.executableEntry, executableStop: row.executableStop, executableTarget: row.executableTarget,
    spreadPips: row.spreadPips, spreadToAtr: row.spreadToAtr,
    midExitTimestamp: row.midpoint.exitTimestamp, midExitReason: row.midpoint.exitReason, midResultR: row.midpoint.resultR,
    execExitTimestamp: row.executable?.exitTimestamp ?? null, execExitReason: row.executable?.exitReason ?? null,
    execResultR: row.executable?.resultR ?? null, holdingHours: row.holdingMs / 3_600_000,
    midAmbiguous: row.midpoint.ambiguousSameBar, execAmbiguous: row.executable?.ambiguousSameBar ?? null,
  }));

  const artifact = {
    generatedAt: new Date().toISOString(), protocol,
    data: { m15: m15.length, daily: daily.length, m15From: m15[0]?.time, m15To: m15.at(-1)?.time, dailyFrom: daily[0]?.time, dailyTo: daily.at(-1)?.time, source: "OANDA practice API MBA" },
    parity, rawSignals: rawSignals.length, accepted: full.accepted, skippedWhileOpen: full.skipped, unresolved: full.unresolved,
    midpoint: mid, midpointYears: midYears, midpointDirection: midDirection, tvLikeOverlap: tvLikeMetrics,
    executable: exec, executableYears: execYears, executableDirection: execDirection,
    costs: {
      midpointPf: mid.profitFactor, executablePf: exec.profitFactor,
      midpointExpectancyR: mid.expectancyR, executableExpectancyR: exec.expectancyR,
      costDragR: costPerTrade, executableWr: exec.winRate,
      averageSpreadPips: mean(spreads), medianSpreadPips: median(spreads), p95SpreadPips: percentile(spreads, 0.95),
      averageSpreadToAtr: mean(spreadAtr), medianSpreadToAtr: median(spreadAtr),
      spreadAsPctOf1R: mean(spreadAtr), midpointWinnersToExecutableLosers: winnerFlips,
    },
    frequency: { years, tradesPerYear: mid.n / years, tradesByYear: Object.fromEntries([2023, 2024, 2025, 2026].map((year) => [year, midYears[year]!.n])) },
    verdict, yearRows, first20Full: trades.slice(0, 20),
  };

  await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
  await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({ ...artifact, trades }, null, 2)}\n`);
  await writeFile(resolve(OUT, "TRADES.midpoint.csv"), toCsv(trades.map((row) => ({
    signalTimestamp: row.signalTimestamp, direction: row.direction, entry: row.midEntry, stop: row.midStop, target: row.midTarget,
    exitTimestamp: row.midExitTimestamp, exitReason: row.midExitReason, resultR: row.midResultR, year: row.year,
  }))));
  await writeFile(resolve(OUT, "TRADES.executable.csv"), toCsv(trades.map((row) => ({
    signalTimestamp: row.signalTimestamp, direction: row.direction, entry: row.executableEntry, stop: row.executableStop, target: row.executableTarget,
    spreadPips: row.spreadPips, exitTimestamp: row.execExitTimestamp, exitReason: row.execExitReason, resultR: row.execResultR, year: row.year,
  }))));

  const midYearLines = [2023, 2024, 2025, 2026].map((year) => {
    const row = midYears[year]!;
    return `| EUR_USD | ${year} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} | ${fmt(row.totalR)} | ${fmt(row.maxDrawdownR)} |`;
  }).join("\n");
  const costLines = yearRows.map((row) => `| ${row.YEAR} | ${row.N} | ${fmt(row.MID_PF)} | ${fmt(row.MID_EXP)} | ${pct(row.EXEC_WR)} | ${fmt(row.EXEC_PF)} | ${fmt(row.EXEC_EXP)} | ${fmt(row.COST_PER_TRADE)} |`).join("\n");
  const report = `# EUR/USD 15m Trend Pullback Reclaim V1 — FULL VALIDATION

Strategy ID: \`${STRATEGY_ID}\`. Frozen rules. OANDA practice MBA. No production strategy was modified. No orders were placed.

## Step 1 — Midpoint parity

TradingView available 2025-2026 sample was approximately N=${TV_HEADLINE.n}, WR=${pct(TV_HEADLINE.winRate)}, PF=${fmt(TV_HEADLINE.profitFactor)}.

| Window | N | WR | PF | EXP R | Total R | Max DD R |
|---|---:|---:|---:|---:|---:|---:|
| TV headline | ${TV_HEADLINE.n} | ${pct(TV_HEADLINE.winRate)} | ${fmt(TV_HEADLINE.profitFactor)} | n/a | n/a | n/a |
| OANDA 2025-2026 overlap | ${parity.overlap.overall.n} | ${pct(parity.overlap.overall.winRate)} | ${fmt(parity.overlap.overall.profitFactor)} | ${fmt(parity.overlap.overall.expectancyR)} | ${fmt(parity.overlap.overall.totalR)} | ${fmt(parity.overlap.overall.maxDrawdownR)} |
| Last 113 overlap trades | ${parity.last113.overall.n} | ${pct(parity.last113.overall.winRate)} | ${fmt(parity.last113.overall.profitFactor)} | ${fmt(parity.last113.overall.expectancyR)} | ${fmt(parity.last113.overall.totalR)} | ${fmt(parity.last113.overall.maxDrawdownR)} |
| 2025 overlap | ${parity.overlap.y2025.n} | ${pct(parity.overlap.y2025.winRate)} | ${fmt(parity.overlap.y2025.profitFactor)} | ${fmt(parity.overlap.y2025.expectancyR)} | ${fmt(parity.overlap.y2025.totalR)} | ${fmt(parity.overlap.y2025.maxDrawdownR)} |
| 2026 overlap | ${parity.overlap.y2026.n} | ${pct(parity.overlap.y2026.winRate)} | ${fmt(parity.overlap.y2026.profitFactor)} | ${fmt(parity.overlap.y2026.expectancyR)} | ${fmt(parity.overlap.y2026.totalR)} | ${fmt(parity.overlap.y2026.maxDrawdownR)} |
| TV-path diagnostic on overlap | ${tvLikeMetrics.n} | ${pct(tvLikeMetrics.winRate)} | ${fmt(tvLikeMetrics.profitFactor)} | ${fmt(tvLikeMetrics.expectancyR)} | ${fmt(tvLikeMetrics.totalR)} | ${fmt(tvLikeMetrics.maxDrawdownR)} |

Parity gate: **passed**. ${parity.note}

First 20 overlap entries:

${parity.first20.map((row, index) => `${index + 1}. ${row.signalTimestamp} ${row.direction} @ ${row.midEntry.toFixed(5)} ATR ${row.atr.toFixed(5)}`).join("\n")}

## Step 2 — Full 2023-2026 midpoint

| PAIR | YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R |
|---|---:|---:|---:|---:|---:|---:|---:|
${midYearLines}
| EUR_USD | ALL | ${mid.n} | ${pct(mid.winRate)} | ${fmt(mid.profitFactor)} | ${fmt(mid.expectancyR)} | ${fmt(mid.totalR)} | ${fmt(mid.maxDrawdownR)} |

- wins/losses: ${mid.wins}/${mid.losses}
- long expectancy: ${fmt(midDirection.long.expectancyR)}R (N ${midDirection.long.n})
- short expectancy: ${fmt(midDirection.short.expectancyR)}R (N ${midDirection.short.n})
- average holding time: ${fmt(mid.averageHoldingHours)} hours
- median holding time: ${fmt(mid.medianHoldingHours)} hours
- trades per year: 2023=${midYears[2023]!.n}, 2024=${midYears[2024]!.n}, 2025=${midYears[2025]!.n}, 2026=${midYears[2026]!.n}

## Step 3 / 4 — Executable bid/ask costs

Same midpoint signals. Long enter ASK / exit BID. Short enter BID / exit ASK. Stop-first. ATR frozen from the midpoint signal. SL=1 ATR, TP=2 ATR around the executable entry.

| YEAR | N | MID PF | MID EXP | EXEC WR | EXEC PF | EXEC EXP | COST/TRADE |
|---|---:|---:|---:|---:|---:|---:|---:|
${costLines}
| ALL | ${mid.n} | ${fmt(mid.profitFactor)} | ${fmt(mid.expectancyR)} | ${pct(exec.winRate)} | ${fmt(exec.profitFactor)} | ${fmt(exec.expectancyR)} | ${fmt(costPerTrade)} |

- midpoint PF: ${fmt(mid.profitFactor)}
- executable PF: ${fmt(exec.profitFactor)}
- midpoint expectancy: ${fmt(mid.expectancyR)}R
- executable expectancy: ${fmt(exec.expectancyR)}R
- cost drag: ${fmt(costPerTrade)}R/trade
- executable WR: ${pct(exec.winRate)}
- average / median / p95 spread: ${fmt(mean(spreads))} / ${fmt(median(spreads))} / ${fmt(percentile(spreads, 0.95))} pips
- spread as % of ATR / 1R stop: ${pct(mean(spreadAtr))}
- midpoint winners that become executable losers: ${winnerFlips}
- long executable expectancy: ${fmt(execDirection.long.expectancyR)}R
- short executable expectancy: ${fmt(execDirection.short.expectancyR)}R
- total executable R: ${fmt(exec.totalR)}
- executable max drawdown: ${fmt(exec.maxDrawdownR)}R

## Classification

**${verdict}**

Approximate annual frequency: ${fmt(mid.n / years, 1)} trades/year.

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
`;
  await writeFile(resolve(OUT, "FINAL_REPORT.md"), report);
  console.log(JSON.stringify({
    verdict, midpoint: mid, executable: exec, costs: artifact.costs, parity: { passed: parity.passed, overlapN: parity.overlap.overall.n, last113: parity.last113.overall },
    outputDirectory: OUT,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
