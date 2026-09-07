# USDCHF Bear Consensus Structure V1 — authoritative TradingView 103-trade OANDA executable spread replay

> **Decision status: `USDCHF_V1_FROZEN` · `FROZEN_RESEARCH_CANDIDATE` · `SURVIVES_COSTS` · `STRONG`.**
> See `DECISION.md` and `REGISTRY.json`. Entry rules are frozen (consensus `<= -3`, no Phase-4 filter). No deployment. No broker orders.

> **Research/paper only. No deployment. No broker orders. No strategy modification.**
> The strategy was **not** scanned, optimized, or altered. This is a frozen-cohort executable replay of the exact 103 TradingView trades.

## Verdict: SURVIVES_COSTS

Execution classification: **STRONG**. Exact OANDA executable net expectancy for the 103 matched trades is **0.2664R/trade**. EXEC profit factor is **1.523**. EXEC win rate is **45.63%**.

## Matching

- TradingView trades: **103**
- Matched: **103**
- Unmatched: **0**

None. All 103 TradingView trades had a complete OANDA H1 signal bar and M1 (or future-#3 H1) execution window.

CSV composition: 103 `USDCHF_1100_SHORT` entries; 82 TP_OR_SL exits, 21 TIME_EXIT exits — reproduced exactly. TradingView money result is 51 wins / 52 losses (49.51% WR), headline PF 1.763.

## TradingView parity (pre-replay verification)

1. **103 exact entries** — parsed from the authoritative CSV. ✓
2. **Every entry is SHORT** — all 103 are `Exit short` / `Entry short` with signal `USDCHF_1100_SHORT`. ✓
3. **Every entry resolves to 11:00 UTC** — America/New_York wall time, DST-aware: 06:00 NY in EST and 07:00 NY in EDT both map to 11:00 UTC. Verified at the first (2023-01-17, EST), DST-transition, and last (2026-09-03, EDT) samples; all 103 resolve to 11:00 UTC. ✓
4. **EMA20 / EMA50 parity** — OANDA mid close at the 11:00-open bar equals the TradingView entry price to within **0.10 pips** (max), confirming TradingView's feed is OANDA and the EMA inputs match. ✓
5. **Four-vote consensus ≤ −3** — recomputed on OANDA H1 mid: **103/103** reproduce a firing consensus. Parity failures: **0**. ✓
6. **LH + LL structure** — recomputed on OANDA H1 mid: **103/103** reproduce `high<high[1] AND low<low[1]`. Parity failures: **0**. ✓
7. **Frozen ATR14 reproduces TradingView stop/target geometry** — for the 82 TP_OR_SL trades, |TV exit − TV entry| in OANDA-frozen-ATR units clusters at **min 0.980 / median 1.000 / max 1.997**: stops at ~1.0 ATR, targets at ~2.0 ATR. ✓

No parity failures. All 103 trades were replayed (nothing dropped).

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 103 | 103 |
| Wins | 51 | 47 |
| Losses | 52 | 56 |
| Win rate | 49.51% | 45.63% |
| Profit factor | 1.908 | 1.523 |
| Total R | 41.4504R | 27.4426R |
| Expectancy R/trade | 0.4024R | 0.2664R |
| Average winner R | 1.7083R | 1.7002R |
| Average loser R | -0.8784R | -0.9369R |
| Max drawdown R | 7.0207R | 7.9599R |

## Year stability (EXEC)

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy R/trade |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 31 | 12 | 19 | 38.71% | 1.053 | 1.0230R | 0.0330R |
| 2024 | 30 | 13 | 17 | 43.33% | 1.509 | 8.2127R | 0.2738R |
| 2025 | 30 | 14 | 16 | 46.67% | 1.563 | 7.6325R | 0.2544R |
| 2026 | 12 | 8 | 4 | 66.67% | 4.160 | 10.5745R | 0.8812R |

Positive EXEC expectancy in **4 of 4** active calendar years.

## Consensus-strength breakdown (measurement only — NOT a filter)

Consensus score recomputed on OANDA H1 mid. Distribution: consensus −3 → **0** trades; consensus −4 → **103** trades; other → **0**.

| Consensus | Trades | EXEC WR | EXEC PF | EXEC Expectancy R/trade |
|---|---:|---:|---:|---:|
| −3 | 0 | — | — | — |
| −4 | 103 | 45.63% | 1.523 | 0.2664R |

**Every one of the 103 firing signals scored consensus −4** on OANDA (all four votes bearish). The −3 subgroup is empty, so −3 vs −4 cannot be compared on this cohort — the entire book is −4. No filter change was made.

## Spread

- Average / median / maximum **entry** spread: 1.503 / 1.500 / 2.200 pips
- Average / median / maximum **exit** spread: 1.603 / 1.500 / 4.800 pips
- Average / median / maximum **execution drag**: 0.1360 / 0.0640 / 3.0796 R
- Total execution drag: 14.0077R
- MID expectancy 0.4024R − EXEC expectancy 0.2664R = **0.1360R difference**

## Outcome changes (MID → EXEC)

- WIN → LOSS: 3
- WIN → smaller WIN: 47
- WIN → TIME EXIT: 13
- LOSS → larger LOSS: 52
- LOSS → WIN: 0
- TP missed because executable ASK did not reach target: 2
- SL hit (exec) where TV was not a stop: 2
- Exit reason changed: 2

## Method

- Authoritative cohort: TradingView export `GX_USDCHF_Bear_Consensus_Structure_V1_-_1_to_2_RR`, 103 completed 11:00-UTC SHORT trades, 2023-01-17 → 2026-09-03.
- Geometry: 1R is OANDA H1 Wilder ATR14 frozen at the 11:00-open signal bar. Barriers mid-referenced off the signal-bar mid close: stop = mid + 1 ATR, target = mid − 2 ATR (Pine geometry).
- Entry: executable **BID** at the signal-bar close. Exits (target / stop / time exit): executable **ASK**. Spread embedded once — no second subtraction.
- M1 replay from the open of future #1 (entry + 1h = 12:00 UTC) through the close of future #3 (entry + 4h = 15:00 UTC). Same-minute stop-and-target → **stop first** (pessimistic).
- TIME_EXIT: buy-to-close on the ASK at the close of future #3 (the 14:00-open H1 bar). Max hold 3 future H1 bars.
- All prices OANDA Practice bid/ask. No midpoint used as a final executable result.

## Decision

1. **Does USDCHF V1 survive OANDA spread?** — **YES** (SURVIVES_COSTS, STRONG).
2. **Exact EXEC expectancy:** 0.2664R/trade.
3. **Exact EXEC PF:** 1.523.
4. **Exact EXEC win rate:** 45.63%.
5. **Positive across calendar years?** — positive in 4 of 4 active years (see year table for concentration).
6. **−3 vs −4 after costs?** — not comparable: the entire 103-trade cohort is consensus −4; the −3 subgroup is empty.
7. **Frozen USDCHF candidate?** — **YES.** At 0.2664R/trade EXEC (STRONG, PF 1.523) on 103 trades, positive in every calendar year, this exact V1 clears OANDA spread by a wider margin than the already-frozen USDCAD V3 candidate (+0.2283R). Recommend freezing it as the USDCHF research candidate **as-is**. Caveat, not a reason to change anything: the edge is thin in the oldest year (2023 +0.033R, PF 1.05) and strengthens toward the present (2026 +0.88R on only 12 trades), so the forward edge may sit below the full-sample number — size accordingly. No strategy modification was made; any subgroup change (e.g. a −4-only or hour filter) would require a separate new frozen test.

_Generated 2026-09-06T04:17:10.518Z from RAW_RESULTS.json. No optimization. No deployment. No broker orders._
