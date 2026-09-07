import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  GBPUSD_STRATEGY_CONFIG_VERSION, GBPUSD_STRATEGY_NAME, GBPUSD_STRATEGY_VERSION,
  evaluateGbpusdStrategyTrace,
} from "../src/lib/strategy/strategies/gbpusd-strategy";
import type { Candle } from "../src/types/forex";

type Origin = "1030" | "1100" | "1130";
type Direction = "LONG" | "SHORT";
type Signal = { timestamp: string; origin: Origin; direction: Direction };
type PriceBar = { open: number; high: number; low: number; close: number };
type CachedCandle = { time: string; volume: number; complete: boolean; mid: PriceBar; bid: PriceBar; ask: PriceBar };
type ValidatedTrade = { signal: `${Origin}_${Direction}`; tv_entry_timestamp_utc: string; tv_result_r: number; exec_result_r: number };
type Metrics = { trades: number; wins: number; losses: number; winRatePct: number; profitFactor: number; totalR: number; expectancyR: number };
type RawResults = { metrics: { resolvedMid: Metrics; oandaExecutable: Metrics }; trades: ValidatedTrade[] };

const ROOT = resolve(process.cwd(), "../api-server/research-v2/gbpusd-frequency-v3-spread-validation");
const cache = JSON.parse(readFileSync(resolve(ROOT, "data/GBP_USD-M30-MBA.json"), "utf8")) as { candles: CachedCandle[] };
const validated = JSON.parse(readFileSync(resolve(ROOT, "RAW_RESULTS.json"), "utf8")) as RawResults;

function canonicalTime(value: string) {
  return new Date(value).toISOString();
}

function signalKey(signal: Signal) {
  return `${canonicalTime(signal.timestamp)}|${signal.origin}|${signal.direction}`;
}

/** Independent, literal state-machine port of the supplied Pine V3 source. */
function pineReferenceSignals(candles: Candle[]) {
  const bars = candles.filter((bar) => bar.complete).sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const alpha20 = 2 / 21;
  const alpha50 = 2 / 51;
  let ema20: number | null = null;
  let ema50: number | null = null;
  let atr: number | null = null;
  const trSeed: number[] = [];
  let day: string | null = null;
  let preHigh: number | null = null;
  let preLow: number | null = null;
  let rangeBars = 0;
  const signals: Signal[] = [];

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const date = new Date(bar.time);
    const key = date.toISOString().slice(0, 10);
    if (key !== day) {
      day = key;
      preHigh = null;
      preLow = null;
      rangeBars = 0;
    }
    ema20 = ema20 === null ? bar.close : alpha20 * bar.close + (1 - alpha20) * ema20;
    ema50 = ema50 === null ? bar.close : alpha50 * bar.close + (1 - alpha50) * ema50;
    const priorClose = bars[index - 1]?.close ?? bar.close;
    const trueRange = Math.max(bar.high - bar.low, Math.abs(bar.high - priorClose), Math.abs(bar.low - priorClose));
    if (atr === null) {
      trSeed.push(trueRange);
      if (trSeed.length === 14) atr = trSeed.reduce((sum, value) => sum + value, 0) / 14;
    } else {
      atr = (atr * 13 + trueRange) / 14;
    }

    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const origin: Origin | null = hour === 10 && minute === 30 ? "1030"
      : hour === 11 && minute === 0 ? "1100"
        : hour === 11 && minute === 30 ? "1130" : null;
    const expected = origin === "1030" ? 9 : origin === "1100" ? 10 : origin === "1130" ? 11 : 0;
    const rangeReady = origin !== null && rangeBars === expected && preHigh !== null && preLow !== null;
    const trend = ema20 > ema50 ? 1 : ema20 < ema50 ? -1 : 0;
    if (rangeReady && atr !== null && atr > 0) {
      if (trend === 1 && bar.close > preHigh!) signals.push({ timestamp: bar.time, origin, direction: "LONG" });
      if (origin !== "1130" && trend === -1 && bar.close < preLow!) signals.push({ timestamp: bar.time, origin, direction: "SHORT" });
    }

    const inPreRange = (hour >= 6 && hour < 11) || (hour === 11 && minute === 0);
    if (inPreRange) {
      preHigh = preHigh === null ? bar.high : Math.max(preHigh, bar.high);
      preLow = preLow === null ? bar.low : Math.min(preLow, bar.low);
      rangeBars += 1;
    }
  }
  return signals;
}

function calculatedMetrics(rows: number[]): Metrics {
  const wins = rows.filter((value) => value > 0);
  const losses = rows.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const totalR = rows.reduce((sum, value) => sum + value, 0);
  return {
    trades: rows.length, wins: wins.length, losses: losses.length,
    winRatePct: rows.length ? wins.length / rows.length * 100 : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : 0,
    totalR, expectancyR: rows.length ? totalR / rows.length : 0,
  };
}

function assertNear(actual: number, expected: number, label: string, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}

function assertFrozenMetrics(actual: Metrics, expected: Metrics, label: string) {
  assert.equal(actual.trades, expected.trades, `${label} trades`);
  assert.equal(actual.wins, expected.wins, `${label} wins`);
  assert.equal(actual.losses, expected.losses, `${label} losses`);
  assertNear(actual.winRatePct, expected.winRatePct, `${label} win rate`);
  assertNear(actual.profitFactor, expected.profitFactor, `${label} profit factor`);
  assertNear(actual.totalR, expected.totalR, `${label} total R`);
  assertNear(actual.expectancyR, expected.expectancyR, `${label} expectancy`);
}

const bars: Candle[] = cache.candles.map((bar) => ({
  time: canonicalTime(bar.time), volume: bar.volume, complete: bar.complete, ...bar.mid,
}));
const production = evaluateGbpusdStrategyTrace(bars);
assert.equal(production.error, null, production.error ?? undefined);
const productionSignals: Signal[] = production.rows.flatMap((row) => row.rawLongSignal || row.rawShortSignal ? [{
  timestamp: row.timestamp, origin: row.originCode!, direction: row.rawLongSignal ? "LONG" : "SHORT",
}] : []);
const reference = pineReferenceSignals(bars);
assert.deepEqual(productionSignals.map(signalKey), reference.map(signalKey), "Production diverged from the supplied Pine V3 state machine.");

const expected: Signal[] = validated.trades.map((trade) => {
  const match = /^(1030|1100|1130)_(LONG|SHORT)$/.exec(trade.signal);
  assert.ok(match, `Unexpected validated signal label: ${trade.signal}`);
  return { timestamp: canonicalTime(trade.tv_entry_timestamp_utc), origin: match[1] as Origin, direction: match[2] as Direction };
});
const first = Date.parse(expected.at(0)!.timestamp);
const last = Date.parse(expected.at(-1)!.timestamp);
const exactPeriodProduction = productionSignals.filter((signal) => {
  const time = Date.parse(signal.timestamp);
  return time >= first && time <= last;
});
const productionKeys = new Set(exactPeriodProduction.map(signalKey));
const expectedKeys = new Set(expected.map(signalKey));
const missingValidatedSignals = expected.filter((signal) => !productionKeys.has(signalKey(signal)));
const unexpectedProductionSignals = exactPeriodProduction.filter((signal) => !expectedKeys.has(signalKey(signal)));
assert.deepEqual(missingValidatedSignals.map(signalKey), ["2026-04-10T11:30:00.000Z|1130|LONG"], "The known TradingView/OANDA feed divergence changed.");
assert.deepEqual(unexpectedProductionSignals.map(signalKey), [], "OANDA produced an unexpected V3 signal in the frozen validation period.");
const feedDivergences = missingValidatedSignals.map((signal) => {
  const row = production.rows.find((item) => canonicalTime(item.timestamp) === canonicalTime(signal.timestamp));
  return {
    validatedSignal: signalKey(signal),
    oandaMidClose: bars.find((bar) => canonicalTime(bar.time) === canonicalTime(signal.timestamp))?.close ?? null,
    oandaPreRangeHigh: row?.preRangeHigh ?? null,
    oandaTrend: row?.trend ?? null,
    oandaBreakout: row?.breakout ?? null,
  };
});

const legCounts = Object.fromEntries(["1030_LONG", "1030_SHORT", "1100_LONG", "1100_SHORT", "1130_LONG"].map((label) => [
  label, validated.trades.filter((trade) => trade.signal === label).length,
]));
assert.deepEqual(legCounts, { "1030_LONG": 19, "1030_SHORT": 18, "1100_LONG": 24, "1100_SHORT": 18, "1130_LONG": 19 });
assert.equal(validated.trades.some((trade) => trade.signal === "1130_SHORT"), false);

const mid = calculatedMetrics(validated.trades.map((trade) => trade.tv_result_r));
const executable = calculatedMetrics(validated.trades.map((trade) => trade.exec_result_r));
assertFrozenMetrics(mid, validated.metrics.resolvedMid, "MID artifact");
assertFrozenMetrics(executable, validated.metrics.oandaExecutable, "OANDA EXEC artifact");
assert.deepEqual(
  { trades: mid.trades, wins: mid.wins, losses: mid.losses, winRatePct: Number(mid.winRatePct.toFixed(2)), profitFactor: Number(mid.profitFactor.toFixed(3)), totalR: Number(mid.totalR.toFixed(2)), expectancyR: Number(mid.expectancyR.toFixed(3)) },
  { trades: 98, wins: 43, losses: 55, winRatePct: 43.88, profitFactor: 1.514, totalR: 27.02, expectancyR: 0.276 },
  "Frozen MID target",
);
assert.deepEqual(
  { trades: executable.trades, wins: executable.wins, losses: executable.losses, winRatePct: Number(executable.winRatePct.toFixed(2)), profitFactor: Number(executable.profitFactor.toFixed(3)), totalR: Number(executable.totalR.toFixed(2)), expectancyR: Number(executable.expectancyR.toFixed(3)) },
  { trades: 98, wins: 44, losses: 54, winRatePct: 44.90, profitFactor: 1.332, totalR: 19.21, expectancyR: 0.196 },
  "Frozen OANDA EXEC target",
);

console.log(JSON.stringify({
  strategy: { name: GBPUSD_STRATEGY_NAME, version: GBPUSD_STRATEGY_VERSION, configVersion: GBPUSD_STRATEGY_CONFIG_VERSION },
  source: "Frozen OANDA M30 midpoint cache plus matched TradingView/OANDA 98-trade validation artifact",
  candlePeriod: { from: bars.at(0)?.time ?? null, to: bars.at(-1)?.time ?? null, candles: bars.length },
  cohortPeriod: { from: expected.at(0)?.timestamp ?? null, to: expected.at(-1)?.timestamp ?? null },
  pineSignalParity: true,
  exactValidatedCohortParity: missingValidatedSignals.length === 0 && unexpectedProductionSignals.length === 0,
  validatedSignals: expected.length,
  oandaGeneratedSignals: exactPeriodProduction.length,
  feedDivergences,
  validatedLegs: legCounts,
  mid, oandaExecutable: executable,
}, null, 2));
