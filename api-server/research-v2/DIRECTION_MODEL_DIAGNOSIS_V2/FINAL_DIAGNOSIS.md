# DIRECTION_MODEL_DIAGNOSIS_V2 — Final diagnosis

Decomposition of the `NO_DIRECTION_EDGE` result. MOVE_MODEL and the original DIRECTION_MODEL were used read-only and left frozen. Diagnosis only — no TP/SL, sizing, execution, paper or production.

## Verdict table

| Subproblem | Edge | Evidence (best OOS) |
|---|---|---|
| LONG edge | UNCLEAR | best trend-long-conditional AUC 0.5275 (n=2724), not consistent across horizons |
| SHORT edge | UNCLEAR | best trend-short-conditional AUC 0.5228 (n=3587), not consistent across horizons |
| Continuation edge | NO | best model AUC 0.5095; max |base−0.5| 0.0345 |
| Reversal edge | NO | mirror of continuation (same moving-state target) |
| Breakout-direction edge | UNCLEAR | best near-boundary AUC 0.5294 (n=883), holdout+walk-forward |
| Level-reaction edge | UNCLEAR | best near-level AUC 0.5474 (n=453); max |break−0.5| 0.0298 |

'Best X' below are the arg-max of noisy ≈0.50 AUCs (nothing exceeds chance meaningfully or consistently); they are reported as requested but are NOT evidence of edge.
- **Best session:** NEW_YORK (AUC 0.5985)
- **Best horizon:** 15m (AUC 0.5212)
- **Best market state:** HIGH_VOL (AUC 0.5445)
- **Best feature family:** structure
- **Worst feature family:** momentum
- **Main source of bad confidence:** overfitting / noise (high-confidence buckets are tiny and unstable)
- **Largest failure category (15m):** WRONG_REVERSAL_CALL (33.1% of errors)

## The decisive answer
NO DIRECTIONAL SIGNAL: the failure is not caused by mixing behaviors — every decomposed subproblem (long-only, short-only, continuation, reversal, breakout-side, level-reaction), in every session, horizon, market state and feature family, is at chance out-of-sample. The information required to call direction is absent from the current features.

## Reading guide
- AUC/balanced-accuracy ≈ 0.50 = cannot separate the two classes; raw accuracy just tracks class skew and is not evidence of edge.
- `EDGE=YES` requires OOS AUC > 0.53 with n≥200; `UNCLEAR` = 0.515–0.53 or thin n; `NO` = ≤0.515.
- Continuation base rates far from 0.50 would indicate exploitable momentum/mean-reversion even without a model; see CONTINUATION_REVERSAL.csv.
- Per-file: LONG_SHORT_RESULTS, CONTINUATION_REVERSAL, SESSION_DIRECTION, HORIZON_DIRECTION, MARKET_STATE_DIRECTION, BREAKOUT_DIRECTION, LEVEL_REACTION, FEATURE_FAMILY_ISOLATION, CONFIDENCE_FAILURE, ERROR_TAXONOMY.

## Method notes
- Same frozen dataset/features/leakage-controls/walk-forward + untouched holdout (2026-02→2026-08) as DIRECTION_MODEL. Oracle-move selection (ground-truth moves) used so MOVE selection is not a confound.
- Sessions are DST-aware (EU + US rules) via London/New-York local trading hours.
- 5m is an extension computed on M5 with the same methodology (frozen MOVE_MODEL only covers 15m+); M5 history starts 2023-08, so its walk-forward is shorter.
- Labels overlap across bars (effective N ≈ N/horizon); edges judged conservatively.
