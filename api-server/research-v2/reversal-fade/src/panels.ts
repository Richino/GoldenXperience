import { alignQuotes, loadCandles, loadQuotes, pipSizeFor } from "../../src/data.js";
import { precomputeAtr } from "../../src/atr.js";
import { percentile } from "../../src/math.js";
import { classifySession } from "../../src/sessions.js";
import { ATR_PERIOD, ZONES } from "./config.js";
import type { Session, VolBucket, Zone } from "./types.js";

export type PanelBar = {
  closeTime: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bidClose: number | null;
  askClose: number | null;
  bidHigh: number | null;
  bidLow: number | null;
  askHigh: number | null;
  askLow: number | null;
  atr: number;
  spread: number | null;
  mid: number | null;
  session: Session;
};

export type Panel = {
  instrument: string;
  timeframe: string;
  bars: PanelBar[];
  pip: number;
};

export function zoneOf(iso: string): Zone {
  const t = Date.parse(iso);
  if (t >= Date.parse(ZONES.trainStart) && t <= Date.parse(ZONES.trainEnd)) return "train";
  if (t >= Date.parse(ZONES.devStart) && t <= Date.parse(ZONES.devEnd)) return "dev";
  if (t >= Date.parse(ZONES.sealedStart) && t <= Date.parse(ZONES.sealedEnd)) return "sealed";
  return "other";
}

export function zoneEndIso(zone: "train" | "dev" | "sealed"): string {
  if (zone === "train") return ZONES.trainEnd;
  if (zone === "dev") return ZONES.devEnd;
  return ZONES.sealedEnd;
}

export async function loadPanel(instrument: string, timeframe: string): Promise<Panel | null> {
  const [candles, quotes] = await Promise.all([loadCandles(instrument, timeframe), loadQuotes(instrument, timeframe)]);
  if (candles.length < 200) {
    console.warn(`  skip ${instrument} ${timeframe}: ${candles.length} bars`);
    return null;
  }
  const aligned = alignQuotes(candles, quotes);
  const atr = precomputeAtr(
    aligned.map((c) => ({
      closeTime: c.closeTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
    ATR_PERIOD,
  );
  const bars: PanelBar[] = aligned.map((c, i) => {
    const bid = c.quote?.bidClose ?? null;
    const ask = c.quote?.askClose ?? null;
    const spread = bid != null && ask != null ? Math.max(0, ask - bid) : null;
    const mid = bid != null && ask != null ? (bid + ask) / 2 : c.close;
    return {
      closeTime: c.closeTime,
      ts: Date.parse(c.closeTime),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      bidClose: bid,
      askClose: ask,
      bidHigh: c.quote?.bidHigh ?? null,
      bidLow: c.quote?.bidLow ?? null,
      askHigh: c.quote?.askHigh ?? null,
      askLow: c.quote?.askLow ?? null,
      atr: atr[i] || NaN,
      spread,
      mid,
      session: classifySession(new Date(c.closeTime)),
    };
  });
  console.log(`  loaded ${instrument} ${timeframe}: ${bars.length} bars`);
  return { instrument, timeframe, bars, pip: pipSizeFor(instrument) };
}

export function volBucketAt(bars: PanelBar[], i: number, lookback: number): VolBucket {
  if (i < lookback || !(bars[i]!.atr > 0)) return "normal";
  const cur = bars[i]!.atr;
  let below = 0;
  let n = 0;
  for (let k = i - lookback + 1; k <= i; k++) {
    const a = bars[k]!.atr;
    if (!(a > 0)) continue;
    n += 1;
    if (a <= cur) below += 1;
  }
  const pct = n ? (100 * below) / n : 50;
  if (pct <= 25) return "low";
  if (pct <= 75) return "normal";
  if (pct <= 95) return "high";
  return "extreme";
}

export type SpreadAtrStats = { n: number; p25: number; p50: number; p75: number; p90: number; median: number };

export function spreadOverAtr(panel: Panel, zones: Zone[]): SpreadAtrStats {
  const xs: number[] = [];
  for (const b of panel.bars) {
    const z = zoneOf(b.closeTime);
    if (!zones.includes(z)) continue;
    if (b.spread == null || !(b.atr > 0)) continue;
    xs.push(b.spread / b.atr);
  }
  return {
    n: xs.length,
    p25: percentile(xs, 25),
    p50: percentile(xs, 50),
    p75: percentile(xs, 75),
    p90: percentile(xs, 90),
    median: percentile(xs, 50),
  };
}
