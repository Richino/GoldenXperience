# NZDUSD Bull Consensus Structure V1 — exact TradingView cohort OANDA executable spread validation

> Research/paper only. The frozen strategy was not changed; no deployment or broker order was made.

## Verdict: SURVIVES_COSTS

Classification: **STRONG**. EXEC expectancy: **0.1898R/trade**; PF: **1.380**; WR: **48.00%**; total: **18.9782R**.

## Matching and parity

- TradingView trades: **102**; matched: **100**; unmatched: **2**. Exact unmatched reasons are retained in TRADES.csv and RAW_RESULTS.json.
- CSV cohort: 102 NZDUSD_1100_LONG entries; TP_OR_SL: **74**; TIME_EXIT: **28**.
- America/New_York timestamp conversion: **102/102** resolve to 11:00 UTC; first/middle/last and DST-transition samples are retained in RAW_RESULTS.json.
- OANDA H1 midpoint entry agreement: max difference **0.300 pips**. Consensus failures: **0**; HH+HL failures: **0**; ATR/1R-2R geometry failures: **3**.

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 102 | 100 |
| Wins | 54 | 48 |
| Losses | 48 | 52 |
| Win rate | 52.94% | 48.00% |
| Profit factor | 1.900 | 1.380 |
| Total R | 38.7935R | 18.9782R |
| Expectancy R/trade | 0.3803R | 0.1898R |
| Average winner R | 1.5166R | 1.4359R |
| Average loser R | -0.8980R | -0.9605R |
| Max drawdown R | 7.9420R | 11.3552R |

The TradingView headline PF is 1.90. Its exact exported-cohort ATR-normalized MID expectancy is **0.3803R/trade** (the supplied diagnostic was approximately +0.384R/trade).

## Year stability — EXEC

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 33 | 15 | 18 | 45.45% | 1.198 | 3.6398R | 0.1103R | 6.0584R |
| 2024 | 23 | 12 | 11 | 52.17% | 1.649 | 7.7353R | 0.3363R | 4.3190R |
| 2025 | 27 | 10 | 17 | 37.04% | 0.926 | -1.0433R | -0.0386R | 11.3552R |
| 2026 | 17 | 11 | 6 | 64.71% | 2.577 | 8.6464R | 0.5086R | 2.2008R |

3/4 years are positive. Recent performance is not weaker than the prior three-year mean.

## Consensus and time exits — measurement only

| Consensus | Trades | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| +3 | 0 | 0.00% | ∞ | 0.0000R |
| +4 | 100 | 48.00% | 1.380 | 0.1898R |

- TradingView TIME_EXIT: 28; executable TIME_EXIT: 29.
- TIME exits — MID average 0.7363R; EXEC average 0.4891R; EXEC WR 72.41%; total EXEC 14.1834R; drag 7.1683R. This is material: time exits account for 37.2% of the 19.2903R matched-cohort execution drag and lose 0.2472R per time-exit on average.

## Spread and outcome changes

- Entry spread pips (avg / median / max): 1.434 / 1.400 / 2.000
- Exit spread pips (avg / median / max): 1.631 / 1.500 / 14.700
- Execution drag R (avg / median / max / total): 0.1929 / 0.0846 / 3.0918 / 19.2903
- Comparable matched-cohort MID expectancy 0.3827R versus EXEC 0.1898R: difference **0.1929R/trade**. (The 102-trade MID figure above retains both M1-unmatched records; EXEC does not.)
- WIN → LOSS 5; WIN → smaller WIN 48; WIN → TIME EXIT 23; LOSS → larger LOSS 47; LOSS → WIN 0.
- TP missed on BID 6; SL reached earlier on BID 3; exit reason changed 7.

## Decision

1. Does exact NZDUSD V1 survive OANDA costs? **SURVIVES_COSTS**.
2. EXEC expectancy / PF / WR / total R: **0.1898R / 1.380 / 48.00% / 18.9782R**.
3. Year stability: 3/4 positive years.
4. Time exits: 29 executable; total drag 7.1683R.
5. Versus the old -0.094R NZDUSD benchmark: 0.2838R/trade better, but it clears the stated survival rule.
6. Frozen NZDUSD candidate: numeric threshold met, subject to the parity and data-completeness evidence above.

Method: exact supplied cohort only; OANDA Practice M1 MBA; original stop/target remain TradingView entry ± frozen OANDA H1 midpoint ATR14; long entry is signal H1 ASK close, TP/SL/time exits are BID; complete M1 chronology is required, and same-minute TP/SL resolves conservatively stop-first. No second spread subtraction.
