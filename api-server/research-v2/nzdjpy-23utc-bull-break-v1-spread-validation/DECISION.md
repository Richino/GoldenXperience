# NZDJPY 23UTC Bull Break V1 — frozen research decision

**Status:** `FROZEN_PAPER_RESEARCH_CANDIDATE` · `STRONG` · `SURVIVES_COSTS` · `UNSTABLE_BY_YEAR` · `NOT_LIVE_READY`

## Decision

Freeze **GX NZDJPY 23UTC Bull Break V1 - 1 to 2 RR** as a research/paper candidate. The rules and the authoritative 45-trade TradingView cohort are immutable for this V1. No runtime strategy, migration, execution setting, deployment, or broker order was added.

## Frozen contract

- H1, LONG only, completed 23:00 UTC origin candle.
- Four-vote consensus >= +3: EMA20/EMA50 trend, close/EMA20 price, EMA20 versus EMA20[3] slope, and close versus close[3] momentum.
- close > open; body >= 0.50 ATR14; close in the upper 25% of its candle; close - high[1] >= 0.10 ATR14.
- ATR14 freezes at the signal close; stop -1R; target +2R; maximum hold three future H1 candles.
- No trailing stop, break-even, runner, profit lock, partial exit, or additional filter.

## Authoritative executable result

| Metric | Result |
|---|---:|
| TradingView / EXEC matched / unmatched | 45 / 45 / 0 |
| EXEC win rate | 48.89% |
| EXEC PF | 1.389 |
| EXEC expectancy | +0.1767R/trade |
| EXEC total | +7.9527R |
| Average / total execution drag | 0.1650R / 7.4269R |
| Same-minute TP/SL ambiguities | 0 |

The numerical classification is **STRONG** and the cost verdict is **SURVIVES_COSTS**. These are not live-readiness conclusions.

## Stability warning — preserve unchanged

This is **UNSTABLE_BY_YEAR**: 2024 is negative at approximately -0.1970R/trade, while 2025 contributes essentially all positive net result. Do not call it a stable multi-year edge. Do not remove 2024, add a year filter, or tune any threshold based on this decomposition.

Time exits contributed 3.7545R of total execution drag and are more cost-sensitive. That is diagnostic metadata only: the three-H1 maximum hold remains frozen.

The three OANDA-midpoint boundary discrepancies (body, upper-25% close, and 0.10R breakout) are feed-boundary findings. The TradingView cohort remains authoritative; no trade is removed and no signal cohort is regenerated.

## Forward validation requirement

Evaluate only the exact frozen V1 on future untouched data. The question is whether it sustains positive executable expectancy outside this discovery sample. Do not optimize, create a V2 from this sample, or promote to live based on these 45 trades.

## Runtime audit

NZDJPY is absent from the runtime pair-strategy registry and its enabled strategy IDs. That remains intentional: this record is research/paper metadata only.

## Confirmations

- `NZDJPY_V1_FROZEN`
- `STRONG_NUMERIC_EDGE`
- `SURVIVES_COSTS`
- `45_OF_45_MATCHED`
- `UNSTABLE_BY_YEAR`
- `2024_NEGATIVE`
- `2025_CONCENTRATED_EDGE`
- `FORWARD_VALIDATION_REQUIRED`
- `NO_RULE_CHANGE`
- `NO_YEAR_FILTER`
- `NO_EXIT_CHANGE`
- `NO_DEPLOYMENT`
- `NO_BROKER_ORDERS`
