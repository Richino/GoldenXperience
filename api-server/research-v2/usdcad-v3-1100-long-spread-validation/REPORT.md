# USDCAD Structure EMA Reclaim V3 11:00 LONG-only — authoritative TradingView 53-trade spread replay

> **Decision status: `USDCAD_V3_FROZEN` · `FROZEN_RESEARCH_CANDIDATE` · `SURVIVES_COSTS` · `STRONG`.**
> See `DECISION.md`. Entry rules are frozen. No deployment. No broker orders.

## Verdict: SURVIVES_COSTS

Execution classification: **STRONG**. Exact OANDA executable net expectancy for 53 matched trades is **0.2283R/trade**. EXEC profit factor is **1.424**.

This is a frozen-cohort replay. The strategy was not scanned, optimized, or modified. PEN + EXTREME was not used as a filter.

## Matching

- TradingView trades: **53**
- Matched: **53**
- Unmatched: **0**

- None. All 53 TradingView trades had a complete OANDA M1 bid/ask window.

CSV composition reproduced exactly: BASE 32, PEN_EXTREME 21. TradingView money result is 28 wins / 25 losses (52.83% WR). Export CAD profit factor is 2.547; the 2.417 headline is the TradingView UI figure. The table below is R-normalized.

The CSV timezone is **America/New_York**, with DST applied. That maps 53/53 entries onto 11:00 UTC (06:00 NY in EST, 07:00 NY in EDT). Fixed offsets fail across DST.

OANDA H1 structure+EMA20 reclaim parity: **53/53**. Parity mismatches were still replayed; they were not dropped.

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 53 | 53 |
| Wins | 28 | 26 |
| Losses | 25 | 27 |
| Win rate | 52.83% | 49.06% |
| Profit factor | 1.989 | 1.424 |
| Total R | 23.3671R | 12.1025R |
| Expectancy R/trade | 0.4409R | 0.2283R |
| Average winner R | 1.6784R | 1.5645R |
| Average loser R | -0.9452R | -1.0584R |
| Max drawdown R | 5.4750R | 6.7083R |

## Comparison to prior USDCAD V2

| Book | Trades | EXEC WR | EXEC PF | EXEC Exp R |
|---|---:|---:|---:|---:|
| V2 four-leg overall | 181 | n/a | 1.016 | +0.010R |
| V2 11:00 LONG subset | 49 | 48.98% | 1.397 | +0.214R |
| V3 overlap with that subset | 49 | 48.98% | 1.397 | +0.2137R |
| V3 restored four | 4 | 50.00% | 1.742 | +0.4074R |
| V3 full 11:00 LONG | 53 | 49.06% | 1.424 | +0.2283R |

## Four restored trades

These 11:00 LONG signals were blocked in V2 by an earlier 09:00/10:00 position and execute in V3:

| V3 trade | NY entry | UTC | Tag | TV R | EXEC R | EXEC reason |
|---|---|---|---|---:|---:|---|
| 34 | 2025-09-18 07:00 | 2025-09-18T11:00:00.000Z | BASE | 2.0041 | 1.9252 | TAKE_PROFIT |
| 38 | 2025-12-18 06:00 | 2025-12-18T11:00:00.000Z | BASE | -1.0025 | -1.1025 | STOP_LOSS |
| 39 | 2026-01-06 06:00 | 2026-01-06T11:00:00.000Z | BASE | -1.0007 | -1.0927 | STOP_LOSS |
| 51 | 2026-07-24 07:00 | 2026-07-24T11:00:00.000Z | PEN_EXTREME | 2.0059 | 1.8997 | TAKE_PROFIT |

Combined restored EXEC expectancy: +0.4074R on 4 trades, total 1.6297R. Versus the overlapping 49, the four improve V3's average.

## Year stability

| Year | Trades | Wins | WR | PF | Total R | Expectancy R/trade |
|---|---:|---:|---:|---:|---:|---:|
| 2023 | 13 | 8 | 61.54% | 2.174 | 6.2648R | 0.4819R |
| 2024 | 12 | 6 | 50.00% | 1.721 | 4.7857R | 0.3988R |
| 2025 | 13 | 6 | 46.15% | 1.107 | 0.8195R | 0.0630R |
| 2026 | 15 | 6 | 40.00% | 1.026 | 0.2325R | 0.0155R |

## Metadata subgroup

Measurement only. PEN_EXTREME was not turned into a filter.

| Tag | Trades | WR | PF | Expectancy R/trade |
|---|---:|---:|---:|---:|
| BASE | 32 | 50.00% | 1.468 | 0.2550R |
| PEN_EXTREME | 21 | 47.62% | 1.353 | 0.1877R |

## Spread

- Average / median / maximum entry spread: 1.825 / 1.800 / 2.100 pips
- Average / median / maximum exit spread: 1.868 / 1.800 / 2.800 pips
- Average / median / maximum execution drag: 0.2125 / 0.0901 / 3.1326 R/trade
- Total execution drag R: 11.2646R

## Outcome changes

- WIN -> LOSS: 3
- WIN -> smaller WIN: 25
- WIN -> TIME EXIT: 7
- LOSS -> larger LOSS: 24
- LOSS -> WIN: 1
- TP missed from executable BID: 3
- SL reached earlier due spread: 4
- Exit reason changed: 6

## Method

- Authoritative cohort: TradingView export of USDCAD V3 11:00 LONG only, 53 completed trades from 2023-01-10 through 2026-08-13.
- Geometry: 1R is OANDA H1 ATR14 frozen at the 11:00 signal bar. Stop = TV close − 1 ATR. Target = TV close + 2 ATR.
- Entry: ASK at the signal-bar close. Exits: BID for TP, SL, and the close of future H1 #3.
- Same-minute TP and SL: stop first. No second spread subtraction.

## Decision

1. V3 11:00 LONG-only after costs: **SURVIVES_COSTS**.
2. Exact EXEC expectancy: **+0.2283R /trade**.
3. Exact EXEC PF: **1.424**.
4. Four restored trades: **improve** V3 versus the overlapping 49 (+0.4074R vs +0.2137R).
5. V3 vs prior four-leg V2 (+0.010R): **stronger**.
6. Frozen USDCAD research candidate: **YES — V3 11:00 LONG-only is the frozen USDCAD candidate (`USDCAD_V3_FROZEN`)**.

Year-stability warning (does not invalidate V3; do not optimize on this sample): 2023 +0.482R, 2024 +0.399R, 2025 +0.063R, 2026 +0.016R.

No new hours. No optimization. No deployment. No broker orders. PEN_EXTREME remains metadata. 09:00 LONG, 10:00 SHORT, and 11:00 SHORT stay rejected with four-leg V2.
