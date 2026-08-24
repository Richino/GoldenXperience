/**
 * V2 research config — data zones, universes, edge gates.
 * Thresholds and search grids are chosen on TRAIN/DEV only.
 */

import type { DataZones, FeatureFamily, HorizonId, ModelKind } from "./types.js";

export const V2_VERSION = "gx-research-v2.0.0";

/** Primary research universe — start with liquid majors; expand in later hunts. */
export const DEFAULT_PAIRS = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
  "AUD_USD",
  "USD_CAD",
  "EUR_JPY",
] as const;

export const DEFAULT_TIMEFRAME = "H1";

/** Horizon in bars of the primary timeframe (H1 → hours). */
export const HORIZON_BARS: Record<HorizonId, number> = {
  "15m": 1, // only meaningful on M15 panels
  "30m": 2,
  "1h": 1,
  "2h": 2,
  "4h": 4,
  "1d": 24,
};

export const RESEARCH_HORIZONS: HorizonId[] = ["1h", "2h", "4h", "1d"];

/**
 * Fixed chronological zones. SEALED starts 2025-01-01 and is never used for threshold tuning.
 * April 2025 must never be used as a tuning target for new hypotheses.
 */
export const DEFAULT_ZONES: DataZones = {
  trainStart: "2023-01-01T00:00:00.000Z",
  trainEnd: "2024-06-30T23:59:59.999Z",
  devStart: "2024-07-01T00:00:00.000Z",
  devEnd: "2024-12-31T23:59:59.999Z",
  sealedStart: "2025-01-01T00:00:00.000Z",
  sealedEnd: "2099-01-01T00:00:00.000Z",
};

/**
 * Independent pre-2025 sealed window — tests whether a structure exists
 * without any 2025 (incl. April) sealed exposure.
 */
export const ZONES_INDEPENDENT_2024: DataZones = {
  trainStart: "2020-01-01T00:00:00.000Z",
  trainEnd: "2022-12-31T23:59:59.999Z",
  devStart: "2023-01-01T00:00:00.000Z",
  devEnd: "2023-12-31T23:59:59.999Z",
  sealedStart: "2024-01-01T00:00:00.000Z",
  sealedEnd: "2024-12-31T23:59:59.999Z",
};

export const JPY_CROSS_PAIRS = ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"] as const;

export const EDGE_GATES = {
  discovery: {
    minN: 40,
    minNetExpectancy: 0,
  },
  candidate: {
    minN: 60,
    minNetExpectancy: 0,
  },
  strong: {
    minN: 150,
    minNetExpectancy: 0,
    requireCiAboveZero: true,
  },
} as const;

export const DEFAULT_SLIPPAGE_PIPS = 0.1;
export const SAFETY_MARGIN_RETURN = 0.00005; // absolute price fraction buffer

export const ABSTENTION_GRID = {
  minProbAdvantage: [0.02, 0.05, 0.08, 0.12],
  minExpectedNet: [0, 0.00005, 0.0001, 0.0002],
  minConfidence: [0.52, 0.55, 0.6, 0.65],
} as const;

export type DirectionMode = "both" | "long_only" | "short_only";

export type HypothesisSpec = {
  id: string;
  hypothesis: string;
  featureFamilies: FeatureFamily[];
  horizons: HorizonId[];
  modelKinds: ModelKind[];
  regimeFilter?: Partial<{
    trend: Array<RegimeTrend>;
    volBucket: Array<"low" | "normal" | "high">;
    volPhase: Array<"compression" | "normal" | "expansion">;
    session: Array<"asia" | "london" | "newyork" | "overlap" | "off">;
  }>;
  pairs?: readonly string[];
  timeframe?: string;
  stride?: number;
  /** Optional alternate TRAIN/DEV/SEALED (e.g. independent pre-2025 OOS). */
  zones?: DataZones;
  directionMode?: DirectionMode;
  /** Skip in default hunts (retired / rejected ideas). */
  retired?: boolean;
};

type RegimeTrend = "bull" | "bear" | "range" | "mixed";

export const HYPOTHESIS_CATALOG: HypothesisSpec[] = [
  {
    id: "H01",
    hypothesis: "Price/structure features alone predict H1–4h net returns after spread",
    featureFamilies: ["price", "regime", "session"],
    horizons: ["1h", "2h", "4h"],
    modelKinds: ["ridge", "logistic", "boost_reg"],
    stride: 2,
  },
  {
    id: "H02",
    hypothesis: "Cross-pair / currency strength adds predictive power vs standalone price",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["1h", "2h", "4h"],
    modelKinds: ["ridge", "logistic", "boost_reg"],
    stride: 2,
  },
  {
    id: "H03",
    hypothesis: "Volatility compression regimes improve directional predictability",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["2h", "4h"],
    modelKinds: ["ridge", "boost_reg"],
    regimeFilter: { volPhase: ["compression"] },
    stride: 2,
  },
  {
    id: "H04",
    hypothesis: "Trend regimes + London/NY overlap improve momentum-style predictability",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["1h", "2h", "4h"],
    modelKinds: ["ridge", "logistic", "boost_reg"],
    regimeFilter: { trend: ["bull", "bear"], session: ["overlap", "london"] },
    stride: 2,
  },
  {
    id: "H05",
    hypothesis: "Range regimes mean-revert over 1–2h after costs",
    featureFamilies: ["price", "regime", "session"],
    horizons: ["1h", "2h"],
    modelKinds: ["ridge", "logistic"],
    regimeFilter: { trend: ["range"] },
    stride: 2,
  },
  {
    id: "H06",
    hypothesis: "Daily horizon is more predictable than intraday after costs",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["1d"],
    modelKinds: ["ridge", "logistic", "boost_reg"],
    stride: 6,
  },
  {
    id: "H07",
    hypothesis: "High-vol expansion favors continuation over 2–4h",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["2h", "4h"],
    modelKinds: ["ridge", "boost_reg"],
    regimeFilter: { volPhase: ["expansion"], volBucket: ["high"] },
    stride: 2,
  },
  {
    id: "H08",
    hypothesis: "Relative USD strength predicts USD crosses over 4h",
    featureFamilies: ["cross_pair", "regime", "session"],
    horizons: ["4h", "1d"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["EUR_USD", "GBP_USD", "AUD_USD", "NZD_USD", "USD_JPY", "USD_CAD", "USD_CHF"],
    stride: 3,
  },
  {
    id: "H09",
    hypothesis: "Low-vol environments: only strong probability edges clear costs",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["2h", "4h"],
    modelKinds: ["logistic", "boost_reg"],
    regimeFilter: { volBucket: ["low"] },
    stride: 2,
  },
  {
    id: "H10",
    hypothesis: "Cross-sectional divergence (pair vs basket) mean-reverts over 4h",
    featureFamilies: ["cross_pair", "price", "regime"],
    horizons: ["4h"],
    modelKinds: ["ridge", "logistic"],
    stride: 2,
  },
  {
    id: "H11",
    hypothesis: "ATR-normalized forward returns are more learnable than raw price returns",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["2h", "4h", "1d"],
    modelKinds: ["ridge", "logistic"],
    stride: 3,
  },
  {
    id: "H12",
    hypothesis: "Overlap session only: price+cross features clear costs over 4h",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["4h"],
    modelKinds: ["ridge", "logistic", "boost_reg"],
    regimeFilter: { session: ["overlap"] },
    stride: 1,
    retired: true, // gx-v2-candidate-001 ROBUSTNESS_REJECT — do not retune
  },

  // --- Wave B: motivated by 001 pocket analysis (new ideas, not parameter rescue) ---
  {
    id: "H13",
    hypothesis: "JPY crosses: cross-sectional JPY strength predicts 4h returns after costs",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["4h", "1d"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    stride: 2,
  },
  {
    id: "H14",
    hypothesis: "Vol-expansion × JPY-weakness interaction predicts JPY-cross continuation",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["2h", "4h"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    regimeFilter: { volPhase: ["expansion"], volBucket: ["high", "normal"] },
    stride: 2,
  },
  {
    id: "H15",
    hypothesis: "Long-only on JPY crosses in high-vol expansion (asymmetry from 001)",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["4h"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    regimeFilter: { volBucket: ["high"], volPhase: ["expansion"] },
    directionMode: "long_only",
    stride: 2,
  },
  {
    id: "H16",
    hypothesis: "Short-only on JPY crosses — falsify whether shorts ever clear costs",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["4h"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    directionMode: "short_only",
    stride: 2,
  },
  {
    id: "H17",
    hypothesis: "Bear-trend + high-vol JPY crosses (risk-off proxy without using Apr-2025 tuning)",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["4h", "1d"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    regimeFilter: { trend: ["bear"], volBucket: ["high"] },
    stride: 2,
  },
  {
    id: "H18",
    hypothesis: "Independent 2024 sealed: JPY relative strength (no 2025 sealed exposure)",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["4h", "1d"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    zones: ZONES_INDEPENDENT_2024,
    stride: 2,
  },
  {
    id: "H19",
    hypothesis: "Independent 2024 sealed: long-only JPY under vol expansion",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["4h"],
    modelKinds: ["logistic", "ridge"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    regimeFilter: { volPhase: ["expansion"] },
    directionMode: "long_only",
    zones: ZONES_INDEPENDENT_2024,
    stride: 2,
  },
  {
    id: "H20",
    hypothesis: "Session event-proxy hours (Tokyo/London/NY opens) add JPY predictability",
    featureFamilies: ["price", "cross_pair", "regime", "session", "events"],
    horizons: ["2h", "4h"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    stride: 2,
  },
  {
    id: "H21",
    hypothesis: "Macro/rate adapters (no-op until FRED history) — document data blocker if empty",
    featureFamilies: ["price", "cross_pair", "regime", "macro"],
    horizons: ["4h", "1d"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY"],
    stride: 3,
  },
  {
    id: "H22",
    hypothesis: "EUR_JPY vs USD_JPY divergence mean-reverts over 4h (cross-pair relative)",
    featureFamilies: ["cross_pair", "price", "regime"],
    horizons: ["4h"],
    modelKinds: ["ridge", "logistic"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    stride: 2,
  },
  {
    id: "H23",
    hypothesis: "Non-overlapping 1d JPY relative strength (stride=24) — purged overlap vs gx-v2-003",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["1d"],
    modelKinds: ["logistic", "ridge"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    directionMode: "long_only",
    stride: 24,
  },
  {
    id: "H24",
    hypothesis: "Independent 2024-only sealed (sealedEnd fixed): JPY 1d long-only non-overlap",
    featureFamilies: ["price", "cross_pair", "regime", "session"],
    horizons: ["1d"],
    modelKinds: ["logistic", "ridge"],
    pairs: ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"],
    directionMode: "long_only",
    zones: ZONES_INDEPENDENT_2024,
    stride: 24,
  },
];
