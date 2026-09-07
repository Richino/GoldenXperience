# EURJPY research decision — FINAL

**Status tags:** `EURJPY_V1_FROZEN` · `FROZEN_RESEARCH_CANDIDATE` · `SURVIVES_COSTS` · `STRONG`

Date: 2026-09-06

## Decision

- **FREEZE:** **GX EURJPY 01-05 Range Break V1 — 1 to 2 RR**

EURJPY V1 is the frozen EURJPY research candidate. It is **not** deployed, **not** added to the live pair-strategy execution path, and **not** authorized for broker orders. No rule was optimized. No year filter was created. No metadata observation was turned into a filter.

## Frozen candidate contract

Do not modify these rules.

- Name: GX EURJPY 01-05 Range Break V1 - 1 to 2 RR
- Pair: EURJPY (`EUR_JPY`)
- Timeframe: H1
- Direction: LONG only
- Origin: completed 06:00 UTC H1 candle
- Direction gate: EMA20 current > EMA20[3]
- Breakout: close > previous H1 high **AND** close > max high of completed 01:00–05:00 UTC candles (preHigh)
- No other filters
- Entry: 06:00 UTC completed candle close
- Stop: 1 frozen ATR14
- Target: 2 frozen ATR14
- Max hold: 3 future H1 bars
- No trailing stop, no profit lock, no break-even, no runner, no partial exits

## Authoritative validation result

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 136 | 136 |
| Wins | 74 | 68 |
| Losses | 62 | 68 |
| Win rate | 54.41% | 50.00% |
| Profit factor | 1.733 | **1.375** |
| Total R | +40.2145R | **+23.1520R** |
| Expectancy R/trade | +0.2957R | **+0.1702R** |
| Average winner R | +1.2852R | **+1.2482R** |
| Average loser R | -0.8853R | **-0.9077R** |
| Max drawdown R | 6.19R | **7.5154R** |
| Classification | — | **STRONG** |
| Verdict | — | **SURVIVES_COSTS** |

Matched **136 / 136**. Unmatched **0**. Ambiguous-intraminute **0**. Average spread drag **0.1255R/trade** (total **17.0625R**).

Parity (verified, not forced): all 136 entries resolve to 06:00 UTC; EMA20>EMA20[3], close>high[1], and close>preHigh each hold 136/136 on OANDA mid; TP/SL geometry means 1.985R / 0.995R; max entry-price diff 0.30 pips.

## Year stability

Preserve this warning. It does **not** invalidate V1. It **does** mean V1 stays frozen rather than re-optimized on the same sample. **Do not create a year filter.**

| Year | Trades | Expectancy | PF | Total R |
|---|---:|---:|---:|---:|
| 2023 | 45 | +0.3834R | 1.947 | +17.2527R |
| 2024 | 34 | +0.0930R | 1.194 | +3.1614R |
| 2025 | 34 | +0.1028R | 1.232 | +3.4956R |
| 2026 | 23 | -0.0329R | 0.938 | -0.7577R |

3 of 4 years positive; recent performance has weakened.

## Exit finding

Executable exits: TP **27**, SL **55**, TIME **54**.

Time-exit drag per trade ≈ **0.1245R** vs TP/SL drag per trade ≈ **0.1261R**. Time exits are **NOT** unusually responsible for execution drag. **Do not modify max hold** based on this result.

## Metadata — preserve only (NOT filters)

Same-sample diagnostics. Do **not** turn either into a threshold, a filter, a V2, or an optimization run.

- Break-distance: strong subgroups at 0.10–<0.25R and 0.25–<0.50R; negative subgroup at ≥0.50R.
- EMA-slope: strongest results in the lowest slope quartile.

## Active-strategy audit (read-only; no DB writes, no code changes)

| | Before | After |
|---|---|---|
| EURJPY live pair strategy | none (absent from `PAIR_STRATEGY_REGISTRY`, absent from `ENABLED_PAIR_STRATEGY_IDS`) | none — unchanged |
| EURJPY research book | none | **V1 01-05 Range Break frozen candidate** (136 trades, EXEC +0.1702R) |

`PAIR_STRATEGY_REGISTRY` / `ENABLED_PAIR_STRATEGY_IDS` in `frontend/src/lib/strategy/strategies/index.ts` remain unchanged (enabled = GBPUSD, USDJPY, AUDUSD, NZDUSD). No `eurjpy-strategy.ts`. No EURJPY migration. No change to the execution path. EUR_JPY appears in that codebase only in pip-size / spread constant maps, which were not touched.

## Live / research registry

Research status is recorded in `REGISTRY.json` in this directory:

```
EURJPY
version = V1
status = FROZEN_RESEARCH_CANDIDATE
classification = STRONG
validation = SURVIVES_COSTS
direction = LONG
origin_utc = 06:00
exec_trades = 136
exec_win_rate = 50.00
exec_pf = 1.375
exec_expectancy_r = 0.1702
exec_total_r = 23.1520
average_execution_drag_r = 0.1255
unmatched_trades = 0
```

## Confirmations

- `EURJPY_V1_FROZEN`
- `STRONG`
- `SURVIVES_COSTS`
- `136_OF_136_MATCHED`
- `NO_RULE_OPTIMIZATION`
- `NO_YEAR_FILTER`
- `NO_METADATA_FILTER`
- `NO_DEPLOYMENT`
- `NO_BROKER_ORDERS`

No changes to EURUSD, GBPUSD, AUDUSD, USDJPY, USDCHF, USDCAD, NZDUSD, EURGBP, AUDJPY, or any other pair.

## Preserved artifacts (do not delete, do not overwrite the authoritative source files)

- `REPORT.md`
- `TRADES.csv`
- `RAW_RESULTS.json`
- `TRADINGVIEW_SOURCE.csv`
- `PINE_SOURCE.pine`
- `YEAR_STABILITY.csv`
- `EXIT_ANALYSIS.csv`
- `SPREAD_ANALYSIS.csv`
- `REGISTRY.json`
- `DECISION.md`
- `data/EUR_JPY-H1-MBA.json`
- `data/EUR_JPY-M1-MBA.json`
