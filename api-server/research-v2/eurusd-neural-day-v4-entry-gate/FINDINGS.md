# V4 High-Frequency Engine — Entry-Quality Gate Research

Verdict: **NO_ROBUST_IMPROVEMENT — apparent development edge did not survive one frozen out-of-sample application.**

Research-only. V4, V19, V2/V3, paper, and production are untouched. This analysis
consumes only the frozen V4 trade artifacts
(`../eurusd-neural-day-v4/TRADES.development.json` and `TRADES.historical-check.json`).
Reproduce with `node gate.mjs` and `node diag.mjs`.

## Goal

Diagnose V4's later 100-trade sample, and test — on development data only — whether a
predeclared entry-quality gate removes weak entries while preserving frequency. Then run
the frozen gate exactly once on the (semi-)unseen validation period.

## Diagnosis of the later 100-trade sample (descriptive)

100 trades = **57 STOP + 19 TIME_EXIT + 24 TARGET**.

- **57 stops (avg −0.757R):** 11 stopped within 15 min, 22 within 30 min. Roughly a third
  are fast release/entry-shock stops; the rest are ordinary adverse drift. Stops are the
  entire loss column — targets pay a clean +1.493R avg, so the engine's problem is *entry
  selection / direction*, not exit geometry.
- **19 time exits (avg +0.417R):** 17 positive, 2 negative. Time exits are net *helpful*
  here — they bank partial favorable moves. They are not a leak to close.
- **24 targets (+1.493R avg):** healthy full winners.

So the near-breakeven result is driven by the 57 stops, i.e. too many low-quality directional
entries — not by the time-exit rule.

## Which pre-trade variables separate winners on DEVELOPMENT

Every candidate carries these decision-time fields: `score` (predicted R), `margin`
(direction edge), `spreadAtr`, `newsDistanceMinutes`, and entry hour.

- **`score` and `margin` are anti-calibrated.** On development the *top* quartile of the
  model's own predicted-R (`score`) is the *worst* (exp −0.118, 32% win), and the top
  quartile of direction edge (`margin`) is also the worst (exp −0.172, 32% win). A
  confidence gate would remove *good* trades. (Consistent with the standing
  "anti-calibrated confidence" finding on this instrument.)
- **`spreadAtr`** is flat — no signal.
- **Hour-of-session** is the only clean, economically interpretable separator on
  development:

  | Hour (UTC) | n | exp | win rate |
  |---|---:|---:|---:|
  | 11 | 42 | −0.122 | 33% |
  | 12 | 14 | −0.348 | 21% |
  | 13 | 18 | +0.401 | 56% |
  | 14 | 14 | +0.193 | 43% |
  | 15 | 21 | +0.347 | 71% |

  The 11:00–12:00 UTC London/NY lunch lull loses; the 13:00–15:45 UTC NY cash session wins.

## Predeclared gate (frozen on development)

**Enter only when entry UTC hour ≥ 13** (drop the 11:00 and 12:00 UTC decisions).
Chosen because both excluded hours have negative development expectancy and the rule is
structural (avoid the pre-NY-open lull) rather than a fit to the model's anti-calibrated
score. Threshold and rule form were fixed from development before inspecting validation by
hour.

## Results — baseline vs frozen gate

| Set | Trades | Trades/day | Win rate | Avg win | Avg loss | Expectancy | PF | Max DD | Exp 95% CI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| DEV baseline | 109 | 0.421 | 44.04% | +1.058 | −0.714 | +0.066R | 1.165 | 12.27R | [−0.113, +0.244] |
| **DEV gated** | 53 | 0.205 | 58.49% | +1.034 | −0.674 | **+0.325R** | **2.160** | 3.76R | **[+0.071, +0.579]** |
| VAL baseline | 100 | 0.386 | 41.00% | +1.079 | −0.740 | +0.006R | 1.013 | 7.05R | [−0.184, +0.196] |
| **VAL gated** | 61 | 0.236 | 42.62% | +0.982 | −0.727 | **+0.001R** | **1.003** | 5.30R | **[−0.236, +0.238]** |

## Why it failed: the hour structure did not persist

Validation-by-hour, revealed only after the gate was frozen:

| Hour (UTC) | DEV exp | VAL exp |
|---|---:|---:|
| 11 | −0.122 | −0.005 |
| 12 | −0.348 | +0.049 |
| 13 | +0.401 | −0.049 |
| 14 | +0.193 | +0.129 |
| 15 | +0.347 | −0.242 |

The sign of the per-hour edge flips between periods (dev's best hour 13 goes negative;
dev's worst hour 12 goes positive; dev's strong hour 15 becomes the worst). The development
hour pattern was **in-sample noise on 109 trades**, not a stable intraday effect. The
alternative thresholds (hour≥12, hour≥14) tell the same story: large development lift,
≈0 validation lift.

## Conclusion

The gate cleared the viable-version bar **on development** (PF 2.16, avg win +1.03,
avg loss −0.67, 95% expectancy lower bound +0.071 > 0) but produced **no improvement on
the single frozen out-of-sample run** (expectancy +0.006R → +0.001R; PF 1.013 → 1.003;
95% CI still crosses zero from −0.236 to +0.238). Gating by hour also cut frequency
(0.386 → 0.236 trades/day) for no expectancy gain.

**There is no robust entry-quality improvement to V4 from decision-time fields.** V4 stays
a near-breakeven, research-only engine. Do not tune further hour/score/margin gates on this
sample — the held-out period has now been used once and additional cuts would be fitting to
it. A real improvement requires an *exogenous* directional signal, not a re-slice of the
existing candidates (matches prior EUR/USD null results).
