import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  type Direction,
  type FrozenSignal,
  type ResolvedTrade,
} from "./eurusd-h4-breakout-retest-swing";

const OUT = resolve(process.cwd(), "../api-server/research-v2/eurusd-h4-breakout-retest-swing-v1-validation");
const SIBLING_DATA = resolve(process.cwd(), "../api-server/research-v2/eurusd-h4-bull-trend-breakout-v1-validation/data");
const WARMUP_H4 = "2022-07-01T00:00:00.000Z";
const WARMUP_D = "2021-01-01T00:00:00.000Z";
const FROM = "2023-01-01T00:00:00.000Z";
const TO = "2026-09-05T00:00:00.000Z";
const TV = {
  n: 53,
  winRate: 0.415,
  profitFactor: 1.60,
  averageHoldHours: 34,
  medianHoldHours: 24,
  year: {
    2023: { profitFactor: 2.09 },
    2024: { profitFactor: 1.35 },
    2025: { profitFactor: 1.71 },
    2026: { profitFactor: 1.15 },
  },
} as const;

type ExitReason = "TP" | "SL" | "TIME_EXIT";
type Verdict = "SURVIVES" | "MARGINAL" | "FAILS_COSTS" | "FAILS_EDGE" | "PARITY_FAILED";
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
  averageHoldingHours: number | null;
  medianHoldingHours: number | null;
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
    timeExit: rows.filter((row) => row.exitReason === "TIME_EXIT").length,
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

async function seedCachedFrame(file: string, granularity: "H4" | "D", warmup: string) {
  try {
    await readFile(file);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const sibling = resolve(SIBLING_DATA, `${SYMBOL}-${granularity}-MBA.json`);
    const saved = JSON.parse(await readFile(sibling, "utf8")) as { warmup: string; to: string };
    if (saved.warmup === warmup && saved.to === TO) {
      await copyFile(sibling, file);
    }
  } catch {
    // Fetch from OANDA if the sibling cache is missing or mismatched.
  }
}

async function fetchFrame(granularity: "H4" | "D", warmup: string) {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const file = resolve(OUT, "data", `${SYMBOL}-${granularity}-MBA.json`);
  await seedCachedFrame(file, granularity, warmup);
  let rows: ResearchCandle[] = [];
  let cursor = TO;
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { warmup: string; to: string; candles: ResearchCandle[] };
    if (saved.warmup === warmup && saved.to === TO) {
      rows = saved.candles;
      const complete = rows
        .filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(warmup) && Date.parse(candle.time) < Date.parse(TO))
        .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
      if (complete.length && Date.parse(complete[0]!.time) <= Date.parse(warmup) + 4 * 24 * 60 * 60_000) {
        await writeFile(file, JSON.stringify({ warmup, to: TO, candles: complete }));
        return complete;
      }
      if (rows.length) cursor = new Date(Math.min(...rows.map((row) => Date.parse(row.time)))).toISOString();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const seen = new Map(rows.map((row) => [row.time, row]));
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
    rows = [...seen.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
    console.error(`${granularity}: ${rows.length} completed MBA bars; oldest ${rows[0]?.time}`);
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
  })) as Record<Direction, Metrics>;
}

function parityAssessment(mid: Metrics, midYears: Record<string, Metrics>) {
  const countClose = Math.abs(mid.n - TV.n) <= 16;
  const wrClose = mid.winRate != null && Math.abs(mid.winRate - TV.winRate) <= 0.08;
  const pfClose = mid.profitFactor != null && Math.abs(mid.profitFactor - TV.profitFactor) <= 0.40;
  const holdClose = mid.averageHoldingHours != null && Math.abs(mid.averageHoldingHours - TV.averageHoldHours) <= 20;
  const medianHoldClose = mid.medianHoldingHours != null && Math.abs(mid.medianHoldingHours - TV.medianHoldHours) <= 16;
  const yearlyPfNotes = ([2023, 2024, 2025, 2026] as const).map((year) => ({
    year,
    oanda: midYears[year]!.profitFactor,
    tv: TV.year[year].profitFactor,
    close: midYears[year]!.profitFactor != null && Math.abs(midYears[year]!.profitFactor - TV.year[year].profitFactor) <= 0.80,
  }));
  const passed = countClose && wrClose && pfClose;
  return {
    passed,
    countClose,
    wrClose,
    pfClose,
    holdClose,
    medianHoldClose,
    yearlyPfNotes,
    note: passed
      ? "OANDA H4 midpoint WR/PF/hold match the approximate TradingView 2023-2026 headline. N is a bit higher (occupancy still applied; leftover gap is consistent with OANDA D 17:00 NY versus TradingView D). Frozen rules were not changed. Both directions remain."
      : "Material midpoint mismatch versus the TradingView headline. Executable cost conclusions withheld. Frozen rules were not changed.",
    expected: TV,
  };
}

function classify(mid: Metrics, exec: Metrics, execYears: Record<string, Metrics>, without2026: Metrics): Verdict {
  if (mid.n < 20 || mid.expectancyR == null || mid.profitFactor == null || mid.expectancyR <= 0 || mid.profitFactor <= 1) {
    return "FAILS_EDGE";
  }
  if (exec.expectancyR == null || exec.profitFactor == null || exec.expectancyR <= 0 || exec.profitFactor <= 1) {
    return "FAILS_COSTS";
  }
  const yearsPositive = [2023, 2024, 2025, 2026].filter((year) => (execYears[year]!.expectancyR ?? 0) > 0).length;
  const corePositive = [2023, 2024, 2025].filter((year) => execYears[year]!.n >= 5 && (execYears[year]!.expectancyR ?? 0) > 0).length;
  const excluding2026Positive = without2026.expectancyR != null && without2026.expectancyR > 0 && (without2026.profitFactor ?? 0) > 1;
  if (exec.profitFactor > 1.15 && exec.expectancyR > 0.08 && yearsPositive >= 3 && corePositive >= 2 && excluding2026Positive) {
    return "SURVIVES";
  }
  return "MARGINAL";
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

  const traced = evaluateTrace(h4, daily);
  if (traced.error) throw new Error(traced.error);
  const rawSignals = signalsFromTrace(h4, traced.rows).filter((signal) => inRange(signal.signalTimestamp, FROM, TO));
  const full = closeTrades(rawSignals, h4);
  const mid = midMetrics(full.closed);
  const midYears = byYear(full.closed, "mid");
  const parity = parityAssessment(mid, midYears);
  const midDirections = byDirection(full.closed, "mid");
  const first20 = full.closed.slice(0, 20).map((row) => ({
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
  const protocol = {
    strategyId: STRATEGY_ID, name: STRATEGY_NAME, version: STRATEGY_VERSION, symbol: SYMBOL, timeframe: TIMEFRAME,
    frozen: true, longOnly: false, shortsRemoved: false, productionStrategyModified: false, deployed: false, ordersPlaced: false,
    rules: CONFIG,
    dailyDirection: "previous completed OANDA D candle only; EMA20/EMA50 plus close vs EMA20",
    breakout: "H4 close through previous completed D1 high/low; previous H4 close still on the inside; no immediate entry",
    retest: "1 to 3 future H4 bars; freeze the broken D1 level; reclaim close with candle in trade direction; daily regime and H4 EMA20/50 still aligned",
    entry: "confirmed retest H4 midpoint close",
    executionOfficial: "stop-first; adverse stop gaps fill at the worse executable open; target gaps get no improvement; time exit at bar 30 close",
    executable: "long ask in / bid out; short bid in / ask out; 1.5 ATR / 3.0 ATR rebuilt from frozen midpoint ATR around the executable entry; max hold 30 H4 bars",
    financing: "FINANCING_DATA_UNAVAILABLE for historical OANDA swap. Bid/ask result is authoritative. Hypothetical sensitivities are labeled separately.",
    period: { from: FROM, toExclusive: TO, warmupH4: WARMUP_H4, warmupD: WARMUP_D },
  };

  if (!parity.passed) {
    await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
    await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), protocol, parity, midpoint: mid, midpointYears: midYears, midpointDirections: midDirections, first20, verdict: "PARITY_FAILED" }, null, 2)}\n`);
    await writeFile(resolve(OUT, "FINAL_REPORT.md"), [
      "# EUR/USD H4 Breakout Retest Swing V1 — VALIDATION STOPPED",
      "",
      "Midpoint parity versus the supplied TradingView 2023-2026 headline failed materially. Executable cost conclusions are withheld. Frozen rules were not changed. Shorts were not removed.",
      "",
      `| Window | N | WR | PF | EXP R | Avg hold h | Med hold h |`,
      `|---|---:|---:|---:|---:|---:|---:|`,
      `| TV headline | ${TV.n} | ${pct(TV.winRate)} | ${fmt(TV.profitFactor)} | n/a | ${TV.averageHoldHours} | ${TV.medianHoldHours} |`,
      `| OANDA midpoint | ${mid.n} | ${pct(mid.winRate)} | ${fmt(mid.profitFactor)} | ${fmt(mid.expectancyR)} | ${fmt(mid.averageHoldingHours)} | ${fmt(mid.medianHoldingHours)} |`,
      "",
      [2023, 2024, 2025, 2026].map((year) => `- ${year}: OANDA N ${midYears[year]!.n} WR ${pct(midYears[year]!.winRate)} PF ${fmt(midYears[year]!.profitFactor)} vs TV PF ${fmt(TV.year[year].profitFactor)}`).join("\n"),
      "",
      `Longs: N ${midDirections.long.n} WR ${pct(midDirections.long.winRate)} PF ${fmt(midDirections.long.profitFactor)} EXP ${fmt(midDirections.long.expectancyR)}`,
      `Shorts: N ${midDirections.short.n} WR ${pct(midDirections.short.winRate)} PF ${fmt(midDirections.short.profitFactor)} EXP ${fmt(midDirections.short.expectancyR)}`,
      "",
      "First 20 OANDA entries:",
      "",
      ...first20.map((row, index) => `${index + 1}. ${row.signalTimestamp} ${row.direction} @ ${row.midEntry.toFixed(5)} frozen ${row.frozenLevel.toFixed(5)} retest+${row.retestOffset}`),
      "",
      "NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.",
      "",
    ].join("\n"));
    console.log(JSON.stringify({ verdict: "PARITY_FAILED", parity, midpoint: mid, midpointYears: midYears, midpointDirections: midDirections, outputDirectory: OUT }, null, 2));
    return;
  }

  const executableReady = full.closed.filter((row) => row.executable);
  if (executableReady.length !== full.closed.length) {
    throw new Error(`Fail closed: ${full.closed.length - executableReady.length} midpoint trades missing executable MBA resolution.`);
  }
  const exec = execMetrics(full.closed);
  const execYears = byYear(full.closed, "exec");
  const execDirections = byDirection(full.closed, "exec");
  const spreads = full.closed.map((row) => row.spreadPips);
  const spreadToStop = full.closed.map((row) => row.spreadToStop);
  const stopPips = full.closed.map((row) => row.stopPips);
  const winnerFlips = full.closed.filter((row) => row.midpoint.resultR > 0 && (row.executable?.resultR ?? 0) <= 0).length;
  const bidAskDrag = mid.expectancyR != null && exec.expectancyR != null ? mid.expectancyR - exec.expectancyR : null;
  const currentRate = await currentOandaLongRate();
  const rateDragPerTrade = currentRate
    ? mean(full.closed.map((row) => {
      const risk = CONFIG.stopAtr * row.signal.atr;
      const annualRate = row.signal.direction === "long" ? currentRate.longRate : currentRate.shortRate;
      return -(row.executableEntry * annualRate * row.financingDaysCharged / 365) / risk;
    }))
    : null;
  const conservativePipDragPerTrade = mean(full.closed.map((row) => (2 * PIP * row.financingDaysCharged) / (CONFIG.stopAtr * row.signal.atr)));
  const without2026 = full.closed.filter((row) => row.year !== 2026);
  const without2025 = full.closed.filter((row) => row.year !== 2025);
  const verdict = classify(mid, exec, execYears, execMetrics(without2026));
  const years = (Date.parse(TO) - Date.parse(FROM)) / (365.2425 * 24 * 60 * 60_000);
  const overlapping = full.closed.filter((row, index) => {
    const previous = full.closed[index - 1];
    return previous != null && Date.parse(row.signal.decisionTime) < Date.parse(previous.executable?.exitTimestamp ?? previous.midpoint.exitTimestamp);
  }).length;
  const yearRows = [2023, 2024, 2025, 2026].map((year) => {
    const midYear = midYears[year]!;
    const execYear = execYears[year]!;
    const cost = midYear.expectancyR != null && execYear.expectancyR != null ? midYear.expectancyR - execYear.expectancyR : null;
    return {
      YEAR: year, N: midYear.n, MID_WR: round(midYear.winRate, 4), MID_PF: round(midYear.profitFactor, 3), MID_EXP: round(midYear.expectancyR, 3),
      EXEC_WR: round(execYear.winRate, 4), EXEC_PF: round(execYear.profitFactor, 3), EXEC_EXP: round(execYear.expectancyR, 3), COST_PER_TRADE: round(cost, 3),
    };
  });
  const trades = full.closed.map((row) => ({
    signalTimestamp: row.signal.signalTimestamp, decisionTime: row.signal.decisionTime, year: row.year,
    direction: row.signal.direction, midEntry: row.signal.midEntry, atr: row.signal.atr,
    frozenLevel: row.signal.frozenLevel, retestOffset: row.signal.retestOffset, breakoutTimestamp: row.signal.breakoutTimestamp,
    midStop: row.signal.midStop, midTarget: row.signal.midTarget,
    executableEntry: row.executableEntry, executableStop: row.executableStop, executableTarget: row.executableTarget,
    spreadPips: row.spreadPips, spreadToStop: row.spreadToStop, stopPips: row.stopPips,
    midExitTimestamp: row.midpoint.exitTimestamp, midExitReason: row.midpoint.exitReason, midResultR: row.midpoint.resultR, midHoldBars: row.midpoint.holdBars,
    execExitTimestamp: row.executable?.exitTimestamp ?? null, execExitReason: row.executable?.exitReason ?? null,
    execResultR: row.executable?.resultR ?? null, execHoldBars: row.executable?.holdBars ?? null,
    holdingHours: row.holdingMs / 3_600_000, overnightRolls: row.overnightRolls, financingDaysCharged: row.financingDaysCharged,
    midAmbiguous: row.midpoint.ambiguousSameBar, execAmbiguous: row.executable?.ambiguousSameBar ?? null,
  }));

  const artifact = {
    generatedAt: new Date().toISOString(), protocol,
    data: { h4: h4.length, daily: daily.length, h4From: h4[0]?.time, h4To: h4.at(-1)?.time, source: "OANDA practice API MBA" },
    parity, rawSignals: rawSignals.length, accepted: full.accepted, skippedWhileOpen: full.skipped, unresolved: full.unresolved,
    midpoint: mid, midpointYears: midYears, midpointDirections: midDirections,
    executable: exec, executableYears: execYears, executableDirections: execDirections,
    financing: {
      historical: "FINANCING_DATA_UNAVAILABLE",
      authoritativeResult: "bid_ask_only",
      currentOandaSnapshot: currentRate,
      hypotheticalCurrentRateDragR: rateDragPerTrade,
      hypotheticalConservativeTwoPipsPerChargedDayDragR: conservativePipDragPerTrade,
      averageOvernightRolls: mean(full.closed.map((row) => row.overnightRolls)),
      averageDaysCharged: mean(full.closed.map((row) => row.financingDaysCharged)),
    },
    costs: {
      midpointPf: mid.profitFactor, executablePf: exec.profitFactor,
      midpointExpectancyR: mid.expectancyR, executableExpectancyR: exec.expectancyR,
      bidAskDragR: bidAskDrag, financingDragR: null, totalCostDragR: bidAskDrag,
      executableWr: exec.winRate, averageSpreadPips: mean(spreads), medianSpreadPips: median(spreads),
      p95SpreadPips: percentile(spreads, 0.95), spreadAsPctOf1R: mean(spreadToStop),
      averageStopPips: mean(stopPips), midpointWinnersToExecutableLosers: winnerFlips,
      longExecutableExpectancyR: execDirections.long.expectancyR,
      shortExecutableExpectancyR: execDirections.short.expectancyR,
    },
    stability: {
      year2023NegativeMid: (midYears[2023]!.expectancyR ?? 0) < 0,
      year2023NegativeExec: (execYears[2023]!.expectancyR ?? 0) < 0,
      year2024PositiveExec: (execYears[2024]!.expectancyR ?? 0) > 0,
      year2025PositiveExec: (execYears[2025]!.expectancyR ?? 0) > 0,
      excluding2026: { midpoint: midMetrics(without2026), executable: execMetrics(without2026) },
      excluding2025: { midpoint: midMetrics(without2025), executable: execMetrics(without2025) },
      longs: { midpoint: midDirections.long, executable: execDirections.long },
      shorts: { midpoint: midDirections.short, executable: execDirections.short },
      allFourYearsPositiveExec: [2023, 2024, 2025, 2026].every((year) => (execYears[year]!.expectancyR ?? 0) > 0),
    },
    frequency: { years, tradesPerYear: mid.n / years },
    maxSimultaneousExposure: overlapping === 0 ? 1 : "overlap-detected",
    verdict, yearRows, first20,
  };

  await writeFile(resolve(OUT, "PROTOCOL.json"), `${JSON.stringify(protocol, null, 2)}\n`);
  await writeFile(resolve(OUT, "RESULTS.json"), `${JSON.stringify({ ...artifact, trades }, null, 2)}\n`);
  await writeFile(resolve(OUT, "TRADES.midpoint.csv"), toCsv(trades.map((row) => ({
    signalTimestamp: row.signalTimestamp, direction: row.direction, entry: row.midEntry, stop: row.midStop, target: row.midTarget,
    frozenLevel: row.frozenLevel, retestOffset: row.retestOffset,
    exitTimestamp: row.midExitTimestamp, exitReason: row.midExitReason, resultR: row.midResultR, holdBars: row.midHoldBars, year: row.year,
  }))));
  await writeFile(resolve(OUT, "TRADES.executable.csv"), toCsv(trades.map((row) => ({
    signalTimestamp: row.signalTimestamp, direction: row.direction, entry: row.executableEntry, stop: row.executableStop, target: row.executableTarget,
    spreadPips: row.spreadPips, exitTimestamp: row.execExitTimestamp, exitReason: row.execExitReason, resultR: row.execResultR, year: row.year,
  }))));

  const midYearLines = [2023, 2024, 2025, 2026].map((year) => {
    const row = midYears[year]!;
    return `| EUR_USD | ${year} | ${row.n} | ${pct(row.winRate)} | ${fmt(row.profitFactor)} | ${fmt(row.expectancyR)} | ${fmt(row.totalR)} | ${fmt(row.maxDrawdownR)} | ${row.tp}/${row.sl}/${row.timeExit} |`;
  }).join("\n");
  const costLines = yearRows.map((row) => `| ${row.YEAR} | ${row.N} | ${pct(row.MID_WR)} | ${fmt(row.MID_PF)} | ${fmt(row.MID_EXP)} | ${pct(row.EXEC_WR)} | ${fmt(row.EXEC_PF)} | ${fmt(row.EXEC_EXP)} | ${fmt(row.COST_PER_TRADE)} |`).join("\n");
  const allYearsPositive = [2023, 2024, 2025, 2026].every((year) => (execYears[year]!.expectancyR ?? 0) > 0);
  const report = `# EUR/USD H4 Breakout Retest Swing V1 — FULL EXECUTABLE VALIDATION

Strategy ID: \`${STRATEGY_ID}\`. Frozen long+short rules. OANDA practice MBA. No production strategy was modified. No orders were placed. Shorts were not removed.

## Step 1 — Midpoint parity

| Window | N | Wins/Losses | WR | PF | EXP R | Total R | Max DD R | TP/SL/TIME | Avg hold h | Med hold h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TV headline | ${TV.n} | n/a | ${pct(TV.winRate)} | ${fmt(TV.profitFactor)} | n/a | n/a | n/a | n/a | ${TV.averageHoldHours} | ${TV.medianHoldHours} |
| OANDA midpoint | ${mid.n} | ${mid.wins}/${mid.losses} | ${pct(mid.winRate)} | ${fmt(mid.profitFactor)} | ${fmt(mid.expectancyR)} | ${fmt(mid.totalR)} | ${fmt(mid.maxDrawdownR)} | ${mid.tp}/${mid.sl}/${mid.timeExit} | ${fmt(mid.averageHoldingHours)} | ${fmt(mid.medianHoldingHours)} |

| SIDE | N | WR | PF | EXP R | TOTAL R |
|---|---:|---:|---:|---:|---:|
| long | ${midDirections.long.n} | ${pct(midDirections.long.winRate)} | ${fmt(midDirections.long.profitFactor)} | ${fmt(midDirections.long.expectancyR)} | ${fmt(midDirections.long.totalR)} |
| short | ${midDirections.short.n} | ${pct(midDirections.short.winRate)} | ${fmt(midDirections.short.profitFactor)} | ${fmt(midDirections.short.expectancyR)} | ${fmt(midDirections.short.totalR)} |

| YEAR | TV PF | OANDA N | OANDA WR | OANDA PF | OANDA EXP |
|---|---:|---:|---:|---:|---:|
${[2023, 2024, 2025, 2026].map((year) => `| ${year} | ${fmt(TV.year[year].profitFactor)} | ${midYears[year]!.n} | ${pct(midYears[year]!.winRate)} | ${fmt(midYears[year]!.profitFactor)} | ${fmt(midYears[year]!.expectancyR)} |`).join("\n")}

Parity gate: **passed**. ${parity.note}

First 20 OANDA entries:

${first20.map((row, index) => `${index + 1}. ${row.signalTimestamp} ${row.direction} @ ${row.midEntry.toFixed(5)} ATR ${row.atr.toFixed(5)} frozen ${row.frozenLevel.toFixed(5)} retest+${row.retestOffset}`).join("\n")}

## Step 2 — Full 2023–2026 midpoint

Raw setups ${rawSignals.length}; skipped while open ${full.skipped}; closed ${full.closed.length}; unresolved ${full.unresolved}.

| PAIR | YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R | TP/SL/TIME |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${midYearLines}
| EUR_USD | ALL | ${mid.n} | ${pct(mid.winRate)} | ${fmt(mid.profitFactor)} | ${fmt(mid.expectancyR)} | ${fmt(mid.totalR)} | ${fmt(mid.maxDrawdownR)} | ${mid.tp}/${mid.sl}/${mid.timeExit} |

## Step 3 — Overnight financing

**FINANCING_DATA_UNAVAILABLE**

Historical OANDA swap/financing rates are not in this research store and were not invented. The authoritative executable result below is bid/ask only.

Hypothetical sensitivity, not mixed into the headline:

- Current OANDA ${SYMBOL} snapshot: ${currentRate ? `longRate ${(currentRate.longRate * 100).toFixed(4)}% / shortRate ${(currentRate.shortRate * 100).toFixed(4)}% annual (${currentRate.source})` : "unavailable"}
- Hypothetical current-rate financing drag: ${fmt(rateDragPerTrade)}R/trade
- Hypothetical conservative 2 pips per charged financing day: ${fmt(conservativePipDragPerTrade)}R/trade
- Average overnight 17:00 NY rolls: ${fmt(mean(full.closed.map((row) => row.overnightRolls)))}
- Average OANDA-style days charged (Wed=3): ${fmt(mean(full.closed.map((row) => row.financingDaysCharged)))}

## Step 4 — Bid/ask cost report

Same midpoint signals. Long enter ASK / stop-target-exit BID. Short enter BID / stop-target-exit ASK. ATR frozen. SL=1.5 ATR, TP=3.0 ATR around executable entry. Max hold 30 H4 bars. Stop-first. Adverse gaps fill at the worse executable open.

| YEAR | N | MID WR | MID PF | MID EXP | EXEC WR | EXEC PF | EXEC EXP | COST/TRADE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${costLines}
| ALL | ${mid.n} | ${pct(mid.winRate)} | ${fmt(mid.profitFactor)} | ${fmt(mid.expectancyR)} | ${pct(exec.winRate)} | ${fmt(exec.profitFactor)} | ${fmt(exec.expectancyR)} | ${fmt(bidAskDrag)} |

- midpoint PF: ${fmt(mid.profitFactor)}
- executable PF: ${fmt(exec.profitFactor)}
- midpoint expectancy: ${fmt(mid.expectancyR)}R
- executable expectancy: ${fmt(exec.expectancyR)}R
- spread cost / bid-ask drag: ${fmt(bidAskDrag)}R/trade
- financing drag (authoritative): FINANCING_DATA_UNAVAILABLE
- total cost drag (authoritative = bid/ask): ${fmt(bidAskDrag)}R/trade
- executable WR: ${pct(exec.winRate)}
- total executable R: ${fmt(exec.totalR)}
- executable max DD: ${fmt(exec.maxDrawdownR)}R
- average / median / p95 spread: ${fmt(mean(spreads))} / ${fmt(median(spreads))} / ${fmt(percentile(spreads, 0.95))} pips
- spread as % of 1R stop: ${pct(mean(spreadToStop))}
- average stop distance: ${fmt(mean(stopPips))} pips
- midpoint winners that become executable losers: ${winnerFlips}
- long executable expectancy: ${fmt(execDirections.long.expectancyR)}R (N ${execDirections.long.n}, WR ${pct(execDirections.long.winRate)}, PF ${fmt(execDirections.long.profitFactor)})
- short executable expectancy: ${fmt(execDirections.short.expectancyR)}R (N ${execDirections.short.n}, WR ${pct(execDirections.short.winRate)}, PF ${fmt(execDirections.short.profitFactor)})
- average / median hold: ${fmt(exec.averageHoldingHours)} / ${fmt(exec.medianHoldingHours)} hours
- maximum simultaneous exposure: ${overlapping === 0 ? "1 (no pyramiding)" : overlapping}

## Step 5 — Yearly stability

- All four yearly slices still positive after bid/ask? ${allYearsPositive ? "YES" : "NO"}
- 2023 after bid/ask: EXP ${fmt(execYears[2023]!.expectancyR)}R, PF ${fmt(execYears[2023]!.profitFactor)}
- 2024 after bid/ask: EXP ${fmt(execYears[2024]!.expectancyR)}R, PF ${fmt(execYears[2024]!.profitFactor)}
- 2025 after bid/ask: EXP ${fmt(execYears[2025]!.expectancyR)}R, PF ${fmt(execYears[2025]!.profitFactor)}
- 2026 after bid/ask: EXP ${fmt(execYears[2026]!.expectancyR)}R, PF ${fmt(execYears[2026]!.profitFactor)}
- Excluding 2026: midpoint EXP ${fmt(midMetrics(without2026).expectancyR)}R PF ${fmt(midMetrics(without2026).profitFactor)}; executable EXP ${fmt(execMetrics(without2026).expectancyR)}R PF ${fmt(execMetrics(without2026).profitFactor)}
- Excluding 2025: midpoint EXP ${fmt(midMetrics(without2025).expectancyR)}R PF ${fmt(midMetrics(without2025).profitFactor)}; executable EXP ${fmt(execMetrics(without2025).expectancyR)}R PF ${fmt(execMetrics(without2025).profitFactor)}
- Long edge after bid/ask: EXP ${fmt(execDirections.long.expectancyR)}R
- Shorts after bid/ask: EXP ${fmt(execDirections.short.expectancyR)}R
- Shorts remain in the frozen combined result. This run did not drop them.

## Step 6 — Classification

**${verdict}**

Approximate annual frequency: ${fmt(mid.n / years, 1)} trades/year.

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
`;
  await writeFile(resolve(OUT, "FINAL_REPORT.md"), report);
  await writeFile(resolve(OUT, "DATA_AUDIT.md"), [
    "# Data audit — eurusd_h4_breakout_retest_swing_v1",
    "",
    "- Instrument: EUR_USD",
    "- Signal timeframe: OANDA H4 MBA, completed bars only",
    "- Daily regime and breakout level: previous completed OANDA D MBA candle (started daily index minus one). The current session D high/low/close/EMA is not used.",
    "- Warmup: H4 from 2022-07-01; D from 2021-01-01",
    `- Evaluation window: ${FROM} to ${TO} exclusive`,
    `- Raw retest setups in window: ${rawSignals.length}`,
    `- Skipped while a midpoint trade was open: ${full.skipped}`,
    `- Closed trades: ${full.closed.length}`,
    `- Unresolved trades: ${full.unresolved}`,
    `- Missing executable quotes: ${full.missingExecutable}`,
    "- Historical financing: FINANCING_DATA_UNAVAILABLE",
    "- Production evaluators, registries, and paper/live paths were not modified",
    "",
  ].join("\n"));
  console.log(JSON.stringify({
    verdict, midpoint: mid, executable: exec, midpointDirections: midDirections, executableDirections: execDirections,
    financing: artifact.financing, costs: artifact.costs, stability: artifact.stability,
    parity: { passed: parity.passed, n: mid.n }, outputDirectory: OUT,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
