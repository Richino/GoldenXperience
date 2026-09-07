# DIRECTION_EXOGENOUS_V1 — Final report

Final verdict: **NO_EXOGENOUS_DIRECTION_EDGE**

Question: does genuinely NEW exogenous market information add EUR/USD UP/DOWN predictive power that price-derived features alone cannot provide?

## Lane verdict table

| Lane | Data quality | Best horizon | OOS AUC | Incremental AUC | Holdout | WF consistency | Verdict |
|---|---|---|---:|---:|---|---|---|
| RATES | partial, not revision-safe | — | — | — | — | — | INSUFFICIENT_DATA |
| CENTRAL_BANK | none local | — | — | — | — | — | INSUFFICIENT_DATA |
| CROSS_FX | full M15 | 30m | 0.5113 | +0.0032 | ≈0 | 16/32 folds | NO_DIRECTION_SIGNAL |
| POSITIONING | none local | — | — | — | — | — | INSUFFICIENT_DATA |
| ORDER_FLOW | none local | — | — | — | — | — | INSUFFICIENT_ORDER_FLOW_DATA |
| OPTIONS | none local | — | — | — | — | — | INSUFFICIENT_OPTIONS_DATA |

Only **CROSS_FX** had local historical data meeting the causal requirements. RATES, CENTRAL_BANK, POSITIONING, ORDER_FLOW and OPTIONS are INSUFFICIENT_DATA; the configured rates feed lacks comparable German point-in-time vintages and the price caches carry no volume. No weak proxies were substituted (see DATA_INVENTORY.md).

## CROSS_FX — incremental over frozen baseline (all direction rows)

| Horizon | BASE AUC | CROSS_FX alone | BASE+CROSS_FX | Incremental AUC | Folds won | Walk-forward (both vs base) |
|---|---:|---:|---:|---:|---:|---|
| 15m | 0.5175 | 0.5005 | 0.5143 | -0.0031 | 4/8 | 0.5179 vs 0.5184 |
| 30m | 0.5081 | 0.5043 | 0.5113 | +0.0032 | 3/8 | 0.5136 vs 0.5159 |
| 60m | 0.5099 | 0.4967 | 0.5054 | -0.0045 | 4/8 | 0.5097 vs 0.5111 |
| 120m | 0.5162 | 0.4973 | 0.5084 | -0.0079 | 5/8 | 0.5116 vs 0.5125 |

## Headline
- **BEST EXOGENOUS SIGNAL:** CROSS_FX (only lane with data)
- **BEST HORIZON:** 30m
- **BASELINE AUC:** 0.5081
- **NEW AUC (BASE+CROSS_FX):** 0.5113
- **INCREMENTAL EDGE:** +0.0032 AUC (best horizon)
- **ORACLE-MOVE IMPROVEMENT AT PRIMARY-BEST HORIZON:** -0.0020 at 30m (separate ground-truth MOVE subset)
- **BEST ORACLE-ONLY RESULT:** +0.0228 at 120m; isolated to one horizon and contradicted by the ordinary 120m test, so it does not establish an edge
- **WALK-FORWARD FOLDS WON:** 16/32 (base+lane AUC > base AUC)
- **CALIBRATION QUALITY:** near-uninformative; Brier at best horizon 0.2506 (see CALIBRATION.csv)
- **DATA LIMITATIONS:** 5 of 6 lanes lack qualifying point-in-time data; CROSS_FX excludes EUR/USD's own price from EUR-basket to stay exogenous; labels overlap (effective N ≈ N/horizon).

## Conditional & ablation
- CONDITIONAL_RESULTS.csv: incremental by session / volatility / news / strong-MOVE-confidence — checked so no single subgroup drives a false positive.
- ABLATION_RESULTS.csv: not run because no promising combined model passed the preliminary gate; the file records the skip reason, as required by the protocol.
- COMBINATION_RESULTS.csv: only one lane had data, so no multi-lane combination was possible.

## Judgment
Adding exogenous CROSS_FX information does NOT meet the predeclared evidence gate over the frozen baseline (best incremental +0.0032 AUC). That means the completed test does not establish NEW directional information from CROSS_FX. The macro lanes could not be tested under their strict point-in-time requirements. **The negative result is therefore about the tested CROSS_FX construction; the macro-rates hypothesis remains UNTESTED for lack of comparable point-in-time data, not disproven.**

Frozen MOVE_MODEL / DIRECTION_MODEL / diagnosis used read-only. No paper-trading or production connection.
