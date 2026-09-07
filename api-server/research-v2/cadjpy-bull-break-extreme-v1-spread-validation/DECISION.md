# CADJPY research decision — FINAL

**Status tags:** `CADJPY_V1_FROZEN` · `FROZEN_RESEARCH_CANDIDATE` · `SURVIVES_COSTS` · `STRONG`

Date: 2026-09-06

## Decision

- **FREEZE:** **GX CADJPY Bull Break Extreme V1 — 1 to 2 RR**

CADJPY V1 is the frozen CADJPY research candidate. It is **not** deployed, **not** added to the live pair-strategy execution path, and **not** authorized for broker orders. No rule was optimized. No year filter was created. No metadata observation was turned into a filter. No exit convention was changed.

## Frozen candidate contract

Do not modify these rules.

- Name: GX CADJPY Bull Break Extreme V1 - 1 to 2 RR
- Pair: CADJPY (`CAD_JPY`)
- Timeframe: H1
- Direction: LONG only
- Origin: completed 12:00 UTC H1 candle
- Direction gate: 4-vote consensus **>= +3**
  - Vote 1: EMA20 > EMA50 (+1) / EMA20 < EMA50 (-1)
  - Vote 2: close > EMA20 (+1) / close < EMA20 (-1)
  - Vote 3: EMA20 > EMA20[3] (+1) / EMA20 < EMA20[3] (-1)
  - Vote 4: close > close[3] (+1) / close < close[3] (-1)
- Breakout: close > high[1]
- Body + extreme: close > open **AND** abs(close - open) >= 0.50 * ATR14 **AND** close >= high - 0.25 * (high - low)
- No other filters (no Phase-4 07-11 range break)
- Entry: 12:00 UTC completed candle close
- Stop: 1 frozen ATR14
- Target: 2 frozen ATR14
- Max hold: 3 future H1 bars
- No trailing stop, no profit lock, no break-even, no runner, no partial exits

## Authoritative validation result

| Metric | TV benchmark (84) | MID matched (83) | OANDA EXEC (83) |
|---|---:|---:|---:|
| Trades | 84 | 83 | 83 |
| Wins | 46 | 45 | **45** |
| Losses | 38 | 38 | **38** |
| Win rate | 54.76% | 54.22% | **54.22%** |
| Profit factor | 1.722 | 1.668 | **1.342** |
| Total R | +26.3972R | +24.4171R | **+13.5898R** |
| Expectancy R/trade | +0.3143R | +0.2942R | **+0.1637R** |
| Average winner R | +1.3688R | +1.3552R | **+1.1861R** |
| Average loser R | -0.9623R | -0.9623R | **-1.0469R** |
| Max drawdown R | 5.2482R | 5.2482R | **5.8078R** |
| Classification | — | — | **STRONG** |
| Verdict | — | — | **SURVIVES_COSTS** |

Matched **83 / 84**. Unmatched **1**. Ambiguous-intraminute **0**. Average spread drag **0.1304R/trade** (total **10.8272R**).

The full 84-trade frozen-R TradingView benchmark (+0.3143R / PF 1.722) matches the cited PF 1.729 / +0.319R. Currency-weighted CSV PF is 1.762.

Parity (verified, not forced): all 84 entries resolve to 12:00 UTC; all four votes, consensus >= +3, close > high[1], bullish body, and body >= 0.50·ATR14 each hold 84/84 on OANDA mid; TP/SL geometry means 1.981R / 0.994R; max entry-price diff 0.25 pips; max ATR14 diff 0.395 pips.

## Unmatched trade (do not fabricate or replace)

- **Trade 31** — TV entry `2024-05-20 08:00` → `2024-05-20T12:00:00.000Z`.
- Reason: **97-minute OANDA M1 data gap** (`M1_GAP_2024-05-20T14:23:00.000Z_97_MINUTES`) during the hold window.
- It was a TP_OR_SL winner on TradingView (+1.98R); excluding it from EXEC (and from the matched-MID column) keeps the cost comparison apples-to-apples. The trade is **not** removed from the authoritative TradingView cohort and **not** reconstructed from fabricated prices.

## Parity note

On reconstructed OANDA midpoint, "close in upper 25%" passed on **83/84** authoritative signals — a feed-rounding boundary discrepancy on a single signal. The TradingView cohort remains authoritative. **Do not remove or regenerate the trade.**

## Year stability

Preserve this warning. It does **not** invalidate V1. It **does** mean V1 stays frozen rather than re-optimized on the same sample. **Do not create a year filter.**

| Year | Trades | WR | PF | Total R | Expectancy |
|---|---:|---:|---:|---:|---:|
| 2023 | 18 | 61.11% | 1.460 | +3.4621R | +0.1923R |
| 2024 | 32 | 53.13% | 1.259 | +4.0709R | +0.1272R |
| 2025 | 16 | 62.50% | 1.825 | +5.2262R | +0.3266R |
| 2026 | 17 | 41.18% | 1.081 | +0.8307R | +0.0489R |

4 of 4 yearly buckets positive; **2026 is currently the weakest** (PF 1.081, WR 41.18%). Monitoring metadata only.

## Exit finding

Executable exits: TP **18**, SL **36**, TIME **29**.

Time-exit drag per trade ≈ **0.2288R** vs TP/SL drag per trade ≈ **0.0776R**. Time exits are more cost-sensitive (4 TV TP winners degraded to TIME exits under BID pricing). This is a same-sample diagnostic. **Do not modify the frozen 3-H1 hold** based on it.

## Consensus metadata — preserve only (do NOT change the rule)

Matched cohort: consensus **+3 = 0 trades**, **+4 = 83 trades**. The `>= +3` gate never bound in this cohort. **KEEP consensus >= +3. Do NOT change to +4.** The +4 observation is historical metadata only.

## Other metadata — preserve only (NOT filters)

Same-sample diagnostics. Do **not** turn any into a threshold, a filter, a V2, or an optimization run. Do **not** introduce: break-distance thresholds, new body thresholds, top-15% close filter, top-10% close filter, 07-11 range break, 3-bar break, 0.10 ATR break. The frozen strategy stays exactly as validated.

## Active-strategy audit (read-only; no DB writes, no code changes)

| | Before | After |
|---|---|---|
| CADJPY live pair strategy | none (absent from `PAIR_STRATEGY_REGISTRY`, absent from `ENABLED_PAIR_STRATEGY_IDS`) | none — unchanged |
| CADJPY research book | none | **V1 Bull Break Extreme frozen candidate** (84 TV / 83 EXEC, EXEC +0.1637R) |

`PAIR_STRATEGY_REGISTRY` / `ENABLED_PAIR_STRATEGY_IDS` in `frontend/src/lib/strategy/strategies/index.ts` remain unchanged (enabled = GBPUSD, USDJPY, AUDUSD, NZDUSD). No `cadjpy-strategy.ts`. No CADJPY migration. No change to the execution path.

## Live / research registry

Research status is recorded in `REGISTRY.json` in this directory:

```
CADJPY
version = V1
status = FROZEN_RESEARCH_CANDIDATE
classification = STRONG
validation = SURVIVES_COSTS
direction = LONG
origin_utc = 12:00
tv_trades = 84
exec_matched = 83
exec_unmatched = 1
exec_win_rate = 54.22
exec_pf = 1.342
exec_expectancy_r = 0.1637
exec_total_r = 13.5898
max_drawdown_r = 5.8078
average_execution_drag_r = 0.1304
```

## Confirmations

- `CADJPY_V1_FROZEN`
- `STRONG`
- `SURVIVES_COSTS`
- `83_OF_84_EXECUTABLE`
- `1_OANDA_DATA_GAP`
- `CONSENSUS_REMAINS_GTE_3`
- `NO_METADATA_FILTERS`
- `NO_EXIT_CHANGE`
- `NO_DEPLOYMENT`
- `NO_BROKER_ORDERS`

No changes to EURUSD, GBPUSD, AUDUSD, USDJPY, USDCHF, USDCAD, NZDUSD, EURGBP, AUDJPY, EURJPY, GBPJPY, or any other pair.

## Preserved artifacts (do not delete, do not overwrite the authoritative source files)

- `REPORT.md`
- `TRADES.csv`
- `RAW_RESULTS.json`
- `TRADINGVIEW_SOURCE.csv`
- `PINE_SOURCE.pine`
- `YEAR_STABILITY.csv`
- `EXIT_ANALYSIS.csv`
- `SPREAD_ANALYSIS.csv`
- `CONSENSUS_METADATA.csv`
- `BODY_STRENGTH_METADATA.csv`
- `CLOSE_EXTREME_METADATA.csv`
- `BREAK_DISTANCE_METADATA.csv`
- `REGISTRY.json`
- `DECISION.md`
- `data/CAD_JPY-H1-MBA.json`
- `data/CAD_JPY-M1-MBA.json`
