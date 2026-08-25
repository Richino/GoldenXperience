# Legacy strategy revival + TP/SL grid study

Generated: 2026-08-25. RESEARCH ONLY. No production behavior changed.

## Background

- Live paper engine has produced 109 closed+resolved trades across paper batches
  1-8 (batches 1-4 pre-four-family/legacy; 5 ema; 6 breakout; 7 momentum;
  8 meanrev). Result: **−12.92R / −$12,496**, 31.2% winrate.
- User asked whether the pre-four-family legacy strategy (visible in the
  recorded `conditions` field of batch 1 trades) was worth reviving, and
  whether the current engine's problem is take-profit distance, stop-loss
  distance, direction logic, or a combination.

## What was run

Scripts (all under `api-server/scripts/`, all read-only):

- `_check_batches_1_6.ts` — DB inspector confirming batch composition.
- `_inspect_trade_counts.ts` — reconciles 109 vs 75 vs 111 trade counts.
- `_batch1_detail.ts` — full 14-trade tape and gate list from batch 1.
- `_invert_batches_1_6.ts`, `_invert_all_batches.ts` — actual-trade inversion
  using the production `labelOutcome` resolver.
- `_backtest_legacy_batch1.ts` — replicates the batch-1 legacy EMA-pullback
  recipe (10 gates from `conditions`) on 4 years of OANDA M15 bid/ask data
  across the 6 pairs batch 1 actually traded. 1.5R target, 10-bar swing stop,
  16:45 ET forced close, 48h horizon. 421 trades produced.
- `_backtest_legacy_batch1_2R.ts` — same signals, 2.0R target instead of 1.5R.
- `_backtest_legacy_tp_sl_grid.ts` — 49-combo TP/SL grid (TP ∈ {0.5..2.0R},
  SL ∈ {0.5..2.0R}) on the 421 legacy backtest entries. Chronological IS/OOS
  split (70/30). Ambiguous same-M15-bar TP+SL touches flagged, not counted as
  wins. Cost model: entry-bar spread pips / original stop pips, charged in R.
- `_backtest_live109_tp_sl_grid.ts` — identical 49-combo grid on the 111
  closed+resolved live paper trades (sample grew from 109 as 2 batch-7 trades
  closed during the study).

## Key findings

### 1) Inverting momentum (batch 7) is the strongest single signal

| Family | Live n | Original R | Inverted R | Δ |
|---|---:|---:|---:|---:|
| ema (b5) | 16 | +0.32 | −0.22 | −0.54 |
| breakout (b6) | 30 | −1.67 | −6.83 | −5.16 |
| momentum (b7) | 33 | **−5.98** | **+1.38** | **+7.36** |
| legacy-null (b1-4) | 29 | −5.44 | −7.65 | −2.21 |

Uniform inversion of all 109 makes things slightly worse (−1.39R). Only momentum
inverts cleanly; ema / breakout / legacy each had a better original direction
than the flip.

### 2) The legacy batch-1 strategy backtested over 4 years is a small net loser

421 trades × 6 pairs at 1.5R target:

- Winrate 42.0%, avg |R| 1.06, total R **−9.93**, PF 0.95.
- Break-even winrate is 43.3% at observed avg-win (1.11R) and avg-loss (−0.85R).
  Gap: −1.3 pp. The 4:45 PM forced close cuts wins from 1.5R to 1.11R avg;
  that gap is the entire deficit.
- Going to 2.0R target makes it WORSE (−23.08R, PF 0.90) — target hits drop
  from 25% → 17%, forced closes rise 31% → 37%.
- Only USD_JPY is positive individually (+8.21R over 82 trades, PF 1.22).

### 3) 49-combo TP/SL grid on the 421 legacy trades — no combo saves it

- Full-sample: **zero configs net positive**, best cell TP 1.5 / SL 1.0 at
  −0.088R/trade, PF 0.974.
- IS (295 trades): only 5 configs cross PF 1.0, all with near-zero expectancy.
- OOS (126 trades) validation: **every top-5 IS config collapses**. Top IS
  combo (TP 2.0 / SL 0.75) goes from IS −0.040R to **OOS −0.286R**, PF
  1.075 → 0.608. Textbook overfitting.
- Per-pair dispersion is huge; only USD_JPY holds up.

### 4) 49-combo TP/SL grid on the 111 live trades — even worse

- Best cell TP 2.0 / SL 1.5: netExp **−0.266R/trade**, PF **0.832**, total −29.5R.
- Max PF across all 49 combos: **0.83** (vs 0.97 in the legacy 4-year grid).
- Best combo is **4.6 pp short of break-even** (legacy grid was ~0.2-1.4 pp
  short at its best cells).
- Avg MFE +1.01R vs Avg MAE **−1.14R** — trades take MORE heat against them
  than for them on average. Direction is worse-than-random on this sample.
- Only the **ema family (16 trades) is genuinely positive**: TP 2.0 / SL 1.25
  → 62.5% winrate → **+2.79R total, +0.174R/trade**. Everything else loses at
  its own best TP/SL.

### 5) Direct answer to the diagnostic question

**The problem is direction logic, not take-profit or stop-loss distance.**

- Full 421-legacy grid: 0 / 49 combos net positive.
- Full 111-live grid: 0 / 49 combos net positive.
- 111-live MAE > MFE on average (direction signal picks losing side more often
  than winning side).
- IS "winners" don't survive OOS.

No re-parameterization of TP/SL can fix a direction signal that only pushes
trades to +1R average favorable heat while taking −1.14R average adverse heat.

## Recommendations (research findings, not production actions)

1. **Do not revive the legacy batch-1 strategy as-is.** 4-year backtest shows
   slight-negative expectancy; no TP/SL tuning rescues it; OOS collapses.
2. **Do not roll out any single "fixed" TP/SL across the four-family engine.**
   No such combination exists in the 49-combo grid on live data.
3. **Freeze momentum family or paper-test an inverted-momentum variant.** The
   inversion turned −5.98R into +1.38R over 33 trades — corroborated by both
   the earlier momentum-actual-inversion study and this TP/SL grid finding
   that momentum's direction is picking the wrong side.
4. **Isolate and keep the ema family (batch 5)** — only family that's genuinely
   positive at its own best TP/SL config. Collect 30-50 more trades before
   trusting it as a production signal.
5. **If keeping the legacy recipe alive at all**, filter to USD_JPY only —
   the only pair with a real edge in either the 4-year historical or 3-week
   live samples.

## Reproduction

From `api-server/`:

```powershell
npx.cmd tsx scripts/_backtest_legacy_batch1.ts
npx.cmd tsx scripts/_backtest_legacy_batch1_2R.ts
npx.cmd tsx scripts/_backtest_legacy_tp_sl_grid.ts
npx.cmd tsx scripts/_backtest_live109_tp_sl_grid.ts
```

Outputs (regenerable):

- Root: `actual-inversion-all-batches.json`, `actual-inversion-batches-1-6.json`.
- Root: `backtest-legacy-batch1/trades.json`, `backtest-legacy-batch1-2R/trades.json`.
- Root: `backtest-legacy-tp-sl-grid/{grid_full,grid_is,grid_oos}.json`.
- Root: `backtest-live109-tp-sl-grid/grid_live109.json`.
- OANDA M15 bid/ask caches under each dir's `candles/` are gitignored
  (regenerable, hundreds of MB).

## Caveats

- Legacy backtest recipe is inferred from batch 1's recorded `conditions`
  field, not from the pre-versioning source (which isn't in git). Trade rate
  is 7× lower than live batch 1 produced — real recipe was likely looser.
  Direction of the finding is robust; exact magnitudes are conservative.
- Live 111 sample is 3 weeks of one paper engine version. Too small to make
  final production calls; strong enough to redirect research.
- Grid ambiguity counts stayed small (≤4 per combo). M15 same-bar TP+SL
  touches were flagged and excluded from aggregates, per instructions.
- No lower-timeframe (M5/M1) fallback was implemented since ambiguous counts
  were negligible. Would add ~1000 API calls if a future rerun needs it.
