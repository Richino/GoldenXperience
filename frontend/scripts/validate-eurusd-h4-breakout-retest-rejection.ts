import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvConfig } from "@next/env";

import type { ResearchCandle } from "../src/lib/oanda/client";

import {
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
} from "./eurusd-h4-breakout-retest-rejection";

const OUT = resolve(process.cwd(), "../api-server/research-v2/eurusd-h4-breakout-retest-rejection-v1-long-history");
const SIBLING_CACHES = [
  resolve(process.cwd(), "../api-server/research-v2/eurusd-h4-breakout-retest-swing-v1-validation/data"),
  resolve(process.cwd(), "../api-server/research-v2/eurusd-h4-bull-trend-breakout-v1-validation/data"),
];
const REQUESTED_FROM = "2018-01-01T00:00:00.000Z";
const PARITY_FROM = "2023-01-01T00:00:00.000Z";
const TO = "2026-09-05T00:00:00.000Z";
const WARMUP_H4 = "2017-07-01T00:00:00.000Z";
const WARMUP_D = "2016-01-01T00:00:00.000Z";
const TV = {
  n: 22,
  winRate: 0.50,
  profitFactor: 2.36,
  averageHoldHours: 41,
  medianHoldHours: 28,
  year: {
    2023: { profitFactor: 1.19 },
    2024: { profitFactor: 1.11 },
    2025: { profitFactor: 5.0 },
    2026: { n: 1 },
  },
} as const;

type ExitReason = "TP" | "SL" | "TIME_EXIT";
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
  timeExit: number;
  tpPct: number | null;
  slPct: number | null;
  timeExitPct: number | null;
  averageHoldingHours: number | null;
  medianHoldingHours: number | null;
  longestLosingStreak: number;
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
    } else {
      current = 0;
    }
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
  const tp = rows.filter((row) => row.exitReason === "TP").length;
  const sl = rows.filter((row) => row.exitReason === "SL").length;
  const timeExit = rows.filter((row) => row.exitReason === "TIME_EXIT").length;
  return {
    n: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? wins.length / rows.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancyR: rows.length ? totalR / rows.length : null,
    totalR,
    maxDrawdownR: maxDrawdownR(rows.map((row) => row.resultR)),
    tp, sl, timeExit,
    tpPct: rows.length ? tp / rows.length : null,
    slPct: rows.length ? sl / rows.length : null,
    timeExitPct: rows.length ? timeExit / rows.length : null,
    averageHoldingHours: mean(holds.map((value) => value / 3_600_000)),
    medianHoldingHours: median(holds.map((value) => value / 3_600_000)),
    longestLosingStreak: longestLosingStreak(rows.map((row) => row.resultR)),
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

async function loadPartialCache(file: string) {
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { candles?: ResearchCandle[] };
    return saved.candles ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function seedSiblingBars(granularity: "H4" | "D") {
  const seen = new Map<string, ResearchCandle>();
  for (const folder of SIBLING_CACHES) {
    try {
      const saved = JSON.parse(await readFile(resolve(folder, `${SYMBOL}-${granularity}-MBA.json`), "utf8")) as { candles?: ResearchCandle[] };
      for (const candle of saved.candles ?? []) seen.set(candle.time, candle);
    } catch {
      // Sibling cache is optional.
    }
  }
  return [...seen.values()];
}

async function fetchFrame(granularity: "H4" | "D", warmup: string) {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const file = resolve(OUT, "data", `${SYMBOL}-${granularity}-MBA.json`);
  const existing = await loadPartialCache(file);
  const sibling = existing.length ? [] : await seedSiblingBars(granularity);
  const seen = new Map([...sibling, ...existing].map((candle) => [candle.time, candle]));
  let rows = [...seen.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const completeEnough = rows.filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(warmup) && Date.parse(candle.time) < Date.parse(TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  if (completeEnough.length && Date.parse(completeEnough[0]!.time) <= Date.parse(warmup) + 7 * 24 * 60 * 60_000) {
    await writeFile(file, JSON.stringify({ warmup, to: TO, candles: completeEnough }));
    return completeEnough;
  }

  let cursor = rows.length
    ? new Date(Math.min(...rows.map((row) => Date.parse(row.time)))).toISOString()
    : TO;
  let stall = 0;
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
      console.error(`${granularity}: fetch stopped at ${cursor}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
    rows = [...seen.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
    console.error(`${granularity}: ${rows.length} completed MBA bars; oldest ${rows[0]?.time}`);
    await writeFile(file, JSON.stringify({ warmup, to: TO, candles: rows.filter((candle) => candle.complete && Date.parse(candle.time) < Date.parse(TO)) }));
    if (Date.parse(earliest) <= Date.parse(warmup)) break;
  }
  const complete = [...seen.values()]
    .filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(warmup) && Date.parse(candle.time) < Date.parse(TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  await writeFile(file, JSON.stringify({ warmup, to: TO, candles: complete }));
  return complete;
}

async function currentOandaLongRate(): Promise<{ longRate: number; shortRate: number; source: string } | null> {
  const accountId = process.env.OANDA_ACCOUNT_ID?.trim();
  const token = process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim();
  if (!accountId || !token) return null;
  const base = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const response = await fetch(`${base}/v3/accounts/${accountId}/instruments?instruments=${SYMBOL}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok) return null;
  const body = await response.json() as {
    instruments?: Array<{ financing?: { longRate?: string; shortRate?: string } }>;
  };
  const longRate = Number(body.instruments?.[0]?.financing?.longRate);
  const shortRate = Number(body.instruments?.[0]?.financing?.shortRate);
  if (!Number.isFinite(longRate) || !Number.isFinite(shortRate)) return null;
  return { longRate, shortRate, source: `${base} current snapshot, not historical` };
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
      holdingMs,
      overnightRolls: rolls.rolls,
      financingDaysCharged: rolls.daysCharged,
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
  const minYear = Math.min(...rows.map((row) => row.year));
  const maxYear = Math.max(...rows.map((row) => row.year));
  const years: number[] = [];
  for (let year = minYear; year <= maxYear; year += 1) years.push(year);
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

function parityAssessment(mid: Metrics, midYears: Record<string, Metrics>) {
  const countClose = Math.abs(mid.n - TV.n) <= 10;
  const wrClose = mid.winRate != null && Math.abs(mid.winRate - TV.winRate) <= 0.15;
  const pfClose = mid.profitFactor != null && Math.abs(mid.profitFactor - TV.profitFactor) <= 1.20;
  const holdClose = mid.averageHoldingHours != null && Math.abs(mid.averageHoldingHours - TV.averageHoldHours) <= 24;
  const passed = mid.n >= 8 && countClose && wrClose && pfClose;
  return {
    passed,
    countClose,
    wrClose,
    pfClose,
    holdClose,
    year2023Pf: midYears[2023]?.profitFactor ?? null,
    year2024Pf: midYears[2024]?.profitFactor ?? null,
    year2025Pf: midYears[2025]?.profitFactor ?? null,
    year2026N: midYears[2026]?.n ?? 0,
    note: passed
      ? "OANDA H4 midpoint 2023-2026 N/WR/PF are close enough to the approximate TradingView headline to continue. Frozen long-only rejection rules were not changed."
      : "Material midpoint mismatch versus the approximate TradingView 2023-2026 headline. Long-history conclusions withheld. Frozen rules were not changed.",
    expected: TV,
  };
}

function longHistoryGate(full: Metrics, years: Record<string, Metrics>, withoutBest: Metrics, without2025: Metrics, blocks: Record<string, Metrics>) {
  const reasons: string[] = [];
  if (full.n < 50) reasons.push(`N ${full.n} < 50`);
  if (full.profitFactor == null || full.profitFactor < 1.20) reasons.push(`PF ${fmt(full.profitFactor)} < 1.20`);
  if (full.expectancyR == null || full.expectancyR <= 0) reasons.push("expectancy is not positive");
  if (without2025.profitFactor == null || without2025.profitFactor <= 1 || (without2025.expectancyR ?? 0) <= 0) {
    reasons.push("edge does not survive without 2025");
  }
  if (withoutBest.profitFactor == null || withoutBest.profitFactor <= 1) reasons.push("removing the single best year leaves PF <= 1");
  const yearSlices = Object.entries(years).filter(([, row]) => row.n >= 4);
  const positiveYears = yearSlices.filter(([, row]) => (row.expectancyR ?? 0) > 0);
  const blockSlices = Object.values(blocks).filter((row) => row.n >= 8);
  const positiveBlocks = blockSlices.filter((row) => (row.expectancyR ?? 0) > 0);
  const yearMajority = yearSlices.length ? positiveYears.length >= Math.ceil(yearSlices.length / 2) : false;
  const blockMajority = blockSlices.length ? positiveBlocks.length >= Math.ceil(blockSlices.length / 2) : false;
  if (!yearMajority && !blockMajority) reasons.push("majority of meaningful yearly/block slices are not positive");
  return {
    passed: reasons.length === 0,
    reasons,
    n: full.n,
    prefer75Plus: full.n >= 75,
    yearSlices: yearSlices.map(([year, row]) => ({ year, n: row.n, exp: row.expectancyR, pf: row.profitFactor })),
    positiveYearCount: positiveYears.length,
    blockSlices: Object.entries(blocks).map(([name, row]) => ({ name, n: row.n, exp: row.expectancyR, pf: row.profitFactor })),
    positiveBlockCount: positiveBlocks.length,
  };
}

function classifyAfterCosts(mid: Metrics, exec: Metrics, withoutBestYearExec: Metrics, without2025Exec: Metrics): Verdict {
  if (exec.expectancyR == null || exec.profitFactor == null || exec.expectancyR <= 0 || exec.profitFactor <= 1) {
    return "FAILS_COSTS";
  }
  const stillStable = (withoutBestYearExec.profitFactor ?? 0) > 1 && (without2025Exec.expectancyR ?? 0) > 0 && exec.profitFactor > 1.15 && exec.expectancyR > 0.08;
  if (stillStable) return "SURVIVES";
  return "MARGINAL";
}

function first20(rows: readonly ClosedTrade[]) {
  return rows.slice(0, 20).map((row) => ({
    signalTimestamp: row.signal.signalTimestamp,
    decisionTime: row.signal.decisionTime,
    breakoutTimestamp: row.signal.breakoutTimestamp,
    direction: row.signal.direction,
    midEntry: row.signal.midEntry,
    atr: row.signal.atr,
    stop: row.signal.midStop,
    target: row.signal.midTarget,
    frozenLevel: row.signal.frozenLevel,
    retestOffset: row.signal.retestOffset,
  }));
}

function tradeRows(rows: readonly ClosedTrade[]) {
  return rows.map((row) => ({
    signalTimestamp: row.signal.signalTimestamp,
    decisionTime: row.signal.decisionTime,
    year: row.year,
    direction: row.signal.direction,
    midEntry: row.signal.midEntry,
    atr: row.signal.atr,
    frozenLevel: row.signal.frozenLevel,
    retestOffset: row.signal.retestOffset,
    breakoutTimestamp: row.signal.breakoutTimestamp,
    midStop: row.signal.midStop,
    midTarget: row.signal.midTarget,
    executableEntry: row.executableEntry,
    executableStop: row.executableStop,
    executableTarget: row.executableTarget,
    spreadPips: row.spreadPips,
    spreadToStop: row.spreadToStop,
    stopPips: row.stopPips,
    midExitTimestamp: row.midpoint.exitTimestamp,
    midExitReason: row.midpoint.exitReason,
    midResultR: row.midpoint.resultR,
    midHoldBars: row.midpoint.holdBars,
    execExitTimestamp: row.executable?.exitTimestamp ?? null,
    execExitReason: row.executable?.exitReason ?? null,
    execResultR: row.executable?.resultR ?? null,
    execHoldBars: row.executable?.holdBars ?? null,
    holdingHours: row.holdingMs / 3_600_000,
    overnightRolls: row.overnightRolls,
    financingDaysCharged: row.financingDaysCharged,
  }));
}

async function writeAudit(extra: Record<string, unknown>) {
  await writeFile(resolve(OUT, "DATA_AUDIT.md"), [
    "# Data audit — eurusd_h4_breakout_retest_rejection_v1",
    "",
    "- Instrument: EUR_USD",
    "- Signal timeframe: OANDA H4 MBA, completed bars only",
    "- Daily regime and breakout level: previous completed OANDA D MBA candle (started daily index minus one)",
    "- Long only. No shorts. No weekly filter. No trailing stop. No profit lock.",
    `- Requested window: ${REQUESTED_FROM} to ${TO} exclusive`,
    `- Warmup request: H4 ${WARMUP_H4}; D ${WARMUP_D}`,
    ...Object.entries(extra).map(([key, value]) => `- ${key}: ${String(value)}`),
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
  console.error("Fetching EUR_USD D MBA warmup...");
  const daily = await fetchFrame("D", WARMUP_D);
  console.error("Fetching EUR_USD H4 MBA history...");
  const h4 = await fetchFrame("H4", WARMUP_H4);
  if (!daily.length || !h4.length) throw new Error("Required OANDA MBA history is missing.");

  const h4From = h4[0]!.time;
  const dailyFrom = daily[0]!.time;
  const availableFrom = new Date(Math.max(Date.parse(REQUESTED_FROM), Date.parse(h4From))).toISOString();
  const reached2018 = Date.parse(h4From) <= Date.parse(REQUESTED_FROM) + 7 * 24 * 60 * 60_000;

  const traced = evaluateTrace(h4, daily);
  if (traced.error) throw new Error(traced.error);
  const allSignals = signalsFromTrace(h4, traced.rows);
  const paritySignals = allSignals.filter((signal) => inRange(signal.signalTimestamp, PARITY_FROM, TO));
  const historySignals = allSignals.filter((signal) => inRange(signal.signalTimestamp, availableFrom, TO));
  const parityClosed = closeTrades(paritySignals, h4);
  const historyClosed = closeTrades(historySignals, h4);
  const parityMid = midMetrics(parityClosed.closed);
  const parityYears = byYear(parityClosed.closed, "mid", [2023, 2024, 2025, 2026]);
  const parity = parityAssessment(parityMid, parityYears);
  const protocol = {
    strategyId: STRATEGY_ID, name: STRATEGY_NAME, version: STRATEGY_VERSION, symbol: SYMBOL, timeframe: TIMEFRAME,
    frozen: true, longOnly: true, shortsAdded: false, productionStrategyModified: false, deployed: false, ordersPlaced: false,
    rules: CONFIG,
    dailyDirection: "previous completed OANDA D candle only",
    breakout: "H4 close through previous completed D1 high; previous H4 close still on the inside; no immediate entry",
    retest: "1 to 3 future H4 bars; reclaim close; close >= level + 0.10 ATR; bullish body >= 0.25 ATR; close in top 30% of range; daily bull and H4 EMA20>EMA50 still true",
    entry: "confirmed retest H4 midpoint close",
    period: {
      requestedFrom: REQUESTED_FROM, availableFrom, toExclusive: TO,
      warmupH4: WARMUP_H4, warmupD: WARMUP_D, h4From, dailyFrom, reached2018,
    },
  };

  const parityFirst20 = first20(parityClosed.closed);
  if (!parity.passed) {
    await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
    await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), protocol, parity, parityWindow: parityMid, parityYears, first20: parityFirst20, verdict: "PARITY_FAILED" }, null, 2)}\n`);
    await writeAudit({
      "H4 bars": h4.length,
      "D bars": daily.length,
      "H4 from": h4From,
      "D from": dailyFrom,
      "Reached 2018": reached2018,
      Verdict: "PARITY_FAILED",
    });
    await writeFile(resolve(OUT, "FINAL_REPORT.md"), [
      "# EUR/USD H4 Breakout Retest Rejection V1 — VALIDATION STOPPED",
      "",
      "2023-2026 midpoint parity versus the approximate TradingView headline failed. Long-history conclusions withheld. Frozen rules were not changed.",
      "",
      `| Window | N | WR | PF | EXP R | Avg hold h | Med hold h |`,
      `|---|---:|---:|---:|---:|---:|---:|`,
      `| TV headline | ${TV.n} | ${pct(TV.winRate)} | ${fmt(TV.profitFactor)} | n/a | ${TV.averageHoldHours} | ${TV.medianHoldHours} |`,
      `| OANDA midpoint | ${parityMid.n} | ${pct(parityMid.winRate)} | ${fmt(parityMid.profitFactor)} | ${fmt(parityMid.expectancyR)} | ${fmt(parityMid.averageHoldingHours)} | ${fmt(parityMid.medianHoldingHours)} |`,
      "",
      [2023, 2024, 2025, 2026].map((year) => `- ${year}: OANDA N ${parityYears[year]!.n} WR ${pct(parityYears[year]!.winRate)} PF ${fmt(parityYears[year]!.profitFactor)}`).join("\n"),
      "",
      "First 20 OANDA entries:",
      "",
      ...parityFirst20.map((row, index) => `${index + 1}. ${row.signalTimestamp} long @ ${row.midEntry.toFixed(5)} frozen ${row.frozenLevel.toFixed(5)} retest+${row.retestOffset}`),
      "",
      "NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.",
      "",
    ].join("\n"));
    console.log(JSON.stringify({ verdict: "PARITY_FAILED", parity, parityWindow: parityMid, outputDirectory: OUT }, null, 2));
    return;
  }

  const historyMid = midMetrics(historyClosed.closed);
  const historyYearsList = yearsCovered(historyClosed.closed);
  const historyYears = byYear(historyClosed.closed, "mid", historyYearsList.length ? historyYearsList : [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  const blocks = {
    "2018-2020": blockMetrics(historyClosed.closed, 2018, 2020),
    "2021-2022": blockMetrics(historyClosed.closed, 2021, 2022),
    "2023-2024": blockMetrics(historyClosed.closed, 2023, 2024),
    "2025-2026": blockMetrics(historyClosed.closed, 2025, 2026),
  };
  const bestYear = historyYearsList.reduce((best, year) => {
    const total = historyYears[year]!.totalR;
    return total > best.totalR ? { year, totalR: total } : best;
  }, { year: historyYearsList[0] ?? 2025, totalR: -Infinity });
  const withoutBest = midMetrics(historyClosed.closed.filter((row) => row.year !== bestYear.year));
  const without2025 = midMetrics(historyClosed.closed.filter((row) => row.year !== 2025));
  const spanYears = (Date.parse(TO) - Date.parse(availableFrom)) / (365.2425 * 24 * 60 * 60_000);
  const gate = longHistoryGate(historyMid, historyYears, withoutBest, without2025, blocks);
  const historyFirst20 = first20(historyClosed.closed);

  const baseArtifact = {
    generatedAt: new Date().toISOString(), protocol, data: { h4: h4.length, daily: daily.length, h4From, h4To: h4.at(-1)?.time, dailyFrom, source: "OANDA practice API MBA", reached2018, availableFrom },
    parity, parityWindow: parityMid, parityYears,
    rawParity: parityClosed.raw, acceptedParity: parityClosed.accepted, skippedParity: parityClosed.skipped,
    rawHistory: historyClosed.raw, acceptedHistory: historyClosed.accepted, skippedHistory: historyClosed.skipped, unresolvedHistory: historyClosed.unresolved,
    midpoint: historyMid, midpointYears: historyYears, blocks, withoutBestYear: { year: bestYear.year, metrics: withoutBest }, without2025,
    gate, frequency: { years: spanYears, tradesPerYear: historyMid.n / spanYears },
    first20Parity: parityFirst20, first20History: historyFirst20,
  };

  if (!gate.passed) {
    await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
    await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({ ...baseArtifact, trades: tradeRows(historyClosed.closed), verdict: "FAILS_LONG_HISTORY" }, null, 2)}\n`);
    await writeFile(resolve(OUT, "TRADES.midpoint.csv"), toCsv(tradeRows(historyClosed.closed).map((row) => ({
      signalTimestamp: row.signalTimestamp, entry: row.midEntry, stop: row.midStop, target: row.midTarget,
      frozenLevel: row.frozenLevel, retestOffset: row.retestOffset, exitTimestamp: row.midExitTimestamp,
      exitReason: row.midExitReason, resultR: row.midResultR, holdBars: row.midHoldBars, year: row.year,
    }))));
    await writeAudit({
      "H4 bars": h4.length, "D bars": daily.length, "H4 from": h4From, "D from": dailyFrom,
      "Reached 2018": reached2018, "Available from": availableFrom,
      "History closed": historyClosed.closed.length, Verdict: "FAILS_LONG_HISTORY",
    });
    const yearLines = Object.entries(historyYears).map(([year, row]) => `| ${year} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} | ${fmt(row.totalR)} | ${fmt(row.maxDrawdownR)} |`).join("\n");
    const blockLines = Object.entries(blocks).map(([name, row]) => `| ${name} | ${row.n} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} | ${fmt(row.totalR)} |`).join("\n");
    await writeFile(resolve(OUT, "FINAL_REPORT.md"), `# EUR/USD H4 Breakout Retest Rejection V1 — LONG-HISTORY VALIDATION

Strategy ID: \`${STRATEGY_ID}\`. Frozen long-only rejection rules. OANDA practice MBA. No production strategy was modified. No orders were placed.

Requested window 2018-01-01 through 2026-09-04. Earliest complete OANDA H4 bar used: ${h4From}. Evaluation from ${availableFrom}.

## Step 1 — 2023-2026 midpoint parity

| Window | N | Wins/Losses | WR | PF | EXP R | Total R | TP/SL/TIME | Avg hold h | Med hold h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TV headline | ${TV.n} | n/a | ${pct(TV.winRate)} | ${fmt(TV.profitFactor)} | n/a | n/a | n/a | ${TV.averageHoldHours} | ${TV.medianHoldHours} |
| OANDA midpoint | ${parityMid.n} | ${parityMid.wins}/${parityMid.losses} | ${pct(parityMid.winRate)} | ${fmt(parityMid.profitFactor)} | ${fmt(parityMid.expectancyR)} | ${fmt(parityMid.totalR)} | ${parityMid.tp}/${parityMid.sl}/${parityMid.timeExit} | ${fmt(parityMid.averageHoldingHours)} | ${fmt(parityMid.medianHoldingHours)} |

Parity gate: **passed**. ${parity.note}

First 20 2023-2026 entries:

${parityFirst20.map((row, index) => `${index + 1}. ${row.signalTimestamp} long @ ${row.midEntry.toFixed(5)} ATR ${row.atr.toFixed(5)} frozen ${row.frozenLevel.toFixed(5)} retest+${row.retestOffset}`).join("\n")}

## Step 2 — Full available-history midpoint

Raw setups ${historyClosed.raw}; skipped while open ${historyClosed.skipped}; closed ${historyClosed.closed.length}; unresolved ${historyClosed.unresolved}.

| YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R |
|---|---:|---:|---:|---:|---:|---:|
${yearLines}
| ALL | ${historyMid.n} | ${pct(historyMid.winRate)} | ${fmt(historyMid.profitFactor)} | ${fmt(historyMid.expectancyR)} | ${fmt(historyMid.totalR)} | ${fmt(historyMid.maxDrawdownR)} |

| BLOCK | N | PF | EXP R | TOTAL R |
|---|---:|---:|---:|---:|
${blockLines}

- TP %: ${pct(historyMid.tpPct)}
- SL %: ${pct(historyMid.slPct)}
- TIME_EXIT %: ${pct(historyMid.timeExitPct)}
- average / median hold: ${fmt(historyMid.averageHoldingHours)} / ${fmt(historyMid.medianHoldingHours)} hours
- trades/year: ${fmt(historyMid.n / spanYears, 1)}
- longest losing streak: ${historyMid.longestLosingStreak}
- without 2025: N ${without2025.n} PF ${fmt(without2025.profitFactor)} EXP ${fmt(without2025.expectancyR)}
- without best year (${bestYear.year}): N ${withoutBest.n} PF ${fmt(withoutBest.profitFactor)} EXP ${fmt(withoutBest.expectancyR)}

## Long-history gate

**FAILS_LONG_HISTORY**

${gate.reasons.map((reason) => `- ${reason}`).join("\n")}

Bid/ask execution was not run. Financing was not estimated into a headline. Frozen rules were not changed to rescue the result.

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
`);
    console.log(JSON.stringify({ verdict: "FAILS_LONG_HISTORY", parity: { passed: parity.passed, n: parityMid.n, pf: parityMid.profitFactor }, midpoint: historyMid, gate, availableFrom, outputDirectory: OUT }, null, 2));
    return;
  }

  const executableReady = historyClosed.closed.filter((row) => row.executable);
  if (executableReady.length !== historyClosed.closed.length) {
    throw new Error(`Fail closed: ${historyClosed.closed.length - executableReady.length} midpoint trades missing executable MBA resolution.`);
  }
  const exec = execMetrics(historyClosed.closed);
  const execYears = byYear(historyClosed.closed, "exec", historyYearsList);
  const withoutBestExec = execMetrics(historyClosed.closed.filter((row) => row.year !== bestYear.year));
  const without2025Exec = execMetrics(historyClosed.closed.filter((row) => row.year !== 2025));
  const verdict = classifyAfterCosts(historyMid, exec, withoutBestExec, without2025Exec);
  const spreads = historyClosed.closed.map((row) => row.spreadPips);
  const spreadToStop = historyClosed.closed.map((row) => row.spreadToStop);
  const stopPips = historyClosed.closed.map((row) => row.stopPips);
  const winnerFlips = historyClosed.closed.filter((row) => row.midpoint.resultR > 0 && (row.executable?.resultR ?? 0) <= 0).length;
  const bidAskDrag = historyMid.expectancyR != null && exec.expectancyR != null ? historyMid.expectancyR - exec.expectancyR : null;
  const currentRate = await currentOandaLongRate();
  const rateDragPerTrade = currentRate
    ? mean(historyClosed.closed.map((row) => {
      const risk = CONFIG.stopAtr * row.signal.atr;
      return -(row.executableEntry * currentRate.longRate * row.financingDaysCharged / 365) / risk;
    }))
    : null;
  const conservativePipDragPerTrade = mean(historyClosed.closed.map((row) => (2 * PIP * row.financingDaysCharged) / (CONFIG.stopAtr * row.signal.atr)));
  const yearRows = historyYearsList.map((year) => {
    const midYear = historyYears[year]!;
    const execYear = execYears[year]!;
    const cost = midYear.expectancyR != null && execYear.expectancyR != null ? midYear.expectancyR - execYear.expectancyR : null;
    return {
      YEAR: year, N: midYear.n, MID_PF: round(midYear.profitFactor, 3), MID_EXP: round(midYear.expectancyR, 3),
      EXEC_WR: round(execYear.winRate, 4), EXEC_PF: round(execYear.profitFactor, 3), EXEC_EXP: round(execYear.expectancyR, 3), COST_R_TRADE: round(cost, 3),
    };
  });
  const trades = tradeRows(historyClosed.closed);
  await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
  await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({
    ...baseArtifact, executable: exec, executableYears: execYears, yearRows,
    financing: {
      historical: "FINANCING_DATA_UNAVAILABLE",
      authoritativeResult: "bid_ask_only",
      currentOandaSnapshot: currentRate,
      hypotheticalCurrentRateDragR: rateDragPerTrade,
      hypotheticalConservativeTwoPipsPerChargedDayDragR: conservativePipDragPerTrade,
    },
    costs: {
      averageSpreadPips: mean(spreads), medianSpreadPips: median(spreads), p95SpreadPips: percentile(spreads, 0.95),
      averageStopPips: mean(stopPips), spreadAsPctOf1R: mean(spreadToStop),
      midpointWinnersToExecutableLosers: winnerFlips, costDragR: bidAskDrag,
      executableTotalR: exec.totalR, executableMaxDrawdownR: exec.maxDrawdownR,
      executableTradesPerYear: exec.n / spanYears,
    },
    trades, verdict,
  }, null, 2)}\n`);
  await writeFile(resolve(OUT, "TRADES.midpoint.csv"), toCsv(trades.map((row) => ({
    signalTimestamp: row.signalTimestamp, entry: row.midEntry, stop: row.midStop, target: row.midTarget,
    frozenLevel: row.frozenLevel, exitTimestamp: row.midExitTimestamp, exitReason: row.midExitReason, resultR: row.midResultR, year: row.year,
  }))));
  await writeFile(resolve(OUT, "TRADES.executable.csv"), toCsv(trades.map((row) => ({
    signalTimestamp: row.signalTimestamp, entry: row.executableEntry, stop: row.executableStop, target: row.executableTarget,
    spreadPips: row.spreadPips, exitTimestamp: row.execExitTimestamp, exitReason: row.execExitReason, resultR: row.execResultR, year: row.year,
  }))));
  await writeAudit({
    "H4 bars": h4.length, "D bars": daily.length, "H4 from": h4From, "D from": dailyFrom,
    "Reached 2018": reached2018, "Available from": availableFrom,
    "History closed": historyClosed.closed.length, "Missing executable": historyClosed.missingExecutable, Verdict: verdict,
  });
  const yearLines = Object.entries(historyYears).map(([year, row]) => `| ${year} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} | ${fmt(row.totalR)} | ${fmt(row.maxDrawdownR)} |`).join("\n");
  const blockLines = Object.entries(blocks).map(([name, row]) => `| ${name} | ${row.n} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} | ${fmt(row.totalR)} |`).join("\n");
  const costLines = yearRows.map((row) => `| ${row.YEAR} | ${row.N} | ${fmt(row.MID_PF)} | ${fmt(row.MID_EXP)} | ${pct(row.EXEC_WR)} | ${fmt(row.EXEC_PF)} | ${fmt(row.EXEC_EXP)} | ${fmt(row.COST_R_TRADE)} |`).join("\n");
  await writeFile(resolve(OUT, "FINAL_REPORT.md"), `# EUR/USD H4 Breakout Retest Rejection V1 — LONG-HISTORY VALIDATION

Strategy ID: \`${STRATEGY_ID}\`. Frozen long-only rejection rules. OANDA practice MBA. No production strategy was modified. No orders were placed.

Requested window 2018-01-01 through 2026-09-04. Earliest complete OANDA H4 bar used: ${h4From}. Evaluation from ${availableFrom}.

## Step 1 — 2023-2026 midpoint parity

| Window | N | Wins/Losses | WR | PF | EXP R | Total R | TP/SL/TIME | Avg hold h | Med hold h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TV headline | ${TV.n} | n/a | ${pct(TV.winRate)} | ${fmt(TV.profitFactor)} | n/a | n/a | n/a | ${TV.averageHoldHours} | ${TV.medianHoldHours} |
| OANDA midpoint | ${parityMid.n} | ${parityMid.wins}/${parityMid.losses} | ${pct(parityMid.winRate)} | ${fmt(parityMid.profitFactor)} | ${fmt(parityMid.expectancyR)} | ${fmt(parityMid.totalR)} | ${parityMid.tp}/${parityMid.sl}/${parityMid.timeExit} | ${fmt(parityMid.averageHoldingHours)} | ${fmt(parityMid.medianHoldingHours)} |

Parity gate: **passed**. ${parity.note}

First 20 2023-2026 entries:

${parityFirst20.map((row, index) => `${index + 1}. ${row.signalTimestamp} long @ ${row.midEntry.toFixed(5)} ATR ${row.atr.toFixed(5)} frozen ${row.frozenLevel.toFixed(5)} retest+${row.retestOffset}`).join("\n")}

## Step 2 — Full available-history midpoint

Raw setups ${historyClosed.raw}; skipped while open ${historyClosed.skipped}; closed ${historyClosed.closed.length}; unresolved ${historyClosed.unresolved}.

| YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R |
|---|---:|---:|---:|---:|---:|---:|
${yearLines}
| ALL | ${historyMid.n} | ${pct(historyMid.winRate)} | ${fmt(historyMid.profitFactor)} | ${fmt(historyMid.expectancyR)} | ${fmt(historyMid.totalR)} | ${fmt(historyMid.maxDrawdownR)} |

| BLOCK | N | PF | EXP R | TOTAL R |
|---|---:|---:|---:|---:|
${blockLines}

- TP %: ${pct(historyMid.tpPct)}
- SL %: ${pct(historyMid.slPct)}
- TIME_EXIT %: ${pct(historyMid.timeExitPct)}
- average / median hold: ${fmt(historyMid.averageHoldingHours)} / ${fmt(historyMid.medianHoldingHours)} hours
- trades/year: ${fmt(historyMid.n / spanYears, 1)}
- longest losing streak: ${historyMid.longestLosingStreak}
- without 2025: N ${without2025.n} PF ${fmt(without2025.profitFactor)} EXP ${fmt(without2025.expectancyR)}
- without best year (${bestYear.year}): N ${withoutBest.n} PF ${fmt(withoutBest.profitFactor)} EXP ${fmt(withoutBest.expectancyR)}

Long-history gate: **passed**.

## Step 3-4 — Bid/ask execution

| YEAR | N | MID PF | MID EXP | EXEC WR | EXEC PF | EXEC EXP | COST R/TRADE |
|---|---:|---:|---:|---:|---:|---:|---:|
${costLines}
| ALL | ${historyMid.n} | ${fmt(historyMid.profitFactor)} | ${fmt(historyMid.expectancyR)} | ${pct(exec.winRate)} | ${fmt(exec.profitFactor)} | ${fmt(exec.expectancyR)} | ${fmt(bidAskDrag)} |

- average / median / p95 spread: ${fmt(mean(spreads))} / ${fmt(median(spreads))} / ${fmt(percentile(spreads, 0.95))} pips
- average 1R stop: ${fmt(mean(stopPips))} pips
- spread as % of 1R: ${pct(mean(spreadToStop))}
- midpoint winners -> executable losers: ${winnerFlips}
- cost drag: ${fmt(bidAskDrag)}R/trade
- executable total R: ${fmt(exec.totalR)}
- executable max DD: ${fmt(exec.maxDrawdownR)}R
- executable trades/year: ${fmt(exec.n / spanYears, 1)}

## Step 5 — Financing

**FINANCING_DATA_UNAVAILABLE**

Hypothetical sensitivity, not mixed into the headline:

- Current OANDA snapshot: ${currentRate ? `longRate ${(currentRate.longRate * 100).toFixed(4)}% annual (${currentRate.source})` : "unavailable"}
- Hypothetical current-rate drag: ${fmt(rateDragPerTrade)}R/trade
- Hypothetical conservative 2 pips per charged day: ${fmt(conservativePipDragPerTrade)}R/trade

## Classification

**${verdict}**

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
`);
  console.log(JSON.stringify({
    verdict, parity: { passed: parity.passed, n: parityMid.n, wr: parityMid.winRate, pf: parityMid.profitFactor },
    midpoint: historyMid, executable: exec, gate, availableFrom, outputDirectory: OUT,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
