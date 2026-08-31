# EUR/USD Neural Day Engine V5 — Experiment Log

Research-only. Isolated from V19 (frozen swing/news engine) and from V2/V3/V4.
Purpose: a news-aware intraday EUR/USD engine that learns **direction** and
**whether to trade at all (WAIT)**, judged on an untouched final test period and
walk-forward — never on training performance.

## Design decisions (predeclared before seeing test/walk-forward)

- **Data**: EUR/USD M15 bid/ask candles (`backtest-legacy-expanded/candles/EUR_USD_M15.json`).
  News: the two Forex Factory high-impact sets (Aug-2024..Jul-2026), USD+EUR events.
- **Window**: the 2-year news window 2024-08-01 .. 2026-08-01. Candidates built from
  2024-06 (warmup buffer) so news features are always populated.
- **Chronological split (no random, no lookahead)**:
  - TRAIN     2024-08-01 .. 2025-05-01 (9m) — fit heads
  - VALIDATION 2025-05-01 .. 2025-11-01 (6m) — pick architecture, geometry, thresholds
  - TEST      2025-11-01 .. 2026-08-01 (9m) — **touched once**, final judgment
- **Walk-forward**: expanding past-only window, retrain every 2 months, min 6m train,
  frozen selected config, spanning the whole 2 years. Shows survival across regimes.
- **Model**: two heads (reused deterministic MLP): a pairwise DIRECTION head (which
  executable side has higher realized R) and a QUALITY head (will the chosen side be
  profitable after costs). WAIT when quality rank < calibrated threshold or direction
  confidence < min. Coverage is a past-calibrated quantile, never a trade quota.
- **Features**: price/momentum/vol/trend/session/time/spread/regime/multi-lag (reused
  V1 rawFeatures, 41) + NEWS: polarity-adjusted signed post-release surprise toward
  EUR/USD (directional, decayed by recency), minutes-since / minutes-to-next release
  (schedule is known a priori — not lookahead), post-news-window flag, surprise magnitude.
  Surprise value is only used from releases strictly BEFORE the entry candle.
- **Execution**: historical bid/ask, 0.1 pip entry+exit slippage, same-candle target+stop
  ambiguity charged to the stop, 180-minute max hold, ±60-min high-impact news blackout,
  max 3 trades/day, one open position. **No mirror math** — long and short outcomes are
  independent executable bid/ask simulations.
- **Geometry is tested, not assumed**: stop ∈ {1.0, 1.25, 1.5} ATR × reward:risk ∈
  {1.5, 2.0, 2.5}, selected on VALIDATION only.
- **Selection objective (validation only)**: among arms with enough trades and PF>1,
  maximize robust expectancy (exp − 0.5·SE). Never select on test; never target a win rate.

## Log

| # | Date | Change | Result (test / walk-forward) | Verdict |
|---|------|--------|------------------------------|---------|
| 1 | 2026-08-31 | Initial V5 build (news-aware, WAIT, geometry sweep, walk-forward) | TEST +0.091R/PF1.19 (CI crosses 0); WALK-FWD −0.081R/PF0.85 over 666 trades, 6/9 folds negative | **NO_ROBUST_EDGE** |

## Diagnosis of experiment #1 (before changing anything)

Attribution on the 666-trade walk-forward set (`DIAGNOSIS.json`, `diagnose.ts`), plus a
model-independent test of the news premise. Frozen selection: mlp-16, stop 1.5 ATR,
reward:risk 2.5, coverage 20%, no min direction confidence.

- **COSTS are the dominant cause.** Gross (mid-price) expectancy is **+0.066R/trade**
  (gross PF 1.13) — a real but tiny edge. Average execution cost is **0.147R/trade**
  (spread + 0.1-pip slippage). Cost is ~2.2× the gross edge, so net = **−0.081R**. The
  chosen geometry (widest stop) is already the least cost-sensitive of the nine; every
  geometry is net-negative (−0.081 to −0.142R). Geometry is not the lever.
- **Direction: weak but real.** Model picks the better executable side 53.2% of the time;
  chosen-side net −0.081R vs opposite-side net −0.223R (+0.14R better than anti-model).
  Not the main problem, but far too weak to clear costs.
- **News premise: real but tiny.** Model-independent: the signed news feature points to
  the better executable side only **52.5%** of the time (n=1052). Trading the news-implied
  direction (−0.094R) beats trading against it (−0.186R), confirming a faint directional
  signal — consistent with prior research — but nowhere near enough to beat 0.147R costs
  at this cadence. On the untouched TEST the news subset was actually negative (−0.012R).
- **Opportunity selection (WAIT/quality): not working.** Net expectancy by rankScore
  quartile is −0.124 / −0.077 / −0.053 / −0.071 — no useful monotonic separation, so the
  quality head does not concentrate an edge and WAIT gating cannot rescue it.
- **Entry timing:** 44% of losers never reached +0.25R; 17% are ≤30-min stops. This is a
  symptom of weak direction, not an independent fixable leak.

**Conclusion:** the gross price+news signal is genuinely (barely) positive, but the engine
trades intraday at ~1.7/day where the spread (~0.15R) dwarfs the ~0.066R gross edge. The
failure is structural (cost vs cadence), not a bug or a tuning miss. Do NOT iterate by
adding gates/geometry/model tweaks — the diagnosis says the fix is fewer, higher-conviction
trades whose expected move >> spread (the V19/V20 news-event lane), or a materially stronger
gross signal that price + this news data does not provide.

| 2 | 2026-08-31 | V5-SWING: wide stops (3/5/8 ATR) + 2-day hold to cut cost/R (`experiment-swing.ts`, research-v2/eurusd-neural-day-v5-swing) | Cost 0.147R→0.028R BUT gross exp +0.066R→−0.024R; TEST −0.053R/PF0.90, WALK-FWD −0.052R/PF0.90 | **NO_ROBUST_EDGE** |

## Diagnosis of experiment #2 (swing)

The cost hypothesis was correct: 5-ATR stops cut execution cost from 0.147R to 0.028R/trade
(spread neutralized), and frequency fell to 0.50/day. But the directional edge did not
survive the longer horizon — gross expectancy went NEGATIVE (−0.024R, gross PF 0.951) before
costs. Direction ~coin-flip (51.6%) and the news signal dropped below 50% (44.2%) at 2-day
horizon. Confirms the intraday +0.066R gross was short-horizon microstructure, not a durable
edge. Matches `eurusdbot3-1` (standalone swing engine, NO_EDGE, gross breakeven).

### Do-not-retry (falsified here)
- High-frequency (~1–2/day) intraday EUR/USD with price+news features and a WAIT head:
  gross edge too small vs spread. No geometry in {1.0,1.25,1.5}ATR × {1.5,2,2.5}RR fixes it.
- Signed FF-surprise as an intraday direction feature: only 52.5% directional; too weak alone.
- **Swing horizon (wide stops 3/5/8 ATR, 2-day hold) with the same signal: cost drops as
  expected but gross edge goes negative — swinging does NOT rescue it. Direction and news
  both degrade to <=52% / <50% at multi-day horizon.**
