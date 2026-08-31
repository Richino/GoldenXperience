/**
 * eurusd-move-v1 — forward excursion measurement engine.
 *
 * For each H1 candidate timestamp, walk the finer M15 path forward and record,
 * at every horizon in HORIZONS, the pure price behavior — NO trade, NO stop, NO
 * target, NO R:R. Everything is causal from the entry timestamp forward and is
 * reported in both pips and ATR-at-entry units.
 *
 * Per horizon we capture:
 *   retATR / retPips        terminal return (mid close nearest ≤ boundary)
 *   mfeUpATR                max favorable excursion for a LONG (= high reach up)
 *   maeDownATR              max adverse excursion for a LONG (= low reach down, ≤0)
 *     (a SHORT's MFE = -maeDownATR, a SHORT's MAE = -mfeUpATR, by mirror)
 *   reachATR                max one-sided reach = max(up, down)  → MOVE magnitude
 *   rangeATR                realized range = up + |down|
 *   tMFEmin / tMAEmin       minutes to the up-extreme / down-extreme so far
 * Plus, over the full 72h: maxAbsATR and the minute of the largest displacement.
 */
import { PIP, type Bar, firstIndexAfter } from "../eurusdbot3-1/data.js";

export const HORIZONS = [1, 2, 4, 8, 12, 24, 48, 72] as const;
export type Horizon = (typeof HORIZONS)[number];

export type HStat = {
  retATR: number; retPips: number;
  mfeUpATR: number; maeDownATR: number;
  reachATR: number; rangeATR: number;
  tMFEmin: number; tMAEmin: number;
};

export type Excursion = {
  i: number; t: number; iso: string;
  atr: number; atrPips: number; entry: number;
  byH: Record<number, HStat>;
  maxAbsATR: number; tMaxDispMin: number;
};

export function measureExcursion(h1: Bar[], m15: Bar[], i: number, atr: number): Excursion | null {
  const bar = h1[i]!;
  const entry = bar.close;
  const start = firstIndexAfter(m15, bar.t);
  const maxMs = bar.t + HORIZONS.at(-1)! * 3_600_000;

  let runHigh = entry, runLow = entry;      // running mid extremes
  let tHighMin = 0, tLowMin = 0;            // minutes to those extremes
  let lastClose = entry;                    // last mid close ≤ current boundary

  const byH: Record<number, HStat> = {};
  let hp = 0; // pointer into HORIZONS
  const snapshot = (h: Horizon) => {
    const up = runHigh - entry;
    const down = runLow - entry; // ≤ 0
    byH[h] = {
      retATR: (lastClose - entry) / atr,
      retPips: (lastClose - entry) / PIP,
      mfeUpATR: up / atr,
      maeDownATR: down / atr,
      reachATR: Math.max(up, -down) / atr,
      rangeATR: (up - down) / atr,
      tMFEmin: tHighMin,
      tMAEmin: tLowMin,
    };
  };

  for (let j = start; j < m15.length; j++) {
    const b = m15[j]!;
    if (b.t > maxMs) break;
    // snapshot any horizon boundaries this bar has crossed (stats reflect ≤ boundary)
    while (hp < HORIZONS.length && b.t > bar.t + HORIZONS[hp]! * 3_600_000) {
      snapshot(HORIZONS[hp]!);
      hp++;
    }
    // update running extremes with this in-window bar
    const mins = (b.t - bar.t) / 60000;
    if (b.high > runHigh) { runHigh = b.high; tHighMin = mins; }
    if (b.low < runLow) { runLow = b.low; tLowMin = mins; }
    lastClose = b.close;
  }
  // snapshot any remaining horizons at end of data (rare; candidates are capped so full path exists)
  while (hp < HORIZONS.length) { snapshot(HORIZONS[hp]!); hp++; }

  const up = runHigh - entry, down = entry - runLow;
  const maxAbsATR = Math.max(up, down) / atr;
  const tMaxDispMin = up >= down ? tHighMin : tLowMin;

  return { i, t: bar.t, iso: bar.iso, atr, atrPips: atr / PIP, entry, byH, maxAbsATR, tMaxDispMin };
}
