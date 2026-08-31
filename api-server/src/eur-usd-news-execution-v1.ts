export type EurUsdNewsDirection = "long" | "short";

/**
 * Frozen from 2024-25 development, for practice shadow observation only.
 * The 2025-26 validation result was positive but small and is not sufficient
 * authority for order placement.
 */
export const EUR_USD_NEWS_EXECUTION_V1 = Object.freeze({
  instrument: "EUR_USD" as const,
  status: "SHADOW_ONLY" as const,
  confirmationMinutes: 15,
  lowVolatilityAtrCeilingPips: 5.53,
  stopAtr: 1,
  targetToStop: 2,
  winPayoff: 1.5,
  lossPayoff: -0.75,
  maximumHoldingHours: 72,
});

export function createEurUsdNewsExecutionLevels(input: {
  direction: EurUsdNewsDirection;
  executableEntry: number;
  preNewsAtr: number;
}) {
  if (!Number.isFinite(input.executableEntry) || input.executableEntry <= 0) throw new Error("Executable entry must be positive.");
  if (!Number.isFinite(input.preNewsAtr) || input.preNewsAtr <= 0) throw new Error("Pre-news ATR must be positive.");
  const risk = EUR_USD_NEWS_EXECUTION_V1.stopAtr * input.preNewsAtr;
  return input.direction === "long"
    ? { stop: input.executableEntry - risk, target: input.executableEntry + EUR_USD_NEWS_EXECUTION_V1.targetToStop * risk, risk }
    : { stop: input.executableEntry + risk, target: input.executableEntry - EUR_USD_NEWS_EXECUTION_V1.targetToStop * risk, risk };
}
