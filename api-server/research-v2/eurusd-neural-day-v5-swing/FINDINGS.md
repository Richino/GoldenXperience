# V5-SWING — Does swing horizon rescue the cost-bound engine?

Verdict: **NO_ROBUST_EDGE_AT_SWING_HORIZON** — swinging fixed the cost, but the
directional edge did not survive the longer horizon (it went negative *before* costs).

Research-only. Same features / heads / WAIT / split / walk-forward discipline as V5;
only geometry (stop 3/5/8 ATR) and hold (2 trading days) changed. No mirror math.

## Hypothesis and what happened
Spread is fixed in pips, so a ~5× wider stop should cut cost/R ~5×. It did:

| | Intraday V5 | Swing (5 ATR, RR 2, 2-day) |
|---|---:|---:|
| Avg cost / trade | 0.147R | **0.028R** |
| Gross expectancy | **+0.066R** | **−0.024R** |
| Net expectancy (walk-forward) | −0.081R | −0.052R |
| Net PF (walk-forward) | 0.85 | 0.90 |
| Model picks better side | 53.2% | 51.6% |
| News predicts better side | 52.5% | **44.2%** |
| Trades/day | 1.72 | 0.50 |

The cost hypothesis was correct and is now off the table. The problem is that the tiny
intraday gross edge (+0.066R) was short-horizon microstructure that **does not persist to
multi-day**: at swing horizon direction is ~coin-flip and the news signal is below 50%.

## Results (selected on validation only: logistic, stop 5 ATR, RR 2, coverage 20%, min conf 0.10)
| Period | Trades | Trades/day | Win rate | Expectancy | Total R | PF |
|---|---:|---:|---:|---:|---:|---:|
| TEST (untouched, once) | 96 | 0.497 | 39.6% | −0.053R | −5.10 | 0.90 |
| Walk-forward (all folds) | 192 | 0.495 | 39.6% | −0.052R | −10.05 | 0.90 |

## Conclusion
Swing does not rescue V5. Cutting cost only revealed that there was no durable directional
edge underneath. This matches the earlier standalone swing engine (`eurusdbot3-1`, NO_EDGE,
gross breakeven). Neither cost reduction (swing) nor more attempts (intraday) manufactures
direction. The only lane with a real, event-driven directional signal remains the
low-frequency high-impact-news approach (V19/V20).
