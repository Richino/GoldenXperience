/**
 * binary-master-martingale-2y-v1 — frozen Binary Master signal stream.
 * Reuses binary-master-v1 rules/constants; precomputes ATR/SMA for O(n) scans.
 */
import type { M1Bar, Pair } from "./data.js";
import { PAIRS } from "./data.js";
import {
  PIN_BODY_MAX,
  PIN_WICK_MIN,
  PIN_CLOSE_BULL,
  PIN_CLOSE_BEAR,
  PIN_MIN_RANGE_ATR,
  SMA_FAST,
  SMA_SLOW,
  binaryMasterSignal,
  type PinSignal,
  type SmaSignal,
} from "../binary-master-v1/indicators.js";
import { settle, type Dir, type Result } from "../binary-master-v1/metrics.js";

export type MasterSignal = {
  pair: Pair;
  signalBar: number;
  entryIdx: number;
  entryMs: number;
  expiryMs: number;
  entryIso: string;
  expiryIso: string;
  entryPrice: number;
  expiryPrice: number;
  direction: Dir;
  result: Result;
  expiryMin: number;
};

function buildAtr14(bars: M1Bar[]): Float64Array {
  const n = bars.length;
  const atr = new Float64Array(n);
  if (!n) return atr;
  const tr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    const pc = i > 0 ? bars[i - 1]!.close : b.close;
    tr[i] = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  atr[0] = tr[0]!;
  let sum = 0;
  for (let i = 0; i < Math.min(14, n); i++) sum += tr[i]!;
  if (n >= 14) atr[13] = sum / 14;
  for (let i = 14; i < n; i++) atr[i] = (atr[i - 1]! * 13 + tr[i]!) / 14;
  for (let i = 1; i < Math.min(13, n); i++) atr[i] = tr[i]!;
  return atr;
}

function pinAt(bars: M1Bar[], i: number, atr: Float64Array): PinSignal {
  const b = bars[i]!;
  const range = b.high - b.low;
  if (range <= 0 || range < PIN_MIN_RANGE_ATR * atr[i]!) return null;
  const body = Math.abs(b.close - b.open);
  if (body / range > PIN_BODY_MAX) return null;
  const upperWick = b.high - Math.max(b.open, b.close);
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const closeLoc = (b.close - b.low) / range;
  if (lowerWick / range >= PIN_WICK_MIN && closeLoc >= PIN_CLOSE_BULL) return "CALL";
  if (upperWick / range >= PIN_WICK_MIN && closeLoc <= PIN_CLOSE_BEAR) return "PUT";
  return null;
}

function buildSma(closes: number[], period: number): Float64Array {
  const out = new Float64Array(closes.length);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= period) sum -= closes[i - period]!;
    out[i] = sum / Math.min(i + 1, period);
  }
  return out;
}

function smaCrossAt(fast: Float64Array, slow: Float64Array, i: number): SmaSignal {
  if (i < SMA_SLOW) return null;
  const f0 = fast[i - 1]!;
  const s0 = slow[i - 1]!;
  const f1 = fast[i]!;
  const s1 = slow[i]!;
  if (f0 <= s0 && f1 > s1) return "CALL";
  if (f0 >= s0 && f1 < s1) return "PUT";
  return null;
}

export function sortSignals(signals: MasterSignal[]): MasterSignal[] {
  return [...signals].sort((a, b) => {
    if (a.entryMs !== b.entryMs) return a.entryMs - b.entryMs;
    if (a.pair !== b.pair) return a.pair.localeCompare(b.pair);
    return a.direction.localeCompare(b.direction);
  });
}

export function collectPairSignals(bars: M1Bar[], pair: Pair, expiryMin: number): MasterSignal[] {
  if (bars.length < SMA_SLOW + 2 + expiryMin) return [];
  const closes = bars.map((b) => b.close);
  const atr = buildAtr14(bars);
  const fast = buildSma(closes, SMA_FAST);
  const slow = buildSma(closes, SMA_SLOW);
  const out: MasterSignal[] = [];
  const warmup = SMA_SLOW + 2;

  for (let i = warmup; i < bars.length - expiryMin; i++) {
    const pin = pinAt(bars, i, atr);
    const sma = smaCrossAt(fast, slow, i);
    const dir = binaryMasterSignal(pin, sma);
    if (!dir) continue;

    const entryIdx = i + 1;
    const expIdx = entryIdx + expiryMin - 1;
    if (expIdx >= bars.length) continue;

    const entryBar = bars[entryIdx]!;
    const expiryBar = bars[expIdx]!;
    out.push({
      pair,
      signalBar: i,
      entryIdx,
      entryMs: entryBar.t,
      expiryMs: expiryBar.t,
      entryIso: entryBar.iso,
      expiryIso: expiryBar.iso,
      entryPrice: entryBar.open,
      expiryPrice: expiryBar.close,
      direction: dir,
      result: settle(dir, entryBar.open, expiryBar.close),
      expiryMin,
    });
  }
  return out;
}

export function collectGlobalSignals(barsByPair: Map<Pair, M1Bar[]>, expiryMin: number): MasterSignal[] {
  const all: MasterSignal[] = [];
  for (const pair of PAIRS) {
    console.error(`Signals ${pair} (${expiryMin}m)...`);
    all.push(...collectPairSignals(barsByPair.get(pair) ?? [], pair, expiryMin));
  }
  return sortSignals(all);
}
