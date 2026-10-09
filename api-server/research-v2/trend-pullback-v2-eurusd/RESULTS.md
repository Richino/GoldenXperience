# TrendPullback V2 — EUR/USD research results

Verdict: **FAILED TO GENERALIZE.** The frozen strategy lost on 2024–2026 unseen data (−0.053R/trade, PF 0.92, 50 trades) and its direction signal disappeared (the mirror trade did slightly better).

## Phase 1 — TREND_PULLBACK_BASELINE (V1 unchanged, normal mode, 2008–2023)
6,995 trades · 2,487 W / 4,508 L · 35.6% win · avg win +1.61R · avg loss −1.01R · expectancy −0.079R · PF 0.88 · −550.2R · max DD 596R · longest losing streak 18 · 437 trades/yr · 14/16 years negative (only 2008 +0.07R and 2020 +0.06R positive). Adding the V1 news hold (2013+) changed nothing (−0.080R).

## Phases 2–7 — search (3,854+ configs, all net of bid/ask + 0.2 pip slippage)
- Trend: all 132 trend setups negative with default executions. Higher TF loses less (M15 −0.15..−0.27R, H1 −0.06..−0.26R, H4 −0.01..−0.30R): cost/risk falls. The daily-chart trend for H4 entries was best.
- Pullback: jagged response by depth (20% and 66% better, 40% and 75% worse).
- Entry: a limit at the pullback level beat confirmation entries (candle close, break, structure break, EMA reclaim).
- Stop: wider is better on average (ATR 3 best mean); stops behind the pullback low were worst (too tight for the spread).
- Target: R-multiple/structural beat fixed pips; 1.5R–4R all similar.
- Filters: only "no order with high-impact EUR/USD news in the next 4h" passed the pre-set rule (better in both halves, ≥60% of trades kept, higher t).

## Phase 10 — plateau
Broad positive regions for regression length (75–150), R² (0.1–0.5), zz (1.5–3), min impulse (1–3), stop (25–60 pips), target (1.5–4R). Depth is a spike: 0.66 → +0.15R, neighbours 0.45–0.75 ≈ +0.02..+0.07R. A Daily trend is required (H4-only trend ≈ 0).

## Phase 11 — frozen config by year (2008–2023)
| Year | n | Win% | Exp R | Total R | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| 2008 | 27 | 37.0 | −0.077 | −2.1 | 0.88 | 9.6 |
| 2009 | 23 | 43.5 | +0.084 | +1.9 | 1.15 | 4.0 |
| 2010 | 50 | 42.0 | +0.047 | +2.3 | 1.08 | 8.6 |
| 2011 | 46 | 43.5 | +0.084 | +3.9 | 1.15 | 5.5 |
| 2012 | 43 | 48.8 | +0.218 | +9.4 | 1.42 | 6.0 |
| 2013 | 27 | 51.9 | +0.301 | +8.1 | 1.62 | 4.0 |
| 2014 | 30 | 56.7 | +0.415 | +12.4 | 1.95 | 6.0 |
| 2015 | 15 | 53.3 | +0.331 | +5.0 | 1.71 | 4.0 |
| 2016 | 22 | 36.4 | −0.094 | −2.1 | 0.85 | 5.0 |
| 2017 | 30 | 60.0 | +0.498 | +14.9 | 2.24 | 4.0 |
| 2018 | 36 | 38.9 | −0.031 | −1.1 | 0.95 | 4.6 |
| 2019 | 19 | 42.1 | +0.050 | +0.9 | 1.09 | 7.0 |
| 2020 | 21 | 42.9 | +0.069 | +1.4 | 1.12 | 4.5 |
| 2021 | 32 | 40.6 | +0.013 | +0.4 | 1.02 | 9.1 |
| 2022 | 32 | 50.0 | +0.248 | +7.9 | 1.49 | 6.0 |
| 2023 | 20 | 55.0 | +0.373 | +7.5 | 1.83 | 2.0 |

## Phase 12 — walk-forward (whole procedure re-run per fold, train 2008..Y−1, test Y, 2012–2023)
229 trades · 44.1% win · +0.097R · PF 1.17 · +22.1R · max DD 13.7R · t 1.06 (not significant). Training expectancy ≈ +0.3R → test +0.1R.

## Phase 15 — unseen 2024-01-01 → 2026-10-02 (frozen, unchanged)
50 trades · 19 W / 31 L · 38.0% win · avg win +1.50R · avg loss −1.01R · expectancy −0.053R · PF 0.92 · −2.7R · max DD 9.1R · longest losing streak 6.
- 2024: 15 trades, 33.3%, −0.170R, −2.5R, PF 0.75
- 2025: 28 trades, 46.4%, +0.158R, +4.4R, PF 1.29
- 2026: 7 trades, 14.3%, −0.647R, −4.5R, PF 0.25
- Gross (mid) +0.038R; mirror (opposite direction) +0.039R → no direction information out of sample.

## Comparison
| Metric | 2008–2023 Development | Walk-Forward | 2024–2026 Unseen |
|---|---:|---:|---:|
| Trades | 473 | 229 | 50 |
| Win Rate | 46.1% | 44.1% | 38.0% |
| Expectancy | +0.150R | +0.097R | −0.053R |
| Profit Factor | 1.28 | 1.17 | 0.92 |
| Total R | +70.9R | +22.1R | −2.7R |
| Max Drawdown | 12.1R | 13.7R | 9.1R |

Scripts: `frontend/scripts/tp-v2/` (baseline, engine, lib, runner, research, wf, verify, oos).
