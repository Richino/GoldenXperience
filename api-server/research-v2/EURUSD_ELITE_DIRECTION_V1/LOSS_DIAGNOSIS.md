# EURUSD_ELITE_DIRECTION_V1 — Loss diagnosis

This is post-trade forensic analysis only. It does not feed the decision model. “Opposite” means the executable counterfactual from the identical timestamp, using the same +1R/-0.5R geometry, historical bid/ask, slippage, and conservative same-candle resolver.

- Average selected geometry: 10.26-pip target and 5.13-pip stop. The stop is half an ATR-unit by construction.

## All selected trades by realized outcome

| outcome_kind | Trades | Win rate | Target rate | Avg R | Avg model score |
|---|---:|---:|---:|---:|---:|
| STOP | 145 | 0.0% | 0.0% | -0.5101 | 0.586 |
| TARGET | 38 | 100.0% | 100.0% | 0.9900 | 0.585 |
| AMBIGUOUS_STOP | 2 | 0.0% | 0.0% | -0.5127 | 0.600 |
| TIME_EXIT | 2 | 100.0% | 0.0% | 0.7539 | 0.599 |

## Loss mechanism

| loss_cause | Trades | Win rate | Target rate | Avg R | Avg model score |
|---|---:|---:|---:|---:|---:|
| BOTH_DIRECTIONS_LOSE | 110 | 0.0% | 0.0% | -0.5104 | 0.584 |
| OPPOSITE_DIRECTION_PROFITABLE | 37 | 0.0% | 0.0% | -0.5094 | 0.593 |

## Direction selection on losing trades

| direction_status | Trades | Win rate | Target rate | Avg R | Avg model score |
|---|---:|---:|---:|---:|---:|
| TIED_R | 110 | 0.0% | 0.0% | -0.5104 | 0.584 |
| OPPOSITE_BETTER_R | 37 | 0.0% | 0.0% | -0.5094 | 0.593 |

## Calibration check: selected-score buckets

| score_band | Trades | Win rate | Target rate | Avg R | Avg model score |
|---|---:|---:|---:|---:|---:|
| 0.55-0.60 | 131 | 23.7% | 22.9% | -0.1569 | 0.571 |
| 0.60-0.65 | 50 | 14.0% | 12.0% | -0.3053 | 0.619 |
| 0.65-0.70 | 6 | 33.3% | 33.3% | -0.0066 | 0.659 |

## Session composition

| session | Trades | Win rate | Target rate | Avg R | Avg model score |
|---|---:|---:|---:|---:|---:|
| LONDON | 71 | 15.5% | 14.1% | -0.2802 | 0.588 |
| NEW_YORK | 90 | 28.9% | 27.8% | -0.0800 | 0.588 |
| OVERLAP | 26 | 11.5% | 11.5% | -0.3371 | 0.576 |

Interpretation: OPPOSITE_DIRECTION_PROFITABLE is clear direction failure. BOTH_DIRECTIONS_LOSE is a no-move/whipsaw/geometry failure, not evidence the opposite signal would have worked. OPPOSITE_LESS_BAD means direction selection was still inferior, but neither direction produced a profitable outcome.
