# NZDJPY 23UTC Bull Break V1 — OANDA executable validation

> RESEARCH_ONLY / PAPER_ONLY. No deployment, activation, broker orders, or rule modifications.

## Cohort matching

- TradingView entries: 45
- OANDA matched: 45
- Unmatched: 0
- No trade silently removed.

## Verdict: SURVIVES_COSTS

Classification: **STRONG**. EXEC expectancy **0.1767R/trade**, PF **1.389**, WR **48.89%**, total **7.9527R**.

## Parity

- All 45 entries resolve to 23:00 UTC: 45/45. 18:00 NY EST and 19:00 NY EDT samples are retained in RAW_RESULTS.json.
- OANDA-mid indicator reconstruction: EMA20/EMA50/EMA20[3]/close[3] available 45/45; vote components 45/45/45/45/45; consensus >=3 45/45; bullish 45/45; body >=0.50R 44/45; upper 25% 44/45; previous-high break >=0.10R 44/45.
- Max midpoint entry-close difference against TradingView: 0.550 pips. Any genuine OANDA/TV boundary discrepancy is retained rather than tuned away.

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 45 | 45 |
| Wins | 26 | 22 |
| Losses | 19 | 23 |
| Win rate | 57.78% | 48.89% |
| Profit factor | 1.912 | 1.389 |
| Total R | 15.3796R | 7.9527R |
| Expectancy R/trade | 0.3418R | 0.1767R |
| Average winner R | 1.2402R | 1.2910R |
| Average loser R | -0.8876R | -0.8891R |
| Max drawdown R | 3.8343R | 6.1040R |

## Year stability — EXEC

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 16 | 7 | 9 | 43.75% | 1.097 | 0.6525R | 0.0408R | 3.5003R |
| 2024 | 13 | 4 | 9 | 30.77% | 0.721 | -2.5610R | -0.1970R | 4.3430R |
| 2025 | 9 | 7 | 2 | 77.78% | 4.597 | 8.0016R | 0.8891R | 2.2247R |
| 2026 | 7 | 4 | 3 | 57.14% | 1.805 | 1.8595R | 0.2656R | 1.8949R |

## Spread and exit analysis

- Entry spread pips (avg/median/max): 2.693 / 2.700 / 4.000.
- Exit spread pips (avg/median/max): 2.633 / 2.600 / 4.000.
- Execution drag R (avg/median/max/total): 0.1650 / 0.1344 / 1.2012 / 7.4269.
- EXEC exits: TP 11, SL 18, TIME 16. Same-minute ambiguity: 0; primary result is conservative stop-first.

## Decision

1. Does V1 survive executable costs? **SURVIVES_COSTS**.
2. Exact EXEC expectancy / PF / WR / total R: **0.1767R / 1.389 / 48.89% / 7.9527R**.
3. Matched / unmatched: **45 / 0**.
4. Average execution drag: **0.1650R/trade**.
5. Year stability: 3/4 positive buckets; do not create a year filter.
6. The +0.349R pre-cost claim is still meaningful by the specified bar.
7. Frozen research/paper candidate: **YES, subject to the small sample caveat.**.

Method: exact supplied cohort only; OANDA Practice completed M1/H1 MBA. Original midpoint ATR14/stop/target remain frozen. Long entry is ASK at the 23:00 close; TP, SL, and time exit are BID. No second spread charge.