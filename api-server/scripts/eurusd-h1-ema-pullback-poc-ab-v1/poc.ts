/**
 * Frozen yesterday-UTC-day POC for eurusd-h1-ema-pullback-poc-ab-v1.
 *
 * Mathematical methodology copied from frontend/scripts/usdjpy-poc-swing-long.ts
 * computePoc (HLC3, equal-width bins, full-bar tick volume, bin center,
 * lowest-price bin on ties). Window and bin count follow POC_SPEC.md:
 * previous completed UTC calendar day, M5 bars, 48 bins.
 */
export const POC_BINS = 48 as const;

export type VolumeBar = {
  high: number;
  low: number;
  close: number;
  volume: number;
};

export function computePoc(
  bars: readonly VolumeBar[],
  rangeLow: number,
  rangeHigh: number,
  bins = POC_BINS,
): number | null {
  const width = rangeHigh - rangeLow;
  if (!(width > 0) || bins < 1 || !bars.length) return null;
  const binSize = width / bins;
  const volumes = Array.from({ length: bins }, () => 0);
  for (const bar of bars) {
    const hlc3 = (bar.high + bar.low + bar.close) / 3;
    if (!Number.isFinite(hlc3) || !Number.isFinite(bar.volume)) continue;
    let bin = Math.floor((hlc3 - rangeLow) / binSize);
    if (bin < 0) bin = 0;
    if (bin >= bins) bin = bins - 1;
    volumes[bin]! += bar.volume;
  }
  let maxBin = 0;
  for (let bin = 1; bin < bins; bin += 1) {
    if (volumes[bin]! > volumes[maxBin]!) maxBin = bin;
  }
  return rangeLow + binSize * (maxBin + 0.5);
}

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function previousUtcDayKey(dayKey: string): string {
  const start = Date.parse(`${dayKey}T00:00:00.000Z`);
  return new Date(start - 1).toISOString().slice(0, 10);
}

export function utcDayStartMs(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00.000Z`);
}

/** POC keyed by the UTC day it describes (the session that produced the profile). */
export function pocByUtcDay(
  bars: readonly (VolumeBar & { openMs: number })[],
): Map<string, number | null> {
  const grouped = new Map<string, VolumeBar[]>();
  for (const bar of bars) {
    const key = utcDayKey(bar.openMs);
    const list = grouped.get(key);
    if (list) list.push(bar);
    else grouped.set(key, [bar]);
  }
  const result = new Map<string, number | null>();
  for (const [day, dayBars] of grouped) {
    let rangeLow = Infinity;
    let rangeHigh = -Infinity;
    for (const bar of dayBars) {
      rangeLow = Math.min(rangeLow, bar.low);
      rangeHigh = Math.max(rangeHigh, bar.high);
    }
    result.set(day, computePoc(dayBars, rangeLow, rangeHigh));
  }
  return result;
}

export function yesterdayPocForSignalDay(
  pocByDay: Map<string, number | null>,
  signalDayKey: string,
): number | null {
  const yesterday = previousUtcDayKey(signalDayKey);
  if (!pocByDay.has(yesterday)) return null;
  return pocByDay.get(yesterday) ?? null;
}
