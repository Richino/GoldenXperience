import assert from "node:assert/strict";
import { formatTradePL } from "../src/lib/format/trade-pl";
import { chartTargetPL, chartTradePLColor } from "../src/lib/market-stream/chart-trade-pl";

assert.equal(formatTradePL(47.126, "USD"), "P/L +$47.13");
assert.equal(formatTradePL(-18.75, "USD"), "P/L −$18.75");
assert.equal(formatTradePL(0, "USD"), "P/L $0.00");
assert.equal(formatTradePL(-0.004, "USD"), "P/L $0.00");
assert.equal(formatTradePL(1250, "EUR"), "P/L +€1,250.00");
assert.equal(formatTradePL(1250, "JPY"), "P/L +¥1,250.00");
for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
  assert.equal(formatTradePL(value, "USD"), "P/L —");
}
assert.equal(formatTradePL(100, null), "P/L —");
assert.equal(formatTradePL(100, "invalid"), "P/L —");
console.log("Chart cash P/L formatting checks passed.");

const fill = { price: 1.1, units: 100_000 };
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

const yen = { price: 150, units: 10_000 };
assert.equal(chartTradePLColor(-10), "#e74c3c");
assert.equal(chartTradePLColor(10), "#00b377");
assert.equal(chartTradePLColor(-0.004), chartTradePLColor(0));
assert.equal(chartTradePLColor(null), chartTradePLColor(0));
near(chartTargetPL(fill, "EUR_USD", "long", "USD", 1.102), 200);
near(chartTargetPL(fill, "EUR_USD", "short", "USD", 1.098), 200);
near(chartTargetPL({ price: 1.11289, units: 1_041_152 }, "EUR_USD", "short", "USD", 1.11231), 603.86816);
near(chartTargetPL({ ...fill, units: 50_000 }, "EUR_USD", "long", "USD", 1.102), 100);
near(chartTargetPL(yen, "USD_JPY", "long", "USD", 152, { gain: 0.0065, loss: 0.0067 }), 130);
const eurGbp = { price: 0.83538, units: 359_222 };
const gbpConversion = { gain: 1.3142448, loss: 1.3407952 };
near(chartTargetPL(eurGbp, "EUR_GBP", "short", "USD", 0.83247, gbpConversion), 1373.827428537681);
near(chartTargetPL(eurGbp, "EUR_GBP", "short", "USD", 0.83699, gbpConversion), -775.4454446683843);
assert.equal(chartTargetPL(eurGbp, "EUR_GBP", "short", "USD", 0.83247), null);
assert.equal(chartTargetPL(eurGbp, "EUR_GBP", "short", "USD", 0.83699, { gain: 1.31, loss: NaN }), null);
assert.equal(chartTargetPL(eurGbp, "EUR_GBP", "short", "USD", eurGbp.price), 0);
assert.equal(chartTargetPL(undefined, "EUR_USD", "long", "USD", 1.102), null);
assert.equal(chartTargetPL(fill, "EUR_USD", "long", null, 1.102), null);
assert.equal(chartTargetPL(fill, "EUR_USD", "long", "USD", null), null);
assert.equal(chartTargetPL(fill, "EUR_USD", "long", "USD", NaN), null);
console.log("Target cash P/L passed: total profit, long/short symmetry, remaining broker size, account conversion and unavailable data.");
