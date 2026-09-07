# EURUSD London Breakout V3 — authoritative TradingView spread validation

> **Decision status: `RESEARCH_ONLY` · `MARGINAL_AFTER_COSTS` · `REJECTED_REPLACEMENT`.**
> V3 is **not** deployed or promoted. The validated **EURUSD London Breakout V1**
> (356 trades, +0.078R EXEC) remains the active EURUSD strategy. See `DECISION.md`.

## Verdict: MARGINAL_AFTER_COSTS

Classification: **WEAK**. Executable expectancy is **0.0675R/trade** across 234 exact OANDA bid/ask replays of the frozen 234-trade cohort. No strategy rule was changed; barrier levels are taken directly from the Pine and only the executable side decides whether each level was reached.

## Matching

- TradingView trades: **234**
- Matched: **234**
- Unmatched: **0**
- Executable-unresolved (matched but no barrier in data): **0**

Timezone resolved as **America/New_York, DST-aware**: 234/234 entries resolve to their declared leg hour (0600/0700/0800/0900/1000 UTC). Beginning, middle, and end samples were verified against TradingView entry prices (≤0.05 pip) and the frozen Wilder ATR14 reproduces every TP_OR_SL trade's ±1R/+2R geometry exactly.

## Overall results

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 234 | 234 |
| Wins | 116 | 114 |
| Losses | 118 | 120 |
| Win rate | 49.57% | 48.72% |
| Profit factor | 1.455 | 1.125 |
| Total R | 52.3288R | 15.7917R |
| Expectancy R/trade | 0.2236R | 0.0675R |
| Average winner R | 1.4436R | 1.2504R |
| Average loser R | -0.9757R | -1.0563R |
| Max drawdown R | 10.5912R | 13.0584R |

TradingView's tester-reported headline PF is **1.405**. Recomputing a fixed-quantity PF from the CSV's `Net PnL USD` column gives **1.559**, but that column is rounded to ~1 significant digit per trade, so it is unreliable for PF. The table above therefore uses ATR-normalized R (reconstructed from precise prices and the frozen ATR14) for an apples-to-apples MID-vs-EXEC comparison; MID PF **1.455** on that basis is consistent with the ~1.405 headline.

## Results by leg (EXEC)

| Leg | Trades | EXEC WR | EXEC PF | EXEC Exp R |
|---|---:|---:|---:|---:|
| 0600_SHORT | 53 | 49.06% | 1.201 | 0.1099R |
| 0700_LONG | 49 | 48.98% | 0.947 | -0.0288R |
| 0700_SHORT | 42 | 50.00% | 1.405 | 0.2168R |
| 0800_SHORT | 33 | 51.52% | 1.114 | 0.0594R |
| 0900_LONG | 20 | 45.00% | 1.079 | 0.0462R |
| 1000_LONG | 17 | 47.06% | 0.916 | -0.0432R |
| 1000_SHORT | 20 | 45.00% | 1.011 | 0.0061R |

No leg was removed during validation.

## Profit-lock analysis

| Item | Count |
|---|---:|
| TradingView profit-lock activations | 78 |
| OANDA EXEC profit-lock activations | 116 |
| TradingView lock exits (+0.5R) | 45 |
| OANDA EXEC lock exits (+0.5R) | 53 |
| MID reached +1.25R but EXEC did not | 2 |
| EXEC armed +1.25R but MID outcome differed | 18 |
| Lock exit saved trade from a full loss (EXEC) | 53 |
| Lock reduced an eventual +2R winner to +0.5R | 12 |
| Spread changed profit-lock activation | 42 |

## Spread

| Spread (pips) | Avg | Median | Max |
|---|---:|---:|---:|
| Entry | 1.554 | 1.550 | 2.000 |
| Exit | 1.573 | 1.600 | 2.600 |

| Execution drag (R) | Avg | Median | Max | Total |
|---|---:|---:|---:|---:|
| Per trade | 0.1561 | 0.0655 | 3.1134 | 36.5371 |

- MID expectancy: **0.2236R** · EXEC expectancy: **0.0675R** · difference: **0.1561R**

## Outcome changes

| Change | Count |
|---|---:|
| WIN → LOSS | 7 |
| WIN → smaller WIN | 98 |
| LOSS → larger LOSS | 112 |
| LOSS → WIN | 5 |
| TP → profit-lock exit | 12 |
| TP → loss | 4 |
| profit-lock exit → loss | 2 |
| profit-lock exit → TP | 4 |
| MID profit lock triggered but EXEC did not | 2 |
| SL hit earlier because of spread | 6 |
| Exit reason changed | 24 |

## Benchmark

| Strategy | Trades | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| Previous validated EURUSD | 356 | 38.48% | 1.127 | +0.078R |
| EURUSD Frequency V3 | 234 | 48.72% | 1.125 | 0.0675R |

V3 sacrifices frequency for comparable executable edge (no material gain).

Relative to the +0.078R/trade benchmark, V3's executable expectancy is **+0.0675R** (-0.0105R vs benchmark) on 234 trades vs 356.

## Classification

- STRONG ≥ +0.15R · GOOD +0.10..+0.149R · WEAK +0.05..+0.099R · NO EDGE 0..+0.049R · LOSING < 0R
- **EURUSD Frequency V3 EXEC expectancy = 0.0675R → WEAK**

## Execution-modeling notes

These are essential to reading the profit-lock counts correctly:

1. **TradingView's `process_orders_on_close=true` one-bar order lag.** A moved (+0.5R) stop submitted on the arming bar only becomes active the *next* H1 bar, so a fast runner that reaches +1.25R and +2R inside one H1 bar fills the *original* TP order, which TradingView labels `TP_OR_SL`. **42** cohort trades reach +2R yet TradingView's comment says the lock never armed; **4** more carry a `PROFIT_LOCK_OR_TP` comment but a −1R result (the same lag in reverse). This is why TradingView's comment-based activation count (**78**) is lower than the true executable count (**116**). Per the task, the executable side was computed independently from OANDA M1 bid/ask rather than copied from TradingView's activation flag.

2. **Intra-minute pessimism.** When a single M1 minute both arms the lock and touches +0.5R, the sub-minute path is unknowable and was resolved pessimistically to a +0.5R lock exit. Only **3** trades hinge on this (violent news minutes). Re-scoring all 3 at +2R gives an optimistic EXEC expectancy bound of **0.0911R** (total 21.3287R). The verdict is unchanged across the full **0.0675R–0.0911R** band — both fall in the WEAK band and below/around the +0.078R benchmark — so the conclusion does not depend on this modeling choice.

## Final verdict: MARGINAL_AFTER_COSTS

Research/paper only. No optimization, no strategy changes, no deployment, no broker orders.
