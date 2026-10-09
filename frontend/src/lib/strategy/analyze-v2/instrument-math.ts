import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";

/**
 * Pip and executable-price arithmetic. Instrument metadata (catalog.ts) is
 * the only source of pip size and display precision: EUR/USD 0.0001 a pip,
 * USD/JPY 0.01.
 *
 * Execution sides: a LONG is bought at the ASK and closed (stop or target)
 * at the BID; a SHORT is sold at the BID and closed at the ASK. Candles are
 * mid prices and are never used as executable prices.
 */

export type Side = "LONG" | "SHORT";

export interface Quote {
  bid: number;
  ask: number;
  /** ISO time of the quote. */
  time: string;
}

export function pipSize(instrument: string) {
  return pipSizeFor(instrument);
}

/** A price distance in pips (always positive). */
export function toPips(instrument: string, distance: number) {
  return Math.abs(distance) / pipSizeFor(instrument);
}

/** A pip count as a price distance. */
export function fromPips(instrument: string, pips: number) {
  return pips * pipSizeFor(instrument);
}

/** Pips between two prices. */
export function pipsBetween(instrument: string, a: number, b: number) {
  return toPips(instrument, a - b);
}

/** A price at the instrument's display precision. */
export function roundPrice(instrument: string, price: number) {
  return Number(price.toFixed(precisionFor(instrument)));
}

export function midOf(quote: Pick<Quote, "bid" | "ask">) {
  return (quote.bid + quote.ask) / 2;
}

export function spreadPipsOf(instrument: string, quote: Pick<Quote, "bid" | "ask">) {
  return toPips(instrument, quote.ask - quote.bid);
}

/** The price a market entry fills at: the ask for a long, the bid for a short. */
export function executableEntry(side: Side, quote: Pick<Quote, "bid" | "ask">) {
  return side === "LONG" ? quote.ask : quote.bid;
}

/** Which quote side closes the position (stop or target). */
export function exitSide(side: Side): "bid" | "ask" {
  return side === "LONG" ? "bid" : "ask";
}

/**
 * Reward/risk from executable prices: entry at the entry side, exits at the
 * exit side. Stop and target are trigger prices on the exit side, so the
 * spread is already inside the entry; it is not added again.
 */
export function executableRewardRisk(side: Side, entry: number, stop: number, target: number) {
  const risk = side === "LONG" ? entry - stop : stop - entry;
  const reward = side === "LONG" ? target - entry : entry - target;
  return risk > 0 && reward > 0 ? reward / risk : null;
}

/** LONG: target > entry > stop. SHORT: target < entry < stop. */
export function levelsAreOrdered(side: Side, entry: number, stop: number, target: number) {
  return side === "LONG" ? stop < entry && entry < target : target < entry && entry < stop;
}
