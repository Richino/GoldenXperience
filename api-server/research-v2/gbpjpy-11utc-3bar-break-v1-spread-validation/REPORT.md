# GBPJPY 11UTC 3-Bar Break V1 — exact TradingView cohort vs OANDA executable spread validation

> **Status: RESEARCH_ONLY · PAPER_ONLY. No deployment, no activation, no broker orders, no strategy modification.**

> The exact 79 exported TradingView trades were replayed against OANDA Practice M1 bid/ask. No new signal cohort was generated; no rule was added, removed, or tuned.

## Verdict: SURVIVES_COSTS

Classification **STRONG**. EXEC expectancy **0.1864R/trade**, PF **1.431**, WR **51.90%**, total **14.7264R** over 79 matched trades.

## 1. Cohort matching

- TradingView entries: **79**
- Matched OANDA entries: **79**
- Unmatched: **0**
All 79 authoritative trades matched executable OANDA data (no silent omissions).

## 2. Timezone / DST resolution

- Every entry resolves to **11:00 UTC**: **79/79**.
- America/New_York wall-clock inputs (06:00 during EST, 07:00 during EDT) both map to 11:00 UTC. Audited samples:

| segment | trade | TV entry (NY) | resolved UTC |
|---|---|---|---|
| begin | 1 | 2023-01-19 06:00 | 2023-01-19T11:00:00.000Z |
| middle | 40 | 2024-12-10 06:00 | 2024-12-10T11:00:00.000Z |
| end | 79 | 2026-08-20 07:00 | 2026-08-20T11:00:00.000Z |
| EST(winter,06:00NY) | 1 | 2023-01-19 06:00 | 2023-01-19T11:00:00.000Z |
| EDT(summer,07:00NY) | 6 | 2023-03-29 07:00 | 2023-03-29T11:00:00.000Z |
| post-Mar-DST | 6 | 2023-03-29 07:00 | 2023-03-29T11:00:00.000Z |
| pre-Nov-DST | 21 | 2023-11-06 06:00 | 2023-11-06T11:00:00.000Z |

## 3. TradingView parity (verified, not forced)

1. Exact LONG entries: **79** — all `GBPJPY_1100_LONG`.
2. Entries at 11:00 UTC: **79/79**.
3. EMA20 reconstructed on OANDA H1 midpoint; entry-price agreement (mid close vs TV close) max diff **0.050 pips**, median **0.000 pips**.
4. EMA50 reconstructed on OANDA H1 midpoint (available on all 79/79).
5. Vote parity on OANDA mid — voteTrend (EMA20>EMA50): **79/79**; votePrice (close>EMA20): **79/79**; voteSlope (EMA20>EMA20[3]): **79/79**; voteMomentum (close>close[3]): **79/79**.
6. Consensus >= +3 on OANDA mid: **79/79** (mean consensus 4.00).
7. close > high[1]: **79/79**.
8. close > max(high[1],high[2],high[3]) (prev3High): **79/79**.
9. ATR14 parity: reconstructed ATR14 vs ATR implied by clean TP/SL exits — max diff **0.576 pips** over 46 checkable trades.
10. Stop/target geometry: TP/SL move magnitude / ATR clusters at ~1R and ~2R (mean TP 1.979R, mean SL 0.991R).
11. 3-H1 hold: max CSV duration **3 bars**; all durations ≤ 3: **yes**.

No parity discrepancies beyond expected mid-vs-TV feed rounding.

## 4. TradingView PF reconstruction — currency-weighted vs R-normalized

The exported CSV uses fixed quantity (1 unit) and reports PnL in JPY. Two PFs are therefore legitimately different:

- **Currency-weighted TradingView PF** (direct from CSV Net PnL JPY): **1.681** (gross profit 14.560 JPY / gross loss 8.659 JPY; net 5.901 JPY). Matches the exported ~1.68.
- **R-normalized TradingView/MID PF** (each trade normalized by its own frozen ATR14 R): **1.833**, expectancy **0.3111R/trade**. Matches the Phase-4 diagnostic ~1.837 / +0.315R.

These are not contradictory: currency PnL weights every trade by its JPY move (large-ATR trades count more), while R-normalization equalizes risk across trades. Trade-level win/loss signs and geometry agree, so the divergence is purely the ATR-weighting effect, not a parity failure.

## 5. Overall results

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 79 | 79 |
| Wins | 44 | 41 |
| Losses | 35 | 38 |
| Win rate | 55.70% | 51.90% |
| Profit factor | 1.833 | 1.431 |
| Total R | 24.5799R | 14.7264R |
| Expectancy R/trade | 0.3111R | 0.1864R |
| Average winner R | 1.2292R | 1.1918R |
| Average loser R | -0.8430R | -0.8983R |
| Max drawdown R | 4.7827R | 5.7953R |

Reconstructed R-normalized MID/TV expectancy from the authoritative cohort is **0.3111R/trade** (MID PF 1.833). The Pine header cites PF 1.837 / +0.315R/trade.

## 6. Year stability — EXEC

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 24 | 12 | 12 | 50.00% | 1.401 | 4.4908R | 0.1871R | 3.3743R |
| 2024 | 18 | 9 | 9 | 50.00% | 1.193 | 1.7165R | 0.0954R | 3.8406R |
| 2025 | 23 | 10 | 13 | 43.48% | 1.084 | 0.9778R | 0.0425R | 4.0704R |
| 2026 | 14 | 10 | 4 | 71.43% | 4.099 | 7.5412R | 0.5387R | 1.2210R |

**A. All years with trades remain positive.** (4/4 year-buckets with trades are positive). No year filter is applied.

## 7. Exit analysis

EXEC exit counts — TP: **17**, SL: **30**, TIME_EXIT: **32**. TradingView cohort: TP_OR_SL **46**, TIME_EXIT **33** (Phase-4 diagnostic decomposition ≈ TP 18 / SL 28 / TIME 33).

| Exit | Count | Avg MID R | Avg EXEC R | Total MID R | Total EXEC R | Exec drag R |
|---|---:|---:|---:|---:|---:|---:|
| TARGET_2R | 17 | 1.9794 | 1.9391 | 33.6497 | 32.9655 | 0.6842 |
| ORIGINAL_STOP | 30 | -0.8910 | -1.0549 | -26.7313 | -31.6471 | 4.9158 |
| TIME_EXIT | 32 | 0.5519 | 0.4190 | 17.6616 | 13.4080 | 4.2536 |

Are the time exits unusually cost-sensitive? **yes — time exits carry above-average per-trade drag** (time-exit per-trade drag 0.1329R vs TP/SL per-trade drag 0.1191R).

## 8. Spread analysis (GBPJPY pip = 0.01)

- Entry spread pips — avg **3.0557**, median **3.1000**, max **3.8000**
- Exit spread pips — avg **3.3608**, median **3.0000**, max **14.5000**
- Execution drag R — avg **0.1247**, median **0.0732**, max **2.2037**, total **9.8536R**
- MID expectancy **0.3111R** − EXEC expectancy **0.1864R** = **0.1247R/trade** cost.

## 9. Outcome changes

- TV WIN → EXEC LOSS: **3**
- TV WIN → smaller EXEC WIN: **41**
- TV LOSS → larger EXEC LOSS: **35**
- TV LOSS → EXEC WIN: **0**
- TV TP → EXEC TIME_EXIT: **1**
- TV TP → EXEC SL: **0**
- TV TIME → EXEC WIN: **23**
- TV TIME → EXEC LOSS: **10**
- Any exit reason changed: **3**
- Total R impact of changed-outcome trades (EXEC − MID over those trades): **-3.4985R**

## 10. Same-minute TP/SL

- AMBIGUOUS_INTRAMINUTE trades (one M1 candle touched both stop and target): **0**.
- Primary results use conservative chronology (stop-first). Optimistic bound (target-first on the ambiguous minutes): EXEC expectancy **0.1864R/trade**, PF **1.431**, total **14.7264R**.


## 11. Breakout-strength metadata (diagnostic only — NOT a filter)

break_distance = close − prev3High; break_distance_R = break_distance / ATR14.

| break_distance_R | N | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| 0 to <0.10R | 20 | 70.00% | 2.958 | 0.5304R |
| 0.10 to <0.25R | 11 | 45.45% | 1.729 | 0.3076R |
| 0.25 to <0.50R | 24 | 45.83% | 1.162 | 0.0790R |
| >=0.50R | 24 | 45.83% | 0.906 | -0.0484R |

## 12. Consensus-score metadata (diagnostic only — >= +3 rule unchanged)

| Consensus | N | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| +3 | 0 | 0.00% | ∞ | 0.0000R |
| +4 | 79 | 51.90% | 1.431 | 0.1864R |

## Decision

1. **Does GBPJPY V1 survive executable OANDA costs?** Yes. (SURVIVES_COSTS)
2. Exact EXEC expectancy: **0.1864R/trade**.
3. Exact EXEC PF: **1.431**.
4. Exact EXEC win rate: **51.90%**.
5. Total EXEC R: **14.7264R**.
6. Matched / unmatched: **79 / 0**.
7. Year stability: 4/4 positive year-buckets — A. All years with trades remain positive.
8. Average spread drag: **0.1247R/trade** (total 9.8536R).
9. Do time exits materially hurt? yes — time exits carry above-average per-trade drag.
10. Does the pre-cost ~+0.315R Phase-4 edge survive executable pricing? Reconstructed MID edge is 0.3111R; after spread it is 0.1864R — the edge largely survives.
11. Should this exact V1 become the frozen GBPJPY research/paper candidate? **Yes — it clears the ≥+0.10R executable bar (subject to the small-sample and single-instrument caveats).**

---

Method: OANDA Practice H1 midpoint ATR14/EMA20/EMA50 frozen at the 11:00 UTC close; original stop = mid entry − 1·ATR14, target = mid entry + 2·ATR14; executable LONG entry at the 11:00 ASK close; M1 bid replayed chronologically 12:00–14:59 UTC (3 future H1 bars); target/stop tested against BID; stop-first within an ambiguous minute (optimistic bound reported separately); time exit at the 14:00 H1 BID close; every result normalized by the original frozen R. Executable-side pricing already embeds spread — spread is never subtracted twice.
