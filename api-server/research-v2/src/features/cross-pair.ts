/**
 * Cross-pair / currency-level strength features.
 * Built from a snapshot of mid closes at the same timestamp across the universe.
 */

export type Currency = "USD" | "EUR" | "GBP" | "JPY" | "AUD" | "NZD" | "CAD" | "CHF";

const CURRENCIES: Currency[] = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"];

export function splitPair(instrument: string): { base: Currency; quote: Currency } | null {
  const [base, quote] = instrument.split("_") as [Currency, Currency];
  if (!base || !quote) return null;
  return { base, quote };
}

/**
 * Approximate log currency strength: for each pair, attribute half the
 * log-return to base (+), half to quote (−). Aggregate across available pairs.
 */
export function currencyStrength(
  pairReturns: Record<string, number>,
): Record<Currency, number> {
  const scores: Record<Currency, number> = Object.fromEntries(CURRENCIES.map((c) => [c, 0])) as Record<Currency, number>;
  const counts: Record<Currency, number> = Object.fromEntries(CURRENCIES.map((c) => [c, 0])) as Record<Currency, number>;

  for (const [pair, ret] of Object.entries(pairReturns)) {
    const parts = splitPair(pair);
    if (!parts) continue;
    scores[parts.base] += ret;
    scores[parts.quote] -= ret;
    counts[parts.base] += 1;
    counts[parts.quote] += 1;
  }
  for (const c of CURRENCIES) {
    if (counts[c]! > 0) scores[c]! /= counts[c]!;
  }
  return scores;
}

export function crossPairFeatures(
  instrument: string,
  pairReturns1: Record<string, number>,
  pairReturns12: Record<string, number>,
  strength1: Record<Currency, number>,
  strength12: Record<Currency, number>,
): Record<string, number> {
  const parts = splitPair(instrument);
  const out: Record<string, number> = {
    usd_str_1: strength1.USD ?? 0,
    eur_str_1: strength1.EUR ?? 0,
    gbp_str_1: strength1.GBP ?? 0,
    jpy_str_1: strength1.JPY ?? 0,
    usd_str_12: strength12.USD ?? 0,
    eur_str_12: strength12.EUR ?? 0,
    gbp_str_12: strength12.GBP ?? 0,
    jpy_str_12: strength12.JPY ?? 0,
  };
  if (!parts) return out;

  const pairRet1 = pairReturns1[instrument] ?? 0;
  const pairRet12 = pairReturns12[instrument] ?? 0;
  const basket1 = (strength1[parts.base] ?? 0) - (strength1[parts.quote] ?? 0);
  const basket12 = (strength12[parts.base] ?? 0) - (strength12[parts.quote] ?? 0);

  out.base_str_1 = strength1[parts.base] ?? 0;
  out.quote_str_1 = strength1[parts.quote] ?? 0;
  out.base_str_12 = strength12[parts.base] ?? 0;
  out.quote_str_12 = strength12[parts.quote] ?? 0;
  out.pair_minus_basket_1 = pairRet1 - basket1;
  out.pair_minus_basket_12 = pairRet12 - basket12;
  out.rel_trend = basket12;
  out.xs_mom_rank = 0; // filled by panel builder when ranking available

  // JPY-specific structure (motivated by 001 pocket; usable on any pair)
  const jpy1 = strength1.JPY ?? 0;
  const jpy12 = strength12.JPY ?? 0;
  const usd12 = strength12.USD ?? 0;
  const eur12 = strength12.EUR ?? 0;
  out.jpy_str_accel = jpy1 - jpy12 / 12;
  out.usd_minus_jpy_12 = usd12 - jpy12;
  out.eur_minus_jpy_12 = eur12 - jpy12;
  out.jpy_involved = parts.base === "JPY" || parts.quote === "JPY" ? 1 : 0;

  // Dispersion across JPY crosses when available
  const jpyCrossRets = Object.entries(pairReturns12)
    .filter(([p]) => p.includes("JPY"))
    .map(([, r]) => r);
  if (jpyCrossRets.length >= 2) {
    const mu = jpyCrossRets.reduce((a, b) => a + b, 0) / jpyCrossRets.length;
    const varSum = jpyCrossRets.reduce((a, r) => a + (r - mu) * (r - mu), 0) / jpyCrossRets.length;
    out.jpy_cross_dispersion = Math.sqrt(varSum);
    out.jpy_cross_mean_12 = mu;
    const mine = pairReturns12[instrument] ?? 0;
    out.jpy_pair_vs_jpy_basket = mine - mu;
  } else {
    out.jpy_cross_dispersion = 0;
    out.jpy_cross_mean_12 = 0;
    out.jpy_pair_vs_jpy_basket = 0;
  }

  return out;
}

/** Rank instrument's 12-bar return among universe (0..1). */
export function crossSectionalRank(instrument: string, pairReturns12: Record<string, number>): number {
  const vals = Object.entries(pairReturns12);
  if (vals.length < 2) return 0.5;
  const mine = pairReturns12[instrument];
  if (mine == null) return 0.5;
  const below = vals.filter(([, v]) => v <= mine).length;
  return below / vals.length;
}
