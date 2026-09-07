# USDCAD research decision — FINAL

**Status tags:** `USDCAD_V3_FROZEN` · `FROZEN_RESEARCH_CANDIDATE` · `SURVIVES_COSTS` · `STRONG`

Date: 2026-09-06

## Decision

- **FREEZE:** **GX USDCAD Structure EMA Reclaim V3 — 11:00 LONG Only — 1 to 2 RR**
- **REJECT:** prior four-leg **USDCAD Structure EMA Reclaim V2 Selected Origins**

V3 is the frozen USDCAD research candidate. It is **not** deployed, **not** added to the live pair-strategy execution path, and **not** authorized for broker orders.

## Frozen candidate contract

Do not modify these entry rules.

- Name: GX USDCAD Structure EMA Reclaim V3 11:00 LONG Only 1 to 2 RR
- Pair: USDCAD (`USD_CAD`)
- Timeframe: H1
- Direction: LONG only
- Origin: completed 11:00 UTC H1 candle
- Structure: current high > previous high AND current low > previous low
- EMA20 reclaim: previous close <= previous EMA20 AND current close > current EMA20
- Entry: 11:00 UTC completed candle close
- Stop: 1 frozen ATR14
- Target: 2 frozen ATR14
- Max hold: 3 future H1 bars
- PEN_EXTREME: metadata only — not an entry filter
- No shorts
- No trailing stop
- No break-even
- No profit lock
- No partial exits

Do not restore 09:00 LONG, 10:00 SHORT, or 11:00 SHORT.

## Validation result

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 53 | 53 |
| Wins | 28 | 26 |
| Losses | 25 | 27 |
| Win rate | 52.83% | 49.06% |
| Profit factor | 1.989 | **1.424** |
| Total R | +23.37R | **+12.10R** |
| Expectancy R/trade | +0.441R | **+0.228R** |
| Max drawdown R | 5.48R | **6.71R** |
| Classification | — | **STRONG** |
| Verdict | — | **SURVIVES_COSTS** |

Matched 53 / 53. Unmatched 0.

## Comparison

| Book | Trades | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|
| V2 four-leg | 181 | 1.016 | +0.010R |
| V2 isolated 11:00 LONG | 49 | 1.397 | +0.214R |
| V3 11:00 LONG-only | 53 | **1.424** | **+0.228R** |

The four restored V3 trades (blocked in V2 by earlier 09:00 / 10:00 positions) added **+1.63R** and **+0.407R/trade**. V3 is superior to the prior USDCAD variants.

## Year stability warning

Preserve this warning. It does **not** invalidate V3. It **does** mean V3 should remain frozen rather than further optimized on the same sample.

| Year | EXEC expectancy |
|---|---:|
| 2023 | +0.482R/trade |
| 2024 | +0.399R/trade |
| 2025 | +0.063R/trade |
| 2026 | +0.016R/trade |

Every tested year remains non-negative, but recent expectancy has weakened materially.

## Live / research registry

`PAIR_STRATEGY_REGISTRY` in `frontend/src/lib/strategy/strategies/index.ts` is the live pair-strategy registry. USDCAD was not present before this decision and is **not** added here. Adding it would be a deployment path.

Research status is recorded in `REGISTRY.json` in this directory:

```
USDCAD
version = V3
status = FROZEN_RESEARCH_CANDIDATE
validation = SURVIVES_COSTS
exec_expectancy_r = 0.228
exec_pf = 1.424
exec_trades = 53
```

## Active-strategy audit (read-only; no DB writes)

| | Before | After |
|---|---|---|
| USDCAD live pair strategy | none (not in `PAIR_STRATEGY_REGISTRY`, not in `ENABLED_PAIR_STRATEGY_IDS`) | none — unchanged |
| USDCAD research book | V2 four-leg (181 trades, EXEC +0.010R) plus isolated 11:00 LONG subset (49 trades, EXEC +0.214R) | **V3 11:00 LONG-only frozen candidate** (53 trades, EXEC +0.228R) |

No `usdcad-strategy.ts`. No USDCAD migration. No change to `evaluateEnabledPairStrategies()`.

## Confirmations

- `USDCAD_V3_FROZEN`
- `USDCAD_V2_REJECTED`
- `NO_RULE_OPTIMIZATION`
- `NO_DEPLOYMENT`
- `NO_BROKER_ORDERS`

No new hours. PEN_EXTREME remains metadata. No changes to EURUSD, GBPUSD, AUDUSD, USDJPY, USDCHF, NZDUSD, or any other pair.

## Preserved artifacts (do not delete)

- `REPORT.md`
- `TRADES.csv`
- `RAW_RESULTS.json`
- `TRADINGVIEW_SOURCE.csv`
- `PINE_SOURCE.pine`
- `REGISTRY.json`
- `data/USD_CAD-H1-MBA.json`
- `data/USD_CAD-M1-TV53-MBA.json`
