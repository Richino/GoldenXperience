import assert from "node:assert/strict";
import { brokerUnitsForOrder, calculatePositionSize, MAX_NOTIONAL_MULTIPLE, notionalUsd } from "../src/lib/risk/engine";
import type { MajorInstrument } from "../src/types/forex";

/**
 * The broker-order margin guard. Pure: no database, no network, no broker.
 *
 * Proves the cap bounds what OANDA is asked to fill on every pair shape, while
 * leaving the recorded research position — and therefore every R-based
 * statistic — completely untouched.
 */
const BALANCE = 90_249;
const CAP = BALANCE * MAX_NOTIONAL_MULTIPLE;

console.log(`broker cap = ${MAX_NOTIONAL_MULTIPLE}x balance = $${CAP.toLocaleString()}`);
assert.equal(MAX_NOTIONAL_MULTIPLE, 3, "the deployed guard is 3x account equity");

// ---------------------------------------------------------------- notionalUsd
// units * price is an amount of the QUOTE currency; the quote->USD rate carries
// it to USD. This is what the cap divides by, so it is verified per pair shape.
{
  assert.ok(Math.abs(notionalUsd("EUR_USD" as MajorInstrument, 100_000, 1.10)! - 110_000) < 1e-6, "USD quote");
  assert.ok(Math.abs(notionalUsd("USD_JPY" as MajorInstrument, 100_000, 150)! - 100_000) < 1e-6, "USD base");
  const cross = notionalUsd("AUD_JPY" as MajorInstrument, 100_000, 98, 1 / 150)!;
  assert.ok(Math.abs(cross - (100_000 * 98) / 150) < 1e-6, "true cross needs the supplied rate");
  assert.equal(notionalUsd("EUR_USD" as MajorInstrument, -100_000, 1.10), notionalUsd("EUR_USD" as MajorInstrument, 100_000, 1.10),
    "a short has the same notional as a long");
}
console.log("notionalUsd correct on USD-quote, USD-base and true-cross: OK");

// ---------------------------------------------------------------- the real rejections
// Every one of these was cancelled by OANDA for INSUFFICIENT_MARGIN on 2026-08-21.
const REJECTED: Array<{ instrument: MajorInstrument; price: number; rate?: number; units: number }> = [
  { instrument: "AUD_USD" as MajorInstrument, price: 0.65000, units: 1_484_110 },
  { instrument: "EUR_USD" as MajorInstrument, price: 1.10000, units: 1_192_384 },
  { instrument: "USD_CHF" as MajorInstrument, price: 0.80000, units: 870_499 },
  { instrument: "EUR_GBP" as MajorInstrument, price: 0.85000, rate: 1.27, units: 619_058 },
  { instrument: "AUD_USD" as MajorInstrument, price: 0.65000, units: 825_261 },
];
for (const r of REJECTED) {
  const sized = brokerUnitsForOrder({
    instrument: r.instrument, requestedUnits: r.units, price: r.price,
    accountBalance: BALANCE, quoteToUsdRate: r.rate,
  });
  assert.equal(sized.capped, true, `${r.instrument} was a margin rejection and must now be scaled down`);
  assert.ok(sized.notionalUsd! <= CAP + 1, `${r.instrument} must sit inside the cap`);
  assert.ok(sized.units < sized.requestedUnits, `${r.instrument} must shrink`);
  assert.ok(sized.units >= 1, `${r.instrument} must still be a tradeable order`);
  const leverage = sized.notionalUsd! / BALANCE;
  assert.ok(leverage <= MAX_NOTIONAL_MULTIPLE + 1e-6, `${r.instrument} leverage ${leverage} must not exceed the cap`);
  console.log(`   ${r.instrument.padEnd(8)} ${String(r.units).padStart(9)} -> ${String(sized.units).padStart(7)} units  (${leverage.toFixed(1)}x)`);
}
console.log("every historically rejected order now fits inside margin: OK");

// ---------------------------------------------------------------- normal orders untouched
{
  const modest = brokerUnitsForOrder({ instrument: "EUR_USD" as MajorInstrument, requestedUnits: 90_000, price: 1.10, accountBalance: BALANCE });
  assert.equal(modest.capped, false, "an order well inside margin must pass through");
  assert.equal(modest.units, 90_000, "and must not be altered at all");
}
// exactly at the cap is not over it
{
  const exact = brokerUnitsForOrder({ instrument: "EUR_USD" as MajorInstrument, requestedUnits: Math.floor(CAP / 1.10), price: 1.10, accountBalance: BALANCE });
  assert.equal(exact.capped, false, "a position exactly at the ceiling is allowed");
}
console.log("orders inside the cap pass through byte-for-byte: OK");

// ---------------------------------------------------------------- fail safe
{
  const unvaluable = brokerUnitsForOrder({ instrument: "EUR_USD" as MajorInstrument, requestedUnits: 500_000, price: 0, accountBalance: BALANCE });
  assert.equal(unvaluable.capped, false, "an unvaluable notional must not be guessed at");
  assert.equal(unvaluable.units, 500_000, "the calculated size is sent unchanged rather than invented");
  const noBalance = brokerUnitsForOrder({ instrument: "EUR_USD" as MajorInstrument, requestedUnits: 500_000, price: 1.1, accountBalance: 0 });
  assert.equal(noBalance.capped, false, "a zero balance cannot produce a meaningful cap");
}
console.log("fail-safe when the notional or balance cannot be valued: OK");

// ---------------------------------------------------------------- research untouched
// The whole point of putting the guard at the broker boundary: the recorded
// position, and therefore R, must be exactly what it was before.
{
  const research = calculatePositionSize({
    instrument: "EUR_USD" as MajorInstrument, accountBalance: 10_000, riskPercent: 1,
    entry: 1.1, stop: 1.0999, applyPaperCap: false,
  })!;
  assert.ok(research.calculatedStandardLots > 2, "research sizing still exceeds the 2-lot simulation cap");
  assert.equal(research.standardLots, research.calculatedStandardLots, "applyPaperCap:false still returns the uncapped position");
  assert.equal(research.capped, false, "the notional guard must not leak into the research calculation");
  assert.ok(Math.abs(research.calculatedEstimatedRisk - 100) < 1, "and the nominal 1% stake is preserved exactly");
}
console.log("calculatePositionSize is unchanged; nominal 1% research sizing intact: OK");

// scaling is proportional, so the order stays on the same instrument geometry
{
  const sized = brokerUnitsForOrder({ instrument: "EUR_USD" as MajorInstrument, requestedUnits: 1_000_000, price: 1.10, accountBalance: BALANCE });
  const ratio = sized.units / sized.requestedUnits;
  assert.ok(ratio > 0 && ratio < 1, "scaled down proportionally");
  assert.ok(Math.abs(sized.notionalUsd! - CAP) / CAP < 0.001, "scaled to the ceiling, not below it");
}
console.log("scaling lands on the ceiling, not arbitrarily under it: OK");

console.log("\nAll broker notional-cap assertions passed.");
