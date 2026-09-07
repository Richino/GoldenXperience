# EUR/USD H4 Breakout Retest Swing V1 — FULL EXECUTABLE VALIDATION

Strategy ID: `eurusd_h4_breakout_retest_swing_v1`. Frozen long+short rules. OANDA practice MBA. No production strategy was modified. No orders were placed. Shorts were not removed.

## Step 1 — Midpoint parity

| Window | N | Wins/Losses | WR | PF | EXP R | Total R | Max DD R | TP/SL/TIME | Avg hold h | Med hold h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TV headline | 53 | n/a | 41.50% | 1.600 | n/a | n/a | n/a | n/a | 34 | 24 |
| OANDA midpoint | 67 | 27/40 | 40.30% | 1.306 | 0.182 | 12.224 | 6.776 | 26/40/1 | 46.627 | 28.000 |

| SIDE | N | WR | PF | EXP R | TOTAL R |
|---|---:|---:|---:|---:|---:|
| long | 37 | 45.95% | 1.611 | 0.330 | 12.224 |
| short | 30 | 33.33% | 1.000 | -0.000 | -0.000 |

| YEAR | TV PF | OANDA N | OANDA WR | OANDA PF | OANDA EXP |
|---|---:|---:|---:|---:|---:|
| 2023 | 2.090 | 22 | 40.91% | 1.248 | 0.147 |
| 2024 | 1.350 | 15 | 40.00% | 1.333 | 0.200 |
| 2025 | 1.710 | 21 | 42.86% | 1.500 | 0.286 |
| 2026 | 1.150 | 9 | 33.33% | 1.000 | 0.000 |

Parity gate: **passed**. OANDA H4 midpoint WR/PF/hold match the approximate TradingView 2023-2026 headline. N is a bit higher (occupancy still applied; leftover gap is consistent with OANDA D 17:00 NY versus TradingView D). Frozen rules were not changed. Both directions remain.

First 20 OANDA entries:

1. 2023-01-12T14:00:00.000000000Z long @ 1.08488 ATR 0.00419 frozen 1.07764 retest+1
2. 2023-01-20T18:00:00.000000000Z long @ 1.08555 ATR 0.00370 frozen 1.08400 retest+1
3. 2023-03-30T09:00:00.000000000Z long @ 1.09102 ATR 0.00297 frozen 1.08718 retest+1
4. 2023-04-04T13:00:00.000000000Z long @ 1.09463 ATR 0.00377 frozen 1.09166 retest+2
5. 2023-04-13T05:00:00.000000000Z long @ 1.10146 ATR 0.00279 frozen 1.10006 retest+2
6. 2023-04-24T05:00:00.000000000Z long @ 1.10088 ATR 0.00269 frozen 1.09939 retest+2
7. 2023-05-31T13:00:00.000000000Z short @ 1.06381 ATR 0.00285 frozen 1.06725 retest+2
8. 2023-06-27T05:00:00.000000000Z long @ 1.09396 ATR 0.00239 frozen 1.09202 retest+1
9. 2023-07-11T17:00:00.000000000Z long @ 1.10087 ATR 0.00253 frozen 1.10016 retest+1
10. 2023-07-13T05:00:00.000000000Z long @ 1.11610 ATR 0.00278 frozen 1.11405 retest+1
11. 2023-07-14T13:00:00.000000000Z long @ 1.12394 ATR 0.00281 frozen 1.12280 retest+3
12. 2023-08-22T13:00:00.000000000Z short @ 1.08496 ATR 0.00256 frozen 1.08697 retest+1
13. 2023-08-25T17:00:00.000000000Z short @ 1.07944 ATR 0.00293 frozen 1.08050 retest+1
14. 2023-09-07T17:00:00.000000000Z short @ 1.06959 ATR 0.00231 frozen 1.07027 retest+2
15. 2023-09-21T09:00:00.000000000Z short @ 1.06423 ATR 0.00284 frozen 1.06502 retest+3
16. 2023-09-27T05:00:00.000000000Z short @ 1.05600 ATR 0.00233 frozen 1.05622 retest+2
17. 2023-10-03T09:00:00.000000000Z short @ 1.04662 ATR 0.00269 frozen 1.04779 retest+3
18. 2023-11-01T13:00:00.000000000Z short @ 1.05338 ATR 0.00289 frozen 1.05574 retest+1
19. 2023-11-20T06:00:00.000000000Z long @ 1.09368 ATR 0.00264 frozen 1.09143 retest+1
20. 2023-11-26T22:00:00.000000000Z long @ 1.09469 ATR 0.00219 frozen 1.09309 retest+2

## Step 2 — Full 2023–2026 midpoint

Raw setups 89; skipped while open 22; closed 67; unresolved 0.

| PAIR | YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R | TP/SL/TIME |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| EUR_USD | 2023 | 22 | 40.91% | 1.248 | 0.147 | 3.224 | 6.776 | 8/13/1 |
| EUR_USD | 2024 | 15 | 40.00% | 1.333 | 0.200 | 3.000 | 3.000 | 6/9/0 |
| EUR_USD | 2025 | 21 | 42.86% | 1.500 | 0.286 | 6.000 | 5.000 | 9/12/0 |
| EUR_USD | 2026 | 9 | 33.33% | 1.000 | 0.000 | 0.000 | 5.000 | 3/6/0 |
| EUR_USD | ALL | 67 | 40.30% | 1.306 | 0.182 | 12.224 | 6.776 | 26/40/1 |

## Step 3 — Overnight financing

**FINANCING_DATA_UNAVAILABLE**

Historical OANDA swap/financing rates are not in this research store and were not invented. The authoritative executable result below is bid/ask only.

Hypothetical sensitivity, not mixed into the headline:

- Current OANDA EUR_USD snapshot: longRate -2.4400% / shortRate 0.4200% annual (https://api-fxpractice.oanda.com current snapshot, not historical)
- Hypothetical current-rate financing drag: 0.014R/trade
- Hypothetical conservative 2 pips per charged financing day: 0.106R/trade
- Average overnight 17:00 NY rolls: 1.746
- Average OANDA-style days charged (Wed=3): 2.194

## Step 4 — Bid/ask cost report

Same midpoint signals. Long enter ASK / stop-target-exit BID. Short enter BID / stop-target-exit ASK. ATR frozen. SL=1.5 ATR, TP=3.0 ATR around executable entry. Max hold 30 H4 bars. Stop-first. Adverse gaps fill at the worse executable open.

| YEAR | N | MID WR | MID PF | MID EXP | EXEC WR | EXEC PF | EXEC EXP | COST/TRADE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 22 | 40.91% | 1.248 | 0.147 | 40.91% | 1.244 | 0.144 | 0.002 |
| 2024 | 15 | 40.00% | 1.333 | 0.200 | 26.67% | 0.727 | -0.200 | 0.400 |
| 2025 | 21 | 42.86% | 1.500 | 0.286 | 38.10% | 1.231 | 0.143 | 0.143 |
| 2026 | 9 | 33.33% | 1.000 | 0.000 | 33.33% | 1.000 | 0.000 | 0.000 |
| ALL | 67 | 40.30% | 1.306 | 0.182 | 35.82% | 1.074 | 0.047 | 0.135 |

- midpoint PF: 1.306
- executable PF: 1.074
- midpoint expectancy: 0.182R
- executable expectancy: 0.047R
- spread cost / bid-ask drag: 0.135R/trade
- financing drag (authoritative): FINANCING_DATA_UNAVAILABLE
- total cost drag (authoritative = bid/ask): 0.135R/trade
- executable WR: 35.82%
- total executable R: 3.177
- executable max DD: 6.823R
- average / median / p95 spread: 1.743 / 1.600 / 2.200 pips
- spread as % of 1R stop: 4.31%
- average stop distance: 42.465 pips
- midpoint winners that become executable losers: 3
- long executable expectancy: 0.167R (N 37, WR 40.54%, PF 1.281)
- short executable expectancy: -0.100R (N 30, WR 30.00%, PF 0.857)
- average / median hold: 44.478 / 28.000 hours
- maximum simultaneous exposure: 2

## Step 5 — Yearly stability

- All four yearly slices still positive after bid/ask? NO
- 2023 after bid/ask: EXP 0.144R, PF 1.244
- 2024 after bid/ask: EXP -0.200R, PF 0.727
- 2025 after bid/ask: EXP 0.143R, PF 1.231
- 2026 after bid/ask: EXP 0.000R, PF 1.000
- Excluding 2026: midpoint EXP 0.211R PF 1.360; executable EXP 0.055R PF 1.086
- Excluding 2025: midpoint EXP 0.135R PF 1.222; executable EXP 0.004R PF 1.006
- Long edge after bid/ask: EXP 0.167R
- Shorts after bid/ask: EXP -0.100R
- Shorts remain in the frozen combined result. This run did not drop them.

## Step 6 — Classification

**MARGINAL**

Approximate annual frequency: 18.2 trades/year.

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
