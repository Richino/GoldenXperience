# USDCHF research decision — FINAL

**Status tags:** `USDCHF_V1_FROZEN` · `FROZEN_RESEARCH_CANDIDATE` · `SURVIVES_COSTS` · `STRONG`

Date: 2026-09-06

## Decision

- **FREEZE:** **GX USDCHF Bear Consensus Structure V1 — 1 to 2 RR**

V1 is the frozen USDCHF research candidate. It is **not** deployed, **not** added to the live pair-strategy execution path, and **not** authorized for broker orders. It passed exact OANDA bid/ask spread validation on the authoritative 103-trade TradingView cohort.

## Frozen candidate contract

Do not modify these entry rules. No Phase-4 breakthrough filter. Consensus stays `<= -3` (do **not** change to `-4`).

- Name: GX USDCHF Bear Consensus Structure V1 1 to 2 RR
- Pair: USDCHF (`USD_CHF`)
- Timeframe: H1
- Direction: SHORT only
- Origin: completed 11:00 UTC H1 candle
- Trend gate — four causal votes, SHORT requires **consensus `<= -3`**:
  1. EMA20 vs EMA50
  2. close vs EMA20
  3. EMA20 slope vs EMA20[3]
  4. close vs close[3]
- Structure: current high < previous high AND current low < previous low (LH + LL)
- Entry: 11:00 UTC completed candle close
- Stop: 1 frozen ATR14
- Target: 2 frozen ATR14
- Max hold: 3 future H1 bars
- No additional breakout filter
- No trailing stop
- No break-even
- No profit lock
- No partial exits

**Consensus observation (do not act on it):** all 103 actual signals scored consensus `= -4`. The rule is preserved at `<= -3`. Turning it into a `-4`-only filter would be a new frozen test, not this one.

## Validation result

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 103 | 103 |
| Win rate | 49.51% | 45.63% |
| Profit factor | 1.908 | **1.523** |
| Expectancy R/trade | +0.4024R | **+0.2664R** |
| Total R | +41.45R | **+27.44R** |
| Max drawdown R | 7.02R | **7.96R** |
| Classification | — | **STRONG** |
| Verdict | — | **SURVIVES_COSTS** |

Matched 103 / 103. Unmatched 0. Spread drag: **0.136R/trade**, **14.01R** total. All seven TradingView-parity checks passed (entries, SHORT, 11:00 UTC resolution, EMA/geometry, consensus `<= -3`, LH+LL, frozen-ATR geometry); nothing dropped.

## Comparison to the frozen USDCAD candidate

| Book | Trades | EXEC PF | EXEC expectancy |
|---|---:|---:|---:|
| USDCAD V3 11:00 LONG-only (frozen) | 53 | 1.424 | +0.228R |
| **USDCHF V1 11:00 SHORT-only (frozen)** | 103 | **1.523** | **+0.2664R** |

USDCHF V1 clears OANDA spread by a wider per-trade margin than the already-frozen USDCAD V3, on roughly double the sample.

## Year stability (preserve — do not optimize on this sample)

| Year | EXEC expectancy | Note |
|---|---:|---|
| 2023 | +0.033R/trade | nearly flat (PF 1.05) |
| 2024 | +0.274R/trade | |
| 2025 | +0.254R/trade | |
| 2026 | +0.881R/trade | small sample — 12 trades only |

All tested calendar years are positive, but 2023 is nearly flat and 2026 is a small sample. This does **not** invalidate V1; it **does** mean V1 stays frozen rather than further tuned on the same data. The live forward edge may sit below the +0.2664R full-sample figure — size accordingly.

## Live / research registry

`PAIR_STRATEGY_REGISTRY` in `frontend/src/lib/strategy/strategies/index.ts` is the live pair-strategy path. USDCHF is **not** present there and is **not** added by this decision — adding it would be a deployment path. `ENABLED_PAIR_STRATEGY_IDS` remains `[GBPUSD, USDJPY, AUDUSD, NZDUSD]`, unchanged.

Research status is recorded in `REGISTRY.json` in this directory:

```
pair = USDCHF
version = V1
status = FROZEN_RESEARCH_CANDIDATE
validation = SURVIVES_COSTS
exec_expectancy_r = 0.2664
exec_pf = 1.523
exec_win_rate = 45.63
exec_trades = 103
max_drawdown_r = 7.96
```

## Active-strategy audit (read-only; no DB writes)

| | Before | After |
|---|---|---|
| USDCHF live pair strategy | none (not in `PAIR_STRATEGY_REGISTRY`, not in `ENABLED_PAIR_STRATEGY_IDS`, no `usdchf-strategy.ts`, no USDCHF migration) | none — unchanged |
| USDCHF research book | Bear Consensus Structure V1 diagnostic cohort (103 TradingView trades, MID +0.4024R), pending executable validation | **V1 frozen research candidate** — SURVIVES_COSTS, EXEC +0.2664R (103/103 matched) |

No `usdchf-strategy.ts`. No USDCHF migration. No change to `evaluateEnabledPairStrategies()` or the paper-cycle execution path.

## Confirmations

- `USDCHF_V1_FROZEN`
- `SURVIVES_COSTS`
- `STRONG`
- `NO_RULE_OPTIMIZATION`
- `NO_DEPLOYMENT`
- `NO_BROKER_ORDERS`

No Phase-4 filter added. Consensus rule preserved at `<= -3`. No changes to EURUSD, GBPUSD, AUDUSD, USDJPY, USDCAD, EURGBP, NZDUSD, or any other pair.

## Preserved artifacts (do not delete or rewrite)

- `REPORT.md`
- `TRADES.csv`
- `RAW_RESULTS.json`
- `TRADINGVIEW_SOURCE.csv`
- `PINE_SOURCE.pine`
- `REGISTRY.json`
- `DECISION.md`
- `GAP_AUDIT.json`
- `data/USD_CHF-H1-MBA.json`
- `data/USD_CHF-M1-MBA.json`
