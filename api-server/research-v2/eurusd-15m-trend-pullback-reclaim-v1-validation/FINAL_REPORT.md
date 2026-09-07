# EUR/USD 15m Trend Pullback Reclaim V1 — FULL VALIDATION

Strategy ID: `eurusd_15m_trend_pullback_reclaim_v1`  
Pair: `EUR_USD`  
Timeframe: 15 minutes  
Period: 2023-01-01 through 2026-09-04 (OANDA practice MBA, completed bars)  
Source: OANDA midpoint signals; historical bid/ask execution  

Frozen rules were not changed. No production strategy was modified. Nothing was deployed. No orders were placed.

## Frozen geometry

- Local: EMA20, EMA50, Wilder ATR14 on completed M15 midpoint closes
- Daily bias: previous completed OANDA D candle only; long if D1 EMA20 > EMA50 and D1 close > EMA20; short if D1 EMA20 < EMA50 and D1 close < EMA20
- Pullback / reclaim / structure / 0.35 ATR body as specified
- Entry: confirmed M15 close
- Stop 1.0 ATR and target 2.0 ATR frozen at entry
- No time exit, trail, profit lock, or pyramiding
- Same-bar TP+SL: stop-first
- Adverse stop gaps fill at the worse open; target gaps get no improvement

## Step 1 — Midpoint parity

TradingView’s available sample did not load 2023–2024, and it did not load all of 2025. The reconstructed overlap is the last 113 OANDA trades, which start on 2025-11-19 and run through 2026-09-04.

| Window | N | Wins/Losses | WR | PF | EXP R | Total R | Max DD R |
|---|---:|---:|---:|---:|---:|---:|---:|
| TV headline | 113 | ~46/67 | 40.71% | 1.470 | n/a | n/a | n/a |
| TV 2025 headline | ~27 | ~12/15 | 44.44% | 1.598 | n/a | n/a | n/a |
| TV 2026 headline | ~86 | ~34/52 | 39.53% | 1.432 | n/a | n/a | n/a |
| OANDA last 113 (2025-11-19 to 2026-09-04) | 113 | 45/68 | 39.82% | 1.305 | 0.186 | 21.025 | 6.000 |
| OANDA last-113 2025 slice | 19 | 9/10 | 47.37% | 1.640 | 0.370 | 7.025 | 3.975 |
| OANDA last-113 / full 2026 | 94 | 36/58 | 38.30% | 1.241 | 0.149 | 14.000 | 6.000 |
| OANDA full 2025–2026 (TV did not load this) | 265 | 91/174 | 34.34% | 1.040 | 0.027 | 7.025 | 25.000 |

Parity is close enough to continue:

- Last-113 win rate is one winner off the TV headline (45/113 vs ~46/113).
- 2026 count is 94 vs ~86. Win rate 38.30% vs 39.53%.
- PF sits below TV (1.30 vs 1.47) because this replay is conservative stop-first with no extra profit on target gaps. At exact +2R/−1R, 45/68 is PF 1.32.
- Full 2025 was not used as a parity gate. TV did not load it.

### First 20 reconstructed-overlap entries

These are the first twenty trades of the last-113 window, the range TradingView could actually have seen.

1. 2025-11-19T04:15:00.000Z short @ 1.15792
2. 2025-11-20T00:00:00.000Z short @ 1.15344
3. 2025-11-20T09:00:00.000Z short @ 1.15188
4. 2025-11-21T13:00:00.000Z short @ 1.15178
5. 2025-11-21T15:15:00.000Z short @ 1.15110
6. 2025-12-11T07:00:00.000Z long @ 1.16920
7. 2025-12-11T09:30:00.000Z long @ 1.16970
8. 2025-12-12T00:00:00.000Z long @ 1.17436
9. 2025-12-12T01:15:00.000Z long @ 1.17457
10. 2025-12-12T21:00:00.000Z long @ 1.17435
11. 2025-12-15T14:15:00.000Z long @ 1.17508
12. 2025-12-16T11:30:00.000Z long @ 1.17590
13. 2025-12-16T17:00:00.000Z long @ 1.17758
14. 2025-12-17T22:00:00.000Z long @ 1.17425
15. 2025-12-18T04:45:00.000Z long @ 1.17428
16. 2025-12-22T17:00:00.000Z long @ 1.17540
17. 2025-12-23T07:30:00.000Z long @ 1.17740
18. 2025-12-24T05:15:00.000Z long @ 1.17945
19. 2025-12-30T03:15:00.000Z long @ 1.17746
20. 2026-01-20T01:00:00.000Z long @ 1.16420

## Step 2 — Full 2023–2026 midpoint

Raw setups 637; 62 skipped while a trade was already open; 575 closed; 0 unresolved.

| PAIR | YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R |
|---|---:|---:|---:|---:|---:|---:|---:|
| EUR_USD | 2023 | 169 | 26.63% | 0.725 | -0.202 | -34.157 | 36.157 |
| EUR_USD | 2024 | 141 | 26.24% | 0.689 | -0.236 | -33.340 | 33.340 |
| EUR_USD | 2025 | 171 | 32.16% | 0.940 | -0.041 | -6.975 | 25.000 |
| EUR_USD | 2026 | 94 | 38.30% | 1.241 | 0.149 | 14.000 | 6.000 |
| EUR_USD | ALL | 575 | 30.09% | 0.851 | -0.105 | -60.473 | 88.498 |

- Overall N: 575
- Overall WR: 30.09% (173 wins / 402 losses)
- Overall PF: 0.851
- Overall expectancy: -0.105R
- Total R: -60.473
- Long: N 345, WR 28.12%, PF 0.779, EXP -0.160R
- Short: N 230, WR 33.04%, PF 0.966, EXP -0.023R
- Max drawdown: 88.498R
- Average holding time: 2.65 hours
- Median holding time: 0.75 hours
- Trades per year: 2023=169, 2024=141, 2025=171, 2026=94 (partial year through 4 Sep)

The recent TradingView-like window is real, but it is not the strategy. 2023, 2024, and full 2025 are all midpoint-negative.

## Step 3 / 4 — Executable bid/ask costs

Signals stay on midpoint M15. Long enters ASK and is stopped/targeted/exited on BID. Short enters BID and is stopped/targeted/exited on ASK. ATR is the frozen midpoint ATR. SL = 1 ATR and TP = 2 ATR around the executable entry. Missing MBA quotes fail closed; none were missing.

| YEAR | N | MID PF | MID EXP | EXEC WR | EXEC PF | EXEC EXP | COST/TRADE |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 169 | 0.725 | -0.202 | 19.53% | 0.475 | -0.431 | 0.229 |
| 2024 | 141 | 0.689 | -0.236 | 15.60% | 0.367 | -0.538 | 0.302 |
| 2025 | 171 | 0.940 | -0.041 | 23.98% | 0.626 | -0.286 | 0.245 |
| 2026 | 94 | 1.241 | 0.149 | 28.72% | 0.753 | -0.188 | 0.337 |
| ALL | 575 | 0.851 | -0.105 | 21.39% | 0.533 | -0.374 | 0.269 |

- Midpoint PF: 0.851
- Executable PF: 0.533
- Midpoint expectancy: -0.105R
- Executable expectancy: -0.374R
- Cost drag: 0.269R/trade
- Executable WR: 21.39%
- Average / median / p95 spread: 1.643 / 1.500 / 1.900 pips
- Spread as % of ATR / 1R stop: 31.37% (median 28.17%)
- Midpoint winners that become executable losers: 50
- Long executable expectancy: -0.414R
- Short executable expectancy: -0.315R
- Total executable R: -215.311
- Executable max drawdown: 215.311R

15-minute EURUSD ATR at these signals is typically ~3–8 pips. A 1.6 pip spread is about a third of the 1R stop, so even the only midpoint-positive year (2026, +0.149R) is negative after costs (−0.188R).

## Classification

**FAILS_EDGE**

The full 2023–2026 midpoint history does not support an edge (PF 0.85, −0.105R/trade, three negative years). Spreads then make it worse; they are not the original failure. Parameters were not changed to rescue the result.

## Plain English

1. **Did the 15m strategy survive 2023–2026?** No. Midpoint expectancy is negative over the full sample.
2. **Did spread destroy it?** Spread is severe on this timeframe (~31% of 1R) and turns the only green year red, but the strategy already lacked a full-sample midpoint edge.
3. **Which years were positive/negative?** Midpoint: 2023 negative, 2024 negative, 2025 slightly negative, 2026 positive. Executable: every year negative.
4. **Is it strong enough to keep as a portfolio candidate?** No. Do not keep it.
5. **Approximate annual trade frequency?** About 156 closed trades per year, median hold 45 minutes.

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
