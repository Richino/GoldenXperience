/**
 * binary-fade-v1 — the authoritative live binary model.
 *
 * Rule, taken verbatim from the 1,160-configuration stability sweep in
 * `scripts/_binary_push_to_65_stable.ts` (holdout winrate 67.1% on n=252,
 * quarter standard deviation 1.3pp):
 *
 *     when price closes >= 1.25 ATR outside the 20-period 2-sigma
 *     Bollinger band, and RSI(14) confirms an overbought/oversold
 *     stretch, take the 10-minute binary AGAINST the break.
 *
 *     - price above upper band AND RSI > 65   -> predict DOWN
 *     - price below lower band AND RSI < 35   -> predict UP
 *     - otherwise                             -> WAIT
 *
 * EUR_AUD is excluded because it was the weakest pair in the discovery
 * split (48.6% on the base band-break fade) and its inclusion pulled the
 * per-pair minimum below the 55% floor.
 *
 * The model deliberately does NOT tune any parameter from live data or
 * accept a shadow calibration. It reproduces the exact frozen rule that
 * the stability search picked, so the live winrate can be compared
 * cleanly to the backtest number.
 */
import type { BinaryFeatures, BinaryModel, BinaryDecision } from "./binary-engine.js";

/** Names used to tag rows in `binary_predictions`. */
export const BINARY_FADE_MODEL_NAME = "binary-fade-v1";
export const BINARY_FADE_MODEL_VERSION = "1.0.0";

/** ATR-normalised extension outside the band required to fire. */
export const BINARY_FADE_MIN_EXTENSION_ATR = 1.25;
/** Overbought threshold; the mirror value (100 - X) is used for oversold. */
export const BINARY_FADE_RSI_HIGH = 65;
/** Score below which the engine returns WAIT — enforces the fade threshold. */
export const BINARY_FADE_THRESHOLD = 0.60;

/**
 * Instruments the fade rule refuses to trade regardless of signal strength.
 * Backtested as net-negative on the discovery sample.
 */
export const BINARY_FADE_EXCLUDED_PAIRS: readonly string[] = ["EUR_AUD"];

export function isFadeExcluded(instrument: string): boolean {
  return BINARY_FADE_EXCLUDED_PAIRS.includes(instrument);
}

/** Descriptive config saved to `binary_models.configuration`. */
export const BINARY_FADE_CONFIGURATION = {
  rule: "bollinger-band-fade",
  horizonSeconds: 600,
  bollinger: { period: 20, stdev: 2 },
  atrPeriod: 14,
  minExtensionAtr: BINARY_FADE_MIN_EXTENSION_ATR,
  rsiPeriod: 14,
  rsiHigh: BINARY_FADE_RSI_HIGH,
  rsiLow: 100 - BINARY_FADE_RSI_HIGH,
  excludedPairs: [...BINARY_FADE_EXCLUDED_PAIRS],
  threshold: BINARY_FADE_THRESHOLD,
  provenance: "scripts/_binary_push_to_65_stable.ts holdout 67.1% qStd=1.3pp",
};

/**
 * Build the model. The threshold is exposed for tests; production uses the
 * default so the rule is fully described by frozen constants.
 */
export function createFadeModel(threshold = BINARY_FADE_THRESHOLD): BinaryModel {
  return {
    name: BINARY_FADE_MODEL_NAME,
    version: BINARY_FADE_MODEL_VERSION,
    scoreKind: "heuristic_score",
    threshold,
    evaluate(features: BinaryFeatures): BinaryDecision {
      if (isFadeExcluded(features.instrument)) {
        return { direction: "wait", score: 0.5, rationale: `${features.instrument} is excluded from fade-v1.` };
      }
      const bb = features.bollinger;
      const rsi = features.rsi14;
      if (!bb || rsi === null || features.atrPips === null || features.atrPips <= 0) {
        return { direction: "wait", score: 0.5, rationale: "Bollinger, RSI or ATR unavailable." };
      }
      if (bb.dir === 0 || bb.extAtr < BINARY_FADE_MIN_EXTENSION_ATR) {
        return { direction: "wait", score: 0.5, rationale: `Extension ${bb.extAtr.toFixed(2)} ATR is below the ${BINARY_FADE_MIN_EXTENSION_ATR} floor.` };
      }
      const wantsShort = bb.dir === 1;
      const rsiConfirms = wantsShort ? rsi > BINARY_FADE_RSI_HIGH : rsi < 100 - BINARY_FADE_RSI_HIGH;
      if (!rsiConfirms) {
        return { direction: "wait", score: 0.55, rationale: `RSI ${rsi.toFixed(1)} does not confirm the fade.` };
      }
      // Score climbs from 0.60 at the threshold to 0.90 for a 2 ATR-plus stretch.
      // Kept in [0.60, 0.90] so scoreKind stays honestly "heuristic" and never
      // drifts into calibrated-probability territory.
      const excess = Math.min(1, (bb.extAtr - BINARY_FADE_MIN_EXTENSION_ATR) / 0.75);
      const score = Math.max(threshold, Math.min(0.90, 0.60 + 0.30 * excess));
      const direction: "up" | "down" = wantsShort ? "down" : "up";
      const rationale = `Fade ${wantsShort ? "upper" : "lower"} band break (${bb.extAtr.toFixed(2)} ATR, RSI ${rsi.toFixed(1)}, streak ${bb.streak}).`;
      return { direction, score, rationale };
    },
  };
}
