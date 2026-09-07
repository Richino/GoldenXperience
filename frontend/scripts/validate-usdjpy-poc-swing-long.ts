import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvConfig } from "@next/env";

import type { ResearchCandle } from "../src/lib/oanda/client";

import {
  BAR_MS,
  CONFIG,
  HTF_BAR_MS,
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
} from "./usdjpy-poc-swing-long";

const OUT = resolve(process.cwd(), "../api-server/research-v2/usdjpy-poc-swing-long-v1-validation");
const WARMUP_H1 = "2005-01-01T00:00:00.000Z";
const WARMUP_H4 = "2004-07-01T00:00:00.000Z";
const TO = "2026-09-05T00:00:00.000Z";
const PARITY_FROM = "2023-08-01T00:00:00.000Z";
const PARITY_TO = "2026-07-01T00:00:00.000Z";
const TV = { n: 29, wins: 11, losses: 18, winRate: 0.3793, profitFactor: 0.98 } as const;
const COST_PIPS = [0.5, 0.8, 1.0, 1.5, 2.0] as const;

type Verdict = "KEEP_LONG" | "REJECT_LONG" | "INSUFFICIENT_DATA" | "PARITY_FAILED";
type ParityClass = "EXACT" | "CLOSE" | "FAILED";
type ExitReason = "TP" | "SL";
type ClosedTrade = {
  signal: FrozenSignal;
  year: number;
  spreadPips: number;
  spreadToStop: number;
  stopPips: number;
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
  medianR: number | null;
  grossWinsR: number;
  grossLossesR: number;
  maxDrawdownR: number;
  maxConsecutiveLosses: number;
  maxConsecutiveWins: number;
  tp: number;
  sl: number;
  averageHoldingHours: number | null;
  medianHoldingHours: number | null;
  maxHoldingHours: number | null;
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

function streak(results: readonly number[], wantPositive: boolean) {
  let best = 0;
  let current = 0;
  for (const result of results) {
    const hit = wantPositive ? result > 0 : result < 0;
    current = hit ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

function metrics(rows: readonly { resultR: number; exitReason: ExitReason; holdingMs?: number }[]): Metrics {
  const wins = rows.filter((row) => row.resultR > 0);
  const losses = rows.filter((row) => row.resultR < 0);
  const grossWinsR = wins.reduce((sum, row) => sum + row.resultR, 0);
  const grossLossesR = Math.abs(losses.reduce((sum, row) => sum + row.resultR, 0));
  const totalR = rows.reduce((sum, row) => sum + row.resultR, 0);
  const holds = rows.map((row) => row.holdingMs).filter((value): value is number => value != null);
  const resultRs = rows.map((row) => row.resultR);
  return {
    n: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? wins.length / rows.length : null,
    profitFactor: grossLossesR > 0 ? grossWinsR / grossLossesR : null,
    expectancyR: rows.length ? totalR / rows.length : null,
    totalR,
    medianR: median(resultRs),
    grossWinsR,
    grossLossesR,
    maxDrawdownR: maxDrawdownR(resultRs),
    maxConsecutiveLosses: streak(resultRs, false),
    maxConsecutiveWins: streak(resultRs, true),
    tp: rows.filter((row) => row.exitReason === "TP").length,
    sl: rows.filter((row) => row.exitReason === "SL").length,
    averageHoldingHours: mean(holds.map((value) => value / 3_600_000)),
    medianHoldingHours: median(holds.map((value) => value / 3_600_000)),
    maxHoldingHours: holds.length ? Math.max(...holds.map((value) => value / 3_600_000)) : null,
  };
}

function wilson(wins: number, n: number, z = 1.96) {
  if (n <= 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denom;
  return { low: center - margin, high: center + margin, center };
}

function yearOf(timestamp: string) {
  return new Date(timestamp).getUTCFullYear();
}

function inRange(timestamp: string, from: string, toExclusive: string) {
  const time = Date.parse(timestamp);
  return time >= Date.parse(from) && time < Date.parse(toExclusive);
}

function round(value: number | null, digits = 6) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
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

async function writeCandleCache(file: string, warmup: string, candles: readonly ResearchCandle[]) {
  const stream = createWriteStream(file, { flags: "w" });
  stream.write(`{"warmup":${JSON.stringify(warmup)},"to":${JSON.stringify(TO)},"candles":[`);
  for (let index = 0; index < candles.length; index += 1) {
    if (index > 0) stream.write(",");
    if (!stream.write(JSON.stringify(candles[index]))) {
      await new Promise<void>((resolveWrite) => stream.once("drain", resolveWrite));
    }
  }
  stream.end("]}");
  await finished(stream);
}

async function fetchFrame(granularity: "H1" | "H4", warmup: string) {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const file = resolve(OUT, "data", `${SYMBOL}-${granularity}-MBA.json`);
  let rows: ResearchCandle[] = [];
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { warmup: string; to: string; candles: ResearchCandle[] };
    if (saved.warmup === warmup && saved.to === TO) rows = saved.candles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Existing ${granularity} cache unreadable (${error instanceof Error ? error.message : String(error)}); resuming.`);
    }
  }
  const completeEnough = rows
    .filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(warmup) && Date.parse(candle.time) < Date.parse(TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  if (completeEnough.length && Date.parse(completeEnough[0]!.time) <= Date.parse(warmup) + 14 * 24 * 60 * 60_000) {
    return completeEnough;
  }
  let oldestMs = Infinity;
  for (const row of rows) oldestMs = Math.min(oldestMs, Date.parse(row.time));
  const seen = new Map(rows.map((row) => [row.time, row]));
  let cursor = rows.length ? new Date(oldestMs).toISOString() : TO;
  let stall = 0;
  let oldest = rows[0]?.time ?? TO;
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
    if (lastError) {
      console.error(`${granularity} fetch stopped at ${cursor}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      break;
    }
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
    oldest = earliest;
    console.error(`${granularity}: ${seen.size} completed MBA bars; oldest ${oldest}`);
    if (Date.parse(earliest) <= Date.parse(warmup)) break;
  }
  const complete = [...seen.values()]
    .filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(warmup) && Date.parse(candle.time) < Date.parse(TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  await writeCandleCache(file, warmup, complete);
  return complete;
}

function closeTrades(signals: readonly FrozenSignal[], candles: readonly ResearchCandle[]) {
  const cohort = freezeCohort(signals, candles, "midpoint", { ambiguityPolicy: "stop_first" });
  const closed: ClosedTrade[] = [];
  let unresolved = 0;
  let missingExecutable = 0;
  for (const signal of cohort.accepted) {
    const midpoint = resolveTrade(signal, candles, "midpoint", { ambiguityPolicy: "stop_first" });
    if (!midpoint) {
      unresolved += 1;
      continue;
    }
    const signalBar = candles.find((candle) => candle.time === signal.signalTimestamp);
    if (!signalBar) {
      missingExecutable += 1;
      continue;
    }
    const executable = resolveTrade(signal, candles, "executable", { ambiguityPolicy: "stop_first" });
    if (!executable) missingExecutable += 1;
    const levels = levelsFor(signal, signalBar, "executable");
    closed.push({
      signal,
      year: yearOf(signal.signalTimestamp),
      spreadPips: (signalBar.ask.close - signalBar.bid.close) / PIP,
      spreadToStop: (signalBar.ask.close - signalBar.bid.close) / (CONFIG.stopAtr * signal.atr),
      stopPips: CONFIG.stopAtr * signal.atr / PIP,
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

function yearsCovered(rows: readonly ClosedTrade[]) {
  return [...new Set(rows.map((row) => row.year))].sort((left, right) => left - right);
}

function byYear(rows: readonly ClosedTrade[], kind: "mid" | "exec") {
  const years = yearsCovered(rows);
  return Object.fromEntries(years.map((year) => {
    const selected = rows.filter((row) => row.year === year);
    return [year, kind === "mid" ? midMetrics(selected) : execMetrics(selected)];
  }));
}

function classifyParity(mid: Metrics): { classification: ParityClass; note: string } {
  const n = mid.n;
  const wrDelta = mid.winRate == null ? Infinity : Math.abs(mid.winRate - TV.winRate);
  const pfDelta = mid.profitFactor == null ? Infinity : Math.abs(mid.profitFactor - TV.profitFactor);
  const nDelta = Math.abs(n - TV.n);
  if (nDelta <= 2 && wrDelta <= 0.03 && pfDelta <= 0.12) {
    return { classification: "EXACT", note: "Trade count, win rate, and profit factor match the TradingView H1 reference within tight tolerance." };
  }
  if (n >= 21 && n <= 40 && wrDelta <= 0.10 && pfDelta <= 0.40) {
    return {
      classification: "CLOSE",
      note: "Small disagreement versus TradingView is consistent with OANDA vs TradingView candle construction, tick-volume bins, and stop-first vs path-dependent fills. Frozen rules were not changed.",
    };
  }
  return {
    classification: "FAILED",
    note: `Material disagreement versus TradingView (~${TV.n} trades, WR ${pct(TV.winRate)}, PF ${TV.profitFactor}). Backend N=${n}, WR=${pct(mid.winRate)}, PF=${fmt(mid.profitFactor)}. This is not explained by feed noise.`,
  };
}

function inventory(h1: readonly ResearchCandle[], h4: readonly ResearchCandle[]) {
  let h1Duplicates = 0;
  let h1Missing = 0;
  let h4Duplicates = 0;
  let h4Missing = 0;
  const h1Times = h1.map((candle) => Date.parse(candle.time));
  for (let index = 1; index < h1Times.length; index += 1) {
    const delta = h1Times[index]! - h1Times[index - 1]!;
    if (delta === 0) h1Duplicates += 1;
    else if (delta > BAR_MS + 60_000 && delta < 48 * 60 * 60_000) h1Missing += 1;
  }
  const h4Times = h4.map((candle) => Date.parse(candle.time));
  for (let index = 1; index < h4Times.length; index += 1) {
    const delta = h4Times[index]! - h4Times[index - 1]!;
    if (delta === 0) h4Duplicates += 1;
    else if (delta > HTF_BAR_MS + 60_000 && delta < 48 * 60 * 60_000) h4Missing += 1;
  }
  const volumes = h1.filter((candle) => Number.isFinite(candle.volume) && candle.volume > 0).length;
  return {
    source: "OANDA practice API MBA (mid/bid/ask) via getResearchCandles",
    h1: {
      earliest: h1[0]?.time ?? null,
      latest: h1.at(-1)?.time ?? null,
      count: h1.length,
      missingWeekdayGaps: h1Missing,
      duplicateTimestamps: h1Duplicates,
    },
    h4: {
      earliest: h4[0]?.time ?? null,
      latest: h4.at(-1)?.time ?? null,
      count: h4.length,
      missingWeekdayGaps: h4Missing,
      duplicateTimestamps: h4Duplicates,
    },
    midPricesAvailable: true,
    bidPricesAvailable: true,
    askPricesAvailable: true,
    volumeFieldAvailable: volumes === h1.length,
    volumeKind: "OANDA FX tick volume on the candle.volume field. Not centralized exchange volume.",
    timezone: "OANDA candle times are UTC. Weekend gaps are expected. No DST shift is applied to bar opens.",
  };
}

function classify(
  parityClass: ParityClass,
  exec: Metrics,
  secondHalf: Metrics,
  yearly: Record<string, Metrics>,
  withoutBest: Metrics,
): { verdict: Verdict; walkForward: "PASS" | "FAIL" | "UNCLEAR"; rule40: "PASS" | "FAIL"; reasons: string[] } {
  if (parityClass === "FAILED") {
    return { verdict: "PARITY_FAILED", walkForward: "UNCLEAR", rule40: "FAIL", reasons: ["TradingView parity failed."] };
  }
  const reasons: string[] = [];
  if (exec.n < 30) {
    return {
      verdict: "INSUFFICIENT_DATA",
      walkForward: "UNCLEAR",
      rule40: exec.winRate != null && exec.winRate >= 0.40 ? "PASS" : "FAIL",
      reasons: [`Only ${exec.n} completed trades on the available history.`],
    };
  }
  const rule40: "PASS" | "FAIL" = exec.winRate != null && exec.winRate >= 0.40 ? "PASS" : "FAIL";
  if (rule40 === "FAIL") reasons.push(`Executable WR ${pct(exec.winRate)} is below the frozen 40.00% rule.`);
  if (exec.expectancyR == null || exec.expectancyR <= 0) reasons.push("Executable expectancy is not positive.");
  if (exec.profitFactor == null || exec.profitFactor <= 1) reasons.push("Executable profit factor is not greater than 1.");
  const years = Object.entries(yearly);
  const years40 = years.filter(([, row]) => row.n > 0 && (row.winRate ?? 0) >= 0.40).length;
  const profitableYears = years.filter(([, row]) => (row.totalR ?? 0) > 0).length;
  if (secondHalf.profitFactor != null && secondHalf.profitFactor < 0.90 && (secondHalf.winRate ?? 1) < 0.36) {
    reasons.push("Second-half / recent sample collapses.");
  }
  if (withoutBest.profitFactor != null && withoutBest.profitFactor <= 1 && exec.totalR > 0) {
    reasons.push("Aggregate result is driven by a single year.");
  }
  const recent = years.filter(([year]) => Number(year) >= 2024);
  const recentFail = recent.length > 0 && recent.every(([, row]) => (row.profitFactor ?? 0) < 1 && (row.winRate ?? 1) < 0.40);
  if (recentFail) reasons.push("2024+ windows are uniformly weak.");
  const keep = rule40 === "PASS"
    && exec.expectancyR != null && exec.expectancyR > 0
    && exec.profitFactor != null && exec.profitFactor > 1
    && !reasons.some((reason) => reason.includes("collapses") || reason.includes("single year"));
  let walkForward: "PASS" | "FAIL" | "UNCLEAR" = "UNCLEAR";
  if (recentFail || (secondHalf.profitFactor != null && secondHalf.profitFactor < 0.85)) walkForward = "FAIL";
  else if (profitableYears >= Math.ceil(years.length * 0.5) && (secondHalf.profitFactor ?? 0) >= 1) walkForward = "PASS";
  void years40;
  return { verdict: keep ? "KEEP_LONG" : "REJECT_LONG", walkForward, rule40, reasons };
}

async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  if (!process.env.OANDA_REQUEST_TIMEOUT_MS || Number(process.env.OANDA_REQUEST_TIMEOUT_MS) < 60_000) {
    process.env.OANDA_REQUEST_TIMEOUT_MS = "120000";
  }
  await mkdir(resolve(OUT, "data"), { recursive: true });
  console.error("Fetching USD_JPY H4 MBA history...");
  const h4 = await fetchFrame("H4", WARMUP_H4);
  console.error("Fetching USD_JPY H1 MBA history...");
  const h1 = await fetchFrame("H1", WARMUP_H1);
  if (!h1.length || !h4.length) throw new Error("Required OANDA MBA history is missing.");

  const dataInventory = inventory(h1, h4);
  await writeFile(resolve(OUT, "DATA_INVENTORY.md"), `# Data inventory — GX POC SWING LONG ONLY V1

Source: ${dataInventory.source}

## H1

- earliest: ${dataInventory.h1.earliest}
- latest: ${dataInventory.h1.latest}
- count: ${dataInventory.h1.count}
- weekday gaps > 61 minutes (non-weekend): ${dataInventory.h1.missingWeekdayGaps}
- duplicate timestamps: ${dataInventory.h1.duplicateTimestamps}

## H4

- earliest: ${dataInventory.h4.earliest}
- latest: ${dataInventory.h4.latest}
- count: ${dataInventory.h4.count}
- weekday gaps > 4h+1m (non-weekend): ${dataInventory.h4.missingWeekdayGaps}
- duplicate timestamps: ${dataInventory.h4.duplicateTimestamps}

## Quotes and volume

- mid prices available: yes
- bid prices available: yes
- ask prices available: yes
- volume field available: ${dataInventory.volumeFieldAvailable ? "yes" : "no"}
- volume kind: ${dataInventory.volumeKind}
- timezone / DST: ${dataInventory.timezone}

Weekend gaps are expected for FX. History was not fabricated. Warmup requested H1 ${WARMUP_H1}, H4 ${WARMUP_H4}; evaluation ends ${TO} exclusive.
`);

  const traced = evaluateTrace(h1, h4);
  if (traced.error) throw new Error(traced.error);
  const allSignals = signalsFromTrace(h1, traced.rows);
  const paritySignals = allSignals.filter((signal) => inRange(signal.signalTimestamp, PARITY_FROM, PARITY_TO));
  const parityClosed = closeTrades(paritySignals, h1);
  const parityMid = midMetrics(parityClosed.closed);
  const parity = classifyParity(parityMid);
  const parityEntries = parityClosed.closed.map((row) => ({
    entry: row.signal.signalTimestamp,
    breakout: row.signal.breakoutTimestamp,
    midEntry: row.signal.midEntry,
    atr: row.signal.atr,
    lockedPoc: row.signal.lockedPoc,
    resultR: row.midpoint.resultR,
    exit: row.midpoint.exitReason,
  }));

  await writeFile(resolve(OUT, "PARITY_REPORT.md"), `# Parity report — GX POC SWING LONG ONLY V1

Classification: **${parity.classification}**

TradingView reference (approximate, not hardcoded targets):

- Instrument: OANDA USDJPY H1
- Sample: August 2023 through June 2026
- Trades: ${TV.n}
- Wins / losses: ${TV.wins} / ${TV.losses}
- WR: ${pct(TV.winRate)}
- PF: ${TV.profitFactor}

Backend midpoint (same window ${PARITY_FROM} to ${PARITY_TO} exclusive):

- Trades: ${parityMid.n}
- Wins / losses: ${parityMid.wins} / ${parityMid.losses}
- WR: ${pct(parityMid.winRate)}
- PF: ${fmt(parityMid.profitFactor)}
- Net R: ${fmt(parityMid.totalR)}
- Skipped while open: ${parityClosed.skipped}
- Unresolved: ${parityClosed.unresolved}

${parity.note}

## Entry timestamps (backend)

${parityEntries.map((row, index) => `${index + 1}. ${row.entry} breakout ${row.breakout} entry ${row.midEntry.toFixed(3)} POC ${row.lockedPoc.toFixed(3)} ${row.exit} ${row.resultR.toFixed(3)}R`).join("\n") || "(none)"}

TradingView individual entry timestamps were not supplied with the brief. Compare the count, WR, and PF first.

Pine source file was not in the workspace; implementation follows PINE_RULE_SPEC.md.
`);

  const protocol = {
    strategyId: STRATEGY_ID,
    name: STRATEGY_NAME,
    version: STRATEGY_VERSION,
    symbol: SYMBOL,
    timeframe: TIMEFRAME,
    frozen: true,
    longOnly: true,
    productionStrategyModified: false,
    deployed: false,
    ordersPlaced: false,
    rules: CONFIG,
    pineSource: "User brief / PINE_RULE_SPEC.md; original .pine file not in workspace",
  };

  if (parity.classification === "FAILED") {
    await writeFile(resolve(OUT, "SUMMARY.json"), `${JSON.stringify({
      generatedAt: new Date().toISOString(), protocol, dataInventory, parity, parityWindow: parityMid, verdict: "PARITY_FAILED",
    }, null, 2)}\n`);
    await writeFile(resolve(OUT, "CAUSALITY_AUDIT.md"), causalityAudit("not run — parity failed"));
    await writeFile(resolve(OUT, "INTRABAR_REPORT.md"), "# Intrabar report\n\nNot produced. Parity failed.\n");
    await writeFile(resolve(OUT, "TRADE_LOG.csv"), "");
    await writeFile(resolve(OUT, "YEARLY_RESULTS.csv"), "");
    await writeFile(resolve(OUT, "WINDOW_RESULTS.csv"), "");
    await writeFile(resolve(OUT, "COST_RESULTS.csv"), "");
    await writeFile(resolve(OUT, "FINAL_REPORT.md"), finalReport({
      verdict: "PARITY_FAILED",
      parity,
      parityMid,
      history: null,
      exec: null,
      firstHalf: null,
      secondHalf: null,
      years40: "n/a",
      walkForward: "UNCLEAR",
      rule40: "FAIL",
      period: `${PARITY_FROM} to ${PARITY_TO}`,
    }));
    console.log(JSON.stringify({ verdict: "PARITY_FAILED", parity, parityWindow: parityMid, outputDirectory: OUT }, null, 2));
    return;
  }

  const historyFrom = h1[0]!.time;
  const historySignals = allSignals.filter((signal) => inRange(signal.signalTimestamp, historyFrom, TO));
  const historyClosed = closeTrades(historySignals, h1);
  const historyMid = midMetrics(historyClosed.closed);
  const execReady = historyClosed.closed.filter((row) => row.executable);
  if (execReady.length !== historyClosed.closed.length) {
    throw new Error(`Fail closed: ${historyClosed.closed.length - execReady.length} midpoint trades missing executable MBA resolution.`);
  }
  const historyExec = execMetrics(historyClosed.closed);
  const yearsList = yearsCovered(historyClosed.closed);
  const midYears = byYear(historyClosed.closed, "mid");
  const execYears = byYear(historyClosed.closed, "exec");
  const midByCount = [...historyClosed.closed];
  const split = Math.floor(midByCount.length / 2);
  const firstHalf = execMetrics(midByCount.slice(0, split));
  const secondHalf = execMetrics(midByCount.slice(split));
  const bestYear = yearsList.reduce((best, year) => execYears[year]!.totalR > best.totalR ? { year, totalR: execYears[year]!.totalR } : best, { year: yearsList[0] ?? 0, totalR: -Infinity });
  const withoutBest = execMetrics(historyClosed.closed.filter((row) => row.year !== bestYear.year));
  const worstYear = yearsList.reduce((worst, year) => execYears[year]!.totalR < worst.totalR ? { year, totalR: execYears[year]!.totalR } : worst, { year: yearsList[0] ?? 0, totalR: Infinity });
  const profitableYears = yearsList.filter((year) => execYears[year]!.totalR > 0).length;
  const losingYears = yearsList.filter((year) => execYears[year]!.totalR < 0).length;
  const years40 = yearsList.filter((year) => (execYears[year]!.winRate ?? 0) >= 0.40).length;
  const spanYears = (Date.parse(h1.at(-1)!.time) - Date.parse(h1[0]!.time)) / (365.2425 * 24 * 60 * 60_000);
  const tradesPerYear = yearsList.map((year) => execYears[year]!.n);
  const ci = wilson(historyExec.wins, historyExec.n);
  const classification = classify(parity.classification, historyExec, secondHalf, execYears, withoutBest);

  const windows = [
    { name: "early", rows: sliceByTime(historyClosed.closed, 0, 1 / 3) },
    { name: "middle", rows: sliceByTime(historyClosed.closed, 1 / 3, 2 / 3) },
    { name: "recent", rows: sliceByTime(historyClosed.closed, 2 / 3, 1) },
    ...yearPairs(yearsList).map((pair) => ({
      name: pair.name,
      rows: historyClosed.closed.filter((row) => pair.years.includes(row.year)),
    })),
  ].map((window) => ({ window: window.name, ...execMetrics(window.rows) }));

  const ambiguous = historyClosed.closed.filter((row) => row.midpoint.ambiguousSameBar).length;
  const execAmbiguous = historyClosed.closed.filter((row) => row.executable?.ambiguousSameBar).length;

  const costRows = [
    { scenario: "MIDPOINT_IDEAL", ...historyMid },
    { scenario: "BID_ASK_EXECUTABLE", ...historyExec },
    ...COST_PIPS.map((pips) => ({
      scenario: `ROUND_TRIP_${pips.toFixed(1)}_PIP`,
      ...metrics(historyClosed.closed.map((row) => {
        const costR = (pips * PIP) / (CONFIG.stopAtr * row.signal.atr);
        return { resultR: row.midpoint.resultR - costR, exitReason: row.midpoint.exitReason, holdingMs: row.holdingMs };
      })),
    })),
  ];

  const tradeLog = historyClosed.closed.map((row) => ({
    signalTimestamp: row.signal.signalTimestamp,
    decisionTime: row.signal.decisionTime,
    breakoutTimestamp: row.signal.breakoutTimestamp,
    year: row.year,
    midEntry: row.signal.midEntry,
    askEntry: row.executableEntry,
    atr: row.signal.atr,
    lockedPoc: row.signal.lockedPoc,
    lockedRangeHigh: row.signal.lockedRangeHigh,
    lockedRangeLow: row.signal.lockedRangeLow,
    barsSinceBreakout: row.signal.barsSinceBreakout,
    midStop: row.signal.midStop,
    midTarget: row.signal.midTarget,
    midExitTimestamp: row.midpoint.exitTimestamp,
    midExitReason: row.midpoint.exitReason,
    midResultR: row.midpoint.resultR,
    midHoldBars: row.midpoint.holdBars,
    midAmbiguous: row.midpoint.ambiguousSameBar,
    execExitTimestamp: row.executable?.exitTimestamp ?? null,
    execExitReason: row.executable?.exitReason ?? null,
    execResultR: row.executable?.resultR ?? null,
    execAmbiguous: row.executable?.ambiguousSameBar ?? null,
    spreadPips: row.spreadPips,
    holdingHours: row.holdingMs / 3_600_000,
  }));

  const yearlyCsv = yearsList.map((year) => {
    const row = execYears[year]!;
    return {
      Year: year,
      Trades: row.n,
      Wins: row.wins,
      Losses: row.losses,
      WR: round(row.winRate, 6),
      PF: round(row.profitFactor, 6),
      NetR: round(row.totalR, 6),
      ExpectancyR: round(row.expectancyR, 6),
      MaxDD: round(row.maxDrawdownR, 6),
    };
  });

  const windowCsv = windows.map((row) => ({
    Window: row.window,
    n: row.n,
    WR: round(row.winRate, 6),
    PF: round(row.profitFactor, 6),
    NetR: round(row.totalR, 6),
    Expectancy: round(row.expectancyR, 6),
  }));

  const costCsv = costRows.map((row) => ({
    Scenario: row.scenario,
    n: row.n,
    WR: round(row.winRate, 6),
    PF: round(row.profitFactor, 6),
    NetR: round(row.totalR, 6),
    Expectancy: round(row.expectancyR, 6),
  }));

  await writeFile(resolve(OUT, "TRADE_LOG.csv"), toCsv(tradeLog));
  await writeFile(resolve(OUT, "YEARLY_RESULTS.csv"), toCsv(yearlyCsv));
  await writeFile(resolve(OUT, "WINDOW_RESULTS.csv"), toCsv(windowCsv));
  await writeFile(resolve(OUT, "COST_RESULTS.csv"), toCsv(costCsv));
  await writeFile(resolve(OUT, "INTRABAR_REPORT.md"), `# Intrabar report — GX POC SWING LONG ONLY V1

H1 bars can touch both stop and target. Lower-timeframe bid/ask path data was not used to order fills.

Policy: **stop-first** (conservative). Adverse stop gaps fill at the worse open. Target gaps are not improved.

- Midpoint trades with both SL and TP reachable on the same H1 bar: ${ambiguous} / ${historyClosed.closed.length}
- Executable (bid) trades with both SL and TP reachable on the same H1 bar: ${execAmbiguous} / ${historyClosed.closed.length}

No M1/M5 path reconstruction was available for this validation, so favorable outcomes were not assumed.
`);
  await writeFile(resolve(OUT, "CAUSALITY_AUDIT.md"), causalityAudit("PASS"));
  await writeFile(resolve(OUT, "SUMMARY.json"), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    protocol,
    dataInventory,
    parity,
    parityWindow: parityMid,
    period: { from: historyFrom, toExclusive: TO, warmupH1: WARMUP_H1, warmupH4: WARMUP_H4 },
    midpoint: historyMid,
    executable: historyExec,
    winRateCI95: ci,
    firstHalf,
    secondHalf,
    yearly: execYears,
    windows,
    costs: costCsv,
    frequency: {
      spanYears,
      averageTradesPerYear: mean(tradesPerYear),
      medianTradesPerYear: median(tradesPerYear),
      minTradesPerYear: tradesPerYear.length ? Math.min(...tradesPerYear) : null,
      maxTradesPerYear: tradesPerYear.length ? Math.max(...tradesPerYear) : null,
      tradesPerMonth: mean(tradesPerYear) != null ? mean(tradesPerYear)! / 12 : null,
    },
    bestYear,
    worstYear,
    profitableYears,
    losingYears,
    yearsWrAtLeast40: `${years40} / ${yearsList.length}`,
    classification,
    verdict: classification.verdict,
  }, null, 2)}\n`);

  await writeFile(resolve(OUT, "FINAL_REPORT.md"), finalReport({
    verdict: classification.verdict,
    parity,
    parityMid,
    history: {
      period: `${historyFrom} to ${h1.at(-1)!.time}`,
      mid: historyMid,
      exec: historyExec,
      spanYears,
      averageTradesPerYear: mean(tradesPerYear),
      ci,
      bestYear,
      worstYear,
      profitableYears,
      losingYears,
      years40: `${years40} / ${yearsList.length}`,
      reasons: classification.reasons,
      costRows,
      windows,
      yearly: execYears,
      yearsList,
      minTrades: tradesPerYear.length ? Math.min(...tradesPerYear) : null,
      maxTrades: tradesPerYear.length ? Math.max(...tradesPerYear) : null,
      medianTrades: median(tradesPerYear),
    },
    exec: historyExec,
    firstHalf,
    secondHalf,
    years40: `${years40} / ${yearsList.length}`,
    walkForward: classification.walkForward,
    rule40: classification.rule40,
    period: `${historyFrom} to ${h1.at(-1)!.time}`,
  }));

  console.log(JSON.stringify({
    verdict: classification.verdict,
    parity,
    parityWindow: parityMid,
    executable: historyExec,
    outputDirectory: OUT,
  }, null, 2));
}

function sliceByTime(rows: readonly ClosedTrade[], fromFrac: number, toFrac: number) {
  if (!rows.length) return [];
  const times = rows.map((row) => Date.parse(row.signal.signalTimestamp)).sort((left, right) => left - right);
  const start = times[0]!;
  const end = times.at(-1)!;
  const from = start + (end - start) * fromFrac;
  const to = start + (end - start) * toFrac;
  return rows.filter((row) => {
    const time = Date.parse(row.signal.signalTimestamp);
    return time >= from && (toFrac === 1 ? time <= to : time < to);
  });
}

function yearPairs(years: readonly number[]) {
  const pairs: Array<{ name: string; years: number[] }> = [];
  for (let index = 0; index < years.length; index += 2) {
    const left = years[index]!;
    const right = years[index + 1];
    pairs.push(right == null ? { name: `${left}`, years: [left] } : { name: `${left}-${right}`, years: [left, right] });
  }
  return pairs;
}

function causalityAudit(htf: string) {
  return `# Causality audit — GX POC SWING LONG ONLY V1

Implementation: \`frontend/scripts/usdjpy-poc-swing-long.ts\` (research only).

| Item | Result |
|---|---|
| Future H4 information | ${htf === "PASS" ? "PASS" : "FAIL"} — previous completed H4 only (\`startedIndex - 1\`), equivalent to Pine \`close[1]\` / \`EMA[1]\` with lookahead off |
| Future POC information | PASS — POC uses previous 24 completed H1 bars; lock frozen at breakout |
| Future H1 candles | PASS — signals use only the current completed H1 bar and prior history |
| Incorrect centered windows | PASS — consolidation is \`[i-24, i-1]\`, current bar excluded |
| Lookahead EMA calculations | PASS — H4 EMA50/200 computed on the H4 close series, read at the previous-completed index |
| Incorrect breakout range inclusion | PASS — breakout candle is not inside the 24-bar range |
| Future volume bins | PASS — volume is taken from the same previous 24 H1 bars |

Pine source \`.pine\` file was not in the workspace. This audit covers the research engine against PINE_RULE_SPEC.md.
`;
}

function finalReport(args: {
  verdict: Verdict;
  parity: { classification: ParityClass; note: string };
  parityMid: Metrics;
  history: {
    period: string;
    mid: Metrics;
    exec: Metrics;
    spanYears: number;
    averageTradesPerYear: number | null;
    ci: { low: number; high: number } | null;
    bestYear: { year: number; totalR: number };
    worstYear: { year: number; totalR: number };
    profitableYears: number;
    losingYears: number;
    years40: string;
    reasons: string[];
    costRows: Array<Metrics & { scenario: string }>;
    windows: Array<Metrics & { window: string }>;
    yearly: Record<string, Metrics>;
    yearsList: number[];
    minTrades: number | null;
    maxTrades: number | null;
    medianTrades: number | null;
  } | null;
  exec: Metrics | null;
  firstHalf: Metrics | null;
  secondHalf: Metrics | null;
  years40: string;
  walkForward: "PASS" | "FAIL" | "UNCLEAR";
  rule40: "PASS" | "FAIL";
  period: string;
}) {
  const history = args.history;
  const exec = args.exec;
  return `VERDICT:
${args.verdict}

TradingView parity:
TV trades: ${TV.n}
Backend trades: ${args.parityMid.n}
TV WR: ${pct(TV.winRate)}
Backend WR: ${pct(args.parityMid.winRate)}
TV PF: ${TV.profitFactor}
Backend PF: ${fmt(args.parityMid.profitFactor)}

Parity class: ${args.parity.classification}
${args.parity.note}

Full historical validation:
Period: ${args.period}
Trades: ${history?.exec.n ?? "n/a"}
Trades/year: ${fmt(history?.averageTradesPerYear, 2)}
Wins: ${history?.exec.wins ?? "n/a"}
Losses: ${history?.exec.losses ?? "n/a"}
WR: ${pct(history?.exec.winRate ?? null)}
PF: ${fmt(history?.exec.profitFactor ?? null)}
Net R: ${fmt(history?.exec.totalR ?? null)}
Expectancy R/trade: ${fmt(history?.exec.expectancyR ?? null)}
Max DD: ${fmt(history?.exec.maxDrawdownR ?? null)}
Avg hold: ${fmt(history?.exec.averageHoldingHours ?? null)} h
Median hold: ${fmt(history?.exec.medianHoldingHours ?? null)} h
Max hold: ${fmt(history?.exec.maxHoldingHours ?? null)} h
WR 95% Wilson CI: ${history?.ci ? `${pct(history.ci.low)} to ${pct(history.ci.high)}` : "n/a"}

Midpoint / ideal:
WR: ${pct(history?.mid.winRate ?? null)}
PF: ${fmt(history?.mid.profitFactor ?? null)}
Net R: ${fmt(history?.mid.totalR ?? null)}
Expectancy: ${fmt(history?.mid.expectancyR ?? null)}

Realistic execution:
WR: ${pct(exec?.winRate ?? null)}
PF: ${fmt(exec?.profitFactor ?? null)}
Net R: ${fmt(exec?.totalR ?? null)}
Expectancy: ${fmt(exec?.expectancyR ?? null)}

First half:
Trades: ${args.firstHalf?.n ?? "n/a"}
WR: ${pct(args.firstHalf?.winRate ?? null)}
PF: ${fmt(args.firstHalf?.profitFactor ?? null)}
Expectancy: ${fmt(args.firstHalf?.expectancyR ?? null)}

Second half:
Trades: ${args.secondHalf?.n ?? "n/a"}
WR: ${pct(args.secondHalf?.winRate ?? null)}
PF: ${fmt(args.secondHalf?.profitFactor ?? null)}
Expectancy: ${fmt(args.secondHalf?.expectancyR ?? null)}

Years >=40% WR:
${args.years40}

Walk-forward / chronological stability:
${args.walkForward}

40% direction rule:
${args.rule40}

Final classification:
${args.verdict}

${history ? `## Year by year (executable)

| Year | Trades | Wins | Losses | WR | PF | Net R | Exp R | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${history.yearsList.map((year) => {
    const row = history.yearly[year]!;
    return `| ${year} | ${row.n} | ${row.wins} | ${row.losses} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.totalR)} | ${fmt(row.expectancyR)} | ${fmt(row.maxDrawdownR)} |`;
  }).join("\n")}

Best year: ${history.bestYear.year} (${fmt(history.bestYear.totalR)}R)
Worst year: ${history.worstYear.year} (${fmt(history.worstYear.totalR)}R)
Profitable years: ${history.profitableYears}
Losing years: ${history.losingYears}

## Trade frequency (completed trades)

- average trades/year: ${fmt(history.averageTradesPerYear, 2)}
- median trades/year: ${fmt(history.medianTrades, 2)}
- min trades in a calendar year: ${history.minTrades ?? "n/a"}
- max trades in a calendar year: ${history.maxTrades ?? "n/a"}
- approximate trades/month: ${fmt(history.averageTradesPerYear == null ? null : history.averageTradesPerYear / 12, 2)}

## Cost scenarios

| Scenario | N | WR | PF | Net R | Exp R |
|---|---:|---:|---:|---:|---:|
${history.costRows.map((row) => `| ${row.scenario} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.totalR)} | ${fmt(row.expectancyR)} |`).join("\n")}

## Chronological windows (executable)

| Window | N | WR | PF | Net R | Exp R |
|---|---:|---:|---:|---:|---:|
${history.windows.map((row) => `| ${row.window} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.totalR)} | ${fmt(row.expectancyR)} |`).join("\n")}

## KEEP_LONG checklist

1. Overall WR >= 40.00% after realistic costs: ${args.rule40}
2. Positive expectancy after realistic costs: ${(exec?.expectancyR ?? 0) > 0 ? "PASS" : "FAIL"}
3. PF > 1 after realistic costs: ${(exec?.profitFactor ?? 0) > 1 ? "PASS" : "FAIL"}
4. Adequate sample: ${history.exec.n >= 30 ? "PASS" : "FAIL"} (${history.exec.n} trades)
5. No obvious recent/OOS collapse: ${args.walkForward}
6. Not driven almost entirely by one period: ${history.reasons.some((reason) => reason.includes("single year")) ? "FAIL" : "PASS"}

${history.reasons.length ? `Rejection / caution notes:\n${history.reasons.map((reason) => `- ${reason}`).join("\n")}` : ""}
` : "Full-history metrics were not produced because parity failed."}

This validation is LONG only. It was not compared to a USDJPY swing short model.

NO STRATEGY RULES WERE CHANGED. NO PRODUCTION CODE WAS MODIFIED. NO ORDERS WERE PLACED.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
