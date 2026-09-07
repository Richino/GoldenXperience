# MOVE_MODEL — Final report

Final verdict: **MOVE_EDGE_FOUND**

Question answered: can EUR/USD's *timing of a meaningful (volatility-normalized) move* be predicted out-of-sample, independent of direction?

## Most predictable horizon (walk-forward, GBT)

| Horizon | Mean GBT AUC | Min fold AUC | Mean seasonal-clock AUC |
|---|---:|---:|---:|
| 120m | 0.8203 | 0.7703 | 0.7982 |
| 60m | 0.7953 | 0.7626 | 0.7726 |
| 30m | 0.7723 | 0.7447 | 0.7470 |
| 15m | 0.7610 | 0.7389 | 0.7353 |

Most predictable horizon: **120m** (primary threshold 2 ATR).

## Final untouched holdout (per horizon, primary threshold)

| Horizon | Thr | MOVE rate | **Seasonal-clock AUC** | Logistic AUC | GBT AUC | GBT − clock | GBT acc |
|---|---:|---:|---:|---:|---:|---:|---:|
| 15m | 0.75 | 0.435 | 0.7114 | 0.7261 | 0.7432 | +0.0317 | 0.6926 |
| 30m | 1 | 0.487 | 0.7156 | 0.7283 | 0.7468 | +0.0312 | 0.6866 |
| 60m | 1.5 | 0.462 | 0.7363 | 0.7407 | 0.7655 | +0.0293 | 0.7019 |
| 120m | 2 | 0.514 | 0.7630 | 0.7566 | 0.7890 | +0.0261 | 0.7171 |

The **seasonal-clock baseline** = P(MOVE | half-hour-of-day), i.e. pure intraday volatility seasonality with zero model skill. It is the honest null and already scores ~0.74–0.82 AUC. The `GBT − clock` column is the only number that represents genuine, non-trivial move-timing skill.

## The headline number is mostly a volatility clock
Against random/majority the model looks spectacular (AUC 0.75–0.91), but that is almost entirely EUR/USD's well-known intraday volatility cycle (quiet Asia → active London/NY). Once measured against the seasonal clock, the incremental edge is small. See ROBUSTNESS_RESULTS.csv: the clock alone reaches AUC 0.74–0.82; the model's incremental edge is ~+0.02–0.03 AUC on volatility-normalized labels and ~+0.04–0.07 on a raw-pips label. Crucially, that incremental edge **survives** re-defining the label with a stable (slow) volatility denominator and with raw pips — so it is not purely the ATR-normalization artifact — and it holds across every walk-forward fold and the untouched holdout.

## Critical diagnostics
1. **Beats the HONEST (seasonal-clock) baseline out-of-sample?** Yes, but by a small margin — final GBT AUC 0.7890 vs seasonal 0.7630 (incremental +0.0261). Against random it beats by ~0.25 AUC, but that is the clock, not skill.
2. **Most predictable horizon:** 120m (longer horizons have higher raw AUC, but also higher incremental edge on the raw-pips label — see ROBUSTNESS_RESULTS.csv).
3. **Most predictable threshold:** see THRESHOLD_SWEEP.csv; balanced-class primary per horizon = 15m:0.75, 30m:1, 60m:1.5, 120m:2.
4. **Does confidence track accuracy?** Yes — the GBT is well calibrated (CALIBRATION.csv; predicted≈actual across bins). Best-horizon Brier = 0.1876.
5. **Regimes:** works best in LOW/MID volatility, degrades in HIGH volatility (REGIME_RESULTS.csv). By session and news: SESSION_RESULTS.csv / NEWS_RESULTS.csv.
6. **Survives every walk-forward fold?** 8/8 folds beat the seasonal clock by >0.01 AUC.
7-8. **Feature contribution / ablation:** the edge is driven by TIME-OF-DAY (largest) then VOLATILITY level and MULTI-TIMEFRAME vol. **News contributes ~0.000 AUC.** Momentum, candle, spread, location add nothing. See ABLATION_RESULTS.csv (positive delta = removal improved dev AUC → harmful/noise).

## Neural net
Gate opened (GBT cleared the baseline gate). NN holdout AUC = 0.7815 — no better than the GBT, so no extra complexity is warranted (see RESULTS.json).

## Judgment
There is a **small but repeatable** out-of-sample signal for WHEN EUR/USD makes a meaningful move, ABOVE the intraday volatility clock — it survives all walk-forward folds, the untouched holdout, and re-definition of the label (stable-vol denominator and raw pips), so it is not merely the ATR-normalization artifact. IMPORTANT CAVEATS: (a) ~90% of the raw AUC is the trivial volatility clock, not skill; (b) this is a TIMING/MAGNITUDE signal only — it says NOTHING about direction; (c) it has not been shown that the incremental move-size is large enough to beat the spread. It is saved to feed a separate DIRECTION_MODEL, whose job is the still-unsolved part.

This experiment models MOVE only. DIRECTION_MODEL was NOT built.
