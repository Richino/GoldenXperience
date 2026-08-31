/**
 * eurusdbot3-1 — true R-multiple barrier resolver.
 *
 * A trade is entered at an H1 close and resolved by walking the finer M15 path
 * forward until the +TP·R target or the -1R stop is touched, or the max hold
 * elapses. Spread is real (entry on ask/bid, exit on the opposite side); an
 * explicit slippage-in-R term is subtracted for the NET book.
 *
 * Same-M15-bar ambiguity (both barriers inside one M15 bar, order unknown) is
 * NEVER counted as a win — it is classed "ambiguous" and, for headline
 * expectancy, booked conservatively as the -1R loss. It is also tallied
 * separately so the ambiguous fraction is transparent.
 */
import { PIP, type Bar, firstIndexAfter } from "./data.js";

export type Outcome = {
  cls: "win" | "loss" | "timeout" | "ambiguous";
  r: number;
  holdMs: number;
  exitTime: number;
  ambiguous: boolean;
  mfeR: number; // max favorable excursion in R
  maeR: number; // max adverse excursion in R
};

export type BarrierParams = {
  direction: "long" | "short";
  entryH1: Bar;
  riskDistance: number; // price units (1R)
  tpR: number;          // target as multiple of R (3 for 1:3)
  horizonMs: number;
  m15: Bar[];
  slippagePips: number;
  cost: "net" | "gross";
};

export function resolveOutcome(p: BarrierParams): Outcome {
  const { direction, entryH1, riskDistance, tpR, horizonMs, m15, slippagePips, cost } = p;
  const net = cost === "net";
  const slipR = net ? (slippagePips * PIP) / riskDistance : 0;

  // Entry fill: long buys the ask, short sells the bid (NET). GROSS uses mid.
  const entry = net
    ? (direction === "long" ? entryH1.askClose : entryH1.bidClose)
    : entryH1.close;

  const target = direction === "long" ? entry + tpR * riskDistance : entry - tpR * riskDistance;
  const stop = direction === "long" ? entry - riskDistance : entry + riskDistance;

  const startIdx = firstIndexAfter(m15, entryH1.t);
  const endTime = entryH1.t + horizonMs;

  let mfe = 0, mae = 0;
  for (let i = startIdx; i < m15.length; i++) {
    const b = m15[i]!;
    if (b.t > endTime) break;

    // Exit fills on the opposite side of entry (NET); GROSS uses mid H/L.
    const hi = net ? (direction === "long" ? b.bidHigh : b.askHigh) : b.high;
    const lo = net ? (direction === "long" ? b.bidLow : b.askLow) : b.low;

    // Track excursions in R (favorable/adverse relative to entry).
    if (direction === "long") {
      mfe = Math.max(mfe, (hi - entry) / riskDistance);
      mae = Math.min(mae, (lo - entry) / riskDistance);
    } else {
      mfe = Math.max(mfe, (entry - lo) / riskDistance);
      mae = Math.min(mae, (entry - hi) / riskDistance);
    }

    const targetHit = direction === "long" ? hi >= target : lo <= target;
    const stopHit = direction === "long" ? lo <= stop : hi >= stop;

    if (targetHit && stopHit) {
      return { cls: "ambiguous", r: -1 - slipR, holdMs: b.t - entryH1.t, exitTime: b.t, ambiguous: true, mfeR: mfe, maeR: mae };
    }
    if (targetHit) {
      return { cls: "win", r: tpR - slipR, holdMs: b.t - entryH1.t, exitTime: b.t, ambiguous: false, mfeR: mfe, maeR: mae };
    }
    if (stopHit) {
      return { cls: "loss", r: -1 - slipR, holdMs: b.t - entryH1.t, exitTime: b.t, ambiguous: false, mfeR: mfe, maeR: mae };
    }
  }

  // Timeout: mark to market at the last M15 bar within the horizon.
  const lastIdx = (() => {
    let idx = startIdx;
    for (let i = startIdx; i < m15.length; i++) { if (m15[i]!.t > endTime) break; idx = i; }
    return idx;
  })();
  const last = m15[Math.min(lastIdx, m15.length - 1)] ?? entryH1;
  const exitPx = net
    ? (direction === "long" ? last.bidClose : last.askClose)
    : last.close;
  const move = direction === "long" ? exitPx - entry : entry - exitPx;
  const r = move / riskDistance - slipR;
  return { cls: "timeout", r, holdMs: last.t - entryH1.t, exitTime: last.t, ambiguous: false, mfeR: mfe, maeR: mae };
}
