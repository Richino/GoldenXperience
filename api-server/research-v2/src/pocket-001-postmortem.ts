/**
 * Post-mortem of gx-v2-candidate-001 (ROBUSTNESS_REJECT).
 * Used only to motivate NEW hypotheses — never to retune 001.
 *
 * Observed pocket (sealed 2025–2026, overlap/4h/logistic):
 * - Profit almost entirely USD_JPY + EUR_JPY absolute price units
 * - LONG profitable; SHORT negative
 * - Bear + high-vol + expansion regimes dominate; bull/range/low-vol lose
 * - Single month 2025-04 > entire sample net; 2026 calendar year net negative
 * - Edge dies without both JPY pairs or without 2025-04 / top winners
 *
 * Mechanistic hypotheses to test separately (TRAIN/DEV → fresh OOS):
 * 1. JPY cross-sectional relative strength (not overlap-session generic ML)
 * 2. Vol-expansion × JPY-weakness interaction (carry unwind / risk-off proxy)
 * 3. Long-only asymmetry on JPY crosses
 * 4. Same structure in an independent pre-2025 sealed window (2024)
 * 5. Rate/yield differentials once FRED (or equivalent) history is available
 * 6. Event-window proxies (Tokyo/London/NY open + US data hours) until calendar history lands
 *
 * Forbidden: tuning thresholds on April 2025 or re-optimizing H12/001.
 */
export const CANDIDATE_001_STATUS = "ROBUSTNESS_REJECT" as const;
export const CANDIDATE_001_ID = "gx-v2-candidate-001";
