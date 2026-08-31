# EURUSD-EXOGENOUS-V1

## 1. EXECUTIVE VERDICT

**NO_EXOGENOUS_DIRECTION_EDGE · NO_TRADE_EDGE.**
Sub-verdicts: **no DXY edge · no cross-FX edge · no risk-asset (gold) edge · rates / CB-expectations / positioning / order-flow = INSUFFICIENT_DATA (absent on disk).**

On the frozen `eurusd-move-v1` MOVE_LIKELY windows (reach ≥ 3.0 ATR @ 24h;
27,032 dev / 1,226 sealed), no exogenous family predicts EUR/USD direction better
than random. Every family lands at **49–50% OOS accuracy with ROC-AUC below 0.5**;
the sealed exogenous model is **45.4% (p = 0.0014 — significantly *worse* than
random, AUC 0.43)**. The decisive finding is a clean **correlation-without-
prediction dissociation**: the synthetic USD basket is **−0.80 contemporaneously
correlated** with EUR/USD (a non-causal rule that peeks at the *future* USD move
scores 81.2%), yet using only **past** USD information the forward accuracy is
**exactly 50.0% at every lookback (1–24h)**. **DXY does not *lead* EUR/USD — it
moves with it simultaneously.** No configuration is NET-profitable. Do not paper
trade.

> Reproduce: `cd api-server && npx tsx scripts/eurusd-exogenous-v1/experiment.ts`
> [`RESULTS.json`](./RESULTS.json) · [`DATA_INVENTORY.md`](./DATA_INVENTORY.md) · code [`scripts/eurusd-exogenous-v1/`](../../scripts/eurusd-exogenous-v1/)
> `eurusdbot3-1` and `eurusd-move-v1` were **not modified** — imported only.

## 2. Prior-experiment context

- `eurusdbot3-1`: NO_EDGE (1:3/72h, 21.6% OOS WR, costs sink flat gross).
- `eurusd-move-v1`: MOVE_EDGE_FOUND (statistical) / NO_DIRECTION_EDGE / NO_TRADE_EDGE — direction random from EUR/USD's own price/vol/news; natural geometry ~1:1.
- This experiment tests the one remaining lever from `eurusd-move-v1`'s "next step": **exogenous** information as the missing directional arrow.

## 3. Data inventory (full detail in DATA_INVENTORY.md)

**Usable, on disk, offline (shared OANDA H1 grid, 2019-07 → 2026-08, bid/ask):**
USD_JPY, USD_CHF, USD_CAD, GBP_USD, AUD_USD, NZD_USD, EUR_GBP, EUR_JPY (+ GBP_JPY,
AUD_JPY aux) and **XAU_USD** (gold). Derived proxies (from these only): **USD
strength basket "DXY-ex-EUR"**, **EUR strength basket**, **strength_diff**.

**Absent → not tested:** intraday US/German yields & curves (only *monthly* OECD
levels are wired via FRED, not on disk, too coarse for 1–72h and non-reproducible);
Fed/ECB rate expectations (STIR/OIS); equity indices / VIX; COT; order-flow /
broker positioning.

## 4. Data quality / leakage review

- Every exogenous feature at `t` uses only bars with `closeTime ≤ t` (binary search).
- Labels use the M15 path strictly after `t`.
- Real DXY (57.6% EUR) is deliberately **not** rebuilt — the USD basket excludes EUR so it is genuinely independent of EUR_USD.
- Contemporaneous co-movement (near-tautological) is reported separately from forward value; only lagged info feeds any model.

## 5. Frozen MOVE detector

Imported verbatim from `eurusd-move-v1`: MOVE = reach ≥ 3.0 ATR @ 24h (balance-
selected there), WARMUP 520, sealed = 2026-05-01→, 6-fold expanding walk-forward,
72h embargo, direction labels (dominant excursion primary / terminal secondary),
coverage buckets. MOVE_LIKELY base rate reproduced exactly: **65.1% (dev 27,032)** —
confirming the freeze.

## 6. DXY results

USD-basket family (7 features) OOS: **acc 0.5005, AUC 0.4948, p 0.90** — random.
Simple DXY-inverse rule (USD weak over last 4h → EUR/USD up): **0.4986, p 0.72**.
No DXY edge. See §16 for why (lead-lag).

## 7. Rates results

**INSUFFICIENT_DATA.** No intraday yield/curve data on disk; only monthly OECD
long-term levels are reachable (non-reproducible, and too coarse to move within
a 1–72h horizon). `simple_rate_diff` baseline: not computable. Rate *expectations*
(the week-to-week driver) have no source in this repo.

## 8. Cross-FX results

Cross-FX family (10 features incl. EUR basket, strength_diff, lead pairs) OOS:
**acc 0.4942, AUC 0.4876, p 0.12** — random-to-slightly-worse. Simple cross-FX
strength rule (strength_diff>0 → up): **0.4938, p 0.10**. No cross-FX edge.

## 9. Risk-asset results

Gold family (3 features) OOS: **acc 0.4997, AUC 0.4919, p 0.94** — random. Gold
carries no forward EUR/USD directional information here.

## 10. Positioning results

**INSUFFICIENT_DATA** — no COT on disk.

## 11. Order-flow results

**INSUFFICIENT_DATA / SKIP** — no historical order-book / broker-positioning source (per §11 of the brief, not proxied).

## 12. Combined models

| Model | OOS acc @100% | AUC |
|---|---|---|
| DXY only | 0.5005 | 0.495 |
| Cross-FX only | 0.4942 | 0.488 |
| Risk (gold) only | 0.4997 | 0.492 |
| DXY + Cross-FX | 0.4952 | 0.488 |
| **ALL exogenous** | **0.4903** (p 0.010, *below* random) | 0.482 |
| Exogenous + EUR/USD internal | 0.4788 | — |
| Internal-only (prior price/vol/news family) | 0.4904 | — |

Combining families does **not** help; ALL_EXO is significantly *below* 50%, and
adding internal features makes it *worse* (0.479) — more anti-predictive inputs,
more noise-fitting, not more signal.

## 13. Horizon comparison

Primary horizon is the frozen 24h. Accuracy is ~random at 24h across all families;
signed returns are ~0 to slightly negative. (Shorter/longer horizons were the
subject of `eurusd-move-v1`, which found direction random at every horizon; nothing
here changes that.)

## 14. Confidence / coverage (ALL exogenous, dominant label)

| Coverage | n | accuracy | p vs 50% | signed pips | MFE/MAE |
|---|---|---|---|---|---|
| 100% | 17,566 | 0.490 | 0.010 | −0.26 | 0.99 |
| 50% | 8,783 | 0.483 | 0.001 | −0.67 | 0.97 |
| 30% | 5,270 | 0.458 | ~0 | −2.71 | 0.90 |
| 20% | 3,513 | 0.454 | ~0 | −3.11 | 0.88 |
| 10% | 1,757 | 0.454 | 0.0001 | −1.36 | 0.89 |
| 5% | 878 | 0.478 | 0.20 | +4.04 | 0.98 |

**Confidence is anti-calibrated** (accuracy *falls* as coverage narrows, signed
returns go negative) — the identical perverse pattern seen with internal features.
The 5% bucket is a non-significant small-sample wiggle.

## 15. Baselines (identical MOVE_LIKELY OOS timestamps, n = 17,566)

| Source | acc | Source | acc |
|---|---|---|---|
| random | **0.5024** | exogenous ALL | 0.4903 |
| always down | 0.5049 | internal prior model | 0.4904 |
| always up | 0.4951 | combined exo+internal | 0.4788 |
| simple DXY-inverse | 0.4986 | simple cross-FX strength | 0.4938 |
| simple rate-diff | n/a (no data) | | |

**Nothing beats random.** The exogenous model ties the (failed) internal model at
the bottom.

## 16. Lead-lag analysis — the decisive result

| Quantity | Value |
|---|---|
| Contemporaneous corr( EUR/USD next-24h , USD-basket next-24h ) | **−0.798** |
| **Non-causal** rule using the *future* USD move (upper bound) | **81.2% acc** (p≈0) |
| Forward acc — past USD basket, lookback 1h / 2h / 4h / 8h / 24h | 0.501 / 0.498 / 0.499 / 0.499 / 0.498 |
| Forward acc — past strength_diff, lookback 1h / 2h / 4h / 8h / 24h | 0.497 / 0.494 / 0.494 / 0.498 / 0.497 |

The USD basket and EUR/USD are **strongly, mechanically co-moving (−0.80) at the
same instant** — a trader who knew the next 24h of USD flow would call EUR/USD
direction 81% of the time. But **no part of that information is available in
advance**: every *lagged* rule is pinned at 50%. **DXY/cross-FX do not lead
EUR/USD; they are contemporaneous.** This is exactly the correlation-≠-prediction
trap the brief warned against, and it is the core reason no exogenous edge exists.

## 17. Correlation vs prediction

See §16. Strong contemporaneous correlation (−0.80) coexists with zero forward
predictive value (50.0%). Reported explicitly to avoid mistaking the former for
the latter.

## 18. Temporal stability (ALL exogenous, per walk-forward window)

| W1 | W2 | W3 | W4 | W5 | W6 |
|---|---|---|---|---|---|
| 0.480 | 0.461 | 0.475 | 0.501 | 0.504 | 0.526 |

Straddles 0.5 with no consistency (worse 2021–23, ~flat 2024–26) — not a robust
relationship.

## 19. Regime analysis (ALL exogenous)

low-vol 0.495 · normal-vol 0.484 (p 0.017) · high-vol 0.490 · London 0.498 · NY
0.490 · overlap 0.491 · Asia 0.486 (p 0.014). No regime is above random; the only
significant cells (normal-vol, Asia) are *below* it. No regime filter (chosen on
train/validation) recovers an edge.

## 20. Walk-forward

Every window reported (§18); none removed. Family-level per-window accuracy is in
`RESULTS.json`. All families straddle 0.5.

## 21. Sealed test (run once, frozen ALL-exogenous model)

**n = 1,226 · accuracy 0.4543 · p = 0.0014 · AUC 0.4305.** Significantly *worse*
than random. By coverage: 100% → 45.4% (−4.8 signed pips), 50% → 41.0% (−7.5),
10% → 56.9% on ~123 samples (small-sample noise, not significant). **Sealed
confirms: no exogenous direction edge.**

## 22. Statistical significance

Binomial z-tests vs 50% and Wilson 95% lower bounds throughout. No family clears
50% on the upper side at any coverage; several are significantly *below* 50%
(ALL_EXO 0.490 p 0.010; sealed 0.454 p 0.001). **Feature-sign stability:** 9 of 20
ALL_EXO coefficients — including the core `usd_ret_2/4`, `usd_slope`, `sdiff_1/4`,
`gbpusd_ret_4` — **flip sign across folds**. The model cannot even agree on the
*direction* of each relationship over time: the signal is noise.

## 23. Data-derived trade test

Run for completeness on frozen ALL-exogenous top-20%-confidence predictions
(1.0 ATR stop, sweep TP, NET of spread + 0.5 pip slippage):

| R:R | trades | WR | NET exp | PF |
|---|---|---|---|---|
| 1:1 | 3,513 | 42.4% | −0.183 R | 0.69 |
| 1:1.5 | 3,513 | 35.1% | −0.154 R | 0.77 |
| 1:2 | 3,513 | 30.5% | −0.116 R | 0.84 |
| 1:2.5 | 3,513 | 27.7% | −0.061 R | 0.92 |
| 1:3 | 3,513 | 25.7% | **0.000 R** | 1.00 |

## 24. NET expectancy

No configuration is NET-positive; 1:3 merely reaches the WR 25.7% ≈ 25% random-
walk breakeven wall (identical to both prior experiments). No account simulation
run (edge absent).

## 25. Failure analysis

- **The predictive information genuinely does not exist in the tested data.** The one variable strongly linked to EUR/USD (the USD complex) is linked *contemporaneously* (−0.80), and markets arbitrage that link away intraday — so it carries no *lead*.
- **Confidence is anti-calibrated** (as with internal features): the model's boldest calls are its worst.
- **Signs are unstable across time** — no durable structural relationship.
- **Costs finish it**: a coin-flip direction plus ~2-pip round-trip is NET-negative at every R:R.
- **Whole families are simply missing** (rates, rate-expectations, equities/VIX, positioning, order-flow) — the sources most likely to *lead* FX are not in the repo.

## 26. FINAL VERDICT

**NO_EXOGENOUS_DIRECTION_EDGE · NO_TRADE_EDGE** (DXY / cross-FX / gold: no edge;
rates / CB-expectations / positioning / order-flow: INSUFFICIENT_DATA). Do not
proceed to paper trading. Per the pre-registered stop rule (§29), the search ends
here — no further indicator hunting.

---

## Direct answers to the 20 final questions

1. **Any external variable predicts EUR/USD direction > random on MOVE_LIKELY?** No. All families 49–50%, AUC < 0.5; sealed 45.4% (below random).
2. **Strongest family?** None. DXY 0.5005 ≈ gold 0.4997 > cross-FX 0.4942 > ALL_EXO 0.4903 — all ~random, ranking is noise. Rates/positioning/order-flow untestable.
3. **Does DXY lead EUR/USD or only correlate?** **Only correlates** — contemporaneous −0.80, but forward accuracy from past DXY is exactly 50.0%. No lead.
4. **Do US-vs-euro rate changes predict direction?** Untestable — no intraday rate data on disk (monthly-only, non-reproducible).
5. **Does cross-pair currency strength predict direction?** No — 49.4–49.8% forward at every lookback.
6. **Does combining families help?** No — ALL_EXO 0.490 (below random); exo+internal 0.479 (worse).
7. **Best OOS accuracy?** ~0.50 (DXY 0.5005), statistically indistinguishable from random and not above it with any confidence.
8. **Best SEALED accuracy?** 0.4543 overall (below random, p 0.0014); a 56.9% top-10% cell is small-sample noise.
9. **At what coverage/confidence?** None — accuracy *falls* with confidence (anti-calibrated).
10. **Monotonic improvement with confidence?** No — monotonic *decline*.
11. **Stable across years/windows?** No — 0.46–0.53, no consistency.
12. **Which features stay directionally stable?** Few — 9 of 20 flip sign across folds, including the core USD/strength features. None reliably stable.
13. **Statistically significant results?** Yes, but the *wrong* way — several families/sealed are significantly *below* 50%; none significantly above.
14. **Beat random direction?** No.
15. **Beat eurusd-move-v1 direction?** No — tied at the bottom (~0.490).
16. **Beat eurusdbot3-1 direction?** No.
17. **Positive signed future returns?** No — flat-to-negative, worsening with confidence.
18. **Any NET-profitable frozen config?** No (best 0.000 R at 1:3 — breakeven wall).
19. **Enough evidence to paper trade?** No.
20. **Strongest conclusion about EUR/USD prediction with datasets tested so far?** Across three experiments, EUR/USD's directional "arrow" is **not recoverable** from any price-derived source available here — its own price/vol/news, nor cross-FX / synthetic-DXY / gold. The variable most tied to it (the USD complex) is tied **contemporaneously** and arbitraged away intraday, so it offers no lead. The remaining hypothesis — that *genuinely leading* exogenous data exists (intraday rate-expectations/STIR/OIS, real order-flow / dealer positioning) — **cannot be tested with the repository's data**. The next step is therefore a **data-acquisition** decision, not another modelling pass: without a source that leads EUR/USD in time, there is no evidence such an edge is obtainable, and the honest position is that EUR/USD short-horizon direction is (for these datasets) **efficient and unpredictable**.

---

### Research-integrity notes
MOVE detector, split, walk-forward and labels frozen from `eurusd-move-v1` (base
rate reproduced exactly). Chronological throughout; no random splits; sealed run
once and not tuned; features grouped into pre-registered families with L2
regularisation (§21); contemporaneous correlation reported separately from forward
prediction and never fed to a model; the 81% non-causal rule is explicitly flagged
as look-ahead and used only as an upper-bound illustration; every family, window,
regime, and weak/small-sample confidence bucket is shown; the pre-registered stop
rule was honoured — no post-hoc indicator search.
