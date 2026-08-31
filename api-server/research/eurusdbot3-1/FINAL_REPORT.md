# EURUSDBOT3-1

## FINAL VERDICT: **NO_EDGE**

An EUR/USD-specific direction model was built and tested end-to-end against a
true 1:3 (−1R / +3R), 72-hour-max-hold barrier. On genuine out-of-sample data it
achieves **~21.6% win rate at −0.146R net expectancy per trade** — below the
~25% random-walk base rate for a 1:3 barrier, worse than a coin flip on the same
timestamps, and firmly loss-making after costs. The single most important
finding: **gross expectancy is essentially breakeven (24.7% WR, +0.016R) and the
~2-pip round-trip spread is the entire difference between breakeven and losing.**
The signals contain no exploitable directional information at this horizon.

This is a *successful* research outcome in the sense that matters: it prevents
deploying a strategy that would lose money. It should **not** be paper-traded
forward as-is.

> Reproduce: `cd api-server && npx tsx scripts/eurusdbot3-1/experiment.ts`
> Raw artifact: [`RESULTS.json`](./RESULTS.json). Code: [`scripts/eurusdbot3-1/`](../../scripts/eurusdbot3-1/).

---

## 1. Existing components reused (per the inspection brief)

| Component | Source in repo | How it was reused |
|---|---|---|
| Historical EUR/USD candles | `backtest-legacy-expanded/candles/EUR_USD_{H1,M15,H4}.json` | Primary data. 7 years (2019-08→2026-08), **bid/ask** OHLC, so spread is real. Loaded offline, nothing fetched at runtime → fully reproducible. |
| Bid/ask barrier convention | `scripts/_eur_usd_engine_backtest.ts` (`resolveTrade`) | Adopted: enter long on ask / short on bid, exit on the opposite side; conservative same-bar handling. Extended to walk the finer **M15 path** and to book a NET slippage term. |
| News dataset | `research-v2/eurusd-ff-high-impact-aug2024-jul2025/`, `…aug2025-jul2026/` | 801 high-impact EUR/USD ForexFactory events with `releaseTimeUtc`, actual/forecast/previous. Loaded look-ahead-safely; surprise z-scored from prior events only. |
| Existing direction engine | `src/eur-usd-engine.ts` (`runEurUsdEngine`) | Used as a **baseline** (direction counterfactual on the model's OOS entries). |
| Logistic inference shape | `src/binary-logistic-v1.ts` | Mirrored the standardize→sigmoid form; trainer (L2 full-batch GD, class-balanced) added because the repo ships no ML dependency. |
| Session / horizon-label idioms | `scripts/audit-eur-usd-trend-v1-shorts-72h.ts` | Reused the chronological, non-overlapping-lock and multi-horizon-label patterns. |

**Nothing production/live was modified.** All new code lives under
`scripts/eurusdbot3-1/`; all outputs under `research/eurusdbot3-1/`.

---

## 2. Data

- **Instrument:** EUR/USD only.
- **Range:** 2019-08-27 → 2026-08-21 (labelled candidates; last 72h reserved for barrier resolution).
- **Candles:** H1 = 44,055 · M15 = 176,185 (barrier path) · H4 = 10,639 · Daily = 1,459 (both resampled from H1, completed-bar-only, no look-ahead).
- **Candidates built:** 43,485 (one causal candidate per H1 close) — 41,543 development, 1,942 sealed.
- **News:** 801 high-impact EUR/USD events, 2024-08-01 → 2026-07-31 (653 with actual → surprise computable). Covers only the recent ~2 years, so the news ablation runs on the 2024-08+ sub-period.
- **Costs:** median spread ~1.5 pip is embedded in the bid/ask data; a further **0.5 pip slippage** is charged on the NET book. Swap/financing is **not** in the data — noted as an un-modelled extra drag on multi-day holds (would make NET slightly *worse*, never better).

Ambiguous intrabar outcomes (both barriers inside one M15 bar) were only **0.45%** of candidates and are booked conservatively as losses and reported separately — so barrier resolution is not a material source of error.

---

## 3. Final model

- **Features (37):** EUR/USD-specific, all causal. Momentum/displacement over 1–24 H1 bars; H4 & Daily returns; H1/H4 EMA gaps, EMA slope, daily location; multi-timeframe trend alignment; swing structure bias (HH/HL vs LH/LL); range position; distance to swing highs/lows and rolling day extremes; consecutive-direction; ATR (normalised, percentile, expansion), realized vol, candle body/range; UTC session one-hots and hour/day cyclicals.
- **Direction logic:** one **symmetric** logistic model scores both sides — long features as-is, short features sign-flipped — predicting P(this side reaches +3R before −1R in 72h). Decision = higher-probability side; **NO_TRADE** when the max probability is below a confidence threshold. This doubles training data and bakes in long/short symmetry.
- **Stop:** volatility-based, 1R = 1.0 × ATR(H1,14), floored at 5 pips (never manufactured small).
- **Target:** exactly 3 × riskDistance.
- **No-trade / confidence:** absolute-probability threshold chosen **on a validation slice** (last 15% of each training block), never on test/sealed.

---

## 4. Results (walk-forward out-of-sample, NET)

| Metric | Value |
|---|---|
| Trades | 1,339 |
| Wins / Losses / Timeouts / Ambiguous | 289 / 1,029 / 20 / 1 |
| **Win rate** | **21.6%** (Wilson 95% lower bound 19.5%) |
| Gross expectancy | +0.016 R |
| **Net expectancy** | **−0.146 R** |
| Total R (net) | −195.8 |
| Profit factor | 0.82 |
| Max drawdown | 198.9 R |
| Longest losing streak | 21 (longest win streak 3) |
| Avg / median hold | 8.9h / 3.5h (close 1R stop hit fast) |

**GROSS vs NET is the whole story:** gross 24.7% WR / +0.016R (≈ the 25% random-walk theoretical) → net 21.6% WR / −0.146R. Costs, not signal, decide the outcome.

---

## 5. Walk-forward (every window shown, none removed)

| Window | Test period | Thr | n | WR | Net exp | Total R |
|---|---|---|---|---|---|---|
| 1 | 2021-12 → 2022-09 | 0.54 | 476 | 21.2% | −0.163 | −77.7 |
| 2 | 2022-09 → 2023-06 | 0.58 | 67 | 26.9% | **+0.071** | +4.8 |
| 3 | 2023-06 → 2024-02 | 0.58 | 32 | 18.8% | −0.295 | −9.5 |
| 4 | 2024-02 → 2024-11 | 0.54 | 203 | 20.7% | −0.223 | −45.3 |
| 5 | 2024-11 → 2025-08 | 0.46 | 558 | 21.9% | −0.117 | −65.0 |
| 6 | 2025-08 → 2026-04 | 0.58 | 3 | 0.0% | −1.025 | −3.1 |

Only 1 of 6 windows is marginally positive (W2, n=67). No stability, no
single-period concentration of *profit* — the losses are broad-based.

---

## 6. Sealed test (2026-05-01 → 2026-08-21, evaluated once)

- Threshold 0.56 → **9 trades, 11.1% WR, −0.612R** (Wilson lower bound 2%).
- The threshold selector produced very few sealed trades (low power). A robustness sweep shows the sealed book is *noise-dominated*: shifting the threshold −0.04 flips it to 142 trades / 26.8% WR / +0.041R, while +0.02 yields zero trades. A result that swings from −0.61R to +0.04R on a 0.04 threshold nudge is not an edge. **Sealed fails.**

---

## 7. Confidence analysis (does selectivity help?)

| Coverage | n | WR | Net exp |
|---|---|---|---|
| 100% | 1,339 | 21.6% | −0.146 |
| 75% | 1,004 | 22.2% | −0.133 |
| 50% | 670 | 22.2% | −0.132 |
| 30% | 402 | 22.1% | −0.132 |
| 20% | 268 | 24.3% | −0.043 |
| 10% | 134 | 23.9% | −0.064 |

Weakly monotonic at best; **expectancy is negative at every coverage.**
Confidence is not calibrated enough to reach profitability — selectivity cannot rescue a signal that has no edge.

---

## 8. News ablation (2024-08+ covered period)

| Variant | n | WR | Net exp |
|---|---|---|---|
| No news | 580 | 22.1% | −0.111 |
| News-avoidance filter | 553 | 21.7% | −0.125 |
| News as features | 570 | 20.2% | **−0.197 (worse)** |
| High-impact-only | 27 | 29.6% | +0.155 |

News **does not help.** Feature-encoding news made results worse; avoidance was
neutral. The lone positive (high-impact-only) rests on 27 trades — statistically
meaningless, flagged only as a hypothesis for far more data.

---

## 9. R:R comparison (frozen entries & directions)

| R:R | WR | Net exp | Total R |
|---|---|---|---|
| 1:1 | 43.2% | −0.168 | −226.6 |
| 1:1.5 | 34.9% | −0.159 | −213.7 |
| 1:2 | 29.8% | −0.135 | −182.5 |
| 1:2.5 | 24.9% | −0.150 | −202.6 |
| 1:3 | 21.5% | −0.149 | −201.3 |

**Every R:R is negative.** Tighter targets buy a higher win rate but the same
loss — there is no edge to reshape. 1:3 is not specially bad, but no R:R is
"appropriate," because the entries lack directional information. (Note: 1:1.5
reaches ~35% WR — a reminder that a 35% figure alone is meaningless without the
R:R it belongs to.)

---

## 10. Hold-time comparison (frozen entries & directions)

| Hold | WR | Net exp |
|---|---|---|
| 24h | 18.5% | −0.150 |
| 48h | 19.9% | −0.160 |
| 72h | 21.5% | −0.149 |
| 96h | 21.9% | −0.145 |
| 120h | 22.2% | −0.144 |

More time slightly raises the win rate (more room to reach 3R) but expectancy is
flat and negative throughout. **72h is not the best; 120h is marginally
least-bad; none is profitable.** The original 72h hypothesis is not protected.

---

## 11. Baselines (same data, same barrier, same costs)

**Direction counterfactual on the model's own 1,339 OOS entry timestamps:**

| Direction source | WR | Net exp |
|---|---|---|
| **eurusdbot3-1 model** | **21.6%** | **−0.146** |
| Random (seeded) | 23.0% | −0.098 |
| Always long | 21.8% | −0.136 |
| Always short | 21.4% | −0.158 |
| Simple trend (EMA gap) | 21.4% | −0.162 |
| Simple momentum (12h) | 20.0% | −0.225 |
| Existing `eur-usd-engine` | 21.8% | −0.136 |

The model is **worse than random** and no better than the existing engine on
identical entries. Trend and momentum are mildly *anti*-predictive at this
horizon, which is exactly why the model — which leans on them — underperforms a
coin flip. On the full 5,500-trade universe every baseline is −0.16R to −0.19R.

---

## 12. Account simulation ($100, 1% risk/trade — presentation only)

| Stream | Ending | Return | Max DD% | Lowest |
|---|---|---|---|---|
| OOS, $100 | $11.78 | −88.2% | 88.5% | $11.57 |
| OOS, $1,000 | $117.80 | −88.2% | 88.5% | $115.67 |
| OOS, $10,000 | $1,178 | −88.2% | 88.5% | $1,156.75 |
| Sealed, $100 | $94.56 | −5.4% | 6.2% | $94.56 |
| Combined, $100 | $11.14 | −88.9% | 88.9% | $11.14 |

Scales linearly with starting balance, as expected. Negative expectancy
compounds to near-total ruin.

---

## 13. Failure analysis — where and why it loses

1. **No directional edge at the 3R/72h horizon.** Gross win rate (24.7%) is
   indistinguishable from the 25% random-walk barrier probability. The features
   (trend, momentum, structure, MTF, session, news) carry essentially zero
   information about whether EUR/USD reaches +3R before −1R over the next 72h.
2. **Costs dominate any residual signal.** The ~2-pip round-trip spread + 0.5-pip
   slippage is ~0.1–0.2R per trade on ATR-sized stops — larger than the entire
   gross edge. Gross ≈ breakeven; net is a reliable loser.
3. **Trend/momentum are mildly anti-predictive** at this horizon (momentum
   baseline is the worst), so a model that weights them lands *below* random.
4. **Confidence is not calibrated** — the top decile only nudges WR to ~24%,
   never into profit.
5. **Instability** — walk-forward windows and the sealed book swing sign on
   tiny threshold changes: the classic signature of fitting noise.

---

## 14. Direct answers to the final questions

1. **≥35% WR at true 1:3 on 72h OOS?** No — **21.6%** (sealed 11.1%).
2. **≥35% on the sealed test?** No — 11.1% (9 trades); even the most favorable threshold shift only reached 26.8%.
3. **NET expectancy per trade?** OOS **−0.146R**; sealed **−0.612R**. Both negative (gross OOS ≈ +0.016R).
4. **Trades evaluated?** 43,485 candidates built; 1,339 OOS trades taken (+9 sealed); ~5,500 in the baseline universe.
5. **Did confidence filtering genuinely improve performance?** No — weakly monotonic but negative at every coverage; not calibrated.
6. **Did news improve performance?** No — news features made it worse; avoidance was neutral.
7. **Was 72h actually the best hold?** No — all holds negative; 120h marginally least-bad. 72h is not special.
8. **Was 1:3 the best R:R?** No — all R:R negative; none is appropriate because there is no edge to harvest.
9. **Beat random and the existing engine?** No — it is *worse* than random (23.0% vs 21.6%) and ≈ the existing engine (21.8%) on identical entries.
10. **Strong enough to paper-trade forward?** **No.**
11. **Biggest remaining weakness?** No exploitable directional information at the 3R/72h horizon, compounded by costs that exceed the entire gross edge (gross is only a breakeven coin flip).
12. **What to test next?**
    - Shorter-horizon / intraday targets where the signal-to-cost ratio is higher (3R over 72h is dominated by a fixed 2-pip cost).
    - **Gate every future idea on a pre-cost screen:** require gross WR meaningfully **above ~25%** before spending effort on execution — anything at 25% gross is dead on arrival.
    - Event-conditioned directional bets (the high-impact-only hint) on far more history to see if it survives out of sample.
    - Cost reduction (limit-entry fills, tighter-spread sessions) — but only *after* a signal clears the gross bar.
    - Consider abandoning the symmetric 1:3 swing framing for EUR/USD; the pair's mean-reverting intraday behavior fights a 3R trend target.

---

## 15. Integrity notes

- No shuffling of time series; strictly chronological train → validate → test → sealed.
- Thresholds/parameters selected only on validation data available before each test block; the sealed period was evaluated once and not tuned against.
- No look-ahead: HTF bars are completed-only; news uses scheduled times for future events and actual/surprise only for already-released events.
- All windows reported, including profitable and unprofitable; timeouts and ambiguous outcomes are counted and shown, not hidden.
- Headline decisions use NET (spread + slippage) results; GROSS shown only for diagnosis.
