/**
 * Unit-style assertions for carry / pair orientation (run via hunt preflight).
 */
import { pairFromCurrencies, pairCarryDifferential, carryFavorsDirection } from "./pairs.js";
import type { Currency } from "./types.js";

export function runPairOrientationSelfTest(): void {
  const uni = ["EUR_USD", "USD_JPY", "GBP_USD", "AUD_USD", "EUR_JPY"] as const;

  const a = pairFromCurrencies("USD", "JPY", uni);
  if (!a || a.instrument !== "USD_JPY" || a.direction !== "long") {
    throw new Error(`expected USD/JPY long, got ${JSON.stringify(a)}`);
  }

  const b = pairFromCurrencies("USD", "EUR", uni);
  if (!b || b.instrument !== "EUR_USD" || b.direction !== "short") {
    throw new Error(`expected EUR_USD short when USD strong / EUR weak, got ${JSON.stringify(b)}`);
  }

  const c = pairFromCurrencies("GBP", "USD", uni);
  if (!c || c.instrument !== "GBP_USD" || c.direction !== "long") {
    throw new Error(`expected GBP_USD long, got ${JSON.stringify(c)}`);
  }

  const rates = new Map<Currency, number>([
    ["USD", 4.1],
    ["JPY", 0.9],
    ["EUR", 2.0],
  ]);
  const dUsdJpy = pairCarryDifferential("USD_JPY", rates);
  if (dUsdJpy == null || Math.abs(dUsdJpy - 3.2) > 1e-9) throw new Error(`USD_JPY carry ${dUsdJpy}`);
  if (!carryFavorsDirection(dUsdJpy, "long")) throw new Error("USD_JPY long should be favored");

  const dEurUsd = pairCarryDifferential("EUR_USD", rates);
  if (dEurUsd == null || Math.abs(dEurUsd - (2.0 - 4.1)) > 1e-9) throw new Error(`EUR_USD carry ${dEurUsd}`);
  // US rates > EUR → favor SHORT EUR_USD
  if (!carryFavorsDirection(dEurUsd, "short")) throw new Error("EUR_USD short should be favored when US>EUR");

  console.log("pair orientation self-test OK");
}
