# Actual trade exit-management M1 replay

Research only. No database rows, engine policies, or paper/live execution behavior were changed.

Trades: 170 actual closed paper trades (2026-08-03 11:00:00+00 through 2026-08-31 20:15:00+00).

## Holdout ranking (chronological final 20%; not used to select configurations)

| Exit policy | N | Win rate | Avg R | Total R | PF | Max DD | Avg winner | Avg loser | Baseline winners harmed | Baseline losers saved | Ambiguous |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Fixed 2:1 +0.75R / -0.375R | 53 | 22.6% | -0.131 | -6.945 | 0.548 | 10.320 | 0.703 | -0.375 | 6 | 6 | 0 |
| Fixed 2:1 +0.5R / -0.25R | 53 | 15.1% | -0.137 | -7.250 | 0.356 | 7.250 | 0.500 | -0.250 | 9 | 5 | 0 |
| Fixed 2:1 +1R / -0.5R | 53 | 24.5% | -0.172 | -9.097 | 0.545 | 12.025 | 0.839 | -0.500 | 4 | 5 | 0 |
| Fixed 2:1 +1.5R / -0.75R | 53 | 26.4% | -0.237 | -12.561 | 0.549 | 16.522 | 1.094 | -0.715 | 0 | 2 | 0 |
| Breakeven after +0.5R (original target retained) | 53 | 7.5% | -0.347 | -18.385 | 0.267 | 21.049 | 1.674 | -0.929 | 8 | 14 | 0 |
| Trail 0.5R after +0.75R (no fixed target after arming) | 53 | 20.8% | -0.370 | -19.600 | 0.483 | 25.467 | 1.664 | -0.903 | 1 | 0 | 0 |
| Trail 0.25R after +0.5R (no fixed target after arming) | 53 | 20.8% | -0.380 | -20.149 | 0.476 | 25.717 | 1.664 | -0.916 | 1 | 0 | 0 |
| Breakeven after +0.75R (original target retained) | 53 | 11.3% | -0.429 | -22.729 | 0.246 | 25.392 | 1.235 | -0.913 | 6 | 8 | 0 |
| Current exit system (frozen control) | 53 | 22.6% | -0.436 | -23.088 | 0.387 | 25.751 | 1.213 | -0.918 | 0 | 0 | 0 |
| Fixed 2:1 +2R / -1R | 53 | 22.6% | -0.441 | -23.357 | 0.380 | 25.751 | 1.191 | -0.918 | 0 | 0 | 0 |
| 50% at +1R, remaining 50% to +2R with breakeven protection | 53 | 22.6% | -0.497 | -26.357 | 0.300 | 27.251 | 0.941 | -0.918 | 0 | 0 | 0 |
| 50% at +0.75R, remaining 50% to +1.5R with breakeven protection | 53 | 22.6% | -0.540 | -28.607 | 0.240 | 29.126 | 0.753 | -0.918 | 0 | 0 | 0 |

## OOS discipline

Policies were fixed before replay. The ranking is final-holdout expectancy, but this short recent dataset is not large enough to establish a production change. Consult RESULTS.json for per-trade MFE/MAE, time-to-MFE/exit, reach rates, and train/development/holdout metrics.
