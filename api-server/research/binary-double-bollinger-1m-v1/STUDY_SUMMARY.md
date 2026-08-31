# Binary Double-Bollinger 1-Minute Reversal — Full Study

**Verdict: `NO_EDGE`.** Over two years and ~208,000 trades, 1-minute binary
direction on this method is a coin flip (50.1%). No configuration holds above the
break-even a real payout demands. This document is the complete investigation,
start to finish, including every attempt to force a winning (or losing) number
and why each one failed.

---

## 1. What was tested

An "extension → rejection → momentum-confirmation → 1-minute reversal" system on
M1 FX candles for the 12 project pairs (EUR/USD, GBP/USD, USD/JPY, AUD/USD,
NZD/USD, USD/CAD, USD/CHF, EUR/GBP, EUR/JPY, GBP/JPY, AUD/JPY, EUR/AUD).

- **Signal:** BB(20,2)/BB(20,3) rejection + Heikin-Ashi reversal + Stochastic(6,3,3)
  cross + CCI(21) slope + ADX/DMI convergence-divergence.
- **Trade:** enter next candle open, settle 60 seconds later (higher/lower).
- **Data:** real OANDA M1 mids. Frozen parameters — no tuning of the indicators.

Full method spec and lookahead audit: `FINAL_REPORT.md`, `IMPLEMENTATION_NOTES.md`.

---

## 2. The core result

| Configuration | Trades | Win rate |
| ------------- | -----: | -------: |
| Full 5-indicator method | 28 | 32% (n too small) |
| BB2 rejection (broad base) | 23,270 | 50.6% |
| Every component variant A–I | — | 45–52% |

Adding confirmations did **not** stack into an edge — the more indicators, the
closer to (or below) 50%. Heikin-Ashi and ADX actively hurt. Stronger Bollinger
extension (BB3 vs BB2) added ~1 point, within noise.

**Every variant loses money at every binary payout from 70% to 90%.**

---

## 3. Out-of-sample: the number never held

The recent-window win rates evaporated on data the configs never saw.

| Config | Recent window | 2 years back (Aug 2024) |
| ------ | ------------: | ----------------------: |
| BB2 base (broad) | 50.6% | 49.8% |
| "63% win" slice (USD/CHF Asia) | 63.0% | **49.4%** |
| "70% loss" slice (ADX Asia DOWN) | 70.4% loss | **50.0%** |

Any win rate far from 50% came from a small sample. Out of sample it reverted to
a coin flip, every time.

---

## 4. Two years, nine windows, 736 frequent configs

Sampled 9 independent 12-day windows quarterly (2024-08 → 2026-08). The broad
base is a flat coin flip in **every** window:

`49.8 · 49.6 · 49.3 · 49.1 · 50.8 · 51.2 · 49.7 · 50.8 · 50.6 %`  (≈208k trades)

Searching all 736 frequent configs for a **persistent** bias:

- Best persistent **loss** lean: ~55% (loses in all 9 windows) — HA+CCI London.
- Best persistent **win** lean: ~50% (a coin flip).

**The most any frequent config held over 2 years was a ~55/45 lean** — not the
70% that appeared in single windows.

---

## 5. Where the "70%" numbers really came from

Two seductive numbers surfaced during the study. Neither is a tradeable edge.

**A durable 70% LOSS exists — via cost, not direction.** Charge a realistic
per-trade spread and a frequent 1-minute bot loses ~70% in every window
(224,261 trades, 67–75% loss). At OANDA's *actual* ~2.3-pip practice spread it
loses **92–97%**. But this loss is a toll, not a wrong-way bet — so **inverting
it does not win**: original 69.7% loss, inverted 69.8% loss. ~40% of trades never
move far enough to beat the cost, and those lose in *both* directions.

**A 70% WIN does not exist.** It is the mirror of a 70% loss-by-direction, which
would require 70% directional accuracy — and the best accuracy anywhere in 2
years was ~55%.

---

## 6. Binary reality: why 50% still loses

On a fixed-payout binary (e.g. 92% payout), there is no spread to cross — the
house edge lives in the payout:

- Win pays **+$0.92**; loss costs **−$1.00**.
- Break-even win rate = 1 / (1 + 0.92) = **52.08%**.
- A coin flip (50%) → **−$0.038 per $1 per trade** — a slow, certain bleed.

Simulated clueless random bot, one window (11,579 trades): **win rate 49.3%,
balance $1,000 → $392.** A person with no knowledge still wins ~half their
trades; the account dies through the payout, not through a low win rate.

---

## 7. Loss analysis: the losers look exactly like the winners

Broke the 208k trades down by every feature. Win rate by bucket:

| Split | Range across buckets |
| ----- | -------------------- |
| Session | 49.8 – 50.3% |
| Pair | 50.1 – 50.6% |
| Direction | 49.9 – 50.2% |
| BB event / extension | 48.7 – 50.2% |
| Hour of day | 50.5 – 51.5% |
| Stochastic bucket | 49.3 – 51.0% |
| CCI bucket | 48.6 – 51.1% |
| ADX bucket | 49.1 – 50.3% |

Stacking every mildly-positive signal together topped out at **51.0%** pooled
(still below 52.08%). When no feature separates winners from losers, the losses
aren't a fixable flaw — the direction simply isn't predictable at this horizon.

---

## 8. Walk-forward: the honest proof against overfitting

Trained on 6 windows (2024–2025), searched 3,216 frequent configs, took the best,
evaluated **unchanged** on 3 unseen 2026 windows:

| Best-on-training config | Train | → Test (unseen) |
| ----------------------- | ----: | --------------: |
| EUR/JPY · overlap · DOWN · K-extreme | 57.5% | 53.1% |
| EUR/JPY · overlap · DOWN · ADX>25 · K-ext | 57.2% | 52.6% |
| EUR/JPY · London · UP · ADX>40 · K-ext | 57.1% | 49.8% |
| USD/JPY · London · UP · ADX>25 · K-ext | 56.8% | 51.0% |
| AUD/JPY · NY · UP · ADX>40 | 56.5% | 48.5% |

Configs that hit 56–57% in training regressed to **49–53%** out of sample, each
with a 2026 quarter in the 45–48% (money-losing) range. **That 4-point train→test
drop is the signature of overfitting.** You can manufacture any in-sample win rate
by searching hard enough; the market does not honor it.

---

## 9. Conclusions

1. **1-minute binary direction is a coin flip** — 50.1%, stable across 2 years
   and 208k trades, CI ±0.2%.
2. **No frequent config holds above the ~52% break-even** out of sample. The
   single most durable lean was ~55%, on one fragile London slice.
3. **A 70% loss is achievable (via cost) but cannot be inverted into a win.**
4. **A 70% win does not exist** in the data at any frequency.
5. **Overfitting can fake any number in-sample**; walk-forward collapses it.

---

## 10. Recommendation

1. **Do not deploy a binary bot on this.** It is structurally negative-EV: a
   coin flip meeting a payout that requires >52%. A bot loses faster and more
   reliably than manual clicking, not less.
2. **Drop fixed-payout binary as the format.** The payout haircut is a fixed
   house edge a ~50% signal can't beat. A setup where you control your own
   risk/reward (regular FX/CFD) is at least a fair-ish game.
3. **Stop mining indicators on 1-minute candles.** Everything price-derived at
   60s is ~50%; that's proven. Higher signal-to-noise lives at longer horizons
   or in non-price information (approach with skepticism — prior research found
   exogenous signals null too).
4. **The one non-dead corner** — the ~55% HA+CCI London reversal lean — is the
   only candidate worth a proper stress test (execution timing, live-feed
   survival, sizing), with honest odds it still washes out.

The most valuable output of this study is the negative result itself: **this
method is a coin flip, and the payout turns a coin flip into a slow loss.**
Knowing that costs a few hours of research instead of a funded account.

---

### Artifacts

`FINAL_REPORT.md` · `IMPLEMENTATION_NOTES.md` · `ROBUSTNESS_2Y.md` ·
`LOSS_CONFIGURATION.md` · `HORRIBLE_BOT_70PCT_LOSS.md` · `RESULTS.json` ·
`TRADES.csv` · plus reproducible scripts: `fetch.mjs`, `run.mjs`,
`loss_search.mjs`, `robustness_2y.mjs`, `spread_settle.mjs`, `walkforward.mjs`.
