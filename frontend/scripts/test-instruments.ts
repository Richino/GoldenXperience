import assert from "node:assert/strict";
import {
  INSTRUMENT_CATALOG,
  displayNameFor,
  findInstrument,
  isKnownInstrument,
  pipSizeFor,
  precisionFor,
} from "../src/lib/instruments/catalog";
import { flagCodeForCurrency, flagImageUrl } from "../src/lib/pair-flags";
import {
  calculatePositionSize,
  getPipValuePerStandardLot,
} from "../src/lib/risk/engine";

// The catalog is the full CURRENCY set from GET /v3/accounts/{id}/instruments.
assert.equal(INSTRUMENT_CATALOG.length, 68);
assert.equal(
  new Set(INSTRUMENT_CATALOG.map((item) => item.name)).size,
  INSTRUMENT_CATALOG.length,
  "instrument names must be unique",
);

// Every currency in the catalog needs a flag, or the avatar silently falls back
// to text initials and the search results look broken.
const currencies = [
  ...new Set(INSTRUMENT_CATALOG.flatMap((item) => item.name.split("_"))),
].sort();
assert.equal(currencies.length, 21);
const missingFlags = currencies.filter((code) => !flagCodeForCurrency(code));
assert.deepEqual(missingFlags, [], `currencies without a flag: ${missingFlags}`);
assert.equal(flagImageUrl("JPY"), "https://flagcdn.com/w40/jp.png");
assert.equal(flagImageUrl("ZZZ"), null);

// Pip size and precision are driven by OANDA's own pipLocation and
// displayPrecision. Deriving them from the symbol is what the old
// `instrument === "USD_JPY"` checks got wrong.
for (const info of INSTRUMENT_CATALOG) {
  assert.equal(pipSizeFor(info.name), 10 ** info.pipLocation, info.name);
  assert.equal(precisionFor(info.name), info.displayPrecision, info.name);
}

// A "quote currency is JPY" heuristic would still be wrong. Thirteen pairs use
// pipLocation -2 and they do not line up with the JPY suffix: HKD/JPY is
// JPY-quoted but quoted to 5dp, while HUF and THB crosses are 3dp.
const coarse = INSTRUMENT_CATALOG.filter((item) => item.pipLocation === -2);
assert.equal(coarse.length, 13);
assert.equal(pipSizeFor("GBP_JPY"), 0.01);
assert.equal(precisionFor("GBP_JPY"), 3);
assert.equal(pipSizeFor("HKD_JPY"), 0.0001, "JPY-quoted but a 5dp pair");
assert.equal(precisionFor("HKD_JPY"), 5);
assert.equal(pipSizeFor("EUR_HUF"), 0.01, "not JPY, still a 3dp pair");
assert.equal(pipSizeFor("USD_THB"), 0.01);
assert.equal(pipSizeFor("EUR_AUD"), 0.0001);
assert.equal(displayNameFor("USD_MXN"), "USD/MXN");

// pipLocation and displayPrecision stay consistent across the catalog.
for (const info of INSTRUMENT_CATALOG) {
  assert.equal(
    info.pipLocation === -2,
    info.displayPrecision === 3,
    `${info.name} pip/precision disagree`,
  );
}

// Unknown symbols fall back safely rather than throwing, and are rejected by
// the guard the API routes use.
assert.equal(pipSizeFor("FAKE_PAIR"), 0.0001);
assert.equal(displayNameFor("FAKE_PAIR"), "FAKE/PAIR");
assert.ok(isKnownInstrument("eur_usd"), "guard is case-insensitive");
assert.ok(!isKnownInstrument("FAKE_PAIR"));
assert.equal(findInstrument("GBP_JPY")?.displayPrecision, 3);

// USD-quoted pairs stay at the flat $10/pip for a standard lot.
assert.equal(getPipValuePerStandardLot("EUR_USD", 1.1), 10);
// The generalized formula must still reproduce the old USD/JPY special case.
assert.ok(
  Math.abs(getPipValuePerStandardLot("USD_JPY", 156.78) - 1_000 / 156.78) < 1e-9,
);
// And now yields a sane value for a cross the old code mispriced entirely.
assert.ok(
  Math.abs(getPipValuePerStandardLot("GBP_JPY", 218.32) - 1_000 / 218.32) < 1e-9,
);

// Position sizing works end to end on a JPY cross.
const gbpJpy = calculatePositionSize({
  instrument: "GBP_JPY",
  accountBalance: 10_000,
  riskPercent: 1,
  entry: 218.32,
  stop: 217.82,
});
assert.ok(gbpJpy, "GBP_JPY should size");
assert.ok(Math.abs(gbpJpy.stopDistancePips - 50) < 0.0001);
assert.ok(gbpJpy.units > 0);
assert.ok(gbpJpy.estimatedRisk <= 100);

console.log("instrument catalog checks passed");
