# USDCAD Structure EMA Reclaim V2 Selected Origins — authoritative TradingView 181-trade spread replay

> **Decision status: `RESEARCH_ONLY` · `NO_EDGE_AFTER_COSTS` · `REJECTED` · `USDCAD_V2_REJECTED`.**
> See `DECISION.md`. Do not restore 09:00 LONG, 10:00 SHORT, or 11:00 SHORT. The frozen USDCAD candidate is V3 11:00 LONG-only.

## Verdict: MARGINAL_AFTER_COSTS

Execution classification: **NO EDGE**. Exact OANDA executable net expectancy for 181 matched trades is **0.0096R/trade**.

This is a frozen-cohort replay. The strategy was not scanned, optimized, or modified. PEN + EXTREME was not used as a filter. The TradingView CSV is the only trade list.

## Matching

- TradingView trades: **181**
- Matched: **181**
- Unmatched: **0**

- None. All 181 TradingView trades had a complete OANDA M1 bid/ask window.

CSV composition reproduced exactly: 09:00 LONG 55, 10:00 SHORT 26, 11:00 LONG 49, 11:00 SHORT 51. TradingView money result is 85 wins / 96 losses (46.96% WR). Export CAD profit factor is 1.476; the 1.39 headline is the TradingView UI figure. The table below is R-normalized so MID and EXEC are comparable.

The CSV timezone is **America/New_York**, with DST applied. That maps 181/181 entries onto 09:00, 10:00, or 11:00 UTC. Fixed offsets fail across DST. Sample conversions are in RAW_RESULTS.json.

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 181 | 181 |
| Wins | 85 | 76 |
| Losses | 96 | 105 |
| Win rate | 46.96% | 41.99% |
| Profit factor | 1.386 | 1.016 |
| Total R | 35.0119R | 1.7309R |
| Expectancy R/trade | 0.1934R | 0.0096R |
| Average winner R | 1.4786R | 1.4131R |
| Average loser R | -0.9445R | -1.0064R |
| Max drawdown R | 10.6634R | 17.5673R |

## Legs

| Leg | Trades | EXEC WR | EXEC PF | EXEC Exp R |
|---|---:|---:|---:|---:|
| 09:00 LONG | 55 | 41.82% | 0.953 | -0.0243R |
| 10:00 SHORT | 26 | 34.62% | 0.689 | -0.2194R |
| 11:00 LONG | 49 | 48.98% | 1.397 | 0.2137R |
| 11:00 SHORT | 51 | 39.22% | 0.948 | -0.0334R |

10:00 SHORT was not removed. It is reported as measured.

## Spread

- Average / median / maximum entry spread: 1.816 / 1.800 / 2.100 pips
- Average / median / maximum exit spread: 1.839 / 1.800 / 2.800 pips
- Average / median / maximum execution drag: 0.1839 / 0.0920 / 3.1326 R/trade
- Total execution drag R: 33.2810R
- MID expectancy: 0.1934R
- EXEC expectancy: 0.0096R
- Difference: 0.1839R/trade

## Outcome changes

- WIN -> LOSS: 10
- WIN -> smaller WIN: 75
- WIN -> TIME EXIT: 36
- LOSS -> larger LOSS: 95
- LOSS -> WIN: 1
- TP missed because executable side did not reach target: 6
- SL hit earlier because of spread: 12
- Exit reason changed: 13

## Year stability

| Year | Trades | WR | PF | Total R | Expectancy R/trade |
|---|---:|---:|---:|---:|---:|
| 2023 | 45 | 40.00% | 0.900 | -2.7888R | -0.0620R |
| 2024 | 44 | 54.55% | 1.906 | 18.0897R | 0.4111R |
| 2025 | 41 | 34.15% | 0.593 | -10.8712R | -0.2652R |
| 2026 | 51 | 39.22% | 0.913 | -2.6989R | -0.0529R |

## Method

- Authoritative cohort: TradingView export of USDCAD Structure EMA Reclaim V2 Selected Origins, 181 completed trades from 2023-01-10 through 2026-08-28.
- Geometry: 1R is OANDA H1 ATR14 frozen at the signal bar. Stop = TV/MID entry ± 1 ATR. Target = TV/MID entry ± 2 ATR. R is not redefined after spread.
- Entry: LONG ASK, SHORT BID at the signal-bar close.
- Intrabar path: completed OANDA Practice M1 bid/ask from the first minute after that close through three future H1 bars.
- LONG stop/TP/time-exit: BID. SHORT stop/TP/time-exit: ASK.
- Same-minute TP and SL: stop first. Gaps fill at the executable open. No second spread subtraction. No trailing stop, profit lock, or threshold change.
- Blocked diagnostic opportunities were not reconstructed.

## Post-validation decision

1. Full four-leg V2 after costs: **MARGINAL_AFTER_COSTS** (NO EDGE, +0.0096R /trade). **REJECTED.**
2. Strongest EXEC leg: **11:00 LONG** at +0.2137R /trade (STRONG). Superseded by V3 (53 trades, EXEC +0.228R).
3. Weakest EXEC leg: **10:00 SHORT** at -0.2194R /trade (LOSING). Do not restore.
4. 09:00 LONG, 10:00 SHORT, and 11:00 SHORT remain **rejected**. Do not restore them.

Lifecycle: **RESEARCH_ONLY**. Cost classification: **NO_EDGE_AFTER_COSTS**. Replacement decision: **REJECTED**. Final status: **USDCAD_V2_REJECTED**.

No deployment. No broker orders. No strategy modification. Artifacts in this directory are preserved.
