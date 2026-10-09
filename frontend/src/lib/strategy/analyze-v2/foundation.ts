import { ANALYZE_V2, type AnalyzeMode, type ModeConfig, type V2Timeframe } from "@/lib/strategy/analyze-v2/config";
import { checkQuote, checkTimeframe, type DataCheck, type QuoteCheck } from "@/lib/strategy/analyze-v2/data-quality";
import type { Quote } from "@/lib/strategy/analyze-v2/instrument-math";
import { readPullback, type PullbackRead } from "@/lib/strategy/analyze-v2/pullback";
import { alignmentOf, describeAlignment, readTrend, type Alignment, type TrendRead } from "@/lib/strategy/analyze-v2/structure";
import { buildZones, type SrZone } from "@/lib/strategy/analyze-v2/zones";
import type { Candle } from "@/types/forex";

/**
 * Phase 2 of Analyze V2: the deterministic read of the market, before any
 * trade decision. Pure: the same candles, quote, clock and mode always give
 * the same result. Phase 3 builds the plan and the LONG / SHORT / NO_TRADE
 * decision on top of this.
 */

export const ANALYZE_V2_VERSION = "analyze-v2.0-foundation";

export interface FoundationInput {
  instrument: string;
  mode: AnalyzeMode;
  candles: Partial<Record<V2Timeframe, Candle[]>>;
  quote: Quote | null;
  /** Decision time in ms (replays pass the candle time). */
  now: number;
  /** Settings override (replays comparing versions); defaults to ANALYZE_V2[mode]. */
  config?: ModeConfig;
}

export interface MarketFoundation {
  version: string;
  instrument: string;
  mode: AnalyzeMode;
  analyzedAt: string;
  timeframes: { primary: V2Timeframe; higher: V2Timeframe; execution: V2Timeframe | null };
  data: { checks: DataCheck[]; quote: QuoteCheck; lastPrimaryCandle: string | null };
  /** Live mid when the quote is executable, else the last closed primary close (reference only). */
  referencePrice: number | null;
  primary: TrendRead | null;
  higher: TrendRead | null;
  alignment: Alignment;
  alignmentText: string;
  zones: SrZone[];
  pullback: PullbackRead | null;
}

export function readMarketFoundation(input: FoundationInput): MarketFoundation {
  const config = input.config ?? ANALYZE_V2[input.mode];
  const primaryData = checkTimeframe("primary", input.candles[config.primary], config.primary, input.now, config, true);
  const higherData = checkTimeframe("higher", input.candles[config.higher], config.higher, input.now, config, true);
  const quote = checkQuote(input.instrument, input.quote, input.now, config.data.maxQuoteAgeMs);
  const checks = [...primaryData.checks, ...higherData.checks, quote];
  const closedPrimary = primaryData.normalized.closed;
  const closedHigher = higherData.normalized.closed;

  const base = {
    version: ANALYZE_V2_VERSION,
    instrument: input.instrument,
    mode: input.mode,
    analyzedAt: new Date(input.now).toISOString(),
    timeframes: { primary: config.primary, higher: config.higher, execution: config.execution },
    data: { checks, quote, lastPrimaryCandle: closedPrimary.at(-1)?.time ?? null },
  };
  if (!closedPrimary.length) {
    return {
      ...base, referencePrice: quote.executable?.mid ?? null, primary: null, higher: null,
      alignment: "UNKNOWN", alignmentText: "No primary candles to read.", zones: [], pullback: null,
    };
  }

  const primary = readTrend(input.instrument, config.primary, closedPrimary, config.regime);
  const higher = closedHigher.length ? readTrend(input.instrument, config.higher, closedHigher, config.regime) : null;
  const alignment = alignmentOf(primary, higher);
  const referencePrice = quote.executable?.mid ?? primary.close;
  const zones = buildZones({
    primary: { timeframe: config.primary, candles: closedPrimary },
    higher: higher ? { timeframe: config.higher, candles: closedHigher, trend: higher } : null,
    trend: primary,
    price: referencePrice,
    config,
  });
  const pullback = readPullback({ trend: primary, zones, candles: closedPrimary, config, livePrice: quote.executable?.mid ?? null });
  return {
    ...base,
    referencePrice,
    primary,
    higher,
    alignment,
    alignmentText: describeAlignment(primary, higher, alignment),
    zones,
    pullback,
  };
}
