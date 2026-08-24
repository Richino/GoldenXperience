/**
 * V1 families are FROZEN benchmarks for GoldenXperience.
 *
 * Do not retune ema / breakout / momentum / meanrev for live edge.
 * All new research belongs in api-server/research-v2/.
 *
 * Live execution remains gated by:
 *   LIVE_EXECUTABLE_FAMILIES = []
 * in frontend/src/lib/strategy/strategies/index.ts
 *
 * A V2 candidate may only become executable after:
 *   sealed OOS pass + forward shadow evidence + promotion review.
 */
export const V1_FROZEN = true as const;
