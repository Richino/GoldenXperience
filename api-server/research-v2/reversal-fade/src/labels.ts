import { SLIPPAGE_PIPS } from "./config.js";
import { zoneEndIso, zoneOf, type Panel } from "./panels.js";
import type { Direction, Side, Signal, Trade } from "./types.js";

function fadeDir(impulse: Direction): Direction {
  return impulse === "long" ? "short" : "long";
}

function followDir(impulse: Direction): Direction {
  return impulse;
}

/**
 * Executable P/L in ATR.
 * LONG: entry ask+slip, exit bid-slip
 * SHORT: entry bid-slip, exit ask+slip
 * Gross: mid-to-mid (or close-to-close if mids missing).
 *
 * Embargo: exit bar must stay inside the same zone as the *entry* (not the signal),
 * and must not enter sealed unless allowSealed.
 */
export function labelSignal(args: {
  panel: Panel;
  signal: Signal;
  side: Side;
  delay: number;
  horizon: number;
  allowSealed: boolean;
}): Trade | null {
  const { panel, signal, side, delay, horizon, allowSealed } = args;
  const entryIdx = signal.idx + delay;
  const exitIdx = entryIdx + horizon;
  if (exitIdx >= panel.bars.length || entryIdx >= panel.bars.length || entryIdx < 0) return null;

  const e = panel.bars[entryIdx]!;
  const x = panel.bars[exitIdx]!;
  const entryZone = zoneOf(e.closeTime);
  if (entryZone === "other") return null;
  if (entryZone === "sealed" && !allowSealed) return null;
  if (zoneOf(x.closeTime) !== entryZone) return null;
  if (x.ts > Date.parse(zoneEndIso(entryZone === "sealed" ? "sealed" : entryZone))) return null;

  if (e.bidClose == null || e.askClose == null || x.bidClose == null || x.askClose == null) return null;
  if (!(e.atr > 0)) return null;

  const direction: Direction = side === "fade" ? fadeDir(signal.impulseDir) : followDir(signal.impulseDir);
  const slip = SLIPPAGE_PIPS * panel.pip;
  const entryPx = direction === "long" ? e.askClose + slip : e.bidClose - slip;
  const exitPx = direction === "long" ? x.bidClose - slip : x.askClose + slip;
  const entryMid = e.mid ?? e.close;
  const exitMid = x.mid ?? x.close;
  const grossPx = direction === "long" ? exitMid - entryMid : entryMid - exitMid;
  const netPx = direction === "long" ? exitPx - entryPx : entryPx - exitPx;
  const spreadCost = (e.askClose - e.bidClose) + (x.askClose - x.bidClose);
  const slipCost = 2 * slip;
  const atr = e.atr;

  let mfe = 0;
  let mae = 0;
  let reversalLag: number | null = null;
  let maxFav = 0;
  for (let k = 1; k <= horizon; k++) {
    const b = panel.bars[entryIdx + k];
    if (!b) break;
    if (b.bidClose == null || b.askClose == null) continue;
    const fav =
      direction === "long"
        ? (b.bidHigh ?? b.bidClose) - entryPx
        : entryPx - (b.askLow ?? b.askClose);
    const adv =
      direction === "long"
        ? entryPx - (b.bidLow ?? b.bidClose)
        : (b.askHigh ?? b.askClose) - entryPx;
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
    if (fav > maxFav) maxFav = fav;
    if (reversalLag == null) {
      const closeFav = direction === "long" ? b.close - e.close : e.close - b.close;
      if (closeFav > 0) reversalLag = k;
    }
  }

  const impulsePx = signal.extensionAtr * atr;
  const retracePct = impulsePx > 0 ? maxFav / impulsePx : null;

  return {
    instrument: panel.instrument,
    timeframe: panel.timeframe,
    kind: signal.kind,
    param: signal.param,
    side,
    direction,
    delay,
    horizon,
    entryTime: e.closeTime,
    exitTime: x.closeTime,
    extensionAtr: signal.extensionAtr,
    session: e.session,
    volBucket: signal.volBucket,
    grossAtr: grossPx / atr,
    spreadCostAtr: spreadCost / atr,
    slippageCostAtr: slipCost / atr,
    netAtr: netPx / atr,
    mfeAtr: mfe / atr,
    maeAtr: mae / atr,
    retracePct,
    reversalLag,
  };
}
