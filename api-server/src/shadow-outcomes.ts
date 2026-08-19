import { labelOutcome, type NormalizedQuote } from "./research.js";

/**
 * Shadow (hypothetical) outcome resolution for valid candidates that were NOT
 * executed — because another strategy won the conflict, the adaptive engine
 * suppressed them, or an existing position blocked the instrument.
 *
 * This is a thin, PURE wrapper over the existing `labelOutcome`. It never places
 * an order, never creates a position, and has no access to OANDA, risk, or the
 * paper-trade tables. Its only job is to decide, from the candles available at a
 * given real-time `now`, whether a candidate's hypothetical outcome is yet known
 * — and if so, what it was.
 *
 * The look-ahead guarantee lives here: an outcome is returned only once its
 * resolving candle actually exists in `quotes` (or the horizon has genuinely
 * elapsed). While a candidate is still open inside its horizon it returns null
 * (pending), so the outcome cannot enter the adaptive engine's evidence before
 * it would have become known in real time.
 */
export type ShadowOutcomeKind = "target_first" | "stop_first" | "forced_close" | "timeout" | "ambiguous";

export interface ShadowOutcome {
  outcome: ShadowOutcomeKind;
  resultR: number | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
  exit: number | null;
  resolvedAt: string | null;
  horizonEndsAt: string;
  exitReason: string;
}

export function resolveShadowOutcome(
  direction: "long" | "short",
  entry: number,
  stop: number,
  target: number,
  decisionTime: string,
  quotes: NormalizedQuote[],
  now: Date,
): ShadowOutcome | null {
  const result = labelOutcome(direction, entry, stop, target, decisionTime, quotes);
  const risk = Math.abs(entry - stop);
  // Reconstruct the exit from R so the recorded exit and result_r can never
  // disagree — the same trick the live resolver uses for horizon/forced closes.
  const fromR = (r: number | null) => r === null ? null : direction === "long" ? entry + r * risk : entry - r * risk;

  if (result.outcome === "unresolved") {
    // Still inside its horizon and no level touched: the outcome is not known
    // yet. Returning null keeps it out of evidence until real time reaches it.
    if (now.getTime() < new Date(result.horizonEndsAt).getTime()) return null;
    // Horizon elapsed without a level: mark to market, exactly like a live
    // horizon timeout.
    return {
      outcome: "timeout", resultR: result.resultR, maxFavorableR: result.maxFavorableR, maxAdverseR: result.maxAdverseR,
      exit: fromR(result.resultR), resolvedAt: result.horizonEndsAt, horizonEndsAt: result.horizonEndsAt, exitReason: "timeout",
    };
  }

  const exit = result.outcome === "target_first" ? target : result.outcome === "stop_first" ? stop : fromR(result.resultR);
  return {
    outcome: result.outcome, resultR: result.resultR, maxFavorableR: result.maxFavorableR, maxAdverseR: result.maxAdverseR,
    exit, resolvedAt: result.resolvedAt, horizonEndsAt: result.horizonEndsAt, exitReason: result.outcome,
  };
}
