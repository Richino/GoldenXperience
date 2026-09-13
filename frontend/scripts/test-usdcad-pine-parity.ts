import assert from "node:assert/strict";
import { evaluateUsdcadStructureEmaReclaimV3, evaluateUsdcadStrategy } from "../src/lib/strategy/strategies/usdcad-strategy.js";
import type { Candle } from "../src/types/forex.js";
const start = Date.parse("2026-01-01T00:00:00.000Z");
function candles(kind: "high" | "base" | "no_structure" | "previous_above_ema" | "current_below_ema"): Candle[] {
  const rows: Candle[] = Array.from({ length: 60 }, (_, index) => { const open = 1.4 - index * .001; const close = open - .0004; return { time: new Date(start + index * 3_600_000).toISOString(), open, high: open + .0002, low: close - .0002, close, volume: 1, complete: true }; });
  const prior = rows.at(-2)!; const current = rows.at(-1)!;
  if (kind === "previous_above_ema") rows[rows.length - 2] = { ...prior, open: 1.6, low: 1.59, high: 1.61, close: 1.6 };
  const lastPrior = rows.at(-2)!;
  const close = kind === "current_below_ema" ? lastPrior.close - .001 : 1.45;
  const high = kind === "base" ? close + 1 : close + .01;
  const low = kind === "no_structure" ? lastPrior.low - .001 : lastPrior.low + .00001;
  rows[rows.length - 1] = { ...current, open: close, high, low, close };
  return rows;
}
const high = evaluateUsdcadStructureEmaReclaimV3(candles("high"));
assert.equal(high.originTime, "2026-01-03T11:00:00.000Z"); assert.equal(high.strategySignalQualified, true); assert.equal(high.highConfidenceLong, true); assert.equal(high.signalTag, "USDCAD_1100_LONG_PEN_EXTREME");
const base = evaluateUsdcadStructureEmaReclaimV3(candles("base"));
assert.equal(base.strategySignalQualified, true); assert.equal(base.highConfidenceLong, false); assert.equal(base.signalTag, "USDCAD_1100_LONG_BASE");
assert.equal(evaluateUsdcadStructureEmaReclaimV3(candles("no_structure")).strategySignalQualified, false);
assert.equal(evaluateUsdcadStructureEmaReclaimV3(candles("previous_above_ema")).strategySignalQualified, false);
assert.equal(evaluateUsdcadStructureEmaReclaimV3(candles("current_below_ema")).strategySignalQualified, false);
const input = { instrument: "USD_CAD" as const, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda" as const, candles15m: [], candles1h: candles("base"), candles4h: [], bid: 1.4, ask: 1.401, spreadPips: 999, marketOpen: false, calendarConnected: false, highImpactNewsWithinMinutes: 1, evaluationMode: "live" as const };
const candidate = evaluateUsdcadStrategy(input); assert.equal(candidate.features.usdcadStrategy?.strategySignalQualified, true); assert.equal(candidate.features.usdcadStrategy?.executionAllowed, true, "base entries are not filtered by spread, news, session, PEN, or extreme");
console.log("usdcad frozen Pine evaluator: PASS (raw reclaim entries, PEN/extreme metadata only)");
