# AUDJPY Bull Consensus V1 — exact TradingView cohort OANDA executable spread validation

> **Decision status: AUDJPY_V1_REJECTED · RESEARCH_ONLY · FAILS_COSTS · NO_EDGE · REJECTED.**

> Research/paper only. No deployment, broker orders, or strategy modification. The exact 247 exported trades were replayed; no new cohort was generated.

## Verdict: FAILS_COSTS

Classification: **NO EDGE**. EXEC expectancy is **0.0224R/trade**, PF **1.045**, WR **47.15%**, total **5.5027R**.

## Matching and parity

- TradingView trades: **247**; matched: **246**; unmatched: **1**.
- All CSV entries are AUDJPY_1200_LONG; TP_OR_SL: **144**; TIME_EXIT: **103**.
- America/New_York DST resolution: **247/247** resolve to 12:00 UTC. First/middle/last samples are in RAW_RESULTS.json.
- EMA20/EMA50 input parity is tested from OANDA H1 midpoint entry-price agreement (max difference **0.200 pips**).
- Consensus >= +3 parity: **246/246**; +3: **0**, +4: **246**. ATR/geometry failures: **0**. No additional filter exists in the replay.

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 247 | 246 |
| Wins | 126 | 116 |
| Losses | 121 | 130 |
| Win rate | 51.01% | 47.15% |
| Profit factor | 1.359 | 1.045 |
| Total R | 38.9037R | 5.5027R |
| Expectancy R/trade | 0.1575R | 0.0224R |
| Average winner R | 1.1692R | 1.0909R |
| Average loser R | -0.8960R | -0.9311R |
| Max drawdown R | 13.1580R | 21.7482R |

TradingView headline PF is 1.381; its exact ATR-normalized MID expectancy from this authoritative cohort is **0.1575R/trade**.

## Year stability — EXEC

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 69 | 29 | 40 | 42.03% | 0.785 | -8.0827R | -0.1171R | 13.8361R |
| 2024 | 65 | 31 | 34 | 47.69% | 1.101 | 3.2494R | 0.0500R | 8.8574R |
| 2025 | 62 | 23 | 39 | 37.10% | 0.725 | -10.2966R | -0.1661R | 14.2462R |
| 2026 | 50 | 33 | 17 | 66.00% | 2.474 | 20.6326R | 0.4127R | 3.1451R |

2/4 years are positive; the edge is not broad-based.

## Consensus and time exits (measurement only)

| Consensus | Trades | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| +3 | 0 | 0.00% | ∞ | 0.0000R |
| +4 | 246 | 47.15% | 1.045 | 0.0224R |

EXEC exit counts: TP **34**, SL **107**, TIME **105**.
Time exits: **105**; MID average 0.6948R, EXEC average 0.5124R, EXEC WR 78.10%, total EXEC 53.7992R, drag 19.1514R. TP/SL exits drag 13.4556R.

## Spread (AUDJPY pip = 0.01)

- Entry pips avg / median / max: 1.980 / 1.950 / 2.800
- Exit pips avg / median / max: 2.050 / 1.900 / 15.000
- Execution drag R avg / median / max / total: 0.1325 / 0.0792 / 1.9835 / 32.6071
- MID expectancy 0.1575R vs EXEC 0.0224R: difference **0.1351R/trade**.

## Outcome changes

- WIN → LOSS: 9; WIN → smaller WIN: 116; WIN → TIME EXIT: 89
- LOSS → larger LOSS: 121; LOSS → WIN: 0
- TP missed because BID did not reach target: 6; SL hit earlier on BID: 3; exit reason changed: 9

## Decision

1. Does exact AUDJPY V1 survive costs? **FAILS_COSTS**.
2. EXEC expectancy / PF / WR / total R: **0.0224R / 1.045 / 47.15% / 5.5027R**.
3. Year stability: 2/4 positive years (see table).
4. Time exits are 105 of 247; their EXEC drag is 19.1514R.
5. Frozen AUDJPY candidate: do not freeze it as a candidate; executable edge does not clear the stated threshold.

Method: frozen OANDA H1 midpoint ATR14; original midpoint entry ± 1/2 ATR barriers; long entry at final signal-minute ASK, all exits at BID; M1 chronological replay; stop-first within a minute; no synthetic second spread charge.
