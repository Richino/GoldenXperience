# CADJPY Bull Break Extreme V1 — exact TradingView cohort vs OANDA executable spread validation

> **Status: RESEARCH_ONLY · PAPER_ONLY. No deployment, no activation, no broker orders, no strategy modification.**

> The exact 84 exported TradingView trades were replayed against OANDA Practice M1 bid/ask. No new signal cohort was generated; no rule was added, removed, or tuned.

## Verdict: SURVIVES_COSTS

Classification **STRONG**. EXEC expectancy **0.1637R/trade**, PF **1.342**, WR **54.22%**, total **13.5898R** over 83 matched trades.

## 1. Cohort matching

- TradingView entries: **84**
- Matched OANDA entries: **83**
- Unmatched: **1**

| # | TV timestamp | resolved UTC | reason |
|---|---|---|---|
| 31 | 2024-05-20 08:00 | 2024-05-20T12:00:00.000Z | M1_GAP_2024-05-20T14:23:00.000Z_97_MINUTES |

## 2. Timezone / DST resolution

- Every entry resolves to **12:00 UTC**: **84/84**.
- America/New_York wall-clock inputs (07:00 during EST, 08:00 during EDT) both map to 12:00 UTC. Audited samples:

| segment | trade | TV entry (NY) | resolved UTC |
|---|---|---|---|
| begin | 1 | 2023-01-05 07:00 | 2023-01-05T12:00:00.000Z |
| middle | 43 | 2024-10-09 08:00 | 2024-10-09T12:00:00.000Z |
| end | 84 | 2026-08-31 08:00 | 2026-08-31T12:00:00.000Z |
| EST(winter,07:00NY) | 1 | 2023-01-05 07:00 | 2023-01-05T12:00:00.000Z |
| EDT(summer,08:00NY) | 2 | 2023-03-27 08:00 | 2023-03-27T12:00:00.000Z |
| pre-Nov-DST(EDT,08:00NY) | 17 | 2023-10-12 08:00 | 2023-10-12T12:00:00.000Z |
| post-Nov-DST(EST,07:00NY) | 18 | 2023-12-11 07:00 | 2023-12-11T12:00:00.000Z |

## 3. TradingView parity (verified, not forced)

1. Exact LONG entries: **84** — all `CADJPY_1200_LONG`.
2. Entries at 12:00 UTC: **84/84**.
3. EMA20 reconstructed on OANDA H1 midpoint; entry-price agreement (mid close vs TV close) max diff **0.250 pips**, median **0.000 pips**.
4. EMA50 reconstructed on OANDA H1 midpoint (available on all 84/84).
5. EMA20[3] and close[3] available on all 84/84 (3-bar lookback resolved).
6. Vote parity on OANDA mid — voteTrend (EMA20>EMA50): **84/84**; votePrice (close>EMA20): **84/84**; voteSlope (EMA20>EMA20[3]): **84/84**; voteMomentum (close>close[3]): **84/84**.
7. Consensus >= +3 on OANDA mid: **84/84** (mean consensus 4.00).
8. close > high[1] (previous H1 high break): **84/84**.
9. Bullish origin body (close > open): **84/84**.
10. body >= 0.50·ATR14: **84/84**.
11. close in upper 25% of candle range: **83/84**.
12. ATR14 parity: reconstructed ATR14 vs ATR implied by clean TP/SL exits — max diff **0.395 pips** over 59 checkable trades.
13. Stop/target geometry: TP/SL move magnitude / ATR clusters at ~1R and ~2R (mean TP 1.981R, mean SL 0.994R).
14. 3-H1 hold: max CSV duration **3 bars**; all durations ≤ 3: **yes**.

Discrepancies (reported, not corrected):

- close in upper 25% holds on 83/84 on OANDA mid (feed rounding near boundary).


## 4. TradingView PF reconstruction — currency-weighted vs R-normalized

The exported CSV uses fixed quantity (1 unit) and reports PnL in JPY. Two PFs are therefore legitimately different:

- **Currency-weighted TradingView PF** (direct from CSV Net PnL JPY, all 84 trades): **1.762** (gross profit 10.310 JPY / gross loss 5.850 JPY; net 4.460 JPY). Matches the exported ~1.762.
- **R-normalized TradingView/MID PF** (each trade normalized by its own frozen ATR14 R, all 84 trades): **1.722**, expectancy **0.3143R/trade**, total **26.3972R**. Matches the Phase-3B diagnostic ~1.729 / +0.319R / +26.81R.

These are not contradictory: currency PnL weights every trade by its JPY move (large-ATR trades count more), while R-normalization equalizes risk across trades. Trade-level win/loss signs and geometry agree, so the divergence is purely the ATR-weighting effect, not a parity failure.

## 5. Overall results

The frozen-R **TradingView benchmark** is reconstructed over all 84 authoritative trades. The **OANDA EXEC** column and the apples-to-apples **MID (matched)** column cover the 83 trades with complete executable M1 data (trade 31 excluded — 97-minute OANDA M1 gap during its hold window; it is a +1.98R TV winner, so its removal lowers the matched-MID column below the full benchmark).

| Metric | TV benchmark (84) | MID (matched 83) | OANDA EXEC (83) |
|---|---:|---:|---:|
| Trades | 84 | 83 | 83 |
| Wins | 46 | 45 | 45 |
| Losses | 38 | 38 | 38 |
| Win rate | 54.76% | 54.22% | 54.22% |
| Profit factor | 1.722 | 1.668 | 1.342 |
| Total R | 26.3972R | 24.4171R | 13.5898R |
| Expectancy R/trade | 0.3143R | 0.2942R | 0.1637R |
| Average winner R | 1.3688R | 1.3552R | 1.1861R |
| Average loser R | -0.9623R | -0.9623R | -1.0469R |
| Max drawdown R | 5.2482R | 5.2482R | 5.8078R |

Reconstructed R-normalized TV benchmark from the authoritative cohort is **0.3143R/trade** (PF 1.722, total 26.3972R) — matches the cited PF 1.729 / +0.319R/trade. The apples-to-apples cost comparison (matched 83) is MID **0.2942R** → EXEC **0.1637R**, i.e. **0.1304R/trade** of spread/execution drag.

## 6. Year stability — EXEC

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 18 | 11 | 7 | 61.11% | 1.460 | 3.4621R | 0.1923R | 4.3140R |
| 2024 | 32 | 17 | 15 | 53.13% | 1.259 | 4.0709R | 0.1272R | 3.7433R |
| 2025 | 16 | 10 | 6 | 62.50% | 1.825 | 5.2262R | 0.3266R | 2.7364R |
| 2026 | 17 | 7 | 10 | 41.18% | 1.081 | 0.8307R | 0.0489R | 5.8078R |

**A. All years with trades remain positive.** (4/4 year-buckets with trades are positive). No year filter is applied.

## 7. Exit analysis

EXEC exit counts — TP: **18**, SL: **36**, TIME_EXIT: **29**. TradingView cohort: TP_OR_SL **59**, TIME_EXIT **25** (Phase-3B diagnostic decomposition ≈ TP 23 / SL 36 / TIME 25).

| Exit | Count | Avg MID R | Avg EXEC R | Total MID R | Total EXEC R | Exec drag R |
|---|---:|---:|---:|---:|---:|---:|
| TARGET_2R | 18 | 1.9806 | 1.9143 | 35.6513 | 34.4579 | 1.1934 |
| ORIGINAL_STOP | 36 | -0.9940 | -1.0773 | -35.7849 | -38.7822 | 2.9973 |
| TIME_EXIT | 29 | 0.8466 | 0.6177 | 24.5507 | 17.9141 | 6.6366 |

Are the time exits unusually cost-sensitive? **yes — time exits carry above-average per-trade drag** (time-exit per-trade drag 0.2288R vs TP/SL per-trade drag 0.0776R).

## 8. Spread analysis (CADJPY pip = 0.01)

- Entry spread pips — avg **2.1928**, median **2.1000**, max **3.8000**
- Exit spread pips — avg **2.1988**, median **2.1000**, max **3.7000**
- Execution drag R — avg **0.1304**, median **0.0903**, max **1.3751**, total **10.8272R**
- MID expectancy **0.2942R** − EXEC expectancy **0.1637R** = **0.1304R/trade** cost.

## 9. Outcome changes

- TV WIN → EXEC LOSS: **0**
- TV WIN → smaller EXEC WIN: **45**
- TV LOSS → larger EXEC LOSS: **38**
- TV LOSS → EXEC WIN: **0**
- TV TP → EXEC TIME_EXIT: **4**
- TV TP → EXEC SL: **0**
- TV TIME → EXEC WIN: **23**
- TV TIME → EXEC LOSS: **2**
- Any exit reason changed: **4**
- Total R impact of changed-outcome trades (EXEC − MID over those trades): **-3.6555R**

## 10. Same-minute TP/SL

- AMBIGUOUS_INTRAMINUTE trades (one M1 candle touched both stop and target): **0**.
- Primary results use conservative chronology (stop-first). Optimistic bound (target-first on the ambiguous minutes): EXEC expectancy **0.1637R/trade**, PF **1.342**, total **13.5898R**.


## 11. Break-distance metadata (diagnostic only — NOT a filter)

break_distance = close − previous H1 high; break_distance_R = break_distance / ATR14.

| break_distance_R | N | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| 0 to <0.10R | 5 | 80.00% | 4.398 | 0.7215R |
| 0.10 to <0.25R | 5 | 60.00% | 1.872 | 0.3715R |
| 0.25 to <0.50R | 16 | 43.75% | 1.021 | 0.0121R |
| >=0.50R | 57 | 54.39% | 1.290 | 0.1392R |

## 12. Body-strength metadata (diagnostic only — 0.50 ATR rule unchanged)

body_R = |close − open| / ATR14.

| body_R | N | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| 0.50 to <0.75R | 22 | 50.00% | 1.007 | 0.0035R |
| 0.75 to <1.00R | 18 | 61.11% | 2.245 | 0.5227R |
| >=1.00R | 43 | 53.49% | 1.200 | 0.0954R |

## 13. Close-extreme metadata (diagnostic only, intentionally overlapping)

close_position = (close − low) / (high − low). Cohorts overlap by construction.

| cohort | N | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| top 25% | 82 | 54.88% | 1.380 | 0.1791R |
| top 15% | 53 | 52.83% | 1.283 | 0.1376R |
| top 10% | 44 | 50.00% | 1.140 | 0.0732R |

## 14. Consensus-score metadata (diagnostic only — >= +3 rule unchanged)

| Consensus | N | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| +3 | 0 | 0.00% | ∞ | 0.0000R |
| +4 | 83 | 54.22% | 1.342 | 0.1637R |

## Decision

1. **Does CADJPY V1 survive executable OANDA costs?** Yes. (SURVIVES_COSTS)
2. Exact EXEC expectancy: **0.1637R/trade**.
3. Exact EXEC PF: **1.342**.
4. Exact EXEC win rate: **54.22%**.
5. Total EXEC R: **13.5898R**.
6. Matched / unmatched: **83 / 1**.
7. Average spread drag: **0.1304R/trade** (total 10.8272R).
8. Year stability: 4/4 positive year-buckets — A. All years with trades remain positive.
9. Do time exits materially hurt? yes — time exits carry above-average per-trade drag.
10. Does the pre-cost ~+0.319R Phase-3B edge survive executable pricing? Full-84 frozen-R benchmark is 0.3143R; on the matched 83 the MID edge is 0.2942R and after spread it is 0.1637R — the edge largely survives.
11. Should this exact V1 become the frozen CADJPY research/paper candidate? **Yes — it clears the ≥+0.10R executable bar (subject to the small-sample and single-instrument caveats).**

---

Method: OANDA Practice H1 midpoint ATR14/EMA20/EMA50 frozen at the 12:00 UTC close; original stop = mid entry − 1·ATR14, target = mid entry + 2·ATR14; executable LONG entry at the 12:00 ASK close; M1 bid replayed chronologically 13:00–15:59 UTC (3 future H1 bars); target/stop tested against BID; stop-first within an ambiguous minute (optimistic bound reported separately); time exit at the 15:00 H1 BID close; every result normalized by the original frozen R. Executable-side pricing already embeds spread — spread is never subtracted twice.
