# EUR/USD trade replay — October 12, 2026

Valued at 2026-10-12T20:17:27.914816811Z. Rolling 14-day window starts 2026-09-28T20:17:27.914Z. 22 broker-verified trades; 17 have a complete 48-hour observation period.

## Completed observations

| Rule | Trades | Price P/L after spread | Financing (actual or estimated) | Combined |
|---|---:|---:|---:|---:|
| originalDirectionWiderStructuralStop | 17 | $114 | $-53 | $61 |
| trendDirectionWiderStructuralStop | 15 | $-510 | $12 | $-498 |
| originalDirectionOriginalStop | 17 | $-813 | $-46 | $-859 |
| originalDirectionStructuralStop | 17 | $737 | $-52 | $685 |
| actual | 17 | $-887 | $-11 | $-899 |
| trendFilterActual | 9 | $-1,083 | $4 | $-1,079 |
| allShortSameExit | 17 | $-1,223 | $6 | $-1,216 |
| allShortHoldToday | 17 | $25,456 | $209 | $25,665 |
| originalDirectionHold48h | 17 | $-1,399 | $-250 | $-1,649 |
| allShortHold48h | 17 | $4,217 | $87 | $4,304 |
| trendDirectionOriginalStop | 15 | $-881 | $23 | $-858 |
| trendDirectionStructuralStop | 14 | $-406 | $12 | $-394 |

## Method

- **trend:** Completed H4 close below EMA20 below EMA50, EMA20 falling versus 3 bars ago = short; inverse = long; otherwise neutral. Warmup from Aug 1.
- **entry:** Counterfactual at first full M1 bid/ask open following actual fill; no invented spread.
- **stops:** Original stored stop distance or preceding 6 completed H4 bid lows/ask highs plus 1 pip buffer. Structural units resized to same stored dollar risk.
- **exit:** 2R target or 48 wall-clock hours; stop-first if both touched within M1; gaps filled at worse opening price.
- **costs:** Historical bid/ask included. Actual financing verified from broker. Hypothetical financing estimated from observed same-date rates where available, otherwise current instrument rates, with rollover weekday schedule and 1% conversion adjustment. Historical daily rates incomplete. Commission metadata absent; no additional execution slippage modeled.
- **limits:** Stored stops may have been edited; same-exit candles approximate exit by completed M1 close. Overlapping trade opportunities assumed retained; not independent observations.

## Holding everything short until valuation

Price P/L: $27,516. Estimated financing: $209. Worst combined M1-close P/L below starting equity: $-1,374. Peak-to-trough M1-close equity drawdown: $14,609. Exposure: 4274613 EUR. Peak estimated margin: $95,416.

EUR-only replay appears supportable at 2% margin. Actual other-pair exposure and intraminute equity remain unmodeled; this is not proof for the whole account.

## Interpretation

Holding original directions without stops for 48 hours loses; shorting all for 48 hours wins in this sample. Trend-aligned stopped arms lose on completed observations. Keeping original directions but replacing stored stops with the prior 24-hour structural boundary and fixed 2R/48h exits produces a positive exploratory result. This does not isolate stop width from exit changes, and is not out-of-sample evidence. All short entries share the same market move and may overlap. Retaining historical opportunities after altering prior trade outcomes is a conditional replay, not a complete strategy backtest.

No trade, database, settings, or deployment changes were made.

## Wider-stop control and decision

A further control never narrows the stored stop or increases its position size: use the larger of the stored stop distance and the structural distance. On 17 completed observations it earns approximately $61 including estimated financing, versus approximately -$499 across 15 eligible trend-direction observations. This weakens the wider-stop thesis substantially: the earlier positive structural result partly depended on narrower stops and increased position sizes. Neither is a validated strategy. Recommendation: preserve stops and existing execution settings; investigate entry and exit timing with predeclared rules across different market regimes before changing the trading approach.
