import assert from "node:assert/strict";
import { parseAutoTradeLimits } from "../src/trade-plan-settings.js";
import { TradePlanError } from "../src/trade-plans.js";

/** Auto trade limit validation (no database). */
const ok = { maxRiskPercent: 1, maxAggregateRiskPercent: 3, maxOpenPositions: 3, dailyLossLimitPercent: 3 };
assert.deepEqual(parseAutoTradeLimits(ok), ok);
assert.deepEqual(parseAutoTradeLimits({ ...ok, maxRiskPercent: "0.5" }), { ...ok, maxRiskPercent: 0.5 }, "numeric strings are accepted");
for (const bad of [
  { maxRiskPercent: 0 }, { maxRiskPercent: 6 }, { maxRiskPercent: "x" },
  { maxAggregateRiskPercent: 25 }, { maxOpenPositions: 0 }, { maxOpenPositions: 2.5 },
  { dailyLossLimitPercent: -1 }, { maxRiskPercent: 4, maxAggregateRiskPercent: 3 },
]) {
  assert.throws(() => parseAutoTradeLimits({ ...ok, ...bad }), TradePlanError, JSON.stringify(bad));
}
assert.throws(() => parseAutoTradeLimits({ ...ok, maxOpenPositions: 2.5 }), /whole number/);
console.log("trade plan settings: all checks passed");
