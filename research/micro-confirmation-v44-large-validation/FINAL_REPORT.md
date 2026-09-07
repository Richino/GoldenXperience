# Micro Confirmation V4.4 — Large-Sample Validation

```
VERDICT: NO_EDGE

M1 TRADES:      5,064  (LONDON_ONLY, full history, ~3 years)
M1 WR:          33.45%  (95% CI 32.2–34.8%)
M1 PF:          0.969  (Pine / no-cost)   →   0.059  (realistic spread)
M1 EXPECTANCY:  +0.003 R/trade (no-cost, = noise)   →   −2.04 R/trade (realistic)

M5 TRADES:      1,037  (LONDON_ONLY, full history, ~3 years)
M5 WR:          31.34%  (95% CI 28.6–34.2%)
M5 PF:          0.904  (Pine / no-cost)   →   0.318  (realistic spread)
M5 EXPECTANCY:  −0.06 R/trade (no-cost)   →   −0.92 R/trade (realistic)

LONDON VS OTHER SESSIONS:   London does NOT separate. On M1, ASIA is the best
                            session (PF 1.046) and London is PF 0.965; on M5
                            London is the "least bad" (PF 0.934) but still < 1.
                            No session has a real edge.
PROFITABLE MONTHS:          M1 22/38 (median PF 1.03, no-cost);  M5 15/37 (median PF 0.93)
PROFITABLE WALK-FWD FOLDS:  M1 2/6;  M5 2/6  (one 2024-H1 fold carries M1)
REALISTIC COST RESULT:      Strongly negative — M1 PF 0.06 (−2.04 R/trade),
                            M5 PF 0.32 (−0.92 R/trade). Dead at 1× spread.
```

> This was run as a **disproof attempt**, per instructions. No thresholds,
> sessions, lookbacks, or geometry were changed or optimized. Both timeframes
> were run separately. The strategy did not survive.

---

## Data (Phase 4)

| | M1 | M5 |
|---|---|---|
| Source | OANDA (`price=BA`, practice) | OANDA (`price=BA`, practice) |
| Range | 2023-08-28 → 2026-09-01 | 2023-08-28 → 2026-08-27 |
| Candles | 1,115,000 | 223,753 |
| Duplicates | 0 | 0 |
| Weekend gaps | 157 (expected) | 156 (expected) |
| Intraday gaps > 1 bar | 4,731 (thin off-hours minutes) | 27 |
| Bid/Ask/spread | **yes** (real per-bar spread) | **yes** |
| Avg spread | 1.65 pip (all hours) | 1.67 pip |

M1 is the canonical dataset. M5 is **native OANDA M5** (not aggregated from M1),
so no M1→M5 generation was needed and no M1 was ever generated from M5. Both
carry real bid/ask, enabling a data-driven realistic-cost model. ~3 years each,
overlapping in calendar time (so M1 and M5 are **not** independent — see Phase 11).

## Reproduction (Phase 3) — ACCEPTABLE

| | TradingView | Local | |
|---|---|---|---|
| M1 BASELINE | 180 tr / 30.6% / PF 0.76 | 180 / 27.2% / **0.735** | tight |
| M1 LONDON_ONLY | 39 tr / 41.0% / PF 1.55 | 43 / 39.5% / **1.30** | tight |
| M5 LONDON_ONLY | 28 tr / 50.0% / PF 1.54 | 28 / 35.7% / 1.12 | within CI |

The M1 port reproduces both baseline (PF ≈ 0.74) and London (WR ≈ 40%, PF > 1)
over the matching ~11-day recent window. M5's 28-trade sample has a 95% WR
interval of ~32–68%, so TradingView's 50% is the upper tail of noise. Full detail
in `REPRODUCTION_REPORT.md`. **The port is faithful; the large-sample test is trustworthy.**

## Performance (Phase 5–7) — full history, LONDON_ONLY

### A. PINE-COMPATIBLE (mid price, no commission/spread — matches a TradingView strategy with no costs configured)

| | M1 | M5 |
|---|---|---|
| Trades | 5,064 | 1,037 |
| Win rate | 33.45% (CI 32.2–34.8) | 31.34% (CI 28.6–34.2) |
| Profit factor | **0.969** | **0.904** |
| Expectancy | +0.003 R | −0.061 R |
| Total R | +15.5 | −62.8 |
| Net (price) | −0.0091 | −0.0140 |
| Avg winner / loser | +2.00 R / −1.00 R | +2.00 R / −1.00 R |
| Max drawdown | 184 R | 104 R |
| Max losing streak | 21 | 12 |
| LONG | 2,504 tr, WR 32.6%, PF 0.936, exp −0.024 R | 529 tr, PF 0.889 |
| SHORT | 2,560 tr, WR 34.3%, PF 1.002, exp +0.030 R | 508 tr, PF 0.921 |

Even with **zero costs**, M1 is PF 0.969 (net price **negative**) and M5 is PF
0.904 (losing). The M1 "+0.003 R" expectancy is a mirage: it is R-weighted, while
the price-weighted PF and net are negative — the sign flips with weighting, which
is the signature of noise, not edge. There is **no gross edge to begin with.**

### B. REALISTIC EXECUTION (real per-trade OANDA spread, round-turn)

| | M1 | M5 |
|---|---|---|
| Profit factor | **0.059** | **0.318** |
| Expectancy | −2.04 R | −0.92 R |
| Total R | −10,354 | −951 |

**Why M1 is annihilated:** the frozen geometry is stop = 0.5 × ATR. On M1 the
average ATR is 1.72 pip, so the **average stop distance is 0.86 pip** — *smaller
than the ~1.55 pip spread*. The round-turn cost is ~1.8 R **per trade**. The
strategy risks less than it pays the broker. On M5 the stop distance (2.05 pip)
at least exceeds the spread, but the raw signal already loses, so cost only
deepens the loss.

Realistic-cost assumption (stated, not hidden): each trade pays one full
entry-bar spread round-turn (buy ask / sell bid vs mid-to-mid), taken from the
actual bid/ask in the data; the canonical trade set (entry bar, exit bar, exit
reason) is fixed from the mid-price Pine emulation so signals stay identical
across cost scenarios (Phase 12 requirement). Tick-level slippage is not in the
data; the cost multipliers below bound it.

## Time stability (Phase 8) — see `MONTHLY_RESULTS.csv`, `YEARLY_RESULTS.csv`

Yearly (no-cost): M1 2023 PF 1.06, 2024 PF 1.11 (+120 R), then **2025 PF 0.87
(−108 R), 2026 PF 0.94 (−33 R)**. M5 mirrors this: 2023 PF 1.10 → 2025 PF 0.83.
Monthly: M1 22/38 months profitable, median PF 1.03; best +43 R (2024-04), worst
−49 R (2025-03). **The apparent edge was a 2023–2024 phenomenon that reversed** —
no single month "makes" it, but the whole thing oscillates around breakeven and
turned net-negative for the last ~18 months.

## Walk-forward (Phase 9) — see `WALK_FORWARD.csv`

Six chronological folds, frozen rules, no retraining. M1: **2/6 folds profitable**,
median PF 1.001. Fold 2 (2024-02→08) alone is PF 1.26 / +130 R; folds 3–5 are all
negative. M5: 2/6 folds, median PF 0.939. The strategy is **not stable** across
periods; profit is concentrated in one 2024 window.

## London hypothesis (Phase 10) — see `SESSION_COMPARISON.csv`

BASELINE signals bucketed by entry session (one consistent lock dynamic).
Sessions (NY time): ASIA 18:00–03:00, LONDON 03:00–08:00 (pinned to spec),
NEW_YORK 08:00–17:00, OTHER 17:00–18:00.

| Session | M1 PF | M5 PF |
|---|---|---|
| ASIA | **1.046** | 0.869 |
| LONDON | 0.965 | **0.934** |
| NEW_YORK | 0.944 | 0.844 |
| OTHER | 0.778 | 0.561 |

**London does not separate.** On M1, Asia is (weakly) the best and London is
below 1.0. On M5, London is the least-bad but still losing. There is no robust
London edge — the TradingView London result was the small-sample slice, not a
structural session effect.

## M1 vs M5 (Phase 11)

Neither survives. Signals are **weakly correlated**: only 377 of 5,064 M1 trades
(7.4%) have an M5 entry within 5 minutes (373 same direction) — they are largely
independent samples of the same non-edge, so they do **not** cross-confirm. M5 is
marginally *more credible only structurally* (its stop distance exceeds the
spread, so it isn't auto-dead on costs alone), but it loses even at zero cost, so
the point is moot. M1 is categorically worse: unviable on geometry-vs-spread alone.

## Cost stress (Phase 12) — see `COST_STRESS.csv`

| Cost | M1 PF | M1 total R | M5 PF | M5 total R |
|---|---|---|---|---|
| 0× (mid) | 0.969 | +15.5 | 0.904 | −62.8 |
| 1.0× | 0.059 | −10,354 | 0.318 | −951 |
| 1.25× | 0.026 | −12,947 | 0.243 | −1,174 |
| 1.5× | 0.013 | −15,539 | 0.182 | −1,396 |
| 2.0× | 0.004 | −20,724 | 0.096 | −1,840 |

There is no positive edge for cost to erode: M1 is breakeven at 0× and hopeless
at any spread; M5 is already negative at 0×. **How much deterioration destroys
the edge? None is required — the edge does not exist before costs.**

---

## Answers

1. **Did the TradingView M1 result survive?** No. Over 5,064 trades it is PF 0.969
   at zero cost and PF 0.059 realistically. The 39-trade TV sample was noise.
2. **Did the TradingView M5 result survive?** No. 1,037 trades → PF 0.904 (no-cost),
   0.318 (realistic). The 28-trade / 50% TV sample was the upper tail of a wide CI.
3. **Did London remain better than other sessions?** No. M1 Asia (PF 1.05) beats
   London (0.965); M5 London is least-bad but still < 1. No structural London edge.
4. **Positive after realistic execution costs?** No — strongly negative on both
   (M1 −2.04 R/trade, M5 −0.92 R/trade).
5. **Stable across years?** No. Profitable 2023–24, negative 2025–26 on both TFs.
6. **Stable across walk-forward periods?** No. 2/6 folds each; profit sits in one
   2024 fold.
7. **How sensitive to costs?** Fatal. M1's stop distance (0.86 pip) is *below* the
   spread (~1.55 pip); ~1.8 R/trade is paid to the broker. No edge exists pre-cost
   to erode.
8. **M1 or M5 more credible?** M5, but only marginally and academically — its
   geometry isn't auto-killed by spread. It still loses at zero cost, so neither
   is tradeable.
9. **Evidence of a real repeatable edge?** No. Base win rate ~31–33% with 2:1
   payoff sits right at the breakeven line (33.3%); results oscillate around zero
   and were net-negative for the last ~18 months.
10. **Continue developing this hypothesis?** No. Recommend stopping. The confirmation
    system is a coin-flip at the 2:1-payoff breakeven, London is not special, and
    the M1 geometry is structurally unviable against real spreads. This matches the
    project's prior EUR/USD findings (price-based intraday direction has no edge;
    the spread is the whole cost).

## Files

`RESULTS.json`, `REPRODUCTION_REPORT.md`, `TRADES_M1.csv`, `TRADES_M5.csv`,
`MONTHLY_RESULTS.csv`, `YEARLY_RESULTS.csv`, `WALK_FORWARD.csv`,
`SESSION_COMPARISON.csv`, `COST_STRESS.csv`. Engine: `engine.ts` (frozen port);
driver: `run.ts`; data fetch: `fetch_m1.ts`.
