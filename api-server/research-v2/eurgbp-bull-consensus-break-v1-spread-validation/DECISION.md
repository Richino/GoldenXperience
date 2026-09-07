# EURGBP research decision — FINAL

**Status tags:** `EURGBP_V1_REJECTED` · `RESEARCH_ONLY` · `FAILS_COSTS` · `NO_EDGE` · `REJECTED`

Date: 2026-09-06 (finalized)

## Decision

- **DO NOT FREEZE:** **GX EURGBP Bull Consensus Structure Break V1 — 1 to 2 RR**

V1 is **not** a frozen research candidate. It is **not** deployed, **not** added to the live pair-strategy execution path, and **not** authorized for broker orders. It **failed** exact OANDA bid/ask spread validation on the authoritative 80-trade TradingView cohort: the diagnostic MID edge (+0.2224R/trade) does not survive the spread and collapses to **+0.0249R/trade** — classification **NO EDGE**, verdict **FAILS_COSTS**.

The strategy was **not** modified, scanned, or optimized. This is a frozen-cohort executable replay of the exact 80 TradingView trades.

## Validation result

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | 80 | 80 |
| Wins / Losses | 38 / 42 | 33 / 47 |
| Win rate | 47.50% | **41.25%** |
| Profit factor | 1.435 | **1.042** |
| Expectancy R/trade | +0.2224R | **+0.0249R** |
| Total R | +17.80R | **+2.00R** |
| Max drawdown R | 6.72R | **9.38R** |
| Classification | — | **NO EDGE** |
| Verdict | — | **FAILS_COSTS** |

Matched **80 / 80**. Unmatched 0. No gaps. Spread drag: **0.1975R/trade**, **15.80R** total — the drag (0.1975R) is ~8× the surviving edge (0.0249R) and nearly the entire MID expectancy. Max drawdown grows from 6.72R (MID) to 9.38R (EXEC).

## TradingView parity — all checks passed (nothing dropped)

The MID replay reproduces the authoritative TradingView headline almost exactly, which is what makes the EXEC collapse trustworthy:

1. 80 exact `EURGBP_0600_LONG` entries. ✓
2. Every entry LONG. ✓
3. Every entry resolves to 06:00 UTC (America/New_York, DST-aware: 01:00 NY EST / 02:00 NY EDT). ✓
4. EMA20/EMA50 parity — OANDA mid close = TV entry price to within a fraction of a pip. ✓
5. Four-vote consensus `>= +3` — 80/80 reproduce a firing consensus (0 failures). ✓
6. HH + HL structure — 80/80 reproduce `high>high[1] AND low>low[1]` (0 failures). ✓
7. Breakthrough `close > max(high[1],high[2],high[3])` — 80/80 reproduce (0 failures). ✓
8. Frozen ATR14 reproduces the 1R/2R geometry (stops ~1.0 ATR, targets ~2.0 ATR). ✓

MID reproduction: 38 wins / 42 losses / 47.50% WR / PF 1.435 vs TradingView headline 38 / 42 / 47.50% / PF 1.448. The ~0.013 PF gap is feed-rounding only.

## Why it fails

The MID book is a real but thin +0.2224R edge. The EURGBP OANDA spread averages **1.49 pips at entry** and **1.37 pips at exit**, and 1R is a single ATR14 (typically 15–30 pips), so each round trip costs ~0.20R. That drag is the entire edge:

- **WIN → smaller WIN: 32**, **WIN → LOSS: 5**, **WIN → TIME EXIT: 17**
- **LOSS → larger LOSS: 42**, **LOSS → WIN: 0**
- TP missed because executable BID never reached target: 4
- Executable win rate falls 47.50% → 41.25%

Every trade is worse after spread; not a single loser becomes a winner.

## Year stability — the edge is 2025-only

| Year | Trades | EXEC expectancy | Note |
|---|---:|---:|---|
| 2023 | 20 | **−0.2655R** | PF 0.61 — clearly negative |
| 2024 | 22 | **−0.0838R** | PF 0.88 — negative |
| 2025 | 23 | +0.3682R | PF 1.78 — carries the whole book |
| 2026 | 15 | +0.0454R | PF 1.08 — barely positive, small sample |

Positive in **2 of 4** years, and the entire positive total R comes from 2025. This answers the year-stability question directly: **the executable edge does NOT survive across multiple years — it is negative in the earlier sample (2023–2024) and depends on 2025.** Option **C** (negative in the earlier sample) with dependence on the recent window.

## Consensus & breakthrough breakdowns (measurement only — no filter change)

- **Consensus:** all 80 signals scored **+4**; the +3 subgroup is empty. +3 vs +4 is not comparable on this cohort. Rule preserved at `>= +3`.
- **Break strength:** the strongest-breakthrough bucket (≥0.25 ATR, 55 trades — the bulk of the book) is **negative after costs (−0.0425R, PF 0.93)**, while the weakest bucket (<0.10 ATR, 11 trades) holds the positive expectancy (+0.3939R). A genuine breakout edge would strengthen with break distance; this inverts, which is the signature of **noise, not a breakout edge**. This is a diagnostic observation only — **not** turned into a filter (that would be a new frozen test).

## Live / research registry

`PAIR_STRATEGY_REGISTRY` in `frontend/src/lib/strategy/strategies/index.ts` is the live pair-strategy path. EURGBP is **not** present there and is **not** added by this decision. `ENABLED_PAIR_STRATEGY_IDS` is unchanged. No `eurgbp-strategy.ts`, no EURGBP migration, no change to `evaluateEnabledPairStrategies()` or the paper-cycle execution path.

Research status recorded in `REGISTRY.json` in this directory:

```
pair = EURGBP
version = V1
status = REJECTED_RESEARCH_CANDIDATE
validation = FAILS_COSTS
exec_expectancy_r = 0.0249
exec_pf = 1.042
exec_win_rate = 41.25
exec_trades = 80
max_drawdown_r = 9.3783
```

## Confirmations

- `EURGBP_V1_REJECTED`
- `RESEARCH_ONLY`
- `FAILS_COSTS`
- `NO_EDGE`
- `REJECTED`
- `NO_DEPLOYMENT`
- `NO_BROKER_ORDERS`
- `NO_FURTHER_SAME_SAMPLE_OPTIMIZATION`
- `NO_RULE_OPTIMIZATION`

No rules changed. Consensus preserved at `>= +3`; **no new EURGBP variant is to be optimized from this 80-trade sample** — neither a +4-only filter (the whole cohort is already +4) nor a break-strength filter (the ≥0.25 ATR inversion is noise, not signal). Any future EURGBP test must use a fresh, independent sample.

EURGBP is **not** added to any frozen/approved/live strategy registry. The following validated strategies are untouched by this decision: **EURUSD, GBPUSD, AUDUSD, USDJPY, USDCAD, USDCHF** (and NZDUSD). `ENABLED_PAIR_STRATEGY_IDS` in `frontend/src/lib/strategy/strategies/index.ts` remains `[GBPUSD, USDJPY, AUDUSD, NZDUSD]`, verified unchanged. No `eurgbp-strategy.ts`, no EURGBP migration.

## Preserved artifacts (do not delete or rewrite)

- `REPORT.md`
- `TRADES.csv`
- `RAW_RESULTS.json`
- `TRADINGVIEW_SOURCE.csv`
- `PINE_SOURCE.pine`
- `REGISTRY.json`
- `DECISION.md`
- `GAP_AUDIT.json`
- `data/EUR_GBP-H1-MBA.json`
- `data/EUR_GBP-M1-MBA.json`
