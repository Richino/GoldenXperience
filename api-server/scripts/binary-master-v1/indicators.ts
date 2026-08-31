/**
 * binary-master-v1 — STRICT_NON_REPAINTING PinBar + SMA CrossOver Justin.
 */
import type { M1Bar } from "./data.js";

export type PinSignal = "CALL" | "PUT" | null;
export type SmaSignal = "CALL" | "PUT" | null;
export type MasterSignal = "CALL" | "PUT" | null;

export const PIN_BODY_MAX = 0.35;
export const PIN_WICK_MIN = 0.55;
export const PIN_CLOSE_BULL = 0.60;
export const PIN_CLOSE_BEAR = 0.40;
export const PIN_MIN_RANGE_ATR = 0.30;
export const SMA_FAST = 12;
export const SMA_SLOW = 26;

export function smaAt(closes: number[], period: number, i: number): number {
  const start = Math.max(0, i - period + 1);
  let sum = 0, cnt = 0;
  for (let j = start; j <= i; j++) { sum += closes[j]!; cnt++; }
  return sum / cnt;
}

export function atr14(bars: M1Bar[], i: number): number {
  if (i < 1) return bars[i]!.high - bars[i]!.low;
  let atr = 0;
  for (let k = 0; k <= i; k++) {
    const b = bars[k]!;
    const pc = bars[k - 1]?.close ?? b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    if (k < 14) {
      atr += tr;
      if (k === 13) atr /= 14;
    } else {
      atr = (atr * 13 + tr) / 14;
    }
  }
  return atr;
}

/** Pin bar on completed bar i only. */
export function pinBarSignal(bars: M1Bar[], i: number): PinSignal {
  const b = bars[i]!;
  const atr = atr14(bars, i);
  const range = b.high - b.low;
  if (range <= 0 || range < PIN_MIN_RANGE_ATR * atr) return null;
  const body = Math.abs(b.close - b.open);
  if (body / range > PIN_BODY_MAX) return null;
  const upperWick = b.high - Math.max(b.open, b.close);
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const closeLoc = (b.close - b.low) / range;
  if (lowerWick / range >= PIN_WICK_MIN && closeLoc >= PIN_CLOSE_BULL) return "CALL";
  if (upperWick / range >= PIN_WICK_MIN && closeLoc <= PIN_CLOSE_BEAR) return "PUT";
  return null;
}

/** SMA cross signal confirmed at bar i close. */
export function smaJustinSignal(closes: number[], i: number): SmaSignal {
  if (i < SMA_SLOW) return null;
  const f0 = smaAt(closes, SMA_FAST, i - 1);
  const s0 = smaAt(closes, SMA_SLOW, i - 1);
  const f1 = smaAt(closes, SMA_FAST, i);
  const s1 = smaAt(closes, SMA_SLOW, i);
  if (f0 <= s0 && f1 > s1) return "CALL";
  if (f0 >= s0 && f1 < s1) return "PUT";
  return null;
}

export function binaryMasterSignal(pin: PinSignal, sma: SmaSignal): MasterSignal {
  if (pin === "CALL" && sma === "CALL") return "CALL";
  if (pin === "PUT" && sma === "PUT") return "PUT";
  return null;
}

export function invertedMaster(pin: PinSignal, sma: SmaSignal): MasterSignal {
  const m = binaryMasterSignal(pin, sma);
  if (m === "CALL") return "PUT";
  if (m === "PUT") return "CALL";
  return null;
}

export function pinOnlyInvertedSma(pin: PinSignal, sma: SmaSignal): MasterSignal {
  if (pin === "CALL" && sma === "PUT") return "CALL";
  if (pin === "PUT" && sma === "CALL") return "PUT";
  return null;
}

export function invertedPinOnlySma(pin: PinSignal, sma: SmaSignal): MasterSignal {
  if (pin === "CALL" && sma === "PUT") return "PUT";
  if (pin === "PUT" && sma === "CALL") return "CALL";
  return null;
}

export function sessionUtc(iso: string): string {
  const h = new Date(iso).getUTCHours();
  if (h >= 12 && h < 16) return "London/NY overlap";
  if (h >= 7 && h < 12) return "London";
  if (h >= 16 && h < 21) return "New York";
  if (h >= 21 || h < 7) return "Asia";
  return "Off-hours";
}
