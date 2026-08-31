/**
 * eurusd-exogenous-v1 — exogenous data access.
 *
 * Loads the stored cross-FX + gold candles (bid/ask, shared OANDA grid) and
 * exposes causal, timestamp-keyed lookups. All returns are computed as
 * "close at t vs close at t − k·1h", using the last completed bar at or before
 * each instant (binary search) — never any future bar.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../eurusdbot3-1/data.js";

export type Series = { t: number[]; c: number[] }; // sorted ascending, mid close

export const PAIRS = [
  "USD_JPY", "USD_CHF", "USD_CAD", "GBP_USD", "AUD_USD", "NZD_USD",
  "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "XAU_USD",
] as const;
export type Pair = (typeof PAIRS)[number];

export function loadSeries(pair: string): Series {
  const file = path.join(REPO_ROOT, "backtest-legacy-expanded", "candles", `${pair}_H1.json`);
  const bars = (JSON.parse(readFileSync(file, "utf8")) as { bars: Array<{ closeTime: string; close: number }> }).bars;
  const t: number[] = [], c: number[] = [];
  let lastT = -1;
  for (const b of bars) {
    const ts = Date.parse(b.closeTime);
    if (ts === lastT) { c[c.length - 1] = b.close; continue; }
    t.push(ts); c.push(b.close); lastT = ts;
  }
  return { t, c };
}

function idxAtOrBefore(t: number[], time: number): number {
  let lo = 0, hi = t.length - 1, found = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m]! <= time) { found = m; lo = m + 1; } else hi = m - 1; }
  return found;
}

export class ExoStore {
  private s = new Map<string, Series>();
  constructor(pairs: readonly string[] = PAIRS) { for (const p of pairs) this.s.set(p, loadSeries(p)); }
  closeAt(pair: string, time: number): number | null {
    const ser = this.s.get(pair)!; const i = idxAtOrBefore(ser.t, time);
    return i >= 0 ? ser.c[i]! : null;
  }
  /** pct return of `pair` over the k hours ending at `time` (causal). */
  ret(pair: string, time: number, kHours: number): number {
    const now = this.closeAt(pair, time);
    const then = this.closeAt(pair, time - kHours * 3_600_000);
    if (now == null || then == null || then === 0) return 0;
    return (now - then) / then;
  }
}
