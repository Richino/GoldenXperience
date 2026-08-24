import type { Direction, Trade } from "./types.js";
import { SLIPPAGE_PIPS } from "./config.js";
import { zoneOf, type Panel } from "./panels.js";
import type { Signal, Side } from "./types.js";

function fadeDir(impulse: Direction): Direction {
  return impulse === "long" ? "short" : "long";
}

/** Symmetric R: stop = 1 ATR, target = targetR * ATR. Max bars = maxHold. */
export function labelRExit(args: {
  panel: Panel;
  signal: Signal;
  side: Side;
  delay: number;
  targetR: number;
  stopR: number;
  maxHold: number;
  allowSealed: boolean;
}): Trade | null {
  const { panel, signal, side, delay, targetR, stopR, maxHold, allowSealed } = args;
  const entryIdx = signal.idx + delay;
  if (entryIdx >= panel.bars.length) return null;
  const e = panel.bars[entryIdx]!;
  const entryZone = zoneOf(e.closeTime);
  if (entryZone === "other") return null;
  if (entryZone === "sealed" && !allowSealed) return null;
  if (e.bidClose == null || e.askClose == null || !(e.atr > 0)) return null;

  const direction: Direction = side === "fade" ? fadeDir(signal.impulseDir) : signal.impulseDir;
  const slip = SLIPPAGE_PIPS * panel.pip;
  const entryPx = direction === "long" ? e.askClose + slip : e.bidClose - slip;
  const atr = e.atr;
  const tp = direction === "long" ? entryPx + targetR * atr : entryPx - targetR * atr;
  const sl = direction === "long" ? entryPx - stopR * atr : entryPx + stopR * atr;

  let exitIdx = Math.min(panel.bars.length - 1, entryIdx + maxHold);
  let exitPx = 0;
  let hit = false;
  for (let k = 1; k <= maxHold; k++) {
    const j = entryIdx + k;
    if (j >= panel.bars.length) break;
    const b = panel.bars[j]!;
    if (zoneOf(b.closeTime) !== entryZone) {
      exitIdx = j - 1;
      break;
    }
    if (b.bidClose == null || b.askClose == null) continue;
    if (direction === "long") {
      if ((b.bidLow ?? b.bidClose) <= sl) {
        exitPx = sl - slip;
        exitIdx = j;
        hit = true;
        break;
      }
      if ((b.bidHigh ?? b.bidClose) >= tp) {
        exitPx = tp - slip;
        exitIdx = j;
        hit = true;
        break;
      }
    } else {
      if ((b.askHigh ?? b.askClose) >= sl) {
        exitPx = sl + slip;
        exitIdx = j;
        hit = true;
        break;
      }
      if ((b.askLow ?? b.askClose) <= tp) {
        exitPx = tp + slip;
        exitIdx = j;
        hit = true;
        break;
      }
    }
    exitIdx = j;
  }
  const x = panel.bars[exitIdx]!;
  if (!x || zoneOf(x.closeTime) !== entryZone) return null;
  if (!hit) {
    if (x.bidClose == null || x.askClose == null) return null;
    exitPx = direction === "long" ? x.bidClose - slip : x.askClose + slip;
  }
  const entryMid = e.mid ?? e.close;
  const exitMid = x.mid ?? x.close;
  const grossPx = direction === "long" ? exitMid - entryMid : entryMid - exitMid;
  const netPx = direction === "long" ? exitPx - entryPx : entryPx - exitPx;
  const spreadCost = (e.askClose - e.bidClose) + ((x.askClose ?? e.askClose) - (x.bidClose ?? e.bidClose));
  return {
    instrument: panel.instrument,
    timeframe: panel.timeframe,
    kind: signal.kind,
    param: signal.param + `|R${targetR}/${stopR}`,
    side,
    direction,
    delay,
    horizon: exitIdx - entryIdx,
    entryTime: e.closeTime,
    exitTime: x.closeTime,
    extensionAtr: signal.extensionAtr,
    session: e.session,
    volBucket: signal.volBucket,
    grossAtr: grossPx / atr,
    spreadCostAtr: spreadCost / atr,
    slippageCostAtr: (2 * slip) / atr,
    netAtr: netPx / atr,
    mfeAtr: 0,
    maeAtr: 0,
    retracePct: null,
    reversalLag: null,
  };
}

export function labelRetraceExit(args: {
  panel: Panel;
  signal: Signal;
  side: Side;
  delay: number;
  retraceFrac: number;
  maxHold: number;
  allowSealed: boolean;
}): Trade | null {
  const { panel, signal, side, delay, retraceFrac, maxHold, allowSealed } = args;
  const entryIdx = signal.idx + delay;
  if (entryIdx >= panel.bars.length) return null;
  const e = panel.bars[entryIdx]!;
  const entryZone = zoneOf(e.closeTime);
  if (entryZone === "other" || (entryZone === "sealed" && !allowSealed)) return null;
  if (e.bidClose == null || e.askClose == null || !(e.atr > 0)) return null;
  const direction: Direction = side === "fade" ? fadeDir(signal.impulseDir) : signal.impulseDir;
  const slip = SLIPPAGE_PIPS * panel.pip;
  const entryPx = direction === "long" ? e.askClose + slip : e.bidClose - slip;
  const targetMove = retraceFrac * signal.extensionAtr * e.atr;
  let exitIdx = entryIdx;
  let hit = false;
  let exitPx = entryPx;
  for (let k = 1; k <= maxHold; k++) {
    const j = entryIdx + k;
    if (j >= panel.bars.length) break;
    const b = panel.bars[j]!;
    if (zoneOf(b.closeTime) !== entryZone) break;
    if (b.bidClose == null || b.askClose == null) continue;
    const fav = direction === "long" ? b.bidClose - entryPx : entryPx - b.askClose;
    exitIdx = j;
    if (fav >= targetMove) {
      exitPx = direction === "long" ? b.bidClose - slip : b.askClose + slip;
      hit = true;
      break;
    }
    exitPx = direction === "long" ? b.bidClose - slip : b.askClose + slip;
  }
  const x = panel.bars[exitIdx]!;
  if (!x || zoneOf(x.closeTime) !== entryZone) return null;
  void hit;
  const entryMid = e.mid ?? e.close;
  const exitMid = x.mid ?? x.close;
  const atr = e.atr;
  const grossPx = direction === "long" ? exitMid - entryMid : entryMid - exitMid;
  const netPx = direction === "long" ? exitPx - entryPx : entryPx - exitPx;
  return {
    instrument: panel.instrument,
    timeframe: panel.timeframe,
    kind: signal.kind,
    param: signal.param + `|retrace${retraceFrac}`,
    side,
    direction,
    delay,
    horizon: exitIdx - entryIdx,
    entryTime: e.closeTime,
    exitTime: x.closeTime,
    extensionAtr: signal.extensionAtr,
    session: e.session,
    volBucket: signal.volBucket,
    grossAtr: grossPx / atr,
    spreadCostAtr: ((e.askClose - e.bidClose) + ((x.askClose ?? 0) - (x.bidClose ?? 0))) / atr,
    slippageCostAtr: (2 * slip) / atr,
    netAtr: netPx / atr,
    mfeAtr: 0,
    maeAtr: 0,
    retracePct: null,
    reversalLag: null,
  };
}
