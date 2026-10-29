import assert from "node:assert/strict";
import { formatTradePL } from "../src/lib/format/trade-pl";
import { chartTargetPL, chartTradePL, chartTradePLColor } from "../src/lib/market-stream/chart-trade-pl";

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

const fill = { price: 1.1, units: 100_000, currentBid: 1.101, currentAsk: 1.1012, unrealizedPL: 100 };
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
near(chartTradePL(fill, "EUR_USD", "long", "USD", { bid: 1.1015, ask: 1.1017 }), 150);
near(chartTradePL(fill, "EUR_USD", "long", "USD", { bid: 1.098, ask: 1.0982 }), -200);
const short = { ...fill, unrealizedPL: -120 };
near(chartTradePL(short, "EUR_USD", "short", "USD", { bid: 1.1003, ask: 1.1005 }), -50);
near(chartTradePL(short, "EUR_USD", "short", "USD", { bid: 1.0993, ask: 1.0995 }), 50);
near(chartTradePL(fill, "EUR_USD", "long", "USD", { bid: 1.101, ask: 1.15 }), 100); // Ask cannot move a long's mark.
near(chartTradePL(short, "EUR_USD", "short", "USD", { bid: 1.09, ask: 1.1012 }), -120); // Bid cannot move a short's mark.
near(chartTradePL({ ...fill, unrealizedPL: 105 }, "EUR_USD", "long", "USD", { bid: 1.1015, ask: 1.1017 }), 155); // Broker rebase.
const yen = { price: 150, units: 10_000, currentBid: 151, currentAsk: 151.02, unrealizedPL: 10_000 / 151 };
near(chartTradePL(yen, "USD_JPY", "long", "USD", { bid: 152, ask: 152.02 }), 20_000 / 152);
near(chartTradePL({ ...yen, unrealizedPL: 70 }, "EUR_JPY", "long", "USD", { bid: 152, ask: 152.02 }), 140);
near(chartTradePL({ ...yen, price: 151, unrealizedPL: 0 }, "EUR_JPY", "long", "USD", { bid: 152, ask: 152.02 }), 0); // No invented cross conversion at break-even.
for (const quote of [null, { bid: NaN, ask: 1.102 }, { bid: 1.2, ask: 1.1 }]) {
  near(chartTradePL(fill, "EUR_USD", "long", "USD", quote), 100);
}
near(chartTradePL({ ...fill, currentBid: null }, "EUR_USD", "long", "USD", { bid: 1.102, ask: 1.103 }), 100);
assert.equal(chartTradePL(undefined, "EUR_USD", "long", "USD", { bid: 1.102, ask: 1.103 }), null);
assert.equal(chartTradePLColor(-10), "#e74c3c");
assert.equal(chartTradePLColor(10), "#00b377");
assert.equal(chartTradePLColor(-0.004), chartTradePLColor(0));
assert.equal(chartTradePLColor(null), chartTradePLColor(0));
console.log("Chart tick P/L passed: close-side marks, sign flips, broker rebases, currency conversion and unavailable-price fallback.");
near(chartTargetPL(fill, "EUR_USD", "long", "USD", 1.102), 200);
near(chartTargetPL(short, "EUR_USD", "short", "USD", 1.098), 200);
near(chartTargetPL({ ...short, price: 1.11289, units: 1_041_152 }, "EUR_USD", "short", "USD", 1.11231), 603.86816);
near(chartTargetPL({ ...fill, units: 50_000 }, "EUR_USD", "long", "USD", 1.102), 100);
near(chartTargetPL(yen, "USD_JPY", "long", "USD", 152), 20_000 / 152);
near(chartTargetPL({ ...yen, unrealizedPL: 70 }, "EUR_JPY", "long", "USD", 152), 140);
assert.equal(chartTargetPL(undefined, "EUR_USD", "long", "USD", 1.102), null);
assert.equal(chartTargetPL(fill, "EUR_USD", "long", null, 1.102), null);
assert.equal(chartTargetPL(fill, "EUR_USD", "long", "USD", null), null);
assert.equal(chartTargetPL(fill, "EUR_USD", "long", "USD", NaN), null);
console.log("Target cash P/L passed: total profit, long/short symmetry, remaining broker size, account conversion and unavailable data.");
