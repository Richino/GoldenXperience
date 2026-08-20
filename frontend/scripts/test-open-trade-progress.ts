import assert from "node:assert/strict";
import {
  openTradeProgress,
  quoteToUsdRateFromQuotes,
  resolveOpenTradeQuote,
} from "../src/lib/open-trade-progress";

// USD-quoted fill money is already account cash: move × units.
const eurUsd = openTradeProgress({
  direction: "long",
  instrument: "EUR_USD",
  entry: 1.1,
  stop: 1.09,
  target: 1.12,
  bid: 1.105,
  ask: 1.1052,
  fill: { price: 1.1, units: 20_000 },
  quoteToUsdRate: 1,
});
assert.ok(eurUsd);
assert.ok(Math.abs(eurUsd.money! - 100) < 1e-9, `EUR_USD money ${eurUsd.money}`);

// AUD/JPY fill money is yen until converted. Without a rate the old path would
// label ~¥21k as $21k; with USD/JPY the figure must shrink by ~150×.
const audJpyRaw = openTradeProgress({
  direction: "long",
  instrument: "AUD_JPY",
  entry: 97.0,
  stop: 96.5,
  target: 98.5,
  bid: 97.105,
  ask: 97.12,
  fill: { price: 97.0, units: 200_000 },
  riskAmount: 200,
  // No rate: fall back to R × risk rather than show yen as dollars.
});
assert.ok(audJpyRaw);
assert.ok(
  Math.abs(audJpyRaw.money! - audJpyRaw.unrealizedR * 200) < 1e-9,
  `fallback money ${audJpyRaw.money}`,
);

const usdJpy = 150;
const audJpy = openTradeProgress({
  direction: "long",
  instrument: "AUD_JPY",
  entry: 97.0,
  stop: 96.5,
  target: 98.5,
  bid: 97.105,
  ask: 97.12,
  fill: { price: 97.0, units: 200_000 },
  quoteToUsdRate: 1 / usdJpy,
});
assert.ok(audJpy);
// move = 0.105 JPY × 200_000 = ¥21,000 → $140 at 150.
assert.ok(Math.abs(audJpy.money! - 140) < 1e-9, `AUD_JPY money ${audJpy.money}`);
assert.ok(audJpy.money! < 1_000, "converted money must not look like raw yen");

// Quote→USD from a live map: JPY via USD_JPY inverse.
const rate = quoteToUsdRateFromQuotes("AUD_JPY", {
  USD_JPY: { bid: 149.9, ask: 150.1 },
});
assert.ok(rate);
assert.ok(Math.abs(rate! - 1 / 150) < 1e-9, `JPY rate ${rate}`);

assert.equal(quoteToUsdRateFromQuotes("EUR_USD", {}), 1);
assert.equal(quoteToUsdRateFromQuotes("AUD_JPY", {}), null);

// USD_CAD resolves CAD→USD from the pair's own mid.
const cadRate = quoteToUsdRateFromQuotes("USD_CAD", {
  USD_CAD: { bid: 1.34, ask: 1.36 },
});
assert.ok(cadRate);
assert.ok(Math.abs(cadRate! - 1 / 1.35) < 1e-9, `CAD rate ${cadRate}`);

// Without a stream tick, the broker mid still marks the row so it is not stuck
// on "Open". A live bid/ask wins when both are present.
assert.deepEqual(resolveOpenTradeQuote(undefined, 112.9), {
  bid: 112.9,
  ask: 112.9,
});
assert.equal(resolveOpenTradeQuote(undefined, null), undefined);
assert.deepEqual(
  resolveOpenTradeQuote({ bid: 1.1, ask: 1.1002 }, 1.05),
  { bid: 1.1, ask: 1.1002 },
);

// Mid-only mark is enough to produce progress + money via the paper path.
const cadMark = resolveOpenTradeQuote(undefined, 1.377);
assert.ok(cadMark);
const midOnly = openTradeProgress({
  direction: "short",
  instrument: "USD_CAD",
  entry: 1.37825,
  stop: 1.37999,
  target: 1.37477,
  bid: cadMark.bid,
  ask: cadMark.ask,
  riskAmount: 100,
});
assert.ok(midOnly, "broker mid must unlock progress when the stream is quiet");
assert.ok(midOnly.money !== null, "paper money should land from risk × R");

console.log("Open trade progress checks passed.");
