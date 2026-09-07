# GBPUSD Frequency V3 — authoritative TradingView 98-trade spread replay

## Verdict: SURVIVES_COSTS

Execution classification: **STRONG**. Exact OANDA executable net expectancy for 98 matched trades is **0.1961R/trade**.

This is a frozen-cohort replay. The strategy was not scanned, optimized, or modified. The TradingView CSV is the only trade list.

## Matching

- TradingView trades: **98**
- Matched: **98**
- Unmatched: **0**

- None. All 98 TradingView trades had a complete OANDA M1 bid/ask window.

CSV composition reproduced exactly: 10:30 LONG 19, 10:30 SHORT 18, 11:00 LONG 24, 11:00 SHORT 18, 11:30 LONG 19. 11:30 SHORT remains disabled.

The CSV timezone is **America/New_York**, with DST applied. That maps 98/98 entries onto 10:30, 11:00, or 11:30 UTC. Fixed offsets fail across DST. Sample conversions (beginning, DST boundary, summer, end) are in RAW_RESULTS.json.

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 98 | 98 |
| Wins | 43 | 44 |
| Losses | 55 | 54 |
| Win rate | 43.88% | 44.90% |
| Profit factor | 1.514 | 1.332 |
| Total R | 27.0182R | 19.2142R |
| Expectancy R/trade | 0.2757R | 0.1961R |
| Average winner R | 1.8497R | 1.7506R |
| Average loser R | -0.9549R | -1.0706R |
| Max drawdown R | 9.6984R | 11.2125R |

MID uses all 98 TradingView trades and the frozen TV/ATR geometry. EXEC uses only matched OANDA M1 bid/ask replays.

## Legs

| Leg | Trades | EXEC WR | EXEC PF | EXEC Exp R |
|---|---:|---:|---:|---:|
| 10:30 LONG | 19 | 47.37% | 1.470 | 0.2692R |
| 10:30 SHORT | 18 | 38.89% | 1.123 | 0.0811R |
| 11:00 LONG | 24 | 45.83% | 1.388 | 0.2171R |
| 11:00 SHORT | 18 | 44.44% | 1.297 | 0.1789R |
| 11:30 LONG | 19 | 47.37% | 1.390 | 0.2215R |

10:30 SHORT was not removed. It is reported as measured.

## Data notes

Trade 33 (10:30 LONG, 2025-08-06) is the only geometry fallback. TradingView recorded a 0.5-pip `TP_OR_SL` exit against OANDA ATR14 of 10.4 pips and a 10-pip MAE. Frozen 1R uses that ATR, not the CSV fill. No other trade needed this rule.

10:30 SHORT is the weakest executable leg at **+0.081R/trade** (WEAK). It is still positive and stays in the frozen book.

## Spread

- Average / median / maximum entry spread: 1.888 / 1.900 / 3.400 pips
- Average / median / maximum exit spread: 1.898 / 1.900 / 2.800 pips
- Average / median / maximum spread drag: 0.0796 / 0.0884 / 3.0625 R/trade
- Total spread drag R: 7.8040R
- MID expectancy: 0.2757R
- EXEC expectancy: 0.1961R
- Difference: 0.0796R/trade

## Outcome changes

- WIN -> LOSS: 2
- WIN -> smaller WIN: 41
- WIN -> TIME EXIT: 5
- LOSS -> larger LOSS: 52
- TP -> no TP because executable side did not reach target: 2
- SL hit earlier because of executable spread: 8
- LOSS -> WIN: 3
- Exit reason changed: 7

## Method

- Authoritative cohort: TradingView export of GBPUSD Frequency V3, 98 completed trades from 2025-01-06 through 2026-08-14.
- Geometry: 1R is the original ATR-based stop distance. TP/SL fills reconstruct that distance from the TradingView prices. TIME_EXIT uses OANDA M30 ATR14 at the signal bar. If a TP/SL fill is smaller than 0.25x OANDA ATR14 (CSV artifact), 1R falls back to that ATR; this applied only to trade 33. R is not redefined after spread.
- Entry: LONG ASK, SHORT BID at the signal-bar close.
- Intrabar path: completed OANDA Practice M1 bid/ask from the first minute after that close through the 3-hour / 6-bar horizon.
- LONG stop/TP/time-exit: BID. SHORT stop/TP/time-exit: ASK.
- Same-minute TP and SL: stop first. Gaps fill at the executable open. No second spread subtraction. No trailing stop, profit lock, or threshold change.

## Decision table

| Book | Trades | EXEC expectancy |
|---|---:|---:|
| Original GBPUSD Dual-Origin V2 | 79 | +0.136R/trade |
| GBPUSD Frequency V3 | 98 | 0.1961R/trade |

V3 increases frequency AND preserves/improves the edge.

No deployment. No broker orders. No strategy modification.
