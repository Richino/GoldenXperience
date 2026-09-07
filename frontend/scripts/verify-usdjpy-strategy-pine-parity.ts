import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

import {
  evaluateUsdjpyStrategyTrace, type UsdjpyStrategyTraceRow,
} from "../src/lib/strategy/strategies/usdjpy-strategy";
import type { Candle } from "../src/types/forex";

type ExpectedRow = Partial<UsdjpyStrategyTraceRow> & { timestamp: string };
type ParityFixture = {
  symbol: "USD_JPY";
  timeframe: "H1";
  tolerance?: number;
  candles: Candle[];
  /** Rows exported from the supplied frozen Pine script, keyed by candle START. */
  expected: ExpectedRow[];
};

const numericFields = new Set<keyof UsdjpyStrategyTraceRow>([
  "preHigh", "preLow", "ema20", "ema50", "atr14", "body", "bodyATRRatio",
  "barRange", "signalPrice", "stop", "target",
]);

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
  let tradedUtcDay = false;
  const rangeHours = new Set<number>();
  const signals: Array<{ timestamp: string; direction: "LONG" }> = [];

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const date = new Date(bar.time);
    const key = date.toISOString().slice(0, 10);
    if (key !== day) {
      day = key;
      preHigh = null;
      preLow = null;
      rangeHours.clear();
      tradedUtcDay = false;
    }
    ema20 = ema20 === null ? bar.close : alpha20 * bar.close + (1 - alpha20) * ema20;
    ema50 = ema50 === null ? bar.close : alpha50 * bar.close + (1 - alpha50) * ema50;
    const priorClose = bars[index - 1]?.close ?? bar.close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - priorClose), Math.abs(bar.low - priorClose));
    if (atr === null) {
      trSeed.push(tr);
      if (trSeed.length === 14) atr = trSeed.reduce((sum, value) => sum + value, 0) / 14;
    } else {
      atr = (atr * 13 + tr) / 14;
    }
    const hour = date.getUTCHours();
    if (hour >= 8 && hour <= 10) {
      preHigh = preHigh === null ? bar.high : Math.max(preHigh, bar.high);
      preLow = preLow === null ? bar.low : Math.min(preLow, bar.low);
      rangeHours.add(hour);
    }
    const rangeReady = preHigh !== null && preLow !== null && rangeHours.size === 3;
    const trend = ema20 > ema50 ? 1 : ema20 < ema50 ? -1 : 0;
    const body = Math.abs(bar.close - bar.open);
    const barRange = bar.high - bar.low;
    const isOrigin = hour >= 11 && hour <= 14 && rangeReady && !tradedUtcDay && atr !== null && atr > 0 && trend === 1;
    const longSignal = isOrigin && bar.close > preHigh! && body >= atr! * 0.4
      && barRange > 0 && bar.close >= bar.high - barRange * 0.4;
    if (longSignal) {
      signals.push({ timestamp: bar.time, direction: "LONG" });
      tradedUtcDay = true;
    }
  }
  return signals;
}

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    loadEnvConfig(resolve(process.cwd(), "../api-server"));
    const { getResearchCandles } = await import("../src/lib/oanda/client");
    const oanda = await getResearchCandles("USD_JPY", "H1", 5_000);
    const candles: Candle[] = oanda.map((bar) => ({ time: bar.time, volume: bar.volume, complete: bar.complete, ...bar.mid }));
    const production = evaluateUsdjpyStrategyTrace(candles);
    assert.equal(production.error, null, production.error ?? undefined);
    const productionSignals: Array<{ timestamp: string; direction: "LONG" }> = [];
    for (const row of production.rows) {
      if (row.finalLongSignal) productionSignals.push({ timestamp: row.timestamp, direction: "LONG" });
    }
    const pineReference = pineReferenceSignals(candles);
    const match = JSON.stringify(productionSignals) === JSON.stringify(pineReference);
    console.log(JSON.stringify({
      source: "OANDA practice API, latest 5,000 completed H1 midpoint candles; frozen USDJPY V6 literal reference",
      candles: candles.filter((bar) => bar.complete).length,
      from: candles.find((bar) => bar.complete)?.time ?? null,
      to: candles.filter((bar) => bar.complete).at(-1)?.time ?? null,
      productionSignals,
      pineReferenceSignals: pineReference,
      match,
    }, null, 2));
    assert.deepEqual(productionSignals, pineReference, "Production entries differ from the literal supplied-Pine reference on identical OANDA candles.");
    return;
  }
  const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8")) as ParityFixture;
  assert.equal(fixture.symbol, "USD_JPY");
  assert.equal(fixture.timeframe, "H1");
  const tolerance = fixture.tolerance ?? 1e-9;
  const actual = evaluateUsdjpyStrategyTrace(fixture.candles);
  assert.equal(actual.error, null, actual.error ?? undefined);
  const byTimestamp = new Map(actual.rows.map((row) => [row.timestamp, row]));

  for (const expected of fixture.expected) {
    const row = byTimestamp.get(expected.timestamp);
    assert.ok(row, `No computed row for ${expected.timestamp}`);
    for (const [rawKey, expectedValue] of Object.entries(expected)) {
      const key = rawKey as keyof UsdjpyStrategyTraceRow;
      const actualValue: unknown = row[key];
      if (numericFields.has(key) && typeof expectedValue === "number" && typeof actualValue === "number") {
        assert.ok(Math.abs(actualValue - expectedValue) <= tolerance,
          `${expected.timestamp} ${key}: expected ${expectedValue}, got ${actualValue}`);
      } else {
        assert.deepEqual(actualValue, expectedValue, `${expected.timestamp} ${key}`);
      }
    }
  }
  console.log(`usdjpy_strategy Pine parity passed for ${fixture.expected.length} exported rows`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
