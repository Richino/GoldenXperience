# Pre-News Prediction v1 — USD High-Impact

_Generated 2026-09-11T15:57:59.363292+00:00_

## Verdict

**NO_PRE_NEWS_EDGE** — the model does not produce a positive, baseline-beating edge on the historical walk-forward.

> The verdict is based on the **historical walk-forward**, not the final 10 days. Each historical event was predicted only by a model trained on strictly-earlier events; the final 10 days are a separate untouched demonstration.

## What this is

A leakage-safe test of whether USD high-impact economic releases can be predicted **before** the release well enough to trade EUR_USD. Calendar actual/forecast/previous come from TradingView's economic-calendar API (Forex Factory's exports carry no historical `actual`); prices are OANDA **bid/ask** M1 candles, so every trade pays real spread. All features are frozen at **T−10 min** (the earliest tested entry), so no entry can see post-decision information.

## Data

- Rows (USD high-impact, actual+forecast present): **1121**
- Historical (training/walk-forward): **1109**
- Final untouched OOS (last 10 days): **12**, split at 2026-09-01
- Primary config chosen on historical WF: **entry −5m, exit SLTP 1:2**
- Confidence threshold: 0.45

## Model vs baselines (historical)

Baselines A–C are single-rule direction predictors; D is the model on the same all-tradeable universe (entry −5m, exit T30). The deployed model adds a confidence filter and the chosen primary config.

| baseline | trades | win_rate | avg_pips | expectancy_R | profit_factor |
|---|---|---|---|---|---|
| A: actual follows previous | 857 | 0.4854 | -0.699 | -0.0553 | 0.927 |
| B: forecast vs previous | 857 | 0.4481 | -2.322 | -0.2171 | 0.779 |
| C: pre-news trend only | 1010 | 0.4832 | -1.332 | -0.1124 | 0.87 |
| D: full model (no conf filter) | 388 | 0.4716 | -1.298 | -0.1141 | 0.84 |

**Beats naive baselines:** no

## Historical walk-forward (verdict basis)

| trades | win_rate | avg_pips | expectancy_R | profit_factor | total_pips |
|---|---|---|---|---|---|
| 184 | 0.3804 | -0.974 | -0.0528 | 0.852 | -179.3 |

## Final 10-day OOS demonstration

| trades | win_rate | avg_pips | expectancy_R | profit_factor | total_pips |
|---|---|---|---|---|---|
| 4 | 0.25 | -3.575 | -0.3858 | 0.464 | -14.3 |

_Recent demo only — not the basis for the verdict._

## Results by event

| event | trades | win_rate | avg_pips | expectancy_R | profit_factor |
|---|---|---|---|---|---|
| Building Permits | 3 | 0.6667 | 3.633 | 0.5633 | 1.681 |
| Business Confidence | 20 | 0.25 | -3.165 | -0.1895 | 0.581 |
| Consumer Confidence | 28 | 0.5 | -0.096 | -0.0081 | 0.982 |
| Durable Goods Orders | 19 | 0.4737 | -0.253 | -0.0439 | 0.952 |
| Existing Home Sales | 6 | 0.1667 | -7.067 | -0.6322 | 0.036 |
| GDP Growth Rate | 6 | 0.1667 | -5.0 | -0.5 | 0.4 |
| Housing Starts | 7 | 0.1429 | -6.057 | -0.5343 | 0.342 |
| Inflation Rate | 11 | 0.2727 | -1.818 | -0.1818 | 0.75 |
| Inflation Rate Mom | 5 | 0.4 | 2.0 | 0.2 | 1.333 |
| Job Offers | 16 | 0.1875 | -6.206 | -0.4699 | 0.334 |
| Non Manufacturing PMI | 5 | 0.6 | 8.2 | 0.8 | 2.783 |
| Personal Spending | 9 | 0.1111 | -8.111 | -0.6667 | 0.215 |
| Producer Price Inflation MoM | 29 | 0.5862 | 3.583 | 0.3865 | 1.727 |
| Unemployment Rate | 20 | 0.4 | 1.64 | 0.164 | 1.265 |

## Results by confidence bucket

| confidence | trades | win_rate | avg_pips | expectancy_R | profit_factor |
|---|---|---|---|---|---|
| 0.45-0.55 | 119 | 0.3866 | -0.537 | -0.0297 | 0.918 |
| 0.55-0.65 | 55 | 0.3636 | -2.047 | -0.1346 | 0.693 |
| 0.65+ | 10 | 0.4 | -0.28 | 0.1214 | 0.961 |

## Results by entry timing

| entry | trades | win_rate | avg_pips | expectancy_R | profit_factor |
|---|---|---|---|---|---|
| -10m | 184 | 0.375 | -1.195 | -0.0668 | 0.824 |
| -5m | 184 | 0.3804 | -0.974 | -0.0528 | 0.852 |
| -1m | 184 | 0.3424 | -1.629 | -0.1175 | 0.761 |

## Results by exit horizon

| exit | trades | win_rate | avg_pips | expectancy_R | profit_factor |
|---|---|---|---|---|---|
| T5 | 184 | 0.4402 | -1.507 | -0.1342 | 0.789 |
| T15 | 184 | 0.4348 | -2.984 | -0.2771 | 0.653 |
| T30 | 184 | 0.4076 | -4.239 | -0.384 | 0.572 |
| T60 | 184 | 0.4348 | -4.5 | -0.3975 | 0.591 |
| SLTP 1:1 | 184 | 0.4348 | -1.76 | -0.1414 | 0.712 |
| SLTP 1:1.5 | 184 | 0.3913 | -1.519 | -0.1105 | 0.767 |
| SLTP 1:2 | 184 | 0.3804 | -0.974 | -0.0528 | 0.852 |

## Honest caveats

- Execution is modelled on EUR_USD M1 OHLC; intrabar SL/TP assumes the stop is touched first (conservative). Real fills around a release can slip beyond M1 OHLC.
- Inflation polarity assumes a hot print is USD-bullish (hawkish channel); regime shifts can invert this.
- One simple model on ~1k rows; treat any positive result as a hypothesis, not proof.
- No live orders were placed. Research/paper only.
