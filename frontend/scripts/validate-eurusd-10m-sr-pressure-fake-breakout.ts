import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
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
  breakoutStats,
  evaluateTrace,
  freezeCohort,
  levelsFor,
  resolveTrade,
  signalsFromTrace,
  type FrozenSignal,
  type ResolvedTrade,
  type SignalTraceRow,
} from "./eurusd-10m-sr-pressure-fake-breakout";

const OUT = resolve(process.cwd(), "../api-server/research-v2/eurusd-10m-sr-pressure-fake-breakout-v2-long-only-validation");
const REQUESTED_FROM = "2018-01-01T00:00:00.000Z";
const PARITY_FROM = "2026-02-01T00:00:00.000Z";
const TO = "2026-09-05T00:00:00.000Z";
const WARMUP = "2017-12-01T00:00:00.000Z";
const TV = { n: 23, wins: 11, losses: 12, winRate: 0.4783, profitFactor: 2.39 } as const;

type ExitReason = "TP" | "SL";
type Verdict = "SURVIVES" | "MARGINAL" | "FAILS_COSTS" | "FAILS_LONG_HISTORY" | "PARITY_FAILED";
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
  overnightRolls: number;
  financingDaysCharged: number;
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
  averageWinnerR: number | null;
  averageLoserR: number | null;
  averageHoldingHours: number | null;
  medianHoldingHours: number | null;
  p95HoldingHours: number | null;
  longestHoldingHours: number | null;
  longestLosingStreak: number;
  holdsOver6h: number;
  holdsOver12h: number;
  holdsOver24h: number;
  holdsOver48h: number;
};

const nyClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

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

function longestLosingStreak(results: readonly number[]) {
  let current = 0;
  let longest = 0;
  for (const result of results) {
    if (result < 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  return longest;
}

function metrics(rows: readonly { resultR: number; exitReason: ExitReason; holdingMs?: number }[]): Metrics {
  const wins = rows.filter((row) => row.resultR > 0);
  const losses = rows.filter((row) => row.resultR < 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.resultR, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.resultR, 0));
  const totalR = rows.reduce((sum, row) => sum + row.resultR, 0);
  const holds = rows.map((row) => row.holdingMs).filter((value): value is number => value != null);
  const hours = holds.map((value) => value / 3_600_000);
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
    averageWinnerR: mean(wins.map((row) => row.resultR)),
    averageLoserR: mean(losses.map((row) => row.resultR)),
    averageHoldingHours: mean(hours),
    medianHoldingHours: median(hours),
    p95HoldingHours: percentile(hours, 0.95),
    longestHoldingHours: hours.length ? Math.max(...hours) : null,
    longestLosingStreak: longestLosingStreak(rows.map((row) => row.resultR)),
    holdsOver6h: hours.filter((value) => value > 6).length,
    holdsOver12h: hours.filter((value) => value > 12).length,
    holdsOver24h: hours.filter((value) => value > 24).length,
    holdsOver48h: hours.filter((value) => value > 48).length,
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

function overnightFinancing(entryMs: number, exitMs: number) {
  let rolls = 0;
  let daysCharged = 0;
  const hour = 60 * 60_000;
  const start = Math.ceil((entryMs + 1) / hour) * hour;
  for (let time = start; time <= exitMs; time += hour) {
    const parts = Object.fromEntries(
      nyClock.formatToParts(new Date(time)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    if (parts.hour !== "17" || parts.minute !== "00") continue;
    rolls += 1;
    daysCharged += parts.weekday === "Wed" ? 3 : 1;
  }
  return { rolls, daysCharged };
}

async function writeCandleCache(file: string, candles: readonly ResearchCandle[]) {
  const stream = createWriteStream(file, { flags: "w" });
  stream.write(`{"warmup":${JSON.stringify(WARMUP)},"to":${JSON.stringify(TO)},"candles":[`);
  for (let index = 0; index < candles.length; index += 1) {
    if (index > 0) stream.write(",");
    if (!stream.write(JSON.stringify(candles[index]))) {
      await new Promise<void>((resolveWrite) => stream.once("drain", resolveWrite));
    }
  }
  stream.end("]}");
  await finished(stream);
}

async function fetchFrame() {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const file = resolve(OUT, "data", `${SYMBOL}-M10-MBA.json`);
  let rows: ResearchCandle[] = [];
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { warmup: string; to: string; candles: ResearchCandle[] };
    if (saved.warmup === WARMUP && saved.to === TO) rows = saved.candles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Existing M10 cache unreadable (${error instanceof Error ? error.message : String(error)}); resuming from latest.`);
    }
  }
  const completeEnough = rows
    .filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(WARMUP) && Date.parse(candle.time) < Date.parse(TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  if (completeEnough.length && Date.parse(completeEnough[0]!.time) <= Date.parse(WARMUP) + 7 * 24 * 60 * 60_000) {
    return completeEnough;
  }
  let oldestMs = Infinity;
  for (const row of rows) oldestMs = Math.min(oldestMs, Date.parse(row.time));
  const seen = new Map(rows.map((row) => [row.time, row]));
  let cursor = rows.length ? new Date(oldestMs).toISOString() : TO;
  let stall = 0;
  let oldest = rows[0]?.time ?? TO;
  while (Date.parse(cursor) > Date.parse(WARMUP) && stall < 3) {
    let batch: ResearchCandle[] = [];
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        batch = await getResearchCandles(SYMBOL, "M10", 5_000, { to: cursor });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_500 * (attempt + 1)));
      }
    }
    if (lastError) {
      console.error(`M10 fetch stopped at ${cursor}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
    console.error(`M10: ${seen.size} completed MBA bars; oldest ${oldest}`);
    if (Date.parse(earliest) <= Date.parse(WARMUP)) break;
  }
  const complete = [...seen.values()]
    .filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(WARMUP) && Date.parse(candle.time) < Date.parse(TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  await writeCandleCache(file, complete);
  return complete;
}

async function currentOandaLongRate(): Promise<{ longRate: number; source: string } | null> {
  const accountId = process.env.OANDA_ACCOUNT_ID?.trim();
  const token = process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim();
  if (!accountId || !token) return null;
  const base = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const response = await fetch(`${base}/v3/accounts/${accountId}/instruments?instruments=${SYMBOL}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok) return null;
  const body = await response.json() as { instruments?: Array<{ financing?: { longRate?: string } }> };
  const longRate = Number(body.instruments?.[0]?.financing?.longRate);
  if (!Number.isFinite(longRate)) return null;
  return { longRate, source: `${base} current snapshot, not historical` };
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
    const holdingMs = Date.parse(midpoint.exitTimestamp) - Date.parse(signal.decisionTime);
    const rolls = overnightFinancing(Date.parse(signal.decisionTime), Date.parse((executable ?? midpoint).exitTimestamp));
    closed.push({
      signal, year: yearOf(signal.signalTimestamp),
      spreadPips: (signalBar.ask.close - signalBar.bid.close) / PIP,
      spreadToStop: (signalBar.ask.close - signalBar.bid.close) / (CONFIG.stopAtr * signal.atr),
      stopPips: CONFIG.stopAtr * signal.atr / PIP,
      executableEntry: levels.entry, executableStop: levels.stop, executableTarget: levels.target,
      midpoint, executable, holdingMs, overnightRolls: rolls.rolls, financingDaysCharged: rolls.daysCharged,
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
  if (!rows.length) return [] as number[];
  const years: number[] = [];
  for (let year = Math.min(...rows.map((row) => row.year)); year <= Math.max(...rows.map((row) => row.year)); year += 1) years.push(year);
  return years;
}

function byYear(rows: readonly ClosedTrade[], kind: "mid" | "exec", years: readonly number[]) {
  return Object.fromEntries(years.map((year) => {
    const selected = rows.filter((row) => row.year === year);
    return [year, kind === "mid" ? midMetrics(selected) : execMetrics(selected)];
  }));
}

function blockMetrics(rows: readonly ClosedTrade[], fromYear: number, toYear: number) {
  return midMetrics(rows.filter((row) => row.year >= fromYear && row.year <= toYear));
}

function windowStats(rows: readonly SignalTraceRow[], from: string, toExclusive: string) {
  return breakoutStats(rows.filter((row) => inRange(row.timestamp, from, toExclusive)));
}

function counterfactualBreakoutSignals(candles: readonly ResearchCandle[], rows: readonly SignalTraceRow[]): FrozenSignal[] {
  const byTime = new Map(candles.map((candle) => [candle.time, candle]));
  const out: FrozenSignal[] = [];
  for (const row of rows) {
    if (!row.longBreakout || row.atr14 == null || row.asiaHigh == null || row.ema20 == null || row.ema50 == null) continue;
    const bar = byTime.get(row.timestamp);
    if (!bar) continue;
    const midEntry = bar.mid.close;
    const atr = row.atr14;
    const midStop = midEntry - CONFIG.stopAtr * atr;
    const midTarget = midEntry + CONFIG.rewardR * atr;
    if (!(atr > 0) || !(midStop < midEntry && midEntry < midTarget)) continue;
    out.push({
      strategyId: STRATEGY_ID,
      signalTimestamp: row.timestamp,
      decisionTime: new Date(Date.parse(row.timestamp) + BAR_MS).toISOString(),
      breakoutTimestamp: row.timestamp,
      direction: "long",
      frozenResistance: row.asiaHigh,
      touches: row.touches,
      midEntry, atr, midStop, midTarget,
      ema20: row.ema20, ema50: row.ema50,
    });
  }
  return out;
}

function parityAssessment(mid: Metrics) {
  const countClose = Math.abs(mid.n - TV.n) <= 8;
  const wrClose = mid.winRate != null && Math.abs(mid.winRate - TV.winRate) <= 0.12;
  const pfClose = mid.profitFactor != null && Math.abs(mid.profitFactor - TV.profitFactor) <= 1.20;
  const passed = mid.n >= 10 && countClose && wrClose && pfClose;
  return {
    passed, countClose, wrClose, pfClose, expected: TV,
    note: passed
      ? "OANDA 10m midpoint 2026-02-01 to 2026-09-04 N/WR/PF are close enough to the approximate TradingView headline to continue. Frozen rules were not changed."
      : "Material midpoint mismatch versus the TradingView 23-trade headline. Long-history conclusions withheld. Frozen rules were not changed.",
  };
}

function longHistoryGate(full: Metrics, years: Record<string, Metrics>, withoutBest: Metrics, withoutRecent: Metrics, blocks: Record<string, Metrics>) {
  const reasons: string[] = [];
  if (full.n < 75) reasons.push(`N ${full.n} < 75`);
  if (full.profitFactor == null || full.profitFactor < 1.20) reasons.push(`PF ${fmt(full.profitFactor)} < 1.20`);
  if (full.expectancyR == null || full.expectancyR <= 0) reasons.push("expectancy is not positive");
  if (withoutBest.profitFactor == null || withoutBest.profitFactor <= 1) reasons.push("removing the best year leaves PF <= 1");
  if (withoutRecent.profitFactor == null || withoutRecent.profitFactor <= 1 || (withoutRecent.expectancyR ?? 0) <= 0) {
    reasons.push("edge is entirely dependent on 2025/2026");
  }
  const yearSlices = Object.entries(years).filter(([, row]) => row.n >= 8);
  const positiveYears = yearSlices.filter(([, row]) => (row.expectancyR ?? 0) > 0);
  const blockSlices = Object.values(blocks).filter((row) => row.n >= 10);
  const positiveBlocks = blockSlices.filter((row) => (row.expectancyR ?? 0) > 0);
  const majority = (yearSlices.length && positiveYears.length >= Math.ceil(yearSlices.length / 2))
    || (blockSlices.length && positiveBlocks.length >= Math.ceil(blockSlices.length / 2));
  if (!majority) reasons.push("majority of meaningful yearly/block slices are not positive");
  return {
    passed: reasons.length === 0,
    reasons,
    prefer100Plus: full.n >= 100,
    positiveYearCount: positiveYears.length,
    meaningfulYearCount: yearSlices.length,
    positiveBlockCount: positiveBlocks.length,
  };
}

function classifyAfterCosts(exec: Metrics, withoutBestExec: Metrics, withoutRecentExec: Metrics): Verdict {
  if (exec.expectancyR == null || exec.profitFactor == null || exec.expectancyR <= 0 || exec.profitFactor <= 1) return "FAILS_COSTS";
  const stable = exec.profitFactor > 1.15 && exec.expectancyR > 0.08
    && (withoutBestExec.profitFactor ?? 0) > 1
    && (withoutRecentExec.expectancyR ?? 0) > 0;
  return stable ? "SURVIVES" : "MARGINAL";
}

async function writeAudit(lines: Record<string, unknown>) {
  await writeFile(resolve(OUT, "DATA_AUDIT.md"), [
    "# Data audit — eurusd_10m_sr_pressure_fake_breakout_v2_long_only",
    "",
    "- Instrument: EUR_USD",
    "- Signal timeframe: OANDA M10 MBA, completed bars only",
    "- Sessions: Asia 00:00-06:00 UTC; London entry 06:00-11:00 UTC",
    "- Long only. No time exit. No shorts. No trailing. No profit lock.",
    `- Requested window: ${REQUESTED_FROM} to ${TO} exclusive`,
    `- Warmup request: ${WARMUP}`,
    ...Object.entries(lines).map(([key, value]) => `- ${key}: ${String(value)}`),
    "- Historical financing: FINANCING_DATA_UNAVAILABLE",
    "- Production evaluators, registries, and paper/live paths were not modified",
    "",
  ].join("\n"));
}

async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  if (!process.env.OANDA_REQUEST_TIMEOUT_MS || Number(process.env.OANDA_REQUEST_TIMEOUT_MS) < 60_000) {
    process.env.OANDA_REQUEST_TIMEOUT_MS = "120000";
  }
  await mkdir(resolve(OUT, "data"), { recursive: true });
  console.error("Fetching EUR_USD M10 MBA history...");
  const m10 = await fetchFrame();
  if (!m10.length) throw new Error("Required OANDA M10 MBA history is missing.");
  const availableFrom = new Date(Math.max(Date.parse(REQUESTED_FROM), Date.parse(m10[0]!.time))).toISOString();
  const traced = evaluateTrace(m10);
  if (traced.error) throw new Error(traced.error);
  const allSignals = signalsFromTrace(m10, traced.rows);
  const paritySignals = allSignals.filter((signal) => inRange(signal.signalTimestamp, PARITY_FROM, TO));
  const historySignals = allSignals.filter((signal) => inRange(signal.signalTimestamp, availableFrom, TO));
  const parityClosed = closeTrades(paritySignals, m10);
  const historyClosed = closeTrades(historySignals, m10);
  const parityMid = midMetrics(parityClosed.closed);
  const parity = parityAssessment(parityMid);
  const parityBreakouts = windowStats(traced.rows, PARITY_FROM, TO);
  const historyBreakouts = windowStats(traced.rows, availableFrom, TO);
  const protocol = {
    strategyId: STRATEGY_ID, name: STRATEGY_NAME, version: STRATEGY_VERSION, symbol: SYMBOL, timeframe: TIMEFRAME,
    frozen: true, longOnly: true, timeExit: false, productionStrategyModified: false, deployed: false, ordersPlaced: false,
    rules: CONFIG,
    period: { requestedFrom: REQUESTED_FROM, availableFrom, toExclusive: TO, warmup: WARMUP, m10From: m10[0]?.time, m10To: m10.at(-1)?.time },
  };
  const first23 = parityClosed.closed.slice(0, 23).map((row) => ({
    confirmationTimestamp: row.signal.signalTimestamp,
    breakoutTimestamp: row.signal.breakoutTimestamp,
    decisionTime: row.signal.decisionTime,
    frozenResistance: row.signal.frozenResistance,
    midEntry: row.signal.midEntry,
    atr: row.signal.atr,
    touches: row.signal.touches,
  }));

  if (!parity.passed) {
    await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
    await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), protocol, parity, parityWindow: parityMid, parityBreakouts, first23, verdict: "PARITY_FAILED" }, null, 2)}\n`);
    await writeAudit({ "M10 bars": m10.length, "M10 from": m10[0]?.time, "Available from": availableFrom, Verdict: "PARITY_FAILED" });
    await writeFile(resolve(OUT, "FINAL_REPORT.md"), [
      "# EUR/USD 10m S/R Pressure Fake Breakout V2 Long Only — VALIDATION STOPPED",
      "",
      "2026-02-01 to 2026-09-04 midpoint parity versus the TradingView 23-trade headline failed. Frozen rules were not changed.",
      "",
      `| Window | N | W/L | WR | PF | EXP R |`,
      `|---|---:|---:|---:|---:|---:|`,
      `| TV headline | ${TV.n} | ${TV.wins}/${TV.losses} | ${pct(TV.winRate)} | ${fmt(TV.profitFactor)} | n/a |`,
      `| OANDA midpoint | ${parityMid.n} | ${parityMid.wins}/${parityMid.losses} | ${pct(parityMid.winRate)} | ${fmt(parityMid.profitFactor)} | ${fmt(parityMid.expectancyR)} |`,
      "",
      `Breakout candidates ${parityBreakouts.breakoutCandidates}; real ${parityBreakouts.realBreakouts}; fake ${parityBreakouts.fakeBreakouts}; fake rate ${pct(parityBreakouts.fakeBreakoutRate)}.`,
      "",
      "First entries:",
      "",
      ...first23.map((row, index) => `${index + 1}. confirm ${row.confirmationTimestamp} breakout ${row.breakoutTimestamp} @ ${row.midEntry.toFixed(5)} resistance ${row.frozenResistance.toFixed(5)}`),
      "",
      "NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.",
      "",
    ].join("\n"));
    console.log(JSON.stringify({ verdict: "PARITY_FAILED", parity, parityWindow: parityMid, parityBreakouts, outputDirectory: OUT }, null, 2));
    return;
  }

  const historyMid = midMetrics(historyClosed.closed);
  const yearsList = yearsCovered(historyClosed.closed);
  const historyYears = byYear(historyClosed.closed, "mid", yearsList.length ? yearsList : [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  const blocks = {
    "2018-2020": blockMetrics(historyClosed.closed, 2018, 2020),
    "2021-2022": blockMetrics(historyClosed.closed, 2021, 2022),
    "2023-2024": blockMetrics(historyClosed.closed, 2023, 2024),
    "2025-2026": blockMetrics(historyClosed.closed, 2025, 2026),
  };
  const bestYear = yearsList.reduce((best, year) => historyYears[year]!.totalR > best.totalR ? { year, totalR: historyYears[year]!.totalR } : best, { year: yearsList[0] ?? 2026, totalR: -Infinity });
  const withoutBest = midMetrics(historyClosed.closed.filter((row) => row.year !== bestYear.year));
  const without2026 = midMetrics(historyClosed.closed.filter((row) => row.year !== 2026));
  const withoutRecent = midMetrics(historyClosed.closed.filter((row) => row.year !== 2025 && row.year !== 2026));
  const midpointMs = Date.parse(availableFrom) + (Date.parse(TO) - Date.parse(availableFrom)) / 2;
  const firstHalf = midMetrics(historyClosed.closed.filter((row) => Date.parse(row.signal.signalTimestamp) < midpointMs));
  const secondHalf = midMetrics(historyClosed.closed.filter((row) => Date.parse(row.signal.signalTimestamp) >= midpointMs));
  const spanYears = (Date.parse(TO) - Date.parse(availableFrom)) / (365.2425 * 24 * 60 * 60_000);
  const gate = longHistoryGate(historyMid, historyYears, withoutBest, withoutRecent, blocks);
  const allBreakouts = counterfactualBreakoutSignals(m10, traced.rows).filter((signal) => inRange(signal.signalTimestamp, availableFrom, TO));
  const allBreakoutClosed = closeTrades(allBreakouts, m10);
  const allBreakoutMid = midMetrics(allBreakoutClosed.closed);
  const trades = historyClosed.closed.map((row) => ({
    confirmationTimestamp: row.signal.signalTimestamp,
    breakoutTimestamp: row.signal.breakoutTimestamp,
    year: row.year,
    midEntry: row.signal.midEntry,
    atr: row.signal.atr,
    frozenResistance: row.signal.frozenResistance,
    touches: row.signal.touches,
    midStop: row.signal.midStop,
    midTarget: row.signal.midTarget,
    executableEntry: row.executableEntry,
    spreadPips: row.spreadPips,
    midExitTimestamp: row.midpoint.exitTimestamp,
    midExitReason: row.midpoint.exitReason,
    midResultR: row.midpoint.resultR,
    holdBars: row.midpoint.holdBars,
    holdingHours: row.holdingMs / 3_600_000,
    overnightRolls: row.overnightRolls,
    financingDaysCharged: row.financingDaysCharged,
    execExitTimestamp: row.executable?.exitTimestamp ?? null,
    execExitReason: row.executable?.exitReason ?? null,
    execResultR: row.executable?.resultR ?? null,
  }));

  const base = {
    generatedAt: new Date().toISOString(), protocol,
    data: { m10: m10.length, from: m10[0]?.time, to: m10.at(-1)?.time, availableFrom, source: "OANDA practice API MBA M10" },
    parity, parityWindow: parityMid, parityBreakouts, first23,
    rawParity: parityClosed.raw, acceptedParity: parityClosed.accepted, skippedParity: parityClosed.skipped,
    rawHistory: historyClosed.raw, acceptedHistory: historyClosed.accepted, skippedHistory: historyClosed.skipped, unresolvedHistory: historyClosed.unresolved,
    midpoint: historyMid, midpointYears: historyYears, blocks, historyBreakouts,
    withoutBestYear: { year: bestYear.year, metrics: withoutBest }, without2026, without2025And2026: withoutRecent,
    halves: { first: firstHalf, second: secondHalf },
    confirmationVsRawBreakout: { filtered: historyMid, enterOnBreakout: allBreakoutMid, fakeBreakoutRate: historyBreakouts.fakeBreakoutRate },
    gate, frequency: { years: spanYears, tradesPerYear: historyMid.n / spanYears },
  };

  if (!gate.passed) {
    await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
    await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({ ...base, trades, verdict: "FAILS_LONG_HISTORY" }, null, 2)}\n`);
    await writeFile(resolve(OUT, "TRADES.midpoint.csv"), toCsv(trades.map((row) => ({
      confirmationTimestamp: row.confirmationTimestamp, breakoutTimestamp: row.breakoutTimestamp, entry: row.midEntry,
      stop: row.midStop, target: row.midTarget, frozenResistance: row.frozenResistance, exitTimestamp: row.midExitTimestamp,
      exitReason: row.midExitReason, resultR: row.midResultR, holdingHours: row.holdingHours, year: row.year,
    }))));
    await writeAudit({ "M10 bars": m10.length, "M10 from": m10[0]?.time, "Available from": availableFrom, "History closed": historyClosed.closed.length, Verdict: "FAILS_LONG_HISTORY" });
    const yearLines = Object.entries(historyYears).map(([year, row]) => `| ${year} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} | ${fmt(row.totalR)} | ${fmt(row.maxDrawdownR)} |`).join("\n");
    const blockLines = Object.entries(blocks).map(([name, row]) => `| ${name} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} |`).join("\n");
    await writeFile(resolve(OUT, "FINAL_REPORT.md"), `# EUR/USD 10m S/R Pressure Fake Breakout V2 Long Only — LONG-HISTORY VALIDATION

Strategy ID: \`${STRATEGY_ID}\`. Frozen long-only rules. OANDA M10 MBA. No production strategy was modified. No orders were placed.

Requested 2018-01-01 through 2026-09-04. Earliest complete M10 bar: ${m10[0]?.time}. Evaluation from ${availableFrom}.

## Step 1 — 2026-02-01 to 2026-09-04 midpoint parity

| Window | N | W/L | WR | PF | EXP R | Total R | Avg win R | Avg loss R | Max DD R | Avg hold h | Med hold h | Longest hold h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TV headline | ${TV.n} | ${TV.wins}/${TV.losses} | ${pct(TV.winRate)} | ${fmt(TV.profitFactor)} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| OANDA midpoint | ${parityMid.n} | ${parityMid.wins}/${parityMid.losses} | ${pct(parityMid.winRate)} | ${fmt(parityMid.profitFactor)} | ${fmt(parityMid.expectancyR)} | ${fmt(parityMid.totalR)} | ${fmt(parityMid.averageWinnerR)} | ${fmt(parityMid.averageLoserR)} | ${fmt(parityMid.maxDrawdownR)} | ${fmt(parityMid.averageHoldingHours)} | ${fmt(parityMid.medianHoldingHours)} | ${fmt(parityMid.longestHoldingHours)} |

Breakout candidates ${parityBreakouts.breakoutCandidates}; real ${parityBreakouts.realBreakouts}; fake ${parityBreakouts.fakeBreakouts}; fake rate ${pct(parityBreakouts.fakeBreakoutRate)}.
Raw real setups ${parityClosed.raw}; skipped while open ${parityClosed.skipped}; closed ${parityClosed.closed.length}.

Parity gate: **passed**. ${parity.note}

First 23 OANDA entries:

${first23.map((row, index) => `${index + 1}. confirm ${row.confirmationTimestamp} breakout ${row.breakoutTimestamp} entry ${row.midEntry.toFixed(5)} resistance ${row.frozenResistance.toFixed(5)} ATR ${row.atr.toFixed(5)} touches ${row.touches}`).join("\n")}

## Step 2 — Full available-history midpoint

Raw setups ${historyClosed.raw}; skipped while open ${historyClosed.skipped}; closed ${historyClosed.closed.length}; unresolved ${historyClosed.unresolved}.

| YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R |
|---|---:|---:|---:|---:|---:|---:|
${yearLines}
| ALL | ${historyMid.n} | ${pct(historyMid.winRate)} | ${fmt(historyMid.profitFactor)} | ${fmt(historyMid.expectancyR)} | ${fmt(historyMid.totalR)} | ${fmt(historyMid.maxDrawdownR)} |

- trades/year: ${fmt(historyMid.n / spanYears, 1)}
- longest losing streak: ${historyMid.longestLosingStreak}
- average / median / p95 / longest hold: ${fmt(historyMid.averageHoldingHours)} / ${fmt(historyMid.medianHoldingHours)} / ${fmt(historyMid.p95HoldingHours)} / ${fmt(historyMid.longestHoldingHours)} hours
- TP / SL: ${historyMid.tp} / ${historyMid.sl}
- real breakouts: ${historyBreakouts.realBreakouts}
- fake breakouts: ${historyBreakouts.fakeBreakouts}
- fake breakout rate: ${pct(historyBreakouts.fakeBreakoutRate)}
- holds >6h / >12h / >24h / >48h: ${historyMid.holdsOver6h} / ${historyMid.holdsOver12h} / ${historyMid.holdsOver24h} / ${historyMid.holdsOver48h}

## Step 3 — Stability

| BLOCK | N | WR | PF | EXP R |
|---|---:|---:|---:|---:|
${blockLines}

- Remove best year (${bestYear.year}): N ${withoutBest.n} PF ${fmt(withoutBest.profitFactor)} EXP ${fmt(withoutBest.expectancyR)}
- Remove 2026: N ${without2026.n} PF ${fmt(without2026.profitFactor)} EXP ${fmt(without2026.expectancyR)}
- Remove 2025+2026: N ${withoutRecent.n} PF ${fmt(withoutRecent.profitFactor)} EXP ${fmt(withoutRecent.expectancyR)}
- First half: N ${firstHalf.n} PF ${fmt(firstHalf.profitFactor)} EXP ${fmt(firstHalf.expectancyR)}
- Second half: N ${secondHalf.n} PF ${fmt(secondHalf.profitFactor)} EXP ${fmt(secondHalf.expectancyR)}
- Enter on breakout, no fake filter: N ${allBreakoutMid.n} PF ${fmt(allBreakoutMid.profitFactor)} EXP ${fmt(allBreakoutMid.expectancyR)}
- Frozen fake-breakout filter: N ${historyMid.n} PF ${fmt(historyMid.profitFactor)} EXP ${fmt(historyMid.expectancyR)}

## Long-history gate

**FAILS_LONG_HISTORY**

${gate.reasons.map((reason) => `- ${reason}`).join("\n")}

Bid/ask execution was not run. Frozen rules were not changed to rescue the result.

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
`);
    console.log(JSON.stringify({
      verdict: "FAILS_LONG_HISTORY",
      parity: { passed: parity.passed, n: parityMid.n, wr: parityMid.winRate, pf: parityMid.profitFactor },
      midpoint: historyMid, gate, historyBreakouts, availableFrom, outputDirectory: OUT,
    }, null, 2));
    return;
  }

  const executableReady = historyClosed.closed.filter((row) => row.executable);
  if (executableReady.length !== historyClosed.closed.length) {
    throw new Error(`Fail closed: ${historyClosed.closed.length - executableReady.length} midpoint trades missing executable MBA resolution.`);
  }
  const exec = execMetrics(historyClosed.closed);
  const execYears = byYear(historyClosed.closed, "exec", yearsList);
  const withoutBestExec = execMetrics(historyClosed.closed.filter((row) => row.year !== bestYear.year));
  const withoutRecentExec = execMetrics(historyClosed.closed.filter((row) => row.year !== 2025 && row.year !== 2026));
  const verdict = classifyAfterCosts(exec, withoutBestExec, withoutRecentExec);
  const spreads = historyClosed.closed.map((row) => row.spreadPips);
  const spreadToStop = historyClosed.closed.map((row) => row.spreadToStop);
  const stopPips = historyClosed.closed.map((row) => row.stopPips);
  const winnerFlips = historyClosed.closed.filter((row) => row.midpoint.resultR > 0 && (row.executable?.resultR ?? 0) <= 0).length;
  const bidAskDrag = historyMid.expectancyR != null && exec.expectancyR != null ? historyMid.expectancyR - exec.expectancyR : null;
  const currentRate = await currentOandaLongRate();
  const rateDragPerTrade = currentRate
    ? mean(historyClosed.closed.map((row) => -(row.executableEntry * currentRate.longRate * row.financingDaysCharged / 365) / (CONFIG.stopAtr * row.signal.atr)))
    : null;
  const yearRows = yearsList.map((year) => {
    const midYear = historyYears[year]!;
    const execYear = execYears[year]!;
    const cost = midYear.expectancyR != null && execYear.expectancyR != null ? midYear.expectancyR - execYear.expectancyR : null;
    return {
      YEAR: year, N: midYear.n, MID_WR: round(midYear.winRate, 4), MID_PF: round(midYear.profitFactor, 3), MID_EXP: round(midYear.expectancyR, 3),
      EXEC_WR: round(execYear.winRate, 4), EXEC_PF: round(execYear.profitFactor, 3), EXEC_EXP: round(execYear.expectancyR, 3), COST_R_TRADE: round(cost, 3),
    };
  });
  await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
  await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({
    ...base, executable: exec, executableYears: execYears, yearRows,
    financing: { historical: "FINANCING_DATA_UNAVAILABLE", currentOandaSnapshot: currentRate, hypotheticalCurrentRateDragR: rateDragPerTrade },
    costs: {
      averageSpreadPips: mean(spreads), medianSpreadPips: median(spreads), p95SpreadPips: percentile(spreads, 0.95),
      averageStopPips: mean(stopPips), spreadAsPctOf1R: mean(spreadToStop),
      midpointWinnersToExecutableLosers: winnerFlips, costDragR: bidAskDrag,
      executableTotalR: exec.totalR, executableMaxDrawdownR: exec.maxDrawdownR,
    },
    trades, verdict,
  }, null, 2)}\n`);
  await writeFile(resolve(OUT, "TRADES.midpoint.csv"), toCsv(trades.map((row) => ({
    confirmationTimestamp: row.confirmationTimestamp, breakoutTimestamp: row.breakoutTimestamp, entry: row.midEntry,
    stop: row.midStop, target: row.midTarget, exitTimestamp: row.midExitTimestamp, exitReason: row.midExitReason, resultR: row.midResultR, year: row.year,
  }))));
  await writeFile(resolve(OUT, "TRADES.executable.csv"), toCsv(trades.map((row) => ({
    confirmationTimestamp: row.confirmationTimestamp, entry: row.executableEntry, spreadPips: row.spreadPips,
    exitTimestamp: row.execExitTimestamp, exitReason: row.execExitReason, resultR: row.execResultR, year: row.year,
  }))));
  await writeAudit({ "M10 bars": m10.length, "M10 from": m10[0]?.time, "Available from": availableFrom, "History closed": historyClosed.closed.length, "Missing executable": historyClosed.missingExecutable, Verdict: verdict });
  const yearLines = Object.entries(historyYears).map(([year, row]) => `| ${year} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} | ${fmt(row.totalR)} | ${fmt(row.maxDrawdownR)} |`).join("\n");
  const blockLines = Object.entries(blocks).map(([name, row]) => `| ${name} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} |`).join("\n");
  const costLines = yearRows.map((row) => `| ${row.YEAR} | ${row.N} | ${pct(row.MID_WR)} | ${fmt(row.MID_PF)} | ${fmt(row.MID_EXP)} | ${pct(row.EXEC_WR)} | ${fmt(row.EXEC_PF)} | ${fmt(row.EXEC_EXP)} | ${fmt(row.COST_R_TRADE)} |`).join("\n");
  await writeFile(resolve(OUT, "FINAL_REPORT.md"), `# EUR/USD 10m S/R Pressure Fake Breakout V2 Long Only — LONG-HISTORY + EXECUTABLE VALIDATION

Strategy ID: \`${STRATEGY_ID}\`. Frozen long-only rules. OANDA M10 MBA. No production strategy was modified. No orders were placed.

Requested 2018-01-01 through 2026-09-04. Earliest complete M10 bar: ${m10[0]?.time}. Evaluation from ${availableFrom}.

## Step 1 — 2026-02-01 to 2026-09-04 midpoint parity

| Window | N | W/L | WR | PF | EXP R | Total R | Avg win R | Avg loss R | Max DD R | Avg hold h | Med hold h | Longest hold h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TV headline | ${TV.n} | ${TV.wins}/${TV.losses} | ${pct(TV.winRate)} | ${fmt(TV.profitFactor)} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| OANDA midpoint | ${parityMid.n} | ${parityMid.wins}/${parityMid.losses} | ${pct(parityMid.winRate)} | ${fmt(parityMid.profitFactor)} | ${fmt(parityMid.expectancyR)} | ${fmt(parityMid.totalR)} | ${fmt(parityMid.averageWinnerR)} | ${fmt(parityMid.averageLoserR)} | ${fmt(parityMid.maxDrawdownR)} | ${fmt(parityMid.averageHoldingHours)} | ${fmt(parityMid.medianHoldingHours)} | ${fmt(parityMid.longestHoldingHours)} |

Breakout candidates ${parityBreakouts.breakoutCandidates}; real ${parityBreakouts.realBreakouts}; fake ${parityBreakouts.fakeBreakouts}; fake rate ${pct(parityBreakouts.fakeBreakoutRate)}.

Parity gate: **passed**. ${parity.note}

First 23 OANDA entries:

${first23.map((row, index) => `${index + 1}. confirm ${row.confirmationTimestamp} breakout ${row.breakoutTimestamp} entry ${row.midEntry.toFixed(5)} resistance ${row.frozenResistance.toFixed(5)} ATR ${row.atr.toFixed(5)} touches ${row.touches}`).join("\n")}

## Step 2 — Full available-history midpoint

| YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R |
|---|---:|---:|---:|---:|---:|---:|
${yearLines}
| ALL | ${historyMid.n} | ${pct(historyMid.winRate)} | ${fmt(historyMid.profitFactor)} | ${fmt(historyMid.expectancyR)} | ${fmt(historyMid.totalR)} | ${fmt(historyMid.maxDrawdownR)} |

- trades/year: ${fmt(historyMid.n / spanYears, 1)}
- longest losing streak: ${historyMid.longestLosingStreak}
- average / median / p95 / longest hold: ${fmt(historyMid.averageHoldingHours)} / ${fmt(historyMid.medianHoldingHours)} / ${fmt(historyMid.p95HoldingHours)} / ${fmt(historyMid.longestHoldingHours)} hours
- TP / SL: ${historyMid.tp} / ${historyMid.sl}
- real / fake breakouts: ${historyBreakouts.realBreakouts} / ${historyBreakouts.fakeBreakouts}
- fake breakout rate: ${pct(historyBreakouts.fakeBreakoutRate)}
- holds >6h / >12h / >24h / >48h: ${historyMid.holdsOver6h} / ${historyMid.holdsOver12h} / ${historyMid.holdsOver24h} / ${historyMid.holdsOver48h}

## Step 3 — Stability

| BLOCK | N | WR | PF | EXP R |
|---|---:|---:|---:|---:|
${blockLines}

- Remove best year (${bestYear.year}): PF ${fmt(withoutBest.profitFactor)} EXP ${fmt(withoutBest.expectancyR)}
- Remove 2026: PF ${fmt(without2026.profitFactor)} EXP ${fmt(without2026.expectancyR)}
- Remove 2025+2026: PF ${fmt(withoutRecent.profitFactor)} EXP ${fmt(withoutRecent.expectancyR)}
- First half vs second half: PF ${fmt(firstHalf.profitFactor)} vs ${fmt(secondHalf.profitFactor)}
- Enter on breakout vs fake-filtered: PF ${fmt(allBreakoutMid.profitFactor)} vs ${fmt(historyMid.profitFactor)}

Long-history gate: **passed**.

## Step 4-5 — Bid/ask

| YEAR | N | MID WR | MID PF | MID EXP | EXEC WR | EXEC PF | EXEC EXP | COST R/TRADE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${costLines}
| ALL | ${historyMid.n} | ${pct(historyMid.winRate)} | ${fmt(historyMid.profitFactor)} | ${fmt(historyMid.expectancyR)} | ${pct(exec.winRate)} | ${fmt(exec.profitFactor)} | ${fmt(exec.expectancyR)} | ${fmt(bidAskDrag)} |

- average / median / p95 spread: ${fmt(mean(spreads))} / ${fmt(median(spreads))} / ${fmt(percentile(spreads, 0.95))} pips
- average 1R stop: ${fmt(mean(stopPips))} pips
- spread as % of 1R: ${pct(mean(spreadToStop))}
- midpoint winners -> executable losers: ${winnerFlips}

## Step 6 — Financing

**FINANCING_DATA_UNAVAILABLE**

Hypothetical current-rate drag only: ${fmt(rateDragPerTrade)}R/trade. Not mixed into the headline.

## Classification

**${verdict}**

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
`);
  console.log(JSON.stringify({
    verdict,
    parity: { passed: parity.passed, n: parityMid.n, wr: parityMid.winRate, pf: parityMid.profitFactor },
    midpoint: historyMid, executable: exec, costs: { spreadAsPctOf1R: mean(spreadToStop), drag: bidAskDrag },
    gate, availableFrom, outputDirectory: OUT,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
