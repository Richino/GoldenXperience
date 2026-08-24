import type { Currency, Direction } from "../types.js";
import { splitPair } from "./momentum/currency-strength.js";

/**
 * Map strong/weak currencies to an executable pair + direction.
 * Unit-tested: inversion must flip direction correctly.
 */
export function pairFromCurrencies(
  strong: Currency,
  weak: Currency,
  universe: readonly string[],
): { instrument: string; direction: Direction } | null {
  if (strong === weak) return null;
  const direct = `${strong}_${weak}`;
  const inverted = `${weak}_${strong}`;
  if (universe.includes(direct)) return { instrument: direct, direction: "long" };
  if (universe.includes(inverted)) return { instrument: inverted, direction: "short" };
  return null;
}

/**
 * Carry differential in *pair* orientation: baseRate - quoteRate.
 * Positive → favors LONG the pair (earn higher-yielding base vs quote).
 */
export function pairCarryDifferential(
  instrument: string,
  rateByCcy: Map<Currency, number>,
): number | null {
  const { base, quote } = splitPair(instrument);
  const br = rateByCcy.get(base);
  const qr = rateByCcy.get(quote);
  if (br == null || qr == null) return null;
  return br - qr;
}

/**
 * Does carry favor this trade direction?
 * LONG favored when pairCarryDiff > 0; SHORT when < 0.
 */
export function carryFavorsDirection(pairCarryDiff: number, direction: Direction, eps = 0): boolean {
  if (direction === "long") return pairCarryDiff > eps;
  return pairCarryDiff < -eps;
}

/**
 * Does momentum favor this trade?
 * strong vs weak: LONG instrument means we want base=strong or quote=weak appropriately.
 * Simpler: momSpread = strongMom - weakMom > 0 always if ranks correct;
 * for inverted pair (SHORT), momentum still favors the trade by construction.
 */
export function momentumFavorsTrade(strongMom: number, weakMom: number, minSpread = 0): boolean {
  return strongMom - weakMom > minSpread;
}

/** Limit currency concentration: reject if adding would exceed maxPerCurrency. */
export function wouldBreachExposure(
  open: Array<{ instrument: string; direction: Direction }>,
  next: { instrument: string; direction: Direction },
  maxPerCurrency: number,
): boolean {
  const exposure = new Map<Currency, number>();
  const bump = (inst: string, dir: Direction, sign: number) => {
    const { base, quote } = splitPair(inst);
    // Long base/quote: +1 base, -1 quote; short flips
    if (dir === "long") {
      exposure.set(base, (exposure.get(base) ?? 0) + sign);
      exposure.set(quote, (exposure.get(quote) ?? 0) - sign);
    } else {
      exposure.set(base, (exposure.get(base) ?? 0) - sign);
      exposure.set(quote, (exposure.get(quote) ?? 0) + sign);
    }
  };
  for (const p of open) bump(p.instrument, p.direction, 1);
  bump(next.instrument, next.direction, 1);
  for (const v of exposure.values()) {
    if (Math.abs(v) > maxPerCurrency) return true;
  }
  return false;
}
