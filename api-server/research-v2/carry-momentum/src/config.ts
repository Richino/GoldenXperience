import type { Currency } from "./types.js";

export const STRATEGY_VERSION = "carry-momentum-v1";
export const WAVE_ID = "carry_momentum_wave_2_d1" as const;

export const CURRENCIES: Currency[] = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];

/**
 * Full requested universe vs what exists in OANDA H1 backfill.
 * Missing pairs are skipped — not fabricated.
 */
export const REQUESTED_PAIRS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "USD_CAD", "AUD_USD", "NZD_USD",
  "EUR_GBP", "EUR_JPY", "EUR_CHF", "EUR_CAD", "EUR_AUD", "EUR_NZD",
  "GBP_JPY", "GBP_CHF", "GBP_CAD", "GBP_AUD", "GBP_NZD",
  "AUD_JPY", "AUD_NZD", "AUD_CAD", "AUD_CHF",
  "NZD_JPY", "NZD_CAD", "NZD_CHF",
  "CAD_JPY", "CAD_CHF", "CHF_JPY",
] as const;

/** Pairs with ≥~2000 H1 bars in local DB (aggregated to D1). */
export const PAIR_UNIVERSE = [
  "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "USD_CAD", "AUD_USD", "NZD_USD",
  "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY",
] as const;

export const MISSING_PAIRS = REQUESTED_PAIRS.filter((p) => !(PAIR_UNIVERSE as readonly string[]).includes(p));

export const PRIMARY_TIMEFRAME = "D1";
export const EXEC_TIMEFRAME = "D1"; // H4 optional later; D1 close execution

export const ZONES = {
  trainStart: "2016-04-01T00:00:00.000Z",
  trainEnd: "2022-07-31T23:59:59.999Z",
  devStart: "2022-08-01T00:00:00.000Z",
  devEnd: "2025-07-31T23:59:59.999Z",
  sealedStart: "2025-08-01T00:00:00.000Z",
  sealedEnd: "2026-08-04T23:59:59.999Z",
};

/** Momentum horizons in trading days (≈ 1/3/6/12 months). */
export const MOM_HORIZONS = {
  "1m": 21,
  "3m": 63,
  "6m": 126,
  "12m": 252,
} as const;

export type MomHorizon = keyof typeof MOM_HORIZONS;
export const DEFAULT_MOM_HORIZON: MomHorizon = "3m";

export const REBALANCE = {
  daily: 1,
  weekly: 5,
  monthly: 21,
} as const;

export type RebalanceFreq = keyof typeof REBALANCE;

export const PORTFOLIO_K = [1, 2, 3] as const;
export type PortfolioK = (typeof PORTFOLIO_K)[number];

export const WEIGHT_PRESETS = [
  { label: "carry_only", carry: 1, mom: 0 },
  { label: "momentum_only", carry: 0, mom: 1 },
  { label: "50_50", carry: 0.5, mom: 0.5 },
  { label: "25_75", carry: 0.25, mom: 0.75 },
  { label: "75_25", carry: 0.75, mom: 0.25 },
] as const;

export const SLIPPAGE_PIPS = 0.2;
/** Estimated financing from rate differential — NOT double-counted as free carry in ranking. */
export const FINANCING_DAILY_SCALE = 1 / 365 / 100; // rate diff in % → daily fraction

export const DEV_GATE = {
  minRebalances: 24,
  minSharpe: 0,
  bootstrapAboveZero: true,
} as const;

export const FORWARD_HORIZONS = { "1w": 5, "1m": 21, "3m": 63 } as const;
