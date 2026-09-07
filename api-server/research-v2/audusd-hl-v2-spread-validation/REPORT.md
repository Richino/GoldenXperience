# AUDUSD V2 HL-only — authoritative TradingView spread validation

## Final production decision

- Lifecycle: **RESEARCH_ONLY**
- Cost classification: **MARGINAL_AFTER_COSTS**
- Replacement decision: **REJECTED_REPLACEMENT**
- Production strategy retained: **GX AUDUSD Strong Consensus Structure V1**

V2 HL-only must not be deployed or promoted. Its source cohort, trade-level replay, raw results, and gap audit remain preserved in this directory for historical reference.

## Verdict: MARGINAL_AFTER_COSTS

Classification: **WEAK**. Executable expectancy is **0.0547R/trade** on 219 exact OANDA replays.

## Matching

- TradingView trades: **219**
- Matched: **219**
- Unmatched: **0**

- None. All 219 trades matched OANDA entry bars and resolvable execution windows. Ten isolated replay minutes had no OANDA M1 candle; targeted M1 and S5 rechecks also returned no price candle, so there is no broker tick path to invent. Details are in GAP_AUDIT.json.

The CSV timezone is **America/New_York**, DST-aware: 219/219 entries resolve to the 11:00 UTC signal candle. Beginning, middle, and end samples are retained in RAW_RESULTS.json.

## Comparison

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 219 | 219 |
| Wins | 106 | 97 |
| Losses | 113 | 122 |
| Win rate | 48.40% | 44.29% |
| Profit factor (R-normalized) | 1.407 | 1.100 |
| Total R | 42.7774R | 11.9827R |
| Expectancy R/trade | 0.1953R | 0.0547R |
| Average winner R | 1.3954R | 1.3633R |
| Average loser R | -0.9304R | -0.9857R |
| Max drawdown R | 8.4058R | 14.1003R |

TradingView fixed-quantity PF from the CSV's displayed net-PnL values is **1.462**, reproducing the supplied approximately 1.462 headline. The table uses ATR-normalized R for an apples-to-apples comparison. MID includes the authoritative cohort; EXEC includes exact matched windows only.

## Spread

- Entry spread average / median / maximum: 1.274 / 1.300 / 1.500 pips
- Exit spread average / median / maximum: 1.342 / 1.300 / 2.800 pips
- Spread drag average / median / maximum: 0.1406 / 0.0726 / 3.0882 R/trade
- Total spread drag: 30.7947R
- Matched MID expectancy: 0.1953R
- EXEC expectancy: 0.0547R

## Outcome changes

- WIN -> LOSS: 9
- WIN -> smaller WIN: 97
- WIN -> TIME EXIT: 4
- LOSS -> larger LOSS: 113
- LOSS -> WIN: 0
- TP missed due to BID: 5
- SL hit earlier due to spread: 47
- Exit reason changed: 13

## V1 benchmark

| Strategy | Trades | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| AUDUSD V1 | 195 | 45.64% | 1.232 | +0.118R |
| AUDUSD V2 HL-only, original TV barriers | 219 | 44.29% | 1.100 | 0.0547R |
| AUDUSD V2 HL-only, V1-comparable executable-centered barriers | 219 | 44.29% | 1.169 | 0.0889R |

**V2 increases frequency but weakens executable edge.**

The first V2 row is the literal primary result requested here: original TradingView stop/target prices stay fixed. The second is a diagnostic needed for a fair V1 comparison because the old V1 validation used executable-entry ATR geometry, with 1R/2R barriers centered on ASK. It does not replace the primary result or alter a strategy.

## Executable stability by year

| Year | N | PF | Expectancy |
|---|---:|---:|---:|
| 2023 | 63 | 0.983 | -0.0106R |
| 2024 | 62 | 1.129 | 0.0716R |
| 2025 | 48 | 0.963 | -0.0197R |
| 2026 | 46 | 1.432 | 0.1990R |

The pooled result is not stable across years: 2023 and 2025 are negative, while 2026 supplies most of the positive edge. This reinforces the marginal verdict.

## Method and limitation

The 219-entry TradingView CSV is the only cohort; no full-history signal scan or parameter search was run. CSV timestamps are resolved through America/New_York DST rules. OANDA H1 midpoint reconstructs ATR14 and verifies the signal-close price. Original midpoint barriers are TV entry minus 1 ATR and plus 2 ATR. Long entry uses the final M1 ASK of the completed signal candle; future M1 BID triggers stop/target and supplies the time exit after three future H1 bars. Stop wins same-minute ambiguity; adverse stop gaps fill at BID open. Spread is not subtracted twice. Entry spread is the exact final signal-minute close; for intraminute TP/SL fills, reported exit spread and mid/bid/ask snapshot columns use that M1 candle's close because synchronized tick quotes are unavailable. The separate exec_exit_price column records the barrier or adverse BID-open fill used for P&L.

The CSV omits its internal ATR/stop/target values, so ATR14 is reconstructed from completed historical OANDA H1 midpoint candles. Any signal-close mismatch over 1.5 pips or incomplete M1 boundary makes the trade unmatched; no quote is fabricated. This primary replay keeps TradingView's original midpoint stop/target fixed, as requested, rather than moving them around the executable ASK.

No strategy, production setting, broker order, or deployment was changed.
