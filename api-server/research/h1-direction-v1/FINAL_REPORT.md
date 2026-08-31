# H1 Direction V1 — FINAL REPORT

## VERDICT: `NO_H1_DIRECTION_EDGE`

Generated: 2026-08-30T03:28:31.121Z

---

## Data

- **Pairs (12):** EUR/USD, GBP/USD, USD/JPY, AUD/USD, NZD/USD, USD/CAD, USD/CHF, EUR/GBP, EUR/JPY, GBP/JPY, AUD/JPY, EUR/AUD
- **Period:** 2022-08-01 → 2026-08-01
- **Total H1 candles (all pairs):** 298,868
- **Evaluation bars:** 295,580
- **Directional signals (|score| ≥ 0.60):** 19,782 (6.69% selectivity)

### Pair Coverage

| Pair | Candles | Start | End | Gaps | Missing | Spread (pips) | Source |
| --- | ---: | --- | --- | ---: | ---: | ---: | --- |
| EUR/USD | 24907 | 2022-08-01 | 2026-07-31 | 212 | 10155 | 1.6 | json |
| GBP/USD | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 1.9 | json |
| USD/JPY | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 1.7 | json |
| AUD/USD | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 1.3 | json |
| NZD/USD | 24912 | 2022-08-01 | 2026-07-31 | 217 | 10150 | 1.5 | json |
| USD/CAD | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 1.9 | json |
| USD/CHF | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 1.6 | json |
| EUR/GBP | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 1.4 | json |
| EUR/JPY | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 2.3 | json |
| GBP/JPY | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 3.2 | json |
| AUD/JPY | 24905 | 2022-08-01 | 2026-07-31 | 213 | 10157 | 2 | json |
| EUR/AUD | 24904 | 2022-08-01 | 2026-07-31 | 214 | 10158 | 2.8 | oanda |

---

## Forward Direction by Horizon

| Horizon | Signals | Wins | Losses | Ties | Win Rate | 95% CI |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1H | 19782 | 9713 | 10038 | 31 | 49.10% | [48.40%, 49.80%] |
| 2H | 19782 | 9658 | 10100 | 24 | 48.82% | [48.13%, 49.52%] |
| 3H | 19782 | 9649 | 10108 | 25 | 48.78% | [48.08%, 49.47%] |
| 4H | 19782 | 9687 | 10072 | 23 | 48.97% | [48.27%, 49.67%] |
| 6H | 19782 | 9652 | 10116 | 14 | 48.79% | [48.10%, 49.49%] |
| 8H | 19782 | 9653 | 10114 | 15 | 48.80% | [48.10%, 49.49%] |
| 12H | 19782 | 9774 | 9996 | 12 | 49.41% | [48.71%, 50.11%] |
| 24H | 19782 | 9795 | 9983 | 4 | 49.51% | [48.82%, 50.21%] |

**Best horizon (stable):** 24H — WR 49.51% [48.82%, 50.21%], n=19782

---

## Pair Results at Best Horizon (24H)

| Pair | Signals | Wins | Losses | Ties | WR |
| --- | ---: | ---: | ---: | ---: | ---: |
| EUR/USD | 1528 | 764 | 764 | 0 | 50.00% |
| GBP/USD | 1530 | 763 | 767 | 0 | 49.87% |
| USD/JPY | 1800 | 961 | 839 | 0 | 53.39% |
| AUD/USD | 1656 | 799 | 857 | 0 | 48.25% |
| NZD/USD | 1745 | 818 | 927 | 0 | 46.88% |
| USD/CAD | 1683 | 831 | 852 | 0 | 49.38% |
| USD/CHF | 1478 | 697 | 780 | 1 | 47.16% |
| EUR/GBP | 1387 | 610 | 776 | 1 | 43.98% |
| EUR/JPY | 1718 | 851 | 866 | 1 | 49.53% |
| GBP/JPY | 1732 | 897 | 835 | 0 | 51.79% |
| AUD/JPY | 1782 | 901 | 881 | 0 | 50.56% |
| EUR/AUD | 1743 | 903 | 839 | 1 | 51.81% |
| **ALL** | 19782 | 9795 | 9983 | 4 | 49.51% |

---

## Long vs Short (24H)

| Direction | Signals | Wins | Losses | WR |
| --- | ---: | ---: | ---: | ---: |
| LONG | 12725 | 6525 | 6198 | 51.28% |
| SHORT | 7057 | 3270 | 3785 | 46.34% |

---

## Regime Results (24H)

| Regime | Signals | WR | 95% CI |
| --- | ---: | ---: | --- |
| TREND_UP | 414 | 48.07% | [43.29%, 52.88%] |
| TREND_DOWN | 331 | 41.99% | [36.80%, 47.37%] |
| RANGE | 16 | 37.50% | [18.48%, 61.36%] |
| BREAKOUT | 4047 | 51.57% | [50.03%, 53.11%] |
| HIGH_VOLATILITY | 9112 | 50.18% | [49.15%, 51.20%] |
| LOW_VOLATILITY | 5862 | 47.63% | [46.35%, 48.91%] |

Best: **BREAKOUT** (51.57%, n=4047)  
Worst: **TREND_DOWN** (41.99%, n=331)

---

## Confidence Buckets (24H)

| Absolute Score | Signals | WR |
| --- | ---: | ---: |
| 0.60–0.69 | 16000 | 48.97% |
| 0.70–0.79 | 3782 | 51.82% |
| 0.80–0.89 | 0 | 0.00% |
| 0.90–1.00 | 0 | 0.00% |

**Calibration:** Higher absolute scores generally correspond to higher WR.

---

## Selectivity Analysis (24H)

| Min Score | % Hours Traded | Signals | WR |
| --- | ---: | ---: | ---: |
| 0.50 | 19.01% | 56200 | 49.09% |
| 0.60 | 6.69% | 19782 | 49.51% |
| 0.70 | 1.28% | 3782 | 51.82% |
| 0.80 | 0.00% | 0 | 0.00% |
| 0.90 | 0.00% | 0 | 0.00% |

---

## Walk-Forward

### By Year (24H)
- **2022:** 1860 signals, WR 49.19%
- **2023:** 4918 signals, WR 47.62%
- **2024:** 5022 signals, WR 51.83%
- **2025:** 4895 signals, WR 48.83%
- **2026:** 3087 signals, WR 50.05%

### By Quarter (24H, sample)
- **2024-Q4:** 1214 signals, WR 49.67%
- **2025-Q1:** 1114 signals, WR 49.82%
- **2025-Q2:** 1304 signals, WR 45.25%
- **2025-Q3:** 1203 signals, WR 46.97%
- **2025-Q4:** 1274 signals, WR 53.38%
- **2026-Q1:** 1365 signals, WR 53.19%
- **2026-Q2:** 1332 signals, WR 48.12%
- **2026-Q3:** 390 signals, WR 45.64%

---

## Baseline Comparison (24H)

| Method | Signals | WR | 95% CI Lower |
| --- | ---: | ---: | ---: |
| H1 Bot | 19782 | 49.51% | 48.82% |
| Always LONG | 295580 | 51.98% | 51.80% |
| Previous candle | 294761 | 49.61% | 49.43% |
| EMA20 slope | 295580 | 49.69% | 49.51% |
| EMA20/50 cross | 295580 | 49.35% | 49.17% |
| Random benchmark | — | 50.00% | — |

---

## Component Ablation (24H)

| Model | Signals | WR | Change vs Full |
| --- | ---: | ---: | ---: |
| FULL MODEL | 19782 | 49.51% | 0.00 pp |
| minus structure | 0 | 0.00% | -49.51 pp |
| minus EMA trend | 0 | 0.00% | -49.51 pp |
| minus momentum | 0 | 0.00% | -49.51 pp |
| minus volatility | 18234 | 48.34% | -1.17 pp |
| minus price location | 29058 | 49.03% | -0.49 pp |
| minus regime adj | 21917 | 50.03% | 0.51 pp |

Largest WR drop (models that still trade): **minus volatility**

---

## Trading Simulation (ATR stop, best horizon context)

Conservative fill: simultaneous TP+SL in one bar → SL/AMBIGUOUS.

| RR | Mode | Trades | Wins | Losses | WR | Total R | Exp/Trade | PF |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1:1 | GROSS | 19782 | 9416 | 10008 | 48.48% | -950.0 | -0.048 | 0.94 |
| 1.5:1 | GROSS | 19782 | 7557 | 11992 | 38.66% | -887.5 | -0.045 | 0.95 |
| 2:1 | GROSS | 19782 | 6207 | 13387 | 31.68% | -1149.0 | -0.058 | 0.93 |
| 1:1 | NET | 19782 | 9416 | 10008 | 48.48% | -3670.6 | -0.186 | 0.71 |
| 1.5:1 | NET | 19782 | 7557 | 11992 | 38.66% | -3607.9 | -0.182 | 0.76 |
| 2:1 | NET | 19782 | 6207 | 13387 | 31.68% | -3868.6 | -0.196 | 0.76 |

---

## Answers

1. **Better than short-horizon ~50%?** No — 49.51% at 24H is near random.
2. **Best horizon?** 24H
3. **Statistically meaningful?** No — 95% CI includes 50% ([48.82%, 50.21%]).
4. **Broad across pairs?** 1 of 12 pairs above 52% WR at best horizon.
5. **Selectivity helps?** Marginal lift at 0.70 (51.82%, n=3782) but still near random.
6. **Best regime?** BREAKOUT (51.57%, n=4047)
7. **Top component (among variants with signals)?** Removing **minus volatility** changes WR by -1.17 pp.
8. **Beats baselines?** No — at least one simple baseline matches or beats the bot.
9. **Positive R after costs?** No — NET expectancy ≤ 0 for all RR configs tested.
10. **Worth developing further?** No — treat as null result and do not wire into live engine.

> Reproduce: `cd api-server && npm run h1-direction-v1`
