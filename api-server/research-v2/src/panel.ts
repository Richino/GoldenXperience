/**
 * Build a multi-pair research panel with features + multi-horizon labels.
 * All features use information ≤ bar close; labels look strictly forward.
 */

import { DEFAULT_PAIRS, DEFAULT_TIMEFRAME, DEFAULT_ZONES, RESEARCH_HORIZONS } from "./config.js";
import { dualDirectionLabels, horizonBarsFor, slippageAbsolute } from "./costs.js";
import { alignQuotes, loadCandles, loadQuotes, pipSizeFor } from "./data.js";
import { buildFeatureVector } from "./features/index.js";
import { classifyRegimeV2 } from "./regimes.js";
import type { Candle, DataZones, FeatureFamily, HorizonId, Quote, Sample } from "./types.js";

export type Panel = {
  samples: Sample[];
  zones: DataZones;
  timeframe: string;
  pairs: string[];
  featureNames: string[];
};

type Series = {
  instrument: string;
  candles: Candle[];
  quotes: Quote[];
  aligned: Array<Candle & { quote: Quote | null }>;
  byTime: Map<string, number>;
};

async function loadSeries(instrument: string, timeframe: string): Promise<Series | null> {
  const [candles, quotes] = await Promise.all([loadCandles(instrument, timeframe), loadQuotes(instrument, timeframe)]);
  if (candles.length < 200 || quotes.length < 100) return null;
  const aligned = alignQuotes(candles, quotes);
  const byTime = new Map(candles.map((c, i) => [c.closeTime, i]));
  return { instrument, candles, quotes, aligned, byTime };
}

function retAt(candles: Candle[], i: number, bars: number): number {
  const a = candles[i];
  const b = candles[i - bars];
  if (!a || !b || b.close === 0) return 0;
  return (a.close - b.close) / b.close;
}

export async function buildPanel(args: {
  pairs?: readonly string[];
  timeframe?: string;
  families: FeatureFamily[];
  horizons?: HorizonId[];
  zones?: DataZones;
  stride?: number;
  warmupBars?: number;
}): Promise<Panel> {
  const pairs = [...(args.pairs ?? DEFAULT_PAIRS)];
  const timeframe = args.timeframe ?? DEFAULT_TIMEFRAME;
  const horizons = args.horizons ?? RESEARCH_HORIZONS;
  const zones = args.zones ?? DEFAULT_ZONES;
  const stride = args.stride ?? 1;
  const warmup = args.warmupBars ?? 80;

  const seriesList = (
    await Promise.all(pairs.map((p) => loadSeries(p, timeframe)))
  ).filter((s): s is Series => s != null);

  // Union of timestamps present in ≥2 series (for cross features)
  const timeCounts = new Map<string, number>();
  for (const s of seriesList) {
    for (const c of s.candles) timeCounts.set(c.closeTime, (timeCounts.get(c.closeTime) ?? 0) + 1);
  }
  const commonTimes = [...timeCounts.entries()]
    .filter(([, n]) => n >= Math.min(3, seriesList.length))
    .map(([t]) => t)
    .sort();

  const samples: Sample[] = [];
  let featureNames: string[] = [];

  for (let ti = 0; ti < commonTimes.length; ti += stride) {
    const t = commonTimes[ti]!;
    const ts = Date.parse(t);

    // Cross-sectional returns at this timestamp
    const pairReturns1: Record<string, number> = {};
    const pairReturns12: Record<string, number> = {};
    for (const s of seriesList) {
      const i = s.byTime.get(t);
      if (i == null || i < warmup) continue;
      pairReturns1[s.instrument] = retAt(s.candles, i, 1);
      pairReturns12[s.instrument] = retAt(s.candles, i, 12);
    }

    for (const s of seriesList) {
      const i = s.byTime.get(t);
      if (i == null || i < warmup) continue;
      const candle = s.candles[i]!;
      const quote = s.aligned[i]?.quote;
      if (!quote) continue;

      const maxBars = Math.max(...horizons.map((h) => horizonBarsFor(h, timeframe)));
      if (i + maxBars >= s.candles.length) continue;

      const regime = classifyRegimeV2(s.candles, i);
      const { features, names } = buildFeatureVector({
        instrument: s.instrument,
        candles: s.candles,
        index: i,
        regime,
        families: args.families,
        cross: { pairReturns1, pairReturns12 },
      });
      if (featureNames.length === 0) featureNames = names;

      const labels: Sample["labels"] = {};
      for (const horizon of horizons) {
        const bars = horizonBarsFor(horizon, timeframe);
        const futureQuotes: Quote[] = [];
        for (let k = 1; k <= bars; k += 1) {
          const q = s.aligned[i + k]?.quote;
          if (q) futureQuotes.push(q);
        }
        if (futureQuotes.length < bars) continue;
        const dual = dualDirectionLabels({
          instrument: s.instrument,
          horizon,
          entryAsk: quote.askClose,
          entryBid: quote.bidClose,
          futureQuotes,
          atr: regime.atr,
          timeframe,
        });
        labels[horizon] = dual.long;
        // Store signed long net in label; short is negative of mid move with costs baked in long path for model target
        labels[horizon] = {
          ...dual.long,
          // Model target: executable long net return (short = opposite decision later)
          netReturn: dual.signedLongNet,
        };
      }

      samples.push({
        instrument: s.instrument,
        timeframe,
        closeTime: candle.closeTime,
        ts,
        midClose: candle.close,
        bidClose: quote.bidClose,
        askClose: quote.askClose,
        spread: Math.max(0, quote.askClose - quote.bidClose),
        atr: regime.atr,
        features,
        regime,
        labels,
      });
    }
  }

  return { samples, zones, timeframe, pairs: seriesList.map((s) => s.instrument), featureNames };
}

export function zoneOf(ts: number, zones: DataZones): "train" | "dev" | "sealed" | "other" {
  const trainStart = Date.parse(zones.trainStart);
  const trainEnd = Date.parse(zones.trainEnd);
  const devStart = Date.parse(zones.devStart);
  const devEnd = Date.parse(zones.devEnd);
  const sealedStart = Date.parse(zones.sealedStart);
  const sealedEnd = Date.parse(zones.sealedEnd);
  if (ts >= trainStart && ts <= trainEnd) return "train";
  if (ts >= devStart && ts <= devEnd) return "dev";
  if (ts >= sealedStart && ts <= sealedEnd) return "sealed";
  return "other";
}

export function filterRegime(
  samples: Sample[],
  filter?: {
    trend?: Array<Sample["regime"]["trend"]>;
    volBucket?: Array<Sample["regime"]["volBucket"]>;
    volPhase?: Array<Sample["regime"]["volPhase"]>;
    session?: Array<Sample["regime"]["session"]>;
  },
): Sample[] {
  if (!filter) return samples;
  return samples.filter((s) => {
    if (filter.trend && !filter.trend.includes(s.regime.trend)) return false;
    if (filter.volBucket && !filter.volBucket.includes(s.regime.volBucket)) return false;
    if (filter.volPhase && !filter.volPhase.includes(s.regime.volPhase)) return false;
    if (filter.session && !filter.session.includes(s.regime.session)) return false;
    return true;
  });
}

export { pipSizeFor, slippageAbsolute };
