import { DEFAULT_REGIME_SETTINGS, type RegimeSettings } from "@/lib/strategy/market-regime";

/**
 * Analyze V2 parameters, one block per mode. Every number here is an initial
 * operating choice, not a fitted or proven value; change them here, not in
 * the modules that read them.
 *
 *   NORMAL  day trading   M15 structure · H1 higher timeframe · M5 refinement
 *   SWING   multi-day     H4 structure  · D1 higher timeframe · H1 refinement
 */

export type AnalyzeMode = "NORMAL" | "SWING";
export type V2Timeframe = "M5" | "M15" | "H1" | "H4" | "D1";

export const TIMEFRAME_MS: Record<V2Timeframe, number> = {
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

export interface ModeConfig {
  /** Decides the trend. */
  primary: V2Timeframe;
  /** Context: confirms or conflicts with the primary trend, never overrides it. */
  higher: V2Timeframe;
  /** Optional entry-timing refinement; never decides direction. */
  execution: V2Timeframe | null;
  /** Swing structure settings for the primary and higher timeframes. */
  regime: RegimeSettings;
  zones: {
    /** Pivots closer than this many primary ATRs join one zone... */
    mergeAtr: number;
    /** ...unless the zone would grow wider than this. */
    maxWidthAtr: number;
    /** A single-pivot zone is padded to at least this width. */
    minWidthAtr: number;
    /** A close this far past the far edge, after the last reaction, breaks the zone. */
    breakCloseAtr: number;
    /** Zones further than this from price are left out (structural zones are always kept). */
    maxDistanceAtr: number;
  };
  pullback: {
    /**
     * Retracement (share of the impulse) below which the pullback has not
     * started. Context only: no retracement depth is treated as proof.
     */
    minRetrace: number;
    /** Candles after the impulse extreme before a pullback can be read. */
    minBarsSinceExtreme: number;
    /** Price within this many ATRs of a zone counts as reaching it. */
    nearZoneAtr: number;
    /** A trigger older than this many primary candles has expired... */
    expireBars: number;
    /** ...as has one price has already run this many ATRs past. */
    expireAtr: number;
  };
  data: {
    /** A quote older than this is not an executable price. */
    maxQuoteAgeMs: number;
    /** The latest closed candle may lag the clock by this many candles while the market is open. */
    maxCandleLagBars: number;
    /** Fewer closed primary candles than this is not enough history. */
    minPrimaryBars: number;
    /** Missing candles (market open, not a weekend) above this share is a caution. */
    maxGapShare: number;
  };
  plan: {
    /** Minimum reward/risk after costs (owner's choice, 2026-10-08; configurable, not a proven threshold). */
    minRewardRisk: number;
    /** Preferred target distance where structure leaves room for it; null for none. */
    targetPreferencePips: number | null;
    /** A target that would need more than this many pips is outside the holding horizon (null: no cap). */
    maxTargetPips: number | null;
    /**
     * What the stop sits behind: the pullback's deepest point (V2.0), or the
     * trend's structure level, the latest higher low / lower high (V2.1,
     * frozen 2026-10-09 for forward testing; see AUDIT.md §13).
     */
    stopAnchor: "PULLBACK_EXTREME" | "STRUCTURE_LEVEL";
    /** The stop sits this many ATRs past the invalidation level, plus the spread (bid/ask vs mid candles). */
    stopBufferAtr: number;
    /** A structural stop further than this many ATRs from the entry is too far for the setup. */
    maxStopAtr: number;
    /** Targets stop this many ATRs short of an obstacle, plus the spread. */
    obstacleBufferAtr: number;
    /** Spread as a share of risk: up to `spreadPassShare` PASS, up to `spreadFailShare` CAUTION, above FAIL. */
    spreadPassShare: number;
    spreadFailShare: number;
    /** Lifetime of an order placed from the plan (matches how long a trigger stays valid). */
    orderLifetimeHours: number;
  };
}

export const ANALYZE_V2: Record<AnalyzeMode, ModeConfig> = {
  NORMAL: {
    primary: "M15",
    higher: "H1",
    execution: "M5",
    regime: { ...DEFAULT_REGIME_SETTINGS, lookback: 200 },
    zones: { mergeAtr: 0.35, maxWidthAtr: 0.8, minWidthAtr: 0.15, breakCloseAtr: 0.15, maxDistanceAtr: 15 },
    pullback: { minRetrace: 0.2, minBarsSinceExtreme: 2, nearZoneAtr: 0.25, expireBars: 8, expireAtr: 0.75 },
    data: { maxQuoteAgeMs: 2 * 60_000, maxCandleLagBars: 2, minPrimaryBars: 60, maxGapShare: 0.05 },
    plan: {
      minRewardRisk: 1.5, targetPreferencePips: 15, maxTargetPips: 30, stopAnchor: "STRUCTURE_LEVEL", stopBufferAtr: 0.1, maxStopAtr: 6,
      obstacleBufferAtr: 0.05, spreadPassShare: 0.1, spreadFailShare: 0.25, orderLifetimeHours: 2,
    },
  },
  SWING: {
    primary: "H4",
    higher: "D1",
    execution: "H1",
    regime: { ...DEFAULT_REGIME_SETTINGS, lookback: 200 },
    zones: { mergeAtr: 0.35, maxWidthAtr: 0.8, minWidthAtr: 0.15, breakCloseAtr: 0.15, maxDistanceAtr: 15 },
    pullback: { minRetrace: 0.2, minBarsSinceExtreme: 2, nearZoneAtr: 0.25, expireBars: 4, expireAtr: 0.75 },
    data: { maxQuoteAgeMs: 2 * 60_000, maxCandleLagBars: 2, minPrimaryBars: 60, maxGapShare: 0.05 },
    plan: {
      minRewardRisk: 1.5, targetPreferencePips: null, maxTargetPips: null, stopAnchor: "STRUCTURE_LEVEL", stopBufferAtr: 0.1, maxStopAtr: 6,
      obstacleBufferAtr: 0.05, spreadPassShare: 0.1, spreadFailShare: 0.25, orderLifetimeHours: 16,
    },
  },
};

/** V2.0 settings (stop under the pullback extreme, 3 ATR limit), kept for replay comparison. */
export function v20Config(mode: AnalyzeMode): ModeConfig {
  const config = ANALYZE_V2[mode];
  return { ...config, plan: { ...config.plan, stopAnchor: "PULLBACK_EXTREME", maxStopAtr: 3 } };
}

/** Every timeframe a mode reads, for callers that fetch candles. */
export function timeframesForV2(mode: AnalyzeMode): V2Timeframe[] {
  const config = ANALYZE_V2[mode];
  return [config.primary, config.higher, ...(config.execution ? [config.execution] : [])];
}
