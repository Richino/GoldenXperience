# EUR/USD H4 Breakout Retest Rejection V1 — LONG-HISTORY VALIDATION

Strategy ID: `eurusd_h4_breakout_retest_rejection_v1`. Frozen long-only rejection rules. OANDA practice MBA. No production strategy was modified. No orders were placed.

Requested window 2018-01-01 through 2026-09-04. Earliest complete OANDA H4 bar used: 2017-07-02T21:00:00.000000000Z. Evaluation from 2018-01-01T00:00:00.000Z.

## Step 1 — 2023-2026 midpoint parity

| Window | N | Wins/Losses | WR | PF | EXP R | Total R | TP/SL/TIME | Avg hold h | Med hold h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TV headline | 22 | n/a | 50.00% | 2.360 | n/a | n/a | n/a | 41 | 28 |
| OANDA midpoint | 31 | 15/16 | 48.39% | 1.764 | 0.394 | 12.224 | 14/16/1 | 45.419 | 28.000 |

Parity gate: **passed**. OANDA H4 midpoint 2023-2026 N/WR/PF are close enough to the approximate TradingView headline to continue. Frozen long-only rejection rules were not changed.

First 20 2023-2026 entries:

1. 2023-01-12T14:00:00.000000000Z long @ 1.08488 ATR 0.00419 frozen 1.07764 retest+1
2. 2023-01-20T18:00:00.000000000Z long @ 1.08555 ATR 0.00370 frozen 1.08400 retest+1
3. 2023-03-30T09:00:00.000000000Z long @ 1.09102 ATR 0.00297 frozen 1.08718 retest+1
4. 2023-04-13T05:00:00.000000000Z long @ 1.10146 ATR 0.00279 frozen 1.10006 retest+2
5. 2023-04-24T05:00:00.000000000Z long @ 1.10088 ATR 0.00269 frozen 1.09939 retest+2
6. 2023-06-27T05:00:00.000000000Z long @ 1.09396 ATR 0.00239 frozen 1.09202 retest+1
7. 2023-07-12T09:00:00.000000000Z long @ 1.10582 ATR 0.00262 frozen 1.10274 retest+2
8. 2023-07-13T05:00:00.000000000Z long @ 1.11610 ATR 0.00278 frozen 1.11405 retest+1
9. 2023-07-14T13:00:00.000000000Z long @ 1.12394 ATR 0.00281 frozen 1.12280 retest+3
10. 2023-11-20T06:00:00.000000000Z long @ 1.09368 ATR 0.00264 frozen 1.09143 retest+1
11. 2023-12-19T10:00:00.000000000Z long @ 1.09622 ATR 0.00272 frozen 1.09312 retest+1
12. 2023-12-27T02:00:00.000000000Z long @ 1.10436 ATR 0.00209 frozen 1.10404 retest+2
13. 2024-05-27T21:00:00.000000000Z long @ 1.08650 ATR 0.00152 frozen 1.08579 retest+2
14. 2024-06-03T17:00:00.000000000Z long @ 1.09043 ATR 0.00224 frozen 1.08825 retest+1
15. 2024-08-05T05:00:00.000000000Z long @ 1.09512 ATR 0.00296 frozen 1.09267 retest+1
16. 2024-08-13T01:00:00.000000000Z long @ 1.09392 ATR 0.00170 frozen 1.09314 retest+2
17. 2024-08-19T01:00:00.000000000Z long @ 1.10398 ATR 0.00190 frozen 1.10298 retest+1
18. 2025-03-05T06:00:00.000000000Z long @ 1.07120 ATR 0.00414 frozen 1.06278 retest+1
19. 2025-03-18T13:00:00.000000000Z long @ 1.09387 ATR 0.00323 frozen 1.09299 retest+2
20. 2025-04-02T21:00:00.000000000Z long @ 1.08908 ATR 0.00400 frozen 1.08300 retest+2

## Step 2 — Full available-history midpoint

Raw setups 71; skipped while open 10; closed 61; unresolved 0.

| YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R |
|---|---:|---:|---:|---:|---:|---:|
| 2018 | 4 | 0.00% | 0.000 | -1.000 | -4.000 | 4.000 |
| 2019 | 2 | 50.00% | 0.497 | -0.252 | -0.503 | 1.000 |
| 2020 | 17 | 29.41% | 0.833 | -0.118 | -2.000 | 7.000 |
| 2021 | 5 | 20.00% | 0.500 | -0.400 | -2.000 | 4.000 |
| 2022 | 2 | 100.00% | n/a | 1.186 | 2.372 | 0.000 |
| 2023 | 12 | 41.67% | 1.175 | 0.102 | 1.224 | 4.776 |
| 2024 | 5 | 40.00% | 1.333 | 0.200 | 1.000 | 3.000 |
| 2025 | 13 | 53.85% | 2.333 | 0.615 | 8.000 | 3.000 |
| 2026 | 1 | 100.00% | n/a | 2.000 | 2.000 | 0.000 |
| ALL | 61 | 39.34% | 1.165 | 0.100 | 6.092 | 11.405 |

| BLOCK | N | PF | EXP R | TOTAL R |
|---|---:|---:|---:|---:|
| 2018-2020 | 23 | 0.617 | -0.283 | -6.503 |
| 2021-2022 | 7 | 1.093 | 0.053 | 0.372 |
| 2023-2024 | 17 | 1.222 | 0.131 | 2.224 |
| 2025-2026 | 14 | 2.667 | 0.714 | 10.000 |

- TP %: 34.43%
- SL %: 60.66%
- TIME_EXIT %: 4.92%
- average / median hold: 48.131 / 28.000 hours
- trades/year: 7.0
- longest losing streak: 11
- without 2025: N 48 PF 0.938 EXP -0.040
- without best year (2025): N 48 PF 0.938 EXP -0.040

## Long-history gate

**FAILS_LONG_HISTORY**

- PF 1.165 < 1.20
- edge does not survive without 2025
- removing the single best year leaves PF <= 1

Bid/ask execution was not run. Financing was not estimated into a headline. Frozen rules were not changed to rescue the result.

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
