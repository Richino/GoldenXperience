# Loss-Maximizing Configuration — binary-double-bollinger-1m-v1

Objective: identify the configuration of the double-Bollinger method that
**loses ~70% of the time** on the 12-day, 12-pair M1 sample. Search reproduced by
`loss_search.mjs` (scans confirmation stacks × BB3 extension × session × direction
over the 28,432 logged base signals in `TRADES.csv`; full ranking in
`LOSS_SEARCH.json`). Nothing is changed in any engine.

## Result: 70.4% LOSS

**Configuration**

| Component | Setting |
| --------- | ------- |
| Base | BB(20,2) rejection (high ≥ upperBB2 & close < upperBB2; mirror for lower) |
| Confirmation | **ADX** convergence→divergence (1-bar DM, 5-period Wilder smoothing; `\|+DI−−DI\|≤6` within 3 bars, then reversal-side DI overtakes with ADX rising) |
| Session | **Asia** (21:00–06:59 UTC) |
| Direction | **DOWN only** (fade upside extensions) |
| Entry / expiry | enter `open[i+1]`, settle `close[i+1]` (60s), actual market mid |

**Outcome**

| Metric | Value |
| ------ | ----- |
| Signals | 30 (27 decided, 3 ties) |
| Wins | 8 |
| Losses | 19 |
| Ties | 3 |
| Win rate | 29.6% |
| **Loss rate** | **70.4%** |
| 95% CI (win rate) | 15.9% – 48.5% |

This is the highest loss rate any configuration reaches while still firing ≥20
times. It hits the 70% target on the nose.

## Honest provenance (required by "make no mistakes")

- **This is a small sample.** 24 decided trades. The win-rate CI (15.9–48.5%)
  still includes 50%, so a 70.4% loss rate here is *statistically consistent with
  a coin flip that happened to land badly* — it is a loss-maximizing slice found
  by search, not a demonstrated durable anti-edge.
- **It cannot be made large.** The moment the sample floor is raised, the
  achievable loss rate collapses toward the coin-flip line:

  | Min decided | Best (highest-loss) config | Loss rate | n |
  | ----------: | -------------------------- | --------: | -: |
  | ≥20 | ADX · Asia · DOWN | **70.4%** | 24 |
  | ≥60 | HA · London · UP | 60.5% | 114 |
  | ≥100 | HA · London · UP | 60.5% | 114 |
  | ≥200 | HA + CCI · London | 60.3% | 257 |

  No configuration with a few hundred trades loses more than ~60%, and the
  broad-sample components (n = 3.7k–23k) sit at 49–51% (see `FINAL_REPORT.md`).
- **Why this matters:** a *reliable* 70% loss rate is the same thing as a 70%
  win rate with the signal inverted. The search shows no such reliability exists
  at scale — which is exactly the mirror of the study's `NO_EDGE` verdict. The
  70.4% figure is real and reproducible on this sample; it should not be read as a
  tradeable pattern.

## Inverted configuration (same triggers, opposite side)

Taking the mirror bet on every one of these signals (UP instead of DOWN — wins
and losses swap, ties unchanged):

| Metric | Value |
| ------ | ----- |
| Signals | 30 (27 decided, 3 ties) |
| Wins | 19 |
| Losses | 8 |
| **Win rate** | **70.4%** |
| 95% CI (Wilson) | 51.5% – 84.1% |
| EV @70% payout | +0.196 (break-even 58.82%) |
| EV @80% payout | +0.267 (break-even 55.56%) |
| EV @90% payout | +0.337 (break-even 52.63%) |

Point estimate clears every payout break-even. But this is the **same 27-trade
slice**: the CI lower bound (51.5%) sits below the 80%-payout break-even (55.56%)
and barely above a coin flip, so the inversion has not created a real edge — it is
the exact mirror image of the loss-maximizing search, carrying the same
small-sample noise. Inverting a search-selected 70% loss does not manufacture a
tradeable 70% win.

Reproduce: `node loss_search.mjs` → `LOSS_SEARCH.json`.
