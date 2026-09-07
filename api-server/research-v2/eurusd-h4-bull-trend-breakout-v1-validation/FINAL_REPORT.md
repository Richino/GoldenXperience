# EUR/USD H4 Bull Trend Breakout V1 — FULL EXECUTABLE VALIDATION

Strategy ID: `eurusd_h4_bull_trend_breakout_v1`  
Pair: `EUR_USD`  
Timeframe: H4  
Period: 2023-01-01 through 2026-09-04  
Source: OANDA practice MBA. Long-only. Frozen rules. Nothing was deployed and no orders were placed.

Occupancy: no pyramiding, and no new entry on the same bar as a prior exit. That is the TradingView-like fill order. It brought N from 74 to 64 versus the TV headline of 61.

## Step 1 — Midpoint parity

| Window | N | Wins/Losses | WR | PF | EXP R | Total R | Max DD R | TP/SL/TIME | Avg hold h | Med hold h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TV headline | 61 | n/a | 39.34% | 1.390 | n/a | n/a | n/a | n/a | 43 | 28 |
| OANDA midpoint | 64 | 25/39 | 39.06% | 1.345 | 0.197 | 12.630 | 11.000 | 24/35/5 | 54.1 | 32.0 |

| YEAR | TV N | TV WR | TV PF | OANDA N | OANDA WR | OANDA PF | OANDA EXP |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 21 | 33.30% | 0.800 | 22 | 31.82% | 0.933 | -0.045 |
| 2024 | 11 | 36.40% | 1.670 | 13 | 30.77% | 0.889 | -0.077 |
| 2025 | 23 | 43.50% | 1.750 | 24 | 41.67% | 1.660 | 0.318 |
| 2026 | 6 | 50.00% | 3.750 | 5 | 80.00% | 8.000 | 1.400 |

Parity is close enough to continue. Overall N/WR/PF match. 2023 is weak in both. 2024 is a 13-trade year: TV’s PF 1.67 is not reproduced (OANDA 0.89). That year is too small to treat as a rule mismatch. 2026 is a tiny sample on both sides.

### First 20 OANDA entries

1. 2023-01-09T10:00:00.000Z long @ 1.07252
2. 2023-01-18T06:00:00.000Z long @ 1.08700
3. 2023-01-22T22:00:00.000Z long @ 1.08948
4. 2023-02-01T18:00:00.000Z long @ 1.09896
5. 2023-03-06T14:00:00.000Z long @ 1.06854
6. 2023-03-20T09:00:00.000Z long @ 1.07052
7. 2023-03-28T09:00:00.000Z long @ 1.08396
8. 2023-04-04T13:00:00.000Z long @ 1.09463
9. 2023-04-12T09:00:00.000Z long @ 1.09641
10. 2023-04-14T01:00:00.000Z long @ 1.10690
11. 2023-04-24T09:00:00.000Z long @ 1.10230
12. 2023-05-03T05:00:00.000Z long @ 1.10396
13. 2023-06-21T13:00:00.000Z long @ 1.09706
14. 2023-06-27T05:00:00.000Z long @ 1.09396
15. 2023-07-10T13:00:00.000Z long @ 1.09894
16. 2023-07-13T09:00:00.000Z long @ 1.11798
17. 2023-11-17T18:00:00.000Z long @ 1.09127
18. 2023-11-24T14:00:00.000Z long @ 1.09406
19. 2023-12-14T10:00:00.000Z long @ 1.09438
20. 2023-12-19T14:00:00.000Z long @ 1.09750

## Step 2 — Full 2023–2026 midpoint

Raw setups 151; 87 skipped while a trade was open; 64 closed; 0 unresolved.

| PAIR | YEAR | N | WR | PF | EXP R | TOTAL R | MAX DD R | TP/SL/TIME |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| EUR_USD | 2023 | 22 | 31.82% | 0.933 | -0.045 | -1.000 | 7.000 | 7/15/0 |
| EUR_USD | 2024 | 13 | 30.77% | 0.889 | -0.077 | -1.000 | 8.000 | 4/9/0 |
| EUR_USD | 2025 | 24 | 41.67% | 1.660 | 0.318 | 7.630 | 4.467 | 9/10/5 |
| EUR_USD | 2026 | 5 | 80.00% | 8.000 | 1.400 | 7.000 | 1.000 | 4/1/0 |
| EUR_USD | ALL | 64 | 39.06% | 1.345 | 0.197 | 12.630 | 11.000 | 24/35/5 |

2023 is kept in the headline. It is negative.

## Step 3 — Overnight financing

**FINANCING_DATA_UNAVAILABLE**

No historical OANDA swap series exists in this research store. It was not invented. The authoritative executable result is bid/ask only.

Hypothetical sensitivity, labeled and not mixed into the headline:

| Assumption | Drag R/trade | Effect on 0.139R bid/ask EXP |
|---|---:|---:|
| Current practice longRate −2.44% annual | 0.055 | still about +0.084R |
| Conservative 2 pips per charged financing day | 0.146 | about −0.007R |

Average 2.28 New York 17:00 rolls per trade; OANDA-style days charged (Wednesday ×3) average 3.0.

## Step 4 — Bid/ask costs

Long enter ASK. Stop, target, and exit on BID. ATR frozen from the midpoint signal. SL = 1.5 ATR, TP = 3.0 ATR around the executable entry. Max hold 30 H4 bars. Stop-first. Adverse gaps fill at the worse bid open.

| YEAR | N | MID WR | MID PF | MID EXP | EXEC WR | EXEC PF | EXEC EXP | COST/TRADE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 22 | 31.82% | 0.933 | -0.045 | 31.82% | 0.933 | -0.045 | 0.000 |
| 2024 | 13 | 30.77% | 0.889 | -0.077 | 30.77% | 0.889 | -0.077 | 0.000 |
| 2025 | 24 | 41.67% | 1.660 | 0.318 | 37.50% | 1.294 | 0.163 | 0.155 |
| 2026 | 5 | 80.00% | 8.000 | 1.400 | 80.00% | 8.000 | 1.400 | 0.000 |
| ALL | 64 | 39.06% | 1.345 | 0.197 | 37.50% | 1.233 | 0.139 | 0.058 |

- Midpoint PF 1.345 → executable PF 1.233
- Midpoint EXP 0.197R → executable EXP 0.139R
- Bid/ask drag 0.058R/trade
- Authoritative financing drag: FINANCING_DATA_UNAVAILABLE
- Executable WR 37.50%; total +8.903R; max DD 11.0R
- Spread avg/median/p95: 1.598 / 1.600 / 2.000 pips
- Spread as % of 1R stop: **3.93%**
- Average stop: 45.1 pips
- Midpoint winners → executable losers: 1
- Average / median hold: 53.2 / 32.0 hours
- Max simultaneous exposure: 1

## Step 5 — Yearly stability

- **2023 remains negative.** Midpoint −0.045R; bid/ask unchanged. Keep it in the headline.
- **2024 is still negative after bid/ask** (−0.077R). This disagrees with TV’s small-sample 1.67 PF.
- **2025 is still positive after bid/ask** (0.163R, PF 1.294).
- **Excluding tiny 2026:** executable EXP 0.032R, PF 1.051. The conclusion stays barely positive, not strong.
- **Excluding 2025:** executable EXP 0.125R only because 2026 is 4/5 winners. 2023+2024 alone are negative. The healthy-looking headline is not independent of 2025/2026.

## Step 6 — Classification

**MARGINAL**

Bid/ask expectancy is positive and PF is above 1, but 2023 and 2024 are negative, 2026 is five trades, and dropping 2026 leaves only +0.03R. That is not a SURVIVES year-stability profile.

## Plain English

1. **Did it survive real bid/ask costs?** Yes, barely: executable +0.139R/trade, PF 1.23.
2. **Did spread matter much less than on the failed 15m strategy?** Yes. H4 stop is ~45 pips; 15m was ~5 pips.
3. **What % of 1R did spread consume?** About **3.9%**, versus ~31% on the 15m strategy.
4. **Did overnight financing materially hurt it?** Unknown. Historical swap data is unavailable. A current-rate sketch is ~0.05R/trade; a conservative 2-pip/day sketch could erase the edge. Neither is authoritative.
5. **Years after costs?** 2023 negative, 2024 negative, 2025 positive, 2026 positive but tiny.
6. **Portfolio candidate?** Only as a weak/unstable candidate. Do not treat it as a core sleeve. MARGINAL.
7. **Trades/year?** About **17**.
8. **Average holding time?** About **53 hours** (median 32 hours).

NO STRATEGY RULES WERE CHANGED. NO ORDERS WERE PLACED.
