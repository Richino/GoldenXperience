export const STRATEGY_VERSION = "reversal-fade-h1h4-v1";
export const WAVE_ID = "reversal_fade_h1h4_wave_1" as const;

/** Same decision universe as the stated M15 result. */
export const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;

export const TIMEFRAMES = ["H1", "H4"] as const;

/**
 * TRAIN / DEV / SEALED as specified.
 * Sealed start is a hard wall: entries and label exits must not cross it
 * until a DEV+robustness freeze unlocks sealed evaluation.
 */
export const ZONES = {
  trainStart: "2016-01-01T00:00:00.000Z",
  trainEnd: "2024-07-31T23:59:59.999Z",
  devStart: "2024-08-01T00:00:00.000Z",
  devEnd: "2025-07-31T23:59:59.999Z",
  sealedStart: "2025-08-01T00:00:00.000Z",
  sealedEnd: "2026-08-01T00:00:00.000Z",
} as const;

export const H1_HORIZONS = [1, 2, 4, 8, 12, 24] as const;
export const H4_HORIZONS = [1, 2, 3, 6, 12] as const;

export const IMPULSE_ATRS = [0.2, 0.3, 0.5, 0.75, 1.0] as const;
export const STRUCTURE_EXT_ATRS = [0.25, 0.5, 0.75] as const;
export const ENTRY_DELAYS = [0, 1, 2] as const;

export const SLIPPAGE_PIPS = 0.2;
export const ATR_PERIOD = 14;
export const BREAKOUT_LOOKBACK = 20;
export const SWING_K_H1 = 5;
export const SWING_K_H4 = 3;
export const VOL_LOOKBACK = 100;

export const DEV_GATE = {
  minIndependentN: 40,
  minNet: 0,
  preferCiAboveZero: true,
} as const;

/** Prior M15 result (not re-mined here; preserved as stated). */
export const M15_PRIOR = {
  setup: "break20 reversal",
  grossAtr: 0.128,
  netAtr: -0.129,
} as const;
