import assert from "node:assert/strict";
import { formatTradePL } from "../src/lib/format/trade-pl";

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
