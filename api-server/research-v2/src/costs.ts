/**
 * Realistic bid/ask execution + multi-horizon forward labels.
 *
 * LONG:  entry = ask at signal bar, exit = bid at horizon bar
 * SHORT: entry = bid at signal bar, exit = ask at horizon bar
 */

import { DEFAULT_SLIPPAGE_PIPS, HORIZON_BARS, SAFETY_MARGIN_RETURN } from "./config.js";
import { pipSizeFor } from "./data.js";
import type { ForwardLabel, HorizonId, Quote } from "./types.js";

export function spreadCostAbsolute(entryAsk: number, entryBid: number): number {
  return Math.max(0, entryAsk - entryBid);
}

export function slippageAbsolute(instrument: string, slippagePips = DEFAULT_SLIPPAGE_PIPS): number {
  return slippagePips * pipSizeFor(instrument);
}

/**
 * Hold-to-horizon net return for a directional bet.
 * Uses future quote path for MFE/MAE on the executable side of the book.
 */
export function labelHoldToHorizon(args: {
  instrument: string;
  direction: "long" | "short";
  horizon: HorizonId;
  bars: number;
  entryAsk: number;
  entryBid: number;
  futureQuotes: Quote[];
  atr: number;
  slippagePips?: number;
}): ForwardLabel {
  const {
    instrument,
    direction,
    horizon,
    bars,
    entryAsk,
    entryBid,
    futureQuotes,
    atr,
    slippagePips = DEFAULT_SLIPPAGE_PIPS,
  } = args;

  const spread = spreadCostAbsolute(entryAsk, entryBid);
  const slip = slippageAbsolute(instrument, slippagePips);
  const entry = direction === "long" ? entryAsk + slip : entryBid - slip;

  const exitQuote = futureQuotes[bars - 1] ?? null;
  const exit = exitQuote
    ? direction === "long"
      ? exitQuote.bidClose - slip
      : exitQuote.askClose + slip
    : entry;

  const rawMidMove = exitQuote
    ? direction === "long"
      ? (exitQuote.bidClose + exitQuote.askClose) / 2 - (entryBid + entryAsk) / 2
      : (entryBid + entryAsk) / 2 - (exitQuote.bidClose + exitQuote.askClose) / 2
    : 0;

  const grossReturn = direction === "long" ? exit - entryAsk : entryBid - exit;
  // grossReturn already pays spread+slip via entry/exit sides; report components:
  const spreadCost = spread + 2 * slip;
  const netReturn = direction === "long" ? exit - entryAsk : entryBid - exit;

  let mfe = 0;
  let mae = 0;
  for (let k = 0; k < Math.min(bars, futureQuotes.length); k += 1) {
    const q = futureQuotes[k]!;
    if (direction === "long") {
      mfe = Math.max(mfe, q.bidHigh - entryAsk);
      mae = Math.max(mae, entryAsk - q.bidLow);
    } else {
      mfe = Math.max(mfe, entryBid - q.askLow);
      mae = Math.max(mae, q.askHigh - entryBid);
    }
  }

  const signedRaw = direction === "long" ? rawMidMove : rawMidMove;
  return {
    horizon,
    bars,
    rawReturn: signedRaw,
    atrReturn: atr > 0 ? netReturn / atr : 0,
    mfe,
    mae,
    spreadCost,
    slippageCost: 2 * slip,
    netReturn,
    directionHit: netReturn > 0 ? 1 : netReturn < 0 ? 0 : null,
  };
}

/** Long and short net returns for the same bar (model predicts signed long return). */
export function dualDirectionLabels(args: {
  instrument: string;
  horizon: HorizonId;
  entryAsk: number;
  entryBid: number;
  futureQuotes: Quote[];
  atr: number;
  timeframe: string;
}): { long: ForwardLabel; short: ForwardLabel; signedLongNet: number } {
  const bars = horizonBarsFor(args.horizon, args.timeframe);
  const long = labelHoldToHorizon({ ...args, direction: "long", bars });
  const short = labelHoldToHorizon({ ...args, direction: "short", bars });
  return { long, short, signedLongNet: long.netReturn };
}

export function horizonBarsFor(horizon: HorizonId, timeframe: string): number {
  if (timeframe === "H1") return HORIZON_BARS[horizon];
  if (timeframe === "M15") {
    const map: Record<HorizonId, number> = {
      "15m": 1,
      "30m": 2,
      "1h": 4,
      "2h": 8,
      "4h": 16,
      "1d": 96,
    };
    return map[horizon];
  }
  if (timeframe === "H4") {
    const map: Record<HorizonId, number> = {
      "15m": 1,
      "30m": 1,
      "1h": 1,
      "2h": 1,
      "4h": 1,
      "1d": 6,
    };
    return map[horizon];
  }
  return HORIZON_BARS[horizon];
}

export function expectedNetEdge(expectedGrossLong: number, spread: number, slip: number): number {
  // Model predicts long mid-ish move; subtract round-trip costs + safety.
  return expectedGrossLong - spread - 2 * slip - SAFETY_MARGIN_RETURN;
}

export { SAFETY_MARGIN_RETURN };
