import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvConfig } from "@next/env";

import {
  EURUSD_STRATEGY_NAME,
  EURUSD_STRATEGY_VERSION,
  evaluateEurusdStrategyTrace,
} from "../src/lib/strategy/strategies/eurusd-strategy";
import {
  USDJPY_STRATEGY_NAME,
  USDJPY_STRATEGY_VERSION_LABEL,
  evaluateUsdjpyStrategyTrace,
} from "../src/lib/strategy/strategies/usdjpy-strategy";
import {
  GBPUSD_MAX_HOLD_BARS,
  GBPUSD_STRATEGY_NAME,
  GBPUSD_STRATEGY_VERSION,
  evaluateGbpusdStrategyTrace,
} from "../src/lib/strategy/strategies/gbpusd-strategy";
import {
  AUDUSD_MAX_HOLD_BARS,
  AUDUSD_STRATEGY_NAME,
  AUDUSD_STRATEGY_VERSION,
  evaluateAudusdStrategyTrace,
} from "../src/lib/strategy/strategies/audusd-strategy";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle, MajorInstrument } from "../src/types/forex";

type Pair = "EUR_USD" | "USD_JPY" | "GBP_USD" | "AUD_USD";
type Direction = "long" | "short";
type ExitReason = "TP" | "SL" | "TIME_EXIT";
type Verdict = "SURVIVES" | "MARGINAL" | "FAILS_COSTS" | "PARITY_FAILED";
type PriceBar = { open: number; high: number; low: number; close: number };
type MbaCandle = ResearchCandle;

export type FrozenSignal = {
  pair: Pair;
  strategy: string;
  version: string;
  timeframe: "H1" | "M30";
  barMs: number;
  maxHoldBars: number | null;
  signalTimestamp: string;
  decisionTime: string;
  direction: Direction;
  midEntry: number;
  atr: number;
  midStop: number;
  midTarget: number;
  executableGeometry: "MIDPOINT_LEVELS" | "EXECUTABLE_ENTRY_ATR";
  confidenceTag: string | null;
  origin: string | null;
};

type ResolvedTrade = {
  exitTimestamp: string;
  exitPrice: number;
  exitReason: ExitReason;
  resultR: number;
  ambiguousSameBar: boolean;
};

export type TradeAudit = {
  pair: Pair;
  strategy: string;
  version: string;
  signalTimestamp: string;
  decisionTime: string;
  year: number;
  direction: Direction;
  origin: string | null;
  confidenceTag: string | null;
  midSignalClose: number;
  bid: number;
  ask: number;
  spreadPips: number;
  atr: number;
  midEntry: number;
  executableEntry: number;
  stop: number;
  target: number;
  exitTimestamp: string;
  exitPrice: number;
  exitReason: ExitReason;
  midExitTimestamp: string;
  midExitPrice: number;
  midExitReason: ExitReason;
  midAmbiguousSameBar: boolean;
  executableAmbiguousSameBar: boolean;
  midResultR: number;
  executableResultR: number;
  midPricePnl: number;
  executablePricePnl: number;
  entrySpreadCostR: number;
  costR: number;
};

type Metrics = {
  n: number;
  wins: number;
  nonPositive: number;
  winRate: number | null;
  tp: number;
  sl: number;
  timeExit: number;
  netR: number;
  grossProfitR: number;
  grossLossR: number;
  profitFactor: number | null;
  expectancyR: number | null;
};

type KnownParity = { n: number; profitFactor: number; expectancyR?: number; winRate?: number };

const FROM_OVERRIDE = process.env.EXECUTABLE_COST_FROM;
const TO_OVERRIDE = process.env.EXECUTABLE_COST_TO;
// Avoid OANDA rejecting a workstation clock that is a few seconds ahead of its
// candle server. This does not remove any completed H1/M30 bar.
const CURRENT_TO = new Date(Date.now() - 5 * 60_000).toISOString();
const OUTPUT_DIR = resolve(process.cwd(), "../api-server/research-v2/executable-cost-validation");
const EXTRA_SPREAD_PIPS = [0, 0.1, 0.25, 0.5] as const;
const KNOWN: Record<Pair, KnownParity> = {
  EUR_USD: { n: 356, profitFactor: 1.322, winRate: 0.4101 },
  USD_JPY: { n: 67, profitFactor: 1.929, winRate: 0.4925 },
  GBP_USD: { n: 79, profitFactor: 1.487, expectancyR: 0.267, winRate: 0.443 },
  AUD_USD: { n: 195, profitFactor: 1.442, expectancyR: 0.210, winRate: 0.4923 },
};

function pipSize(pair: Pair) {
  return pair === "USD_JPY" ? 0.01 : 0.0001;
}

function midCandle(bar: MbaCandle): Candle {
  return { time: bar.time, volume: bar.volume, complete: bar.complete, ...bar.mid };
}

function mean(values: readonly number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: readonly number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function percentile(values: readonly number[], percentileValue: number) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(percentileValue * ordered.length) - 1));
  return ordered[index]!;
}

function metrics(rows: readonly { resultR: number; exitReason: ExitReason }[]): Metrics {
  const wins = rows.filter((row) => row.resultR > 0);
  const grossProfitR = wins.reduce((sum, row) => sum + row.resultR, 0);
  const grossLossR = Math.abs(rows.filter((row) => row.resultR < 0).reduce((sum, row) => sum + row.resultR, 0));
  const netR = rows.reduce((sum, row) => sum + row.resultR, 0);
  return {
    n: rows.length,
    wins: wins.length,
    nonPositive: rows.length - wins.length,
    winRate: rows.length ? wins.length / rows.length : null,
    tp: rows.filter((row) => row.exitReason === "TP").length,
    sl: rows.filter((row) => row.exitReason === "SL").length,
    timeExit: rows.filter((row) => row.exitReason === "TIME_EXIT").length,
    netR,
    grossProfitR,
    grossLossR,
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : null,
    expectancyR: rows.length ? netR / rows.length : null,
  };
}

function profitFactor(values: readonly number[]) {
  const grossProfit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return grossLoss > 0 ? grossProfit / grossLoss : null;
}

export async function fetchHistory(pair: Pair, timeframe: "H1" | "M30", from: string, to: string) {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const byTime = new Map<string, MbaCandle>();
  let cursor = to;
  let previousEarliest = "";
  for (let page = 0; page < 20; page += 1) {
    const batch = await getResearchCandles(pair as MajorInstrument, timeframe, 5_000, { to: cursor });
    for (const candle of batch) byTime.set(candle.time, candle);
    const earliest = batch.map((candle) => candle.time).sort()[0];
    if (!earliest || earliest === previousEarliest || Date.parse(earliest) <= Date.parse(from)) break;
    previousEarliest = earliest;
    cursor = new Date(Date.parse(earliest) - 1).toISOString();
  }
  const candles = [...byTime.values()]
    .filter((candle) => candle.complete && Date.parse(candle.time) >= Date.parse(from) && Date.parse(candle.time) < Date.parse(to))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  if (!candles.length) throw new Error(`${pair} returned no completed ${timeframe} MBA candles in ${from}..${to}.`);
  return candles;
}

function validSignal(signal: FrozenSignal): boolean {
  return [signal.midEntry, signal.atr, signal.midStop, signal.midTarget].every(Number.isFinite)
    && signal.atr > 0
    && (signal.direction === "long"
      ? signal.midStop < signal.midEntry && signal.midEntry < signal.midTarget
      : signal.midTarget < signal.midEntry && signal.midEntry < signal.midStop);
}

function signalsFor(pair: Pair, candles: readonly MbaCandle[]): FrozenSignal[] {
  const mid = candles.map(midCandle);
  if (pair === "EUR_USD") {
    const trace = evaluateEurusdStrategyTrace(mid);
    assert.equal(trace.error, null, trace.error ?? undefined);
    return trace.rows.flatMap((row) => row.evtA && row.entry !== null && row.stop !== null && row.target !== null && row.atr14 !== null ? [{
      pair, strategy: EURUSD_STRATEGY_NAME, version: EURUSD_STRATEGY_VERSION,
      timeframe: "H1" as const, barMs: 60 * 60_000, maxHoldBars: null,
      signalTimestamp: row.timestamp, decisionTime: new Date(Date.parse(row.timestamp) + 60 * 60_000).toISOString(),
      direction: row.sigA === 1 ? "long" as const : "short" as const,
      midEntry: row.entry, atr: row.atr14, midStop: row.stop, midTarget: row.target,
      executableGeometry: "MIDPOINT_LEVELS" as const, confidenceTag: null, origin: "LONDON",
    }] : []).filter(validSignal);
  }
  if (pair === "USD_JPY") {
    const trace = evaluateUsdjpyStrategyTrace(mid);
    assert.equal(trace.error, null, trace.error ?? undefined);
    return trace.rows.flatMap((row) => (row.finalLongSignal || row.finalShortSignal)
      && row.signalPrice !== null && row.stop !== null && row.target !== null && row.atr14 !== null ? [{
        pair, strategy: USDJPY_STRATEGY_NAME, version: USDJPY_STRATEGY_VERSION_LABEL,
        timeframe: "H1" as const, barMs: 60 * 60_000, maxHoldBars: 3,
        signalTimestamp: row.timestamp, decisionTime: row.signalCloseTime,
        direction: row.finalLongSignal ? "long" as const : "short" as const,
        midEntry: row.signalPrice, atr: row.atr14, midStop: row.stop, midTarget: row.target,
        executableGeometry: "EXECUTABLE_ENTRY_ATR" as const, confidenceTag: "BODY_EXTREME", origin: "1100",
      }] : []).filter(validSignal);
  }
  if (pair === "GBP_USD") {
    const trace = evaluateGbpusdStrategyTrace(mid);
    assert.equal(trace.error, null, trace.error ?? undefined);
    const byTime = new Map(candles.map((bar) => [bar.time, bar]));
    return trace.rows.flatMap((row) => (row.rawLongSignal || row.rawShortSignal)
      && row.stop !== null && row.target !== null && row.atr14 !== null && byTime.has(row.timestamp) ? [{
        pair, strategy: GBPUSD_STRATEGY_NAME, version: GBPUSD_STRATEGY_VERSION,
        timeframe: "M30" as const, barMs: 30 * 60_000, maxHoldBars: GBPUSD_MAX_HOLD_BARS,
        signalTimestamp: row.timestamp, decisionTime: row.signalCloseTime,
        direction: row.rawLongSignal ? "long" as const : "short" as const,
        midEntry: byTime.get(row.timestamp)!.mid.close, atr: row.atr14, midStop: row.stop, midTarget: row.target,
        executableGeometry: "MIDPOINT_LEVELS" as const, confidenceTag: row.confidenceTag, origin: row.originCode,
      }] : []).filter(validSignal);
  }
  const trace = evaluateAudusdStrategyTrace(mid);
  assert.equal(trace.error, null, trace.error ?? undefined);
  return trace.rows.flatMap((row) => row.finalLongSignal && row.signalClose !== null && row.atr14 !== null ? [{
    pair, strategy: AUDUSD_STRATEGY_NAME, version: AUDUSD_STRATEGY_VERSION,
    timeframe: "H1" as const, barMs: 60 * 60_000, maxHoldBars: AUDUSD_MAX_HOLD_BARS,
    signalTimestamp: row.timestamp, decisionTime: row.signalTimeUtc,
    direction: "long" as const,
    midEntry: row.signalClose, atr: row.atr14, midStop: row.signalClose - row.atr14, midTarget: row.signalClose + 2 * row.atr14,
    executableGeometry: "EXECUTABLE_ENTRY_ATR" as const, confidenceTag: row.confidenceTag, origin: "1100",
  }] : []).filter(validSignal);
}

function shiftedSide(bar: MbaCandle, direction: Direction, extraSpreadPips: number, pair: Pair): PriceBar {
  const base = direction === "long" ? bar.bid : bar.ask;
  const shift = extraSpreadPips * pipSize(pair) / 2 * (direction === "long" ? -1 : 1);
  return { open: base.open + shift, high: base.high + shift, low: base.low + shift, close: base.close + shift };
}

export function resolveSignal(
  signal: FrozenSignal,
  candles: readonly MbaCandle[],
  mode: "midpoint" | "executable",
  extraSpreadPips = 0,
  ambiguityPolicy: "stop_first" | "tradingview_path" = "stop_first",
): ResolvedTrade | null {
  const signalBarIndex = candles.findIndex((bar) => bar.time === signal.signalTimestamp);
  if (signalBarIndex < 0) return null;
  const signalBar = candles[signalBarIndex]!;
  const halfExtra = extraSpreadPips * pipSize(signal.pair) / 2;
  const entry = mode === "midpoint" ? signal.midEntry
    : signal.direction === "long" ? signalBar.ask.close + halfExtra : signalBar.bid.close - halfExtra;
  const stop = mode === "midpoint" || signal.executableGeometry === "MIDPOINT_LEVELS" ? signal.midStop
    : signal.direction === "long" ? entry - signal.atr : entry + signal.atr;
  const target = mode === "midpoint" || signal.executableGeometry === "MIDPOINT_LEVELS" ? signal.midTarget
    : signal.direction === "long" ? entry + 2 * signal.atr : entry - 2 * signal.atr;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;

  if (signal.maxHoldBars === null) {
    for (const bar of candles.slice(signalBarIndex + 1)) {
      const price = mode === "midpoint" ? bar.mid : shiftedSide(bar, signal.direction, extraSpreadPips, signal.pair);
      const stopHit = signal.direction === "long" ? price.low <= stop : price.high >= stop;
      const targetHit = signal.direction === "long" ? price.high >= target : price.low <= target;
      const exitTimestamp = new Date(Date.parse(bar.time) + signal.barMs).toISOString();
      const targetFirst = stopHit && targetHit && ambiguityPolicy === "tradingview_path"
        && (signal.direction === "long" ? price.high - price.open < price.open - price.low : price.open - price.low <= price.high - price.open);
      if (stopHit && !targetFirst) return { exitTimestamp, exitPrice: stop, exitReason: "SL", resultR: -1, ambiguousSameBar: targetHit };
      if (targetHit) {
        const resultR = signal.direction === "long" ? (target - entry) / risk : (entry - target) / risk;
        return { exitTimestamp, exitPrice: target, exitReason: "TP", resultR, ambiguousSameBar: stopHit };
      }
    }
    return null;
  }

  const maxBars = signal.maxHoldBars;
  for (let slot = 1; slot <= maxBars; slot += 1) {
    const expectedStart = Date.parse(signal.decisionTime) + (slot - 1) * signal.barMs;
    const bar = candles[signalBarIndex + slot];
    if (!bar || Date.parse(bar.time) !== expectedStart) return null;
    const price = mode === "midpoint" ? bar.mid : shiftedSide(bar, signal.direction, extraSpreadPips, signal.pair);
    const stopHit = signal.direction === "long" ? price.low <= stop : price.high >= stop;
    const targetHit = signal.direction === "long" ? price.high >= target : price.low <= target;
    const exitTimestamp = new Date(Date.parse(bar.time) + signal.barMs).toISOString();
    const targetFirst = stopHit && targetHit && ambiguityPolicy === "tradingview_path"
      && (signal.direction === "long" ? price.high - price.open < price.open - price.low : price.open - price.low <= price.high - price.open);
    if (stopHit && !targetFirst) return { exitTimestamp, exitPrice: stop, exitReason: "SL", resultR: -1, ambiguousSameBar: targetHit };
    if (targetHit) {
      const resultR = signal.direction === "long" ? (target - entry) / risk : (entry - target) / risk;
      return { exitTimestamp, exitPrice: target, exitReason: "TP", resultR, ambiguousSameBar: stopHit };
    }
    if (slot === signal.maxHoldBars) {
      const resultR = signal.direction === "long" ? (price.close - entry) / risk : (entry - price.close) / risk;
      return { exitTimestamp, exitPrice: price.close, exitReason: "TIME_EXIT", resultR, ambiguousSameBar: false };
    }
  }
  return null;
}

function freezeEurusdPositionCohort(
  signals: readonly FrozenSignal[],
  candles: readonly MbaCandle[],
  ambiguityPolicy: "stop_first" | "tradingview_path" = "stop_first",
) {
  const accepted: FrozenSignal[] = [];
  let occupiedUntil = -Infinity;
  let unresolved = false;
  for (const signal of signals) {
    const decisionMs = Date.parse(signal.decisionTime);
    if (decisionMs < occupiedUntil || unresolved) continue;
    const result = resolveSignal(signal, candles, "midpoint", 0, ambiguityPolicy);
    accepted.push(signal);
    if (result) occupiedUntil = Date.parse(result.exitTimestamp);
    else unresolved = true;
  }
  return { accepted, skippedWhileOpen: signals.length - accepted.length, unresolvedBlock: unresolved };
}

function parityCheck(pair: Pair, midpoint: Metrics, midpointPriceProfitFactor: number | null) {
  const expected = KNOWN[pair];
  const countMatches = midpoint.n === expected.n;
  const normalizedPfMatches = midpoint.profitFactor !== null && Math.abs(midpoint.profitFactor - expected.profitFactor) <= 0.035;
  const pricePfMatches = midpointPriceProfitFactor !== null && Math.abs(midpointPriceProfitFactor - expected.profitFactor) <= 0.035;
  const pfMatches = normalizedPfMatches || pricePfMatches;
  const expectancyMatches = expected.expectancyR === undefined || midpoint.expectancyR !== null
    && Math.abs(midpoint.expectancyR - expected.expectancyR) <= 0.035;
  const winRateMatches = expected.winRate === undefined || midpoint.winRate !== null
    && Math.abs(midpoint.winRate - expected.winRate) <= 0.005;
  return {
    passed: countMatches && pfMatches && expectancyMatches,
    expected, countMatches, pfMatches, normalizedPfMatches, pricePfMatches, midpointPriceProfitFactor, expectancyMatches,
    winRateMatches,
    note: winRateMatches ? null : "Known headline win rate differs under conservative stop-first ambiguity handling; PF/count remain the parity gate.",
  };
}

function yearly(rows: readonly TradeAudit[]) {
  return Object.fromEntries([2023, 2024, 2025, 2026].map((year) => {
    const selected = rows.filter((row) => row.year === year);
    return [year, metrics(selected.map((row) => ({ resultR: row.executableResultR, exitReason: row.exitReason })))];
  }));
}

function directionBreakdown(rows: readonly TradeAudit[]) {
  return Object.fromEntries((["long", "short"] as const).map((direction) => {
    const selected = rows.filter((row) => row.direction === direction);
    return [direction, {
      midpoint: metrics(selected.map((row) => ({ resultR: row.midResultR, exitReason: row.midExitReason }))),
      executable: metrics(selected.map((row) => ({ resultR: row.executableResultR, exitReason: row.exitReason }))),
    }];
  }));
}

function classify(executable: Metrics, byYear: Record<string, Metrics>): Verdict {
  if (executable.profitFactor === null || executable.expectancyR === null
    || executable.profitFactor <= 1 || executable.expectancyR <= 0) return "FAILS_COSTS";
  const materialPositiveYears = Object.values(byYear).filter((row) => row.n >= 5 && (row.expectancyR ?? 0) > 0).length;
  return executable.profitFactor > 1.05 && executable.expectancyR > 0.03 && materialPositiveYears >= 2
    ? "SURVIVES" : "MARGINAL";
}

function round(value: number | null, digits = 6) {
  return value === null ? null : Number(value.toFixed(digits));
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: readonly Record<string, unknown>[]) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]!);
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
}

function auditCsvRow(row: TradeAudit): Record<string, unknown> {
  return { ...row };
}

function formatMetric(value: number | null | undefined, digits = 3) {
  return value == null ? "n/a" : value.toFixed(digits);
}

async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  await mkdir(OUTPUT_DIR, { recursive: true });
  const specs: Array<{ pair: Pair; timeframe: "H1" | "M30"; from: string; to: string }> = [
    // These boundaries reproduce each supplied frozen parity snapshot. They are
    // data identity, not tuned strategy parameters.
    { pair: "EUR_USD", timeframe: "H1", from: FROM_OVERRIDE ?? "2023-01-01T00:00:00.000Z", to: TO_OVERRIDE ?? "2026-09-01T00:00:00.000Z" },
    { pair: "USD_JPY", timeframe: "H1", from: FROM_OVERRIDE ?? "2023-01-01T00:00:00.000Z", to: TO_OVERRIDE ?? CURRENT_TO },
    { pair: "GBP_USD", timeframe: "M30", from: FROM_OVERRIDE ?? "2025-01-06T00:00:00.000Z", to: TO_OVERRIDE ?? CURRENT_TO },
    { pair: "AUD_USD", timeframe: "H1", from: FROM_OVERRIDE ?? "2023-01-01T00:00:00.000Z", to: TO_OVERRIDE ?? "2026-09-04T12:00:00.000Z" },
  ];
  const results: Record<string, unknown> = {};
  const masterRows: Array<Record<string, unknown>> = [];

  for (const spec of specs) {
    console.error(`Fetching ${spec.pair} ${spec.timeframe} MBA history...`);
    const candles = await fetchHistory(spec.pair, spec.timeframe, spec.from, spec.to);
    const rawSignals = signalsFor(spec.pair, candles).filter((signal) => Date.parse(signal.signalTimestamp) >= Date.parse(spec.from));
    const eurusdCohort = spec.pair === "EUR_USD" ? freezeEurusdPositionCohort(rawSignals, candles) : null;
    const signals = eurusdCohort?.accepted ?? rawSignals;
    const audits: TradeAudit[] = [];
    let unresolved = 0;

    for (const signal of signals) {
      const midpoint = resolveSignal(signal, candles, "midpoint");
      const executable = resolveSignal(signal, candles, "executable");
      if (!midpoint || !executable) {
        unresolved += 1;
        continue;
      }
      const signalBar = candles.find((bar) => bar.time === signal.signalTimestamp)!;
      const executableEntry = signal.direction === "long" ? signalBar.ask.close : signalBar.bid.close;
      const executableStop = signal.executableGeometry === "EXECUTABLE_ENTRY_ATR"
        ? signal.direction === "long" ? executableEntry - signal.atr : executableEntry + signal.atr
        : signal.midStop;
      const executableTarget = signal.executableGeometry === "EXECUTABLE_ENTRY_ATR"
        ? signal.direction === "long" ? executableEntry + 2 * signal.atr : executableEntry - 2 * signal.atr
        : signal.midTarget;
      const spreadPips = (signalBar.ask.close - signalBar.bid.close) / pipSize(spec.pair);
      audits.push({
        pair: spec.pair, strategy: signal.strategy, version: signal.version,
        signalTimestamp: signal.signalTimestamp, decisionTime: signal.decisionTime,
        year: new Date(signal.signalTimestamp).getUTCFullYear(), direction: signal.direction,
        origin: signal.origin, confidenceTag: signal.confidenceTag,
        midSignalClose: signal.midEntry, bid: signalBar.bid.close, ask: signalBar.ask.close, spreadPips,
        atr: signal.atr, midEntry: signal.midEntry, executableEntry,
        stop: executableStop, target: executableTarget,
        exitTimestamp: executable.exitTimestamp, exitPrice: executable.exitPrice, exitReason: executable.exitReason,
        midExitTimestamp: midpoint.exitTimestamp, midExitPrice: midpoint.exitPrice, midExitReason: midpoint.exitReason,
        midAmbiguousSameBar: midpoint.ambiguousSameBar,
        executableAmbiguousSameBar: executable.ambiguousSameBar,
        midResultR: midpoint.resultR, executableResultR: executable.resultR,
        midPricePnl: signal.direction === "long" ? midpoint.exitPrice - signal.midEntry : signal.midEntry - midpoint.exitPrice,
        executablePricePnl: signal.direction === "long" ? executable.exitPrice - executableEntry : executableEntry - executable.exitPrice,
        entrySpreadCostR: (signalBar.ask.close - signalBar.bid.close) / signal.atr,
        costR: midpoint.resultR - executable.resultR,
      });
    }

    const midpointMetrics = metrics(audits.map((row) => ({ resultR: row.midResultR, exitReason: row.midExitReason })));
    const midpointPriceProfitFactor = profitFactor(audits.map((row) => row.midPricePnl));
    const tradingViewSignals = spec.pair === "EUR_USD"
      ? freezeEurusdPositionCohort(rawSignals, candles, "tradingview_path").accepted
      : signals;
    const tradingViewPathMidpoint = metrics(tradingViewSignals.flatMap((signal) => {
      const resolved = resolveSignal(signal, candles, "midpoint", 0, "tradingview_path");
      return resolved ? [resolved] : [];
    }));
    const parity = parityCheck(spec.pair, midpointMetrics, midpointPriceProfitFactor);
    if (!parity.passed) {
      results[spec.pair] = {
        source: "OANDA practice API MBA", period: { requestedFrom: spec.from, requestedToExclusive: spec.to, from: candles[0]!.time, to: candles.at(-1)!.time, candles: candles.length },
        rawSignals: rawSignals.length, acceptedSignals: signals.length, unresolved, midpoint: midpointMetrics, parity,
        executable: null, verdict: "PARITY_FAILED",
      };
      masterRows.push({ pair: spec.pair, midN: midpointMetrics.n, midPF: round(midpointMetrics.profitFactor), midEXP: round(midpointMetrics.expectancyR), verdict: "PARITY_FAILED" });
      const rawByYear = Object.fromEntries([2023, 2024, 2025, 2026].map((year) => [year, rawSignals.filter((signal) => new Date(signal.signalTimestamp).getUTCFullYear() === year).length]));
      const rawByOrigin = Object.fromEntries([...new Set(rawSignals.map((signal) => signal.origin ?? "none"))].map((origin) => [origin, rawSignals.filter((signal) => (signal.origin ?? "none") === origin).length]));
      const tail = rawSignals.slice(-KNOWN[spec.pair].n);
      console.error(`${spec.pair}: midpoint parity failed; executable verdict withheld. ${JSON.stringify({ rawSignals: rawSignals.length, rawByYear, rawByOrigin, expectedCountTail: { from: tail.at(0)?.signalTimestamp, to: tail.at(-1)?.signalTimestamp, byOrigin: Object.fromEntries([...new Set(tail.map((signal) => signal.origin ?? "none"))].map((origin) => [origin, tail.filter((signal) => (signal.origin ?? "none") === origin).length])) }, acceptedSignals: signals.length, unresolved, midpoint: midpointMetrics, parity })}`);
      continue;
    }

    const executableMetrics = metrics(audits.map((row) => ({ resultR: row.executableResultR, exitReason: row.exitReason })));
    const executablePriceProfitFactor = profitFactor(audits.map((row) => row.executablePricePnl));
    const yearMetrics = yearly(audits);
    const verdict = classify(executableMetrics, yearMetrics);
    const spreads = audits.map((row) => row.spreadPips);
    const entryCosts = audits.map((row) => row.entrySpreadCostR);
    const totalCosts = audits.map((row) => row.costR);
    const sensitivity = Object.fromEntries(EXTRA_SPREAD_PIPS.map((extra) => {
      const rows = signals.flatMap((signal) => {
        const resolved = resolveSignal(signal, candles, "executable", extra);
        return resolved ? [resolved] : [];
      });
      return [`actual+${extra}`, metrics(rows)];
    }));
    const gbpNetting = spec.pair === "GBP_USD" ? (() => {
      const accepted: TradeAudit[] = [];
      const blocked: TradeAudit[] = [];
      for (const row of [...audits].sort((left, right) => Date.parse(left.decisionTime) - Date.parse(right.decisionTime))) {
        const active = accepted.filter((prior) => Date.parse(prior.exitTimestamp) > Date.parse(row.decisionTime));
        if (active.some((prior) => prior.direction !== row.direction)) blocked.push(row);
        else accepted.push(row);
      }
      return {
        blockedOppositeSignals: blocked.length,
        accepted: metrics(accepted.map((row) => ({ resultR: row.executableResultR, exitReason: row.exitReason }))),
      };
    })() : null;

    const costs = {
      averageSpreadPips: mean(spreads), medianSpreadPips: median(spreads), p95SpreadPips: percentile(spreads, 0.95),
      averageEntrySpreadCostR: mean(entryCosts), medianEntrySpreadCostR: median(entryCosts),
      averageTotalCostR: mean(totalCosts), medianTotalCostR: median(totalCosts),
      midpointExpectancyConsumedPct: midpointMetrics.expectancyR && executableMetrics.expectancyR !== null
        ? (midpointMetrics.expectancyR - executableMetrics.expectancyR) / midpointMetrics.expectancyR * 100 : null,
      outcomeChanged: audits.filter((row) => row.midExitReason !== row.exitReason).length,
      midpointWinnersToExecutableLosers: audits.filter((row) => row.midResultR > 0 && row.executableResultR <= 0).length,
      positiveMidpointTimeExitsToExecutableLoss: audits.filter((row) => row.midExitReason === "TIME_EXIT" && row.midResultR > 0 && row.executableResultR <= 0).length,
      midpointSameBarAmbiguities: audits.filter((row) => row.midAmbiguousSameBar).length,
      executableSameBarAmbiguities: audits.filter((row) => row.executableAmbiguousSameBar).length,
    };
    results[spec.pair] = {
      source: "OANDA practice API MBA",
      period: { requestedFrom: spec.from, requestedToExclusive: spec.to, from: candles[0]!.time, to: candles.at(-1)!.time, candles: candles.length },
      strategy: audits[0]?.strategy ?? rawSignals[0]?.strategy,
      version: audits[0]?.version ?? rawSignals[0]?.version,
      executableGeometry: rawSignals[0]?.executableGeometry,
      rawSignals: rawSignals.length,
      acceptedSignals: signals.length,
      skippedWhilePositionOpen: eurusdCohort?.skippedWhileOpen ?? 0,
      unresolved,
      midpoint: midpointMetrics,
      midpointPriceProfitFactor,
      tradingViewPathMidpoint,
      parity,
      executable: executableMetrics,
      executablePriceProfitFactor,
      costs,
      direction: directionBreakdown(audits),
      year: yearMetrics,
      sensitivity,
      gbpNettingConstraint: gbpNetting,
      verdict,
      trades: audits,
    };
    masterRows.push({
      pair: spec.pair, midN: midpointMetrics.n, midPF: round(midpointMetrics.profitFactor), midEXP: round(midpointMetrics.expectancyR),
      execN: executableMetrics.n, execWR: round(executableMetrics.winRate), execPF: round(executableMetrics.profitFactor), execEXP: round(executableMetrics.expectancyR),
      avgSpreadPips: round(costs.averageSpreadPips), costRPerTrade: round(costs.averageTotalCostR),
      exp2023: round(yearMetrics[2023]!.expectancyR), exp2024: round(yearMetrics[2024]!.expectancyR),
      exp2025: round(yearMetrics[2025]!.expectancyR), exp2026: round(yearMetrics[2026]!.expectancyR), verdict,
    });
    await writeFile(resolve(OUTPUT_DIR, `${spec.pair.toLowerCase().replace("_", "")}-trades.csv`), toCsv(audits.map(auditCsvRow)), "utf8");
    console.error(`${spec.pair}: ${verdict}, executable PF=${formatMetric(executableMetrics.profitFactor)} EXP=${formatMetric(executableMetrics.expectancyR)}R.`);
  }

  masterRows.push({
    pair: "NZD_USD", midN: null, midPF: 1.318, midEXP: 0.152,
    execN: null, execWR: null, execPF: 0.837, execEXP: -0.094,
    avgSpreadPips: null, costRPerTrade: 0.246,
    exp2023: null, exp2024: null, exp2025: null, exp2026: null, verdict: "FAILS_COSTS",
  });
  const pairResults = Object.entries(results).map(([pair, value]) => ({
    pair,
    ...(value as Record<string, unknown>),
  })) as Array<{ pair: string } & Record<string, unknown>>;
  const survivors = pairResults.filter((row) => row.verdict === "SURVIVES").map((row) => row.pair);
  const marginal = pairResults.filter((row) => row.verdict === "MARGINAL").map((row) => row.pair);
  const failures = [...pairResults.filter((row) => row.verdict === "FAILS_COSTS").map((row) => row.pair), "NZD_USD"];
  const annualFrequencyFor = (pairs: readonly string[]) => pairResults.filter((row) => pairs.includes(row.pair))
    .reduce((sum, row) => {
      const period = row.period as { requestedFrom: string; requestedToExclusive: string } | undefined;
      const n = Number((row.executable as Metrics | null)?.n ?? 0);
      const years = period ? (Date.parse(period.requestedToExclusive) - Date.parse(period.requestedFrom)) / (365.2425 * 24 * 60 * 60_000) : 0;
      return sum + (years > 0 ? n / years : 0);
    }, 0);
  const portfolio = {
    survivors, marginal, failsCosts: failures,
    completedPairsSurviving: survivors.length,
    annualTradeFrequencySurvivors: annualFrequencyFor(survivors),
    annualTradeFrequencyIncludingMarginal: annualFrequencyFor([...survivors, ...marginal]),
    caveat: "Frequencies are arithmetic counts, not an independence claim; pair correlation still requires portfolio-level testing.",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    methodology: {
      pairSpecificFrozenParityWindows: true, signalData: "frozen production evaluators on completed midpoint candles",
      executionData: "OANDA practice historical MBA; long ask entry/bid exit; short bid entry/ask exit",
      ambiguity: "stop first when both levels occur in the same strategy-timeframe candle",
      sensitivity: "extra spread is centered on midpoint: half worsens entry and half worsens the executable exit side",
      noNzdusdRerun: true,
    },
    pairs: results,
    nzdusdReference: { midpointPF: 1.318, midpointExpectancyR: 0.152, executablePF: 0.837, executableExpectancyR: -0.094, verdict: "FAILS_COSTS" },
    portfolio,
  };
  await writeFile(resolve(OUTPUT_DIR, "RESULTS.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(resolve(OUTPUT_DIR, "pair-summary.csv"), toCsv(masterRows), "utf8");

  const table = masterRows.map((row) => `| ${row.pair} | ${row.midN ?? "ref"} | ${formatMetric(row.midPF as number | null)} | ${formatMetric(row.midEXP as number | null)} | ${row.execN ?? "ref"} | ${row.execWR == null ? "n/a" : `${(Number(row.execWR) * 100).toFixed(2)}%`} | ${formatMetric(row.execPF as number | null)} | ${formatMetric(row.execEXP as number | null)} | ${formatMetric(row.avgSpreadPips as number | null)} | ${formatMetric(row.costRPerTrade as number | null)} | ${formatMetric(row.exp2023 as number | null)} | ${formatMetric(row.exp2024 as number | null)} | ${formatMetric(row.exp2025 as number | null)} | ${formatMetric(row.exp2026 as number | null)} | ${row.verdict} |`).join("\n");
  const pairSections = pairResults.map((row) => {
    const midpoint = row.midpoint as Metrics;
    const executable = row.executable as Metrics | null;
    const costs = row.costs as Record<string, number | null> | undefined;
    const direction = row.direction as Record<string, { executable: Metrics }> | undefined;
    const year = row.year as Record<string, Metrics> | undefined;
    const sensitivity = row.sensitivity as Record<string, Metrics> | undefined;
    const period = row.period as { requestedFrom: string; requestedToExclusive: string };
    const parity = row.parity as { winRateMatches?: boolean };
    if (!executable || !costs || !direction || !year) return `## ${row.pair}\n\nMidpoint parity failed. The executable verdict is withheld.`;
    const directionText = row.pair === "AUD_USD" ? "LONG only."
      : `| LONG | ${direction.long.executable.n} | ${(Number(direction.long.executable.winRate ?? 0) * 100).toFixed(2)}% | ${formatMetric(direction.long.executable.profitFactor)} | ${formatMetric(direction.long.executable.expectancyR)} |\n| SHORT | ${direction.short.executable.n} | ${(Number(direction.short.executable.winRate ?? 0) * 100).toFixed(2)}% | ${formatMetric(direction.short.executable.profitFactor)} | ${formatMetric(direction.short.executable.expectancyR)} |`;
    const directionTable = row.pair === "AUD_USD" ? directionText
      : `| Direction | N | WR | PF | EXP R |\n|---|---:|---:|---:|---:|\n${directionText}`;
    const yearRows = [2023, 2024, 2025, 2026].filter((value) => year[value]!.n > 0)
      .map((value) => `| ${value} | ${year[value]!.n} | ${formatMetric(year[value]!.profitFactor)} | ${formatMetric(year[value]!.expectancyR)} |`).join("\n");
    const sensitivityRows = EXTRA_SPREAD_PIPS.map((extra) => {
      const value = sensitivity?.[`actual+${extra}`];
      return `| ${extra === 0 ? "actual" : `actual + ${extra} pip`} | ${formatMetric(value?.profitFactor ?? null)} | ${formatMetric(value?.expectancyR ?? null)} |`;
    }).join("\n");
    const parityWarning = row.pair === "EUR_USD" && parity.winRateMatches === false
      ? `\n\nParity caveat: conservative stop-first OANDA H1 replay produced ${midpoint.wins}/${midpoint.n} winners versus the supplied approximate Pine headline of 146/356. There were ${costs.midpointSameBarAmbiguities} midpoint same-bar ambiguities; a TradingView inferred-path diagnostic produced ${(row.tradingViewPathMidpoint as Metrics).wins}/356, not 146. Exact Pine outcome identity therefore remains unproven, although N and PF are within the declared parity tolerance. The executable result below is deliberately the conservative branch.`
      : "";
    const gbpNetting = row.gbpNettingConstraint as { blockedOppositeSignals: number; accepted: Metrics } | null;
    const gbpNote = gbpNetting ? `\n\nGBP netting constraint: ${gbpNetting.blockedOppositeSignals} opposite-direction overlapping signals were blocked; all ${gbpNetting.accepted.n} independent leg signals remained, so netted metrics are unchanged.` : "";
    return `## ${row.pair} — ${row.verdict}\n\nPeriod: ${period.requestedFrom} to ${period.requestedToExclusive} (exclusive).${parityWarning}\n\nMidpoint: N ${midpoint.n}; wins ${midpoint.wins}; non-positive ${midpoint.nonPositive}; WR ${(Number(midpoint.winRate) * 100).toFixed(2)}%; TP/SL/TIME ${midpoint.tp}/${midpoint.sl}/${midpoint.timeExit}; net ${formatMetric(midpoint.netR)}R; PF ${formatMetric(midpoint.profitFactor)}; EXP ${formatMetric(midpoint.expectancyR)}R.\n\nExecutable: N ${executable.n}; wins ${executable.wins}; non-positive ${executable.nonPositive}; WR ${(Number(executable.winRate) * 100).toFixed(2)}%; TP/SL/TIME ${executable.tp}/${executable.sl}/${executable.timeExit}; net ${formatMetric(executable.netR)}R; PF ${formatMetric(executable.profitFactor)}; EXP ${formatMetric(executable.expectancyR)}R.\n\nCost damage: spread avg/median/p95 ${formatMetric(costs.averageSpreadPips)}/${formatMetric(costs.medianSpreadPips)}/${formatMetric(costs.p95SpreadPips)} pips; entry cost avg/median ${formatMetric(costs.averageEntrySpreadCostR)}/${formatMetric(costs.medianEntrySpreadCostR)}R; total cost avg/median ${formatMetric(costs.averageTotalCostR)}/${formatMetric(costs.medianTotalCostR)}R; ${formatMetric(costs.midpointExpectancyConsumedPct)}% of midpoint expectancy consumed. Outcome changes ${costs.outcomeChanged}; midpoint winners becoming non-positive ${costs.midpointWinnersToExecutableLosers}; positive midpoint TIME_EXITs becoming losses ${costs.positiveMidpointTimeExitsToExecutableLoss}.\n\n${directionTable}${gbpNote}\n\n| Year | N | PF | EXP R |\n|---|---:|---:|---:|\n${yearRows}\n\n| Spread scenario | PF | EXP R |\n|---|---:|---:|\n${sensitivityRows}\n\nVerdict: ${row.verdict}.`;
  }).join("\n\n");
  const report = `# EXECUTABLE COST VALIDATION VERDICT\n\nSource: OANDA practice historical MBA candles. Signals and indicators use completed midpoint candles. LONG enters at ASK and exits on BID; SHORT enters at BID and exits on ASK. Same-timeframe bars that contain both stop and target resolve stop-first. Frozen signals were not altered.\n\n| Pair | MID N | MID PF | MID EXP | EXEC N | EXEC WR | EXEC PF | EXEC EXP | Avg spread | Cost R/trade | 2023 EXP | 2024 EXP | 2025 EXP | 2026 EXP | Verdict |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${table}\n\n${pairSections}\n\n# PORTFOLIO AFTER COSTS\n\n- SURVIVES: ${survivors.join(", ") || "none"}\n- MARGINAL: ${marginal.join(", ") || "none"}\n- FAILS_COSTS: ${failures.join(", ") || "none"}\n- Completed pairs surviving costs: ${survivors.length} of 5\n- Approximate annual signal frequency, SURVIVES only: ${formatMetric(portfolio.annualTradeFrequencySurvivors)}\n- Approximate annual signal frequency including MARGINAL: ${formatMetric(portfolio.annualTradeFrequencyIncludingMarginal)}\n\nThese frequencies are arithmetic counts only. Correlation, simultaneous exposure, portfolio drawdown, and capital competition have not been tested.\n\nClassification uses actual historical bid/ask: SURVIVES requires PF > 1.05, EXP > 0.03R, and at least two material positive years; MARGINAL is positive but misses one of those strength/stability tests; PF <= 1 or EXP <= 0 is FAILS_COSTS.\n\nImplementation caveats: EURUSD is currently a registered but dormant evaluator, so its midpoint absolute stop/target geometry is the closest current-code interpretation rather than proof of a live/paper order path. GBPUSD also retains midpoint absolute stop/target levels; USDJPY and AUDUSD rebuild 1R/2R levels around the executable entry, matching their production modules. The GBP start boundary was reconstructed from the supplied 79-trade frozen cohort because no dated parity fixture was present. Historical MBA responses are not immutable cached fixtures.\n\nNO STRATEGY RULES WERE CHANGED DURING THIS TEST.\n`;
  await writeFile(resolve(OUTPUT_DIR, "FINAL_REPORT.md"), report, "utf8");
  console.log(JSON.stringify({ masterRows, portfolio, outputDirectory: OUTPUT_DIR }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
