/**
 * Live figures for a paper trade that has not resolved yet: what it is worth
 * right now, and how far it has travelled from entry towards its target.
 *
 * Shared so the dashboard and the journal cannot drift apart on what "open" is
 * worth. Both read the same rule the outcome labeller uses: a long is marked
 * out on the bid and a short on the ask, because that is the side the position
 * would actually close against.
 */
export interface OpenTradeQuote {
  bid: number | null | undefined;
  ask: number | null | undefined;
}

export interface OpenTradeInput extends OpenTradeQuote {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  /**
   * The cash this trade risks between entry and stop. Money is derived from it
   * rather than from position size so an open trade reads on the same scale as
   * the settled `paperPl` beside it. Null when unknown, and money is then
   * omitted rather than guessed.
   */
  riskAmount?: number | null;
  /**
   * The broker's real fill and size, when the trade was actually executed.
   *
   * The recorded `entry` is the price the strategy decided on; the fill can be
   * a pip or more away and lands minutes later. On a position of a few hundred
   * thousand units that gap is tens of dollars, which is enough to put the
   * paper model and the account on opposite sides of zero. When a fill is
   * known it wins, so a row agrees with the account balance above it.
   */
  fill?: { price: number; units: number } | null;
}

export interface OpenTradeProgress {
  /** Marked against the side the position would close on. */
  price: number;
  /** Unrealised result in R, negative while the trade is under water. */
  unrealizedR: number;
  /** Unrealised cash, or null when the risk amount is unknown. */
  money: number | null;
  /**
   * Which level the trade is currently travelling towards, and how far it has
   * covered of entry → that level, clamped to 0–100.
   *
   * A losing trade reported as "3% to TP" says nothing useful — the number that
   * matters then is how close the stop is. So the reading follows the side the
   * price is actually on rather than always quoting the target.
   */
  towards: "target" | "stop";
  percent: number;
}

export function openTradeProgress(input: OpenTradeInput): OpenTradeProgress | null {
  const { direction, entry, stop, target } = input;
  const price = direction === "long" ? input.bid : input.ask;

  if (price === null || price === undefined || !Number.isFinite(price)) return null;

  // Everything is measured from where the position actually opened.
  const origin = input.fill?.price ?? entry;
  const risk = Math.abs(origin - stop);
  const span = Math.abs(target - origin);
  if (risk === 0 || span === 0) return null;

  const move = direction === "long" ? price - origin : origin - price;
  const unrealizedR = move / risk;
  const towards = move < 0 ? "stop" : "target";
  // Measured against whichever level is being approached: the target's span
  // beyond the open, or the stop's risk behind it.
  const reach = Math.abs(move) / (towards === "stop" ? risk : span);

  return {
    price,
    unrealizedR,
    money: input.fill
      ? move * input.fill.units
      : input.riskAmount === null || input.riskAmount === undefined
        ? null
        : unrealizedR * input.riskAmount,
    towards,
    percent: Math.max(0, Math.min(100, reach * 100)),
  };
}
