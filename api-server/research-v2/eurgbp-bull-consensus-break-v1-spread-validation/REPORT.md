# EURGBP Bull Consensus Structure Break V1 — authoritative TradingView 80-trade OANDA executable spread replay

> **Research/paper only. No deployment. No broker orders. No strategy modification.**
> The strategy was **not** scanned, optimized, or altered. This is a frozen-cohort executable replay of the exact 80 TradingView trades. Entry rules are frozen: 4-vote consensus `>= +3`, HH+HL structure, close above the previous 3 completed H1 highs.

## Verdict: FAILS_COSTS

Execution classification: **NO EDGE**. Exact OANDA executable net expectancy for the 80 matched trades is **0.0249R/trade**. EXEC profit factor is **1.042**. EXEC win rate is **41.25%**.

## Matching

- TradingView trades: **80**
- Matched: **80**
- Unmatched: **0**

None. All 80 TradingView trades had a complete OANDA H1 signal bar and M1 (or future-#3 H1) execution window.

CSV composition: 80 `EURGBP_0600_LONG` entries; 66 TP_OR_SL exits, 14 TIME_EXIT exits — reproduced exactly. TradingView money result on the frozen OANDA-ATR ruler is 38 wins / 42 losses (47.50% WR), MID PF 1.435. (TradingView headline: 38 wins / 42 losses, 47.50% WR, PF 1.448.)

## TradingView parity (pre-replay verification)

1. **80 exact entries** — parsed from the authoritative CSV. ✓
2. **Every entry is LONG** — all 80 are `Entry long` / `Exit long` with signal `EURGBP_0600_LONG`. ✓
3. **Every entry resolves to 06:00 UTC** — America/New_York wall time, DST-aware: 01:00 NY in EST and 02:00 NY in EDT both map to 06:00 UTC. Verified at the first (2023-01-12, EST), DST-transition, and last (2026-09-03, EDT) samples; all 80 resolve to 06:00 UTC. ✓
4. **EMA20 / EMA50 parity** — OANDA mid close at the 06:00-open bar equals the TradingView entry price to within **0.05 pips** (max), confirming TradingView's feed is OANDA and the EMA inputs match. ✓
5. **Four-vote consensus ≥ +3** — recomputed on OANDA H1 mid: **80/80** reproduce a firing consensus. Parity failures: **0**. ✓
6. **HH + HL structure** — recomputed on OANDA H1 mid: **80/80** reproduce `high>high[1] AND low>low[1]`. Parity failures: **0**. ✓
7. **Breakthrough — close > previous 3 completed H1 highs** — recomputed on OANDA H1 mid (current 06:00 bar excluded): **80/80** reproduce `close > max(high[1],high[2],high[3])`. Parity failures: **0**. ✓
8. **Frozen ATR14 reproduces TradingView stop/target geometry** — for the 66 TP_OR_SL trades, |TV exit − TV entry| in OANDA-frozen-ATR units clusters at **min 0.943 / median 0.991 / max 1.985**: stops at ~1.0 ATR, targets at ~2.0 ATR. ✓

No parity failures. All 80 trades were replayed (nothing dropped).

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 80 | 80 |
| Wins | 38 | 33 |
| Losses | 42 | 47 |
| Win rate | 47.50% | 41.25% |
| Profit factor | 1.435 | 1.042 |
| Total R | 17.7955R | 1.9954R |
| Expectancy R/trade | 0.2224R | 0.0249R |
| Average winner R | 1.5443R | 1.5040R |
| Average loser R | -0.9736R | -1.0135R |
| Max drawdown R | 6.7214R | 9.3783R |

## Year stability (EXEC)

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy R/trade |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 20 | 5 | 15 | 25.00% | 0.609 | -5.3103R | -0.2655R |
| 2024 | 22 | 8 | 14 | 36.36% | 0.877 | -1.8441R | -0.0838R |
| 2025 | 23 | 13 | 10 | 56.52% | 1.784 | 8.4690R | 0.3682R |
| 2026 | 15 | 7 | 8 | 46.67% | 1.082 | 0.6808R | 0.0454R |

Positive EXEC expectancy in **2 of 4** active calendar years.

## Consensus-strength breakdown (measurement only — NOT a filter)

Consensus score recomputed on OANDA H1 mid. Distribution: consensus +3 → **0** trades; consensus +4 → **80** trades; other → **0**.

| Consensus | Trades | EXEC WR | EXEC PF | EXEC Expectancy R/trade |
|---|---:|---:|---:|---:|
| +3 | 0 | — | — | — |
| +4 | 80 | 41.25% | 1.042 | 0.0249R |

## Break-strength breakdown (measurement only — NOT a filter)

How far the 06:00 close exceeded `previous3High`, normalized by frozen ATR14.

| Break distance | Trades | EXEC WR | EXEC PF | EXEC Expectancy R/trade |
|---|---:|---:|---:|---:|
| 0 to <0.10 ATR | 11 | 54.55% | 1.908 | 0.3939R |
| 0.10 to <0.25 ATR | 14 | 42.86% | 1.000 | 0.0000R |
| ≥0.25 ATR | 55 | 38.18% | 0.931 | -0.0425R |

## Spread

- Average / median / maximum **entry** spread: 1.486 / 1.400 / 3.500 pips
- Average / median / maximum **exit** spread: 1.372 / 1.400 / 1.700 pips
- Average / median / maximum **execution drag**: 0.1975 / 0.1417 / 2.1420 R
- Total execution drag: 15.8002R
- MID expectancy 0.2224R − EXEC expectancy 0.0249R = **0.1975R difference**

## Outcome changes (MID → EXEC)

- WIN → LOSS: 5
- WIN → smaller WIN: 32
- WIN → TIME EXIT: 17
- LOSS → larger LOSS: 42
- LOSS → WIN: 0
- TP missed because executable BID did not reach target: 4
- SL hit (exec) where TV was not a stop: 0
- Exit reason changed: 4

## Method

- Authoritative cohort: TradingView export `GX_EURGBP_Bull_Consensus_Structure_Break_V1_-_1_to_2_RR`, 80 completed 06:00-UTC LONG trades, 2023-01-12 → 2026-09-03.
- Geometry: 1R is OANDA H1 Wilder ATR14 frozen at the 06:00-open signal bar. Barriers mid-referenced off the signal-bar mid close: stop = mid − 1 ATR, target = mid + 2 ATR (Pine geometry).
- Entry: executable **ASK** at the signal-bar close. Exits (target / stop / time exit): executable **BID**. Spread embedded once — no second subtraction.
- M1 replay from the open of future #1 (entry + 1h = 07:00 UTC) through the close of future #3 (entry + 4h = 10:00 UTC). Same-minute stop-and-target → **stop first** (pessimistic).
- TIME_EXIT: sell-to-close on the BID at the close of future #3 (the 09:00-open H1 bar). Max hold 3 future H1 bars.
- All prices OANDA Practice bid/ask. No midpoint used as a final executable result.

## Decision

1. **Does EURGBP V1 survive OANDA spread?** — **NO** (FAILS_COSTS, NO EDGE).
2. **Exact EXEC expectancy:** 0.0249R/trade.
3. **Exact EXEC PF:** 1.042.
4. **Exact EXEC win rate:** 41.25%.
5. **Positive across calendar years?** — positive in 2 of 4 active years (see year table for concentration).
6. **+3 vs +4 after costs?** — +3: none; +4: 0.0249R (80 trades, PF 1.042). Measurement only — no filter change made.
7. **Breakthrough strength after costs?** — see break-distance table. Measurement only — no filter change made.
8. **Frozen EURGBP candidate?** — NO — fails to clear OANDA spread on this cohort; do not freeze. No strategy modification was made; any subgroup change (e.g. a +4-only or break-strength filter) would require a separate new frozen test.

_Generated 2026-09-06T04:26:03.702Z from RAW_RESULTS.json. No optimization. No deployment. No broker orders._
