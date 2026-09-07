# EURJPY 01-05 Range Break V1 — exact TradingView cohort vs OANDA executable spread validation

> **Status: RESEARCH_ONLY · PAPER_ONLY. No deployment, no activation, no broker orders, no strategy modification.**

> The exact 136 exported TradingView trades were replayed against OANDA Practice M1 bid/ask. No new signal cohort was generated; no rule was added, removed, or tuned.

## Verdict: SURVIVES_COSTS

Classification **STRONG**. EXEC expectancy **0.1702R/trade**, PF **1.375**, WR **50.00%**, total **23.1520R** over 136 matched trades.

## 1. Cohort matching

- TradingView entries: **136**
- Matched OANDA entries: **136**
- Unmatched: **0**
All 136 authoritative trades matched executable OANDA data (no silent omissions).

## 2. Timezone / DST resolution

- Every entry resolves to **06:00 UTC**: **136/136**.
- America/New_York wall-clock inputs (01:00 during EST, 02:00 during EDT) both map to 06:00 UTC. Audited samples:

| segment | trade | TV entry (NY) | resolved UTC |
|---|---|---|---|
| begin | 1 | 2023-01-23 01:00 | 2023-01-23T06:00:00.000Z |
| middle | 69 | 2024-08-21 02:00 | 2024-08-21T06:00:00.000Z |
| end | 136 | 2026-08-24 02:00 | 2026-08-24T06:00:00.000Z |
| EST(Jan) | 1 | 2023-01-23 01:00 | 2023-01-23T06:00:00.000Z |
| EDT(Jun) | 17 | 2023-06-01 02:00 | 2023-06-01T06:00:00.000Z |
| DST-Mar2023 | 7 | 2023-03-13 02:00 | 2023-03-13T06:00:00.000Z |
| DST-Nov2023 | 40 | 2023-11-13 01:00 | 2023-11-13T06:00:00.000Z |

## 3. TradingView parity (verified, not forced)

1. Exact LONG entries: **136** — all `EURJPY_0600_LONG`.
2. Entries at 06:00 UTC: **136/136**.
3. EMA20 reconstructed on OANDA H1 midpoint; entry-price agreement (mid close vs TV close) max diff **0.300 pips**, median **0.050 pips**.
4. EMA20 > EMA20[3] on entry: **136/136**.
5. close > high[1]: **136/136**.
6. 01:00–05:00 preHigh reconstructed from completed H1 highs (all 136/136 available).
7. close > preHigh: **136/136**.
8. ATR14 parity: reconstructed ATR14 vs ATR implied by clean TP/SL exits — max diff **0.235 pips** over 82 checkable trades.
9. Stop/target geometry: TP/SL move magnitude / ATR clusters at ~1R and ~2R (mean TP 1.985R, mean SL 0.995R).
10. 3-H1 hold: max CSV duration **3 bars**; all durations ≤ 3: **yes**.

No parity discrepancies beyond expected mid-vs-TV feed rounding.

## 4. Overall results

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 136 | 136 |
| Wins | 74 | 68 |
| Losses | 62 | 68 |
| Win rate | 54.41% | 50.00% |
| Profit factor | 1.733 | 1.375 |
| Total R | 40.2145R | 23.1520R |
| Expectancy R/trade | 0.2957R | 0.1702R |
| Average winner R | 1.2852R | 1.2482R |
| Average loser R | -0.8853R | -0.9077R |
| Max drawdown R | 6.1907R | 7.5154R |

Reconstructed R-normalized MID/TV expectancy from the authoritative cohort is **0.2957R/trade** (MID PF 1.733). The Pine header cites +0.299R / PF 1.737; the exported strategy header cites PF ≈ 1.780.

## 5. Year stability — EXEC

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 45 | 25 | 20 | 55.56% | 1.947 | 17.2527R | 0.3834R | 2.7631R |
| 2024 | 34 | 16 | 18 | 47.06% | 1.194 | 3.1614R | 0.0930R | 6.8568R |
| 2025 | 34 | 17 | 17 | 50.00% | 1.232 | 3.4956R | 0.1028R | 5.8866R |
| 2026 | 23 | 10 | 13 | 43.48% | 0.938 | -0.7577R | -0.0329R | 7.5154R |

**C/D. Recent years weaken / results are inconsistent across years.** (3/4 year-buckets with trades are positive). No year filter is applied.

## 6. Exit analysis

EXEC exit counts — TP: **27**, SL: **55**, TIME_EXIT: **54**. TradingView cohort: TP_OR_SL **82**, TIME_EXIT **54**.

| Exit | Count | Avg MID R | Avg EXEC R | Total MID R | Total EXEC R | Exec drag R |
|---|---:|---:|---:|---:|---:|---:|
| TARGET_2R | 27 | 1.9857 | 1.9379 | 53.6146 | 52.3228 | 1.2918 |
| ORIGINAL_STOP | 55 | -0.8981 | -1.0626 | -49.3972 | -58.4448 | 9.0476 |
| TIME_EXIT | 54 | 0.6666 | 0.5421 | 35.9971 | 29.2740 | 6.7231 |

Are the time exits unusually cost-sensitive? **no — time-exit drag is in line with TP/SL exits** (time-exit per-trade drag 0.1245R vs TP/SL per-trade drag 0.1261R).

## 7. Spread analysis (EURJPY pip = 0.01)

- Entry spread pips — avg **2.3279**, median **2.3000**, max **3.6000**
- Exit spread pips — avg **2.3368**, median **2.3000**, max **4.4000**
- Execution drag R — avg **0.1255**, median **0.0690**, max **3.0987**, total **17.0625R**
- MID expectancy **0.2957R** − EXEC expectancy **0.1702R** = **0.1255R/trade** cost.

## 8. Outcome changes

- TV WIN → EXEC LOSS: **6**
- TV WIN → smaller EXEC WIN: **68**
- TV LOSS → larger EXEC LOSS: **62**
- TV LOSS → EXEC WIN: **0**
- TV TP → EXEC TIME_EXIT: **1**
- TV TP → EXEC SL: **1**
- TV TIME → EXEC WIN: **40**
- TV TIME → EXEC LOSS: **14**
- Any exit reason changed: **3**
- Total R impact of changed-outcome trades (EXEC − MID over those trades): **-6.5154R**

## 9. Same-minute TP/SL

- AMBIGUOUS_INTRAMINUTE trades (one M1 candle touched both stop and target): **0**.
- Primary results use conservative chronology (stop-first). Optimistic bound (target-first on the ambiguous minutes): EXEC expectancy **0.1702R/trade**, PF **1.375**, total **23.1520R**.


## 10. Range-break metadata (diagnostic only — NOT a filter)

| break_distance_R | N | EXEC WR | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|---:|
| 0 to <0.10R | 18 | 50.00% | 1.302 | 0.1325R |
| 0.10 to <0.25R | 25 | 68.00% | 2.767 | 0.5294R |
| 0.25 to <0.50R | 41 | 58.54% | 1.922 | 0.3771R |
| >=0.50R | 52 | 34.62% | 0.732 | -0.1525R |

## 11. EMA-slope metadata (diagnostic only — NOT a filter)

| Quartile (ema_slope_R) | range | N | EXEC WR | EXEC PF | EXEC expectancy |
|---|---|---:|---:|---:|---:|
| Q1 | 0.004..0.164 | 34 | 67.65% | 3.193 | 0.6380R |
| Q2 | 0.170..0.292 | 34 | 44.12% | 1.169 | 0.0799R |
| Q3 | 0.297..0.474 | 34 | 47.06% | 0.927 | -0.0377R |
| Q4 | 0.479..1.049 | 34 | 41.18% | 1.001 | 0.0008R |

## Decision

1. **Does EURJPY V1 survive executable OANDA costs?** Yes. (SURVIVES_COSTS)
2. Exact EXEC expectancy: **0.1702R/trade**.
3. Exact EXEC PF: **1.375**.
4. Exact EXEC win rate: **50.00%**.
5. Total EXEC R: **23.1520R**.
6. Matched / unmatched: **136 / 0**.
7. Year stability: 3/4 positive year-buckets — C/D. Recent years weaken / results are inconsistent across years.
8. Average spread drag: **0.1255R/trade** (total 17.0625R).
9. Do time exits materially hurt? no — time-exit drag is in line with TP/SL exits.
10. Does the +0.299R Phase-4 edge survive executable pricing? Reconstructed MID edge is 0.2957R; after spread it is 0.1702R — the edge largely survives.
11. Should this exact V1 become the frozen EURJPY research candidate? **Yes — it clears the ≥+0.10R executable bar (subject to the small-sample and single-instrument caveats).**

---

Method: OANDA Practice H1 midpoint ATR14/EMA20 frozen at the 06:00 UTC close; original stop = mid entry − 1·ATR14, target = mid entry + 2·ATR14; executable LONG entry at the 06:00 ASK close; M1 bid replayed chronologically 07:00–09:59 UTC (3 future H1 bars); target/stop tested against BID; stop-first within an ambiguous minute (optimistic bound reported separately); time exit at the 09:00 H1 BID close; every result normalized by the original frozen R. Executable-side pricing already embeds spread — spread is never subtracted twice.
