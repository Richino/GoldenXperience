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
  usdPerUnitOfCurrency,
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
// USD as the base (USD/JPY): 1/price is the correct quote->USD rate, so the
// no-rate call is already right.
assert.ok(
  Math.abs(getPipValuePerStandardLot("USD_JPY", 156.78) - 1_000 / 156.78) < 1e-9,
);
// A true cross needs the quote currency's USD value from a second pair. With
// USD/JPY at 150, one JPY is 1/150 USD, so a GBP/JPY pip on a standard lot is
// 1000 JPY * (1/150) = $6.67 — not the 1000/218.32 the pair's own price implies.
assert.ok(
  Math.abs(getPipValuePerStandardLot("GBP_JPY", 218.32, 1 / 150) - 1_000 / 150) < 1e-9,
);
// usdPerUnitOfCurrency resolves that rate from whichever major carries the
// currency: inverse for a USD-base pair, direct for a quote-side pair.
const jpyToUsd = usdPerUnitOfCurrency("JPY", (instrument) => (instrument === "USD_JPY" ? 150 : null));
assert.ok(jpyToUsd !== null && Math.abs(jpyToUsd - 1 / 150) < 1e-12);
assert.equal(usdPerUnitOfCurrency("USD", () => null), 1);
const gbpToUsd = usdPerUnitOfCurrency("GBP", (instrument) => (instrument === "GBP_USD" ? 1.27 : null));
assert.ok(gbpToUsd !== null && Math.abs(gbpToUsd - 1.27) < 1e-12);
assert.equal(usdPerUnitOfCurrency("JPY", () => null), null, "no USD pair means no rate");

// Position sizing works end to end on a JPY cross when the cross rate is given.
const gbpJpy = calculatePositionSize({
  instrument: "GBP_JPY",
  accountBalance: 10_000,
  riskPercent: 1,
  entry: 218.32,
  stop: 217.82,
  quoteToUsdRate: 1 / 150,
});
assert.ok(gbpJpy, "GBP_JPY should size");
assert.ok(Math.abs(gbpJpy.stopDistancePips - 50) < 0.0001);
assert.ok(gbpJpy.units > 0);
assert.ok(gbpJpy.estimatedRisk <= 100);
// The estimated risk lands on the intended 1% regardless of the pip value, so
// the win here is a correctly sized position, not a different risk figure.
assert.ok(Math.abs(gbpJpy.estimatedRisk - 100) < 5, "risk stays ~1% of balance");

console.log("instrument catalog checks passed");
