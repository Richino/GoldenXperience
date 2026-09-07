import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  evaluateEurusdStrategyTrace, type EurusdStrategyTraceRow,
} from "../src/lib/strategy/strategies/eurusd-strategy";
import type { Candle } from "../src/types/forex";

type ExpectedRow = Partial<EurusdStrategyTraceRow> & { timestamp: string };
type ParityFixture = {
  symbol: "EUR_USD";
  timeframe: "H1";
  tolerance?: number;
  candles: Candle[];
  expected: ExpectedRow[];
};

const numericFields = new Set<keyof EurusdStrategyTraceRow>([
  "asiaHigh", "asiaLow", "ema20", "ema50", "atr14", "body", "entry", "stop", "target",
]);

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) throw new Error("Usage: npm run eurusd-strategy:parity -- <pine-fixture.json>");
  const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8")) as ParityFixture;
  assert.equal(fixture.symbol, "EUR_USD");
  assert.equal(fixture.timeframe, "H1");
  const tolerance = fixture.tolerance ?? 1e-10;
  const actual = evaluateEurusdStrategyTrace(fixture.candles);
  assert.equal(actual.error, null, actual.error ?? undefined);
  const byTimestamp = new Map(actual.rows.map((row) => [row.timestamp, row]));

  for (const expected of fixture.expected) {
    const row = byTimestamp.get(expected.timestamp);
    assert.ok(row, `No computed row for ${expected.timestamp}`);
    for (const [rawKey, expectedValue] of Object.entries(expected)) {
      const key = rawKey as keyof EurusdStrategyTraceRow;
      const actualValue: EurusdStrategyTraceRow[keyof EurusdStrategyTraceRow] = row[key];
      if (numericFields.has(key) && typeof expectedValue === "number" && typeof actualValue === "number") {
        assert.ok(Math.abs(actualValue - expectedValue) <= tolerance,
          `${expected.timestamp} ${key}: expected ${expectedValue}, got ${actualValue}`);
      } else {
        assert.deepEqual(actualValue, expectedValue, `${expected.timestamp} ${key}`);
      }
    }
  }
  console.log(`eurusd_strategy Pine parity passed for ${fixture.expected.length} candles`);
}

await main();
