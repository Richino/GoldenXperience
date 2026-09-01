# EUR/USD Neural Day Engine V5 — News-Aware, WAIT-Capable

Verdict: **NO_ROBUST_EDGE_ON_UNTOUCHED_TEST_OR_WALKFORWARD**

Research-only. Isolated from V19 and from V2/V3/V4. No mirror math; long/short are
independent executable bid/ask simulations. Judgment is based on the **untouched TEST**
and **walk-forward**, never on training.

## Selection (validation only)
- Architecture **mlp-16**, geometry **1.5|2.5** (stopATR|reward:risk), coverage **20%**, min direction confidence **0**.
- validation only: >=30 trades and PF>1, then maximize robust expectancy; never selected on test; no win-rate target

## Headline results (1R = initial risk)
| Period | Trades | Trades/day | Win rate | Avg win | Avg loss | Expectancy | Total R | PF | Max DD | Exp 95% CI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Train (do NOT trust) | 324 | 1.679 | 50.93% | 1.360 | -0.902 | 0.2498 | 80.95 | 1.564 | 8.78 | [0.107, 0.393] |
| Validation (selection) | 217 | 1.644 | 36.87% | 1.281 | -0.874 | -0.0799 | -17.34 | 0.855 | 35.72 | [-0.237, 0.077] |
| TEST (untouched, once) | 242 | 1.254 | 45.87% | 1.250 | -0.892 | 0.0906 | 21.93 | 1.188 | 13.70 | [-0.063, 0.244] |
| Walk-forward (all folds) | 666 | 1.716 | 39.64% | 1.169 | -0.902 | -0.0812 | -54.05 | 0.851 | 65.17 | [-0.169, 0.007] |

Target was 45–52% win rate with positive expectancy after costs and more opportunities than
V19 (~0.114/day). V5 test frequency:
1.254/day.

## TEST breakdowns
| Cut | Trades | Win rate | Expectancy | Total R | PF |
|---|---:|---:|---:|---:|---:|
| Long | 71 | 40.85% | 0.0481 | 3.41 | 1.094 |
| Short | 171 | 47.95% | 0.1083 | 18.52 | 1.230 |
| News | 62 | 46.77% | -0.0119 | -0.74 | 0.975 |
| Non-news | 180 | 45.56% | 0.1259 | 22.67 | 1.260 |
| London (06-11) | 101 | 42.57% | 0.0316 | 3.19 | 1.061 |
| NY AM (11-13) | 13 | 30.77% | -0.3705 | -4.82 | 0.358 |
| NY PM (13-16) | 128 | 50.00% | 0.1840 | 23.55 | 1.413 |

## Walk-forward folds
| Fold | Trades | Win rate | Expectancy | Total R | PF |
|---|---:|---:|---:|---:|---:|
| 2025-02-01..2025-04-01 | 86 | 38.37% | -0.1140 | -9.80 | 0.801 |
| 2025-04-01..2025-06-01 | 112 | 43.75% | 0.1037 | 11.61 | 1.203 |
| 2025-06-01..2025-08-01 | 75 | 37.33% | -0.1537 | -11.52 | 0.740 |
| 2025-08-01..2025-10-01 | 75 | 41.33% | -0.2391 | -17.93 | 0.553 |
| 2025-10-01..2025-12-01 | 51 | 31.37% | -0.2471 | -12.60 | 0.564 |
| 2025-12-01..2026-02-01 | 39 | 48.72% | 0.1277 | 4.98 | 1.260 |
| 2026-02-01..2026-04-01 | 85 | 36.47% | -0.0184 | -1.56 | 0.968 |
| 2026-04-01..2026-06-01 | 71 | 40.85% | -0.0605 | -4.30 | 0.879 |
| 2026-06-01..2026-08-01 | 72 | 38.89% | -0.1796 | -12.93 | 0.674 |

## Why it fails (diagnosis — see DIAGNOSIS.json / diagnose.ts)
Attribution on the 666-trade walk-forward set, before changing anything:
- **Costs dominate.** Gross (mid-price) expectancy **+0.066R**, but execution cost averages
  **0.147R/trade** (spread + slippage) → net **−0.081R**. Cost is ~2.2× the gross edge.
- **Direction** is weak-but-real (model picks the better executable side 53.2%; chosen
  −0.081R vs opposite −0.223R). **News** carries only a faint directional signal
  (signed surprise points to the better side just **52.5%** of the time, n=1052; news-side
  −0.094R still beats anti-news −0.186R). **Quality/WAIT** head does not rank (flat-negative
  by rankScore quartile). **Every** geometry is net-negative.
- **Verdict:** structural, not a bug. At ~1.7 trades/day the spread dwarfs the tiny gross
  edge. The fix is not more gates/geometry/model tweaks — it is fewer, higher-conviction
  trades whose expected move >> spread (the V19/V20 news-event lane), or a materially
  stronger gross signal that price + this news data does not provide.

## Reading this
Training numbers are shown only to demonstrate they are NOT the basis for judgment. The
verdict is set by the untouched test and walk-forward. See EXPERIMENTS.md for the log.
