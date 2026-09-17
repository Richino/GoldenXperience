import type { WindowSizes, MarketConditionThresholds } from "@/lib/strategy/market-condition";
import type { SrStructureThresholds } from "@/lib/strategy/sr-structure";
import type { PriceReactionThresholds } from "@/lib/strategy/price-reaction";
import type { TradeProposalThresholds } from "@/lib/strategy/trade-proposal";

/**
 * Stage 6 — the single source of truth for timeframe behaviour.
 *
 * The core strategy is identical on every timeframe (market condition → outer
 * S/R → reaction → confirmation → structural entry/SL → swing target → cost
 * check, item 19). A profile only adapts the *measurements and sensitivity*:
 * window sizes, candle history, migration lookback, near-level pip scale,
 * confirmation window, structural-SL pip floor, minimum reward, and range-width
 * boundaries. Everything ATR-normalized is deliberately left constant so this
 * stays one strategy, not five.
 *
 * All timeframe-specific constants live here — nothing is scattered elsewhere.
 */

/** OANDA granularities we analyze. */
export type AnalysisTimeframe = "M1" | "M5" | "M15" | "H1" | "H4";

/** The chart's own timeframe tokens. */
export type ChartTimeframeToken = "1m" | "5m" | "15m" | "1h" | "4h";

export interface TimeframeProfile {
  /** OANDA granularity. */
  timeframe: AnalysisTimeframe;
  /** Chart token (matches the frontend chart control). */
  chart: ChartTimeframeToken;
  /** Human label for the UI. */
  label: string;
  /** Candles to fetch (enough for the S/R lookback + broad window). */
  historyCount: number;
  /** Short / medium / broad analysis windows (completed candles). */
  windows: WindowSizes;
  /** Completed candles back the "previous" S/R snapshot looks for migration. */
  migrationStepBars: number;
  /** Higher timeframes to inspect for optional context (item 12), nearest first. */
  higherTimeframes: AnalysisTimeframe[];
  /** Stage 1 overrides (near-level pip scale). */
  marketCondition: Partial<MarketConditionThresholds>;
  /** Stage 2 overrides (range-width boundaries, migration lookback). */
  sr: Partial<SrStructureThresholds>;
  /** Stage 3 overrides (confirmation window). */
  reaction: Partial<PriceReactionThresholds>;
  /** Stage 4 overrides (SL pip floor, minimum reward). */
  proposal: Partial<TradeProposalThresholds>;
}

const CHART_TO_GRANULARITY: Record<ChartTimeframeToken, AnalysisTimeframe> = {
  "1m": "M1",
  "5m": "M5",
  "15m": "M15",
  "1h": "H1",
  "4h": "H4",
};

/**
 * The five profiles. Absolute-pip knobs (near floor/ceiling, SL floor, min
 * reward) scale down for fast timeframes and up for slow ones; ATR-normalized
 * knobs (impulse, rejection, fakeout, acceptance, R:R, spread %) stay constant.
 */
export const TIMEFRAME_PROFILES: Record<AnalysisTimeframe, TimeframeProfile> = {
  M1: {
    timeframe: "M1",
    chart: "1m",
    label: "1m",
    historyCount: 240,
    windows: { short: 6, medium: 15, broad: 30 }, // ~6 / 15 / 30 min
    migrationStepBars: 6,
    higherTimeframes: ["M5", "M15"],
    marketCondition: { nearPipsFloor: 1, nearPipsCeiling: 4 },
    sr: {},
    reaction: { maxConfirmationBars: 4 },
    proposal: { slMinBufferPips: 0.5, minRewardPips: 1.5 },
  },
  M5: {
    timeframe: "M5",
    chart: "5m",
    label: "5m",
    historyCount: 200,
    windows: { short: 6, medium: 12, broad: 24 }, // 30 / 60 / 120 min
    migrationStepBars: 5,
    higherTimeframes: ["M15", "H1"],
    marketCondition: { nearPipsFloor: 2, nearPipsCeiling: 8 },
    sr: {},
    reaction: { maxConfirmationBars: 3 },
    proposal: { slMinBufferPips: 1, minRewardPips: 2.5 },
  },
  M15: {
    timeframe: "M15",
    chart: "15m",
    label: "15m",
    historyCount: 160,
    windows: { short: 4, medium: 8, broad: 16 }, // 1H / 2H / 4H (Stage 1 default)
    migrationStepBars: 4,
    higherTimeframes: ["H1", "H4"],
    marketCondition: {}, // defaults (6 / 20 pip near-scale)
    sr: {},
    reaction: {},
    proposal: {},
  },
  H1: {
    timeframe: "H1",
    chart: "1h",
    label: "1H",
    historyCount: 160,
    windows: { short: 4, medium: 8, broad: 16 }, // 4H / 8H / 16H
    migrationStepBars: 3,
    higherTimeframes: ["H4"],
    marketCondition: { nearPipsFloor: 12, nearPipsCeiling: 40 },
    sr: {},
    reaction: { maxConfirmationBars: 2 },
    proposal: { slMinBufferPips: 4, minRewardPips: 8 },
  },
  H4: {
    timeframe: "H4",
    chart: "4h",
    label: "4H",
    historyCount: 120,
    windows: { short: 3, medium: 6, broad: 12 }, // 12H / 24H / 48H
    migrationStepBars: 2,
    higherTimeframes: [],
    marketCondition: { nearPipsFloor: 25, nearPipsCeiling: 80 },
    sr: {},
    reaction: { maxConfirmationBars: 2 },
    proposal: { slMinBufferPips: 8, minRewardPips: 15 },
  },
};

/** Normalize any timeframe token (granularity or chart token) to a granularity. */
export function toAnalysisTimeframe(value: string | null | undefined): AnalysisTimeframe {
  if (!value) return "M15";
  const upper = value.toUpperCase();
  if (upper === "M1" || upper === "M5" || upper === "M15" || upper === "H1" || upper === "H4") {
    return upper;
  }
  const lower = value.toLowerCase();
  if (lower in CHART_TO_GRANULARITY) return CHART_TO_GRANULARITY[lower as ChartTimeframeToken];
  return "M15";
}

/** The profile for a timeframe (accepts granularity or chart token). */
export function profileFor(value: string | null | undefined): TimeframeProfile {
  return TIMEFRAME_PROFILES[toAnalysisTimeframe(value)];
}
