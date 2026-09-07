# USDJPY Body Extreme V6 — authoritative TradingView 272-trade spread replay

## Verdict: MARGINAL_AFTER_COSTS

Execution classification: **WEAK**. Exact OANDA executable net expectancy for 271 resolved trades is **0.0802R/trade**. The one missing OANDA window gives a conservative stop-to-target full-272 sensitivity of **0.0761R to 0.0871R/trade**; both endpoints remain WEAK.

## Matching

- TradingView trades: **272**
- Matched to OANDA entry timestamp and price: **272**
- Exact completed M1 execution windows: **271**
- Unresolved execution windows: **1**
- Exact implemented OANDA V6 trace signals at resolved timestamps: **268/272**

The CSV timezone is **America/New_York**, with DST applied. This maps 272/272 entries into 11:00-14:00 UTC, matches all 272 entry prices within one pip, and matches 268 implemented signals. Fixed offsets fail across DST. Beginning/middle/end evidence is in RAW_RESULTS.json.

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 272 | 271 |
| Wins | 139 | 131 |
| Losses | 133 | 140 |
| Win rate | 51.10% | 48.34% |
| Profit factor (R-normalized) | 1.391 | 1.179 |
| Total R | 43.617R | 21.741R |
| Expectancy R/trade | 0.1604R | 0.0802R |
| Average winner R | 1.1153R | 1.0910R |
| Average loser R | -0.8377R | -0.8655R |
| Max drawdown | 8.079R | 10.243R |

TradingView's position-size-weighted JPY profit factor is **1.431**, reproducing the 1.43 headline. The table uses R-normalized PF so MID and EXEC are comparable. The MID column contains all 272 trades; EXEC contains 271 exact replays because trade 117 has no OANDA quotes after 14:22 UTC through its 16:00 UTC exit horizon.

## Spread and drag — 271 exact pairs

- Average / median / maximum entry spread: 1.637 / 1.600 / 3.200 pips
- Average / median / maximum exit spread: 1.701 / 1.600 / 10.000 pips
- Average / median / maximum spread cost: 0.0820 / 0.0571 / 1.5282 R/trade
- Total spread drag on matched pairs: 22.212R
- Matched MID expectancy: 0.1622R
- Matched EXEC expectancy: 0.0802R
- Difference: 0.0820R/trade

## Outcome changes — 271 exact pairs

- WIN -> LOSS: 8
- WIN -> smaller WIN: 131
- WIN -> TIME EXIT: 2
- LOSS -> larger LOSS: 132
- TP -> no TP because bid did not reach target: 2

## Method and limitations

The 272 exported trades are frozen; no strategy scan selected or discarded trades. Entries use historical OANDA ask and exits use M1 bid, with no second spread subtraction. The export omits ATR, stop, and target columns. TP/SL touched levels reconstruct their geometry; TIME_EXIT ATR14 comes from the matched OANDA H1 trace and is tagged per row. M1 gaps are not fabricated or forward-filled. The final verdict is robust across the unresolved trade's fixed-stop/fixed-target sensitivity, but an exact 272-trade execution expectancy is not supported by the available broker record.
