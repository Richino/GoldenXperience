# EURUSD-MOVE-V1

## FINAL VERDICT

| Stage | Verdict |
|---|---|
| **Stage A — MOVE detection** | **MOVE_EDGE_FOUND (statistical only — not economically actionable)** |
| **Stage B — Direction** | **NO_DIRECTION_EDGE** |
| **Trade edge (combined + geometry + costs)** | **NO_TRADE_EDGE** |

**One-paragraph summary.** We can predict *whether* EUR/USD will travel a large
distance in ATR-normalised terms (Stage A walk-forward ROC-AUC ≈ 0.70, stable
across six windows, sealed 0.72). But that skill is essentially
**volatility-compression clustering expressed in ATR units** — it does **not**
translate into larger *absolute* moves (pip reach and the move/cost ratio are
flat across MOVE-confidence, ~60 pips / ~30× at 24h everywhere), so it gives no
economic advantage in finding bigger moves. Meanwhile **direction is not
predictable at all**: accuracy is 49% at full coverage (≤ random), and — damningly
— it *falls as confidence rises* (44.5% at the top 5%, 32.8% on sealed), with
signed returns going negative. The natural excursion geometry is symmetric
(median MFE ≈ MAE ≈ 1:1), so **1:3 is not supported by the data**. No frozen
configuration produces positive NET expectancy. This confirms and explains
`eurusdbot3-1`: the wall is direction + costs, not move magnitude.

> Reproduce: `cd api-server && npx tsx scripts/eurusd-move-v1/experiment.ts`
> Raw: [`RESULTS.json`](./RESULTS.json) · Code: [`scripts/eurusd-move-v1/`](../../scripts/eurusd-move-v1/)
> `eurusdbot3-1` was **not modified** — only its data/indicator/model/barrier/metrics modules were imported.

---

## 1. Data

- EUR/USD only, stored bid/ask candles (reused from `eurusdbot3-1`).
- H1 = 44,055 · M15 = 176,185 (path/excursion) · H4 = 10,639 · Daily = 1,459 (resampled, completed-bar-only).
- Range 2019-08-27 → 2026-08-21 (last 72h reserved so every horizon is resolvable).
- Candidates (one causal record per H1 close): **43,485** → dev 41,543 / **sealed 1,942** (2026-05-01 →).
- News: 801 high-impact EUR/USD FF events (2024-08 → 2026-07), causal only.
- Costs: ~1.5 pip median spread (in the data) + 0.5 pip slippage → **2.0 pip** round-trip used for cost-to-move.

## 2. Methodology

Two decoupled stages, both trained by **expanding-window walk-forward** (6 folds,
first 35% warmup, one-horizon embargo between train and test) and evaluated once
on a **sealed** tail. No R:R, TP or SL is imposed during discovery (§3–5); we
measure pure price behaviour first, model MOVE (§6–7) and DIRECTION (§8–9), study
the real MFE/MAE geometry (§10–14), and only then ask what exit geometry — if any —
the discovered behaviour supports (§19–20).

## 3. Move label definitions

MOVE = "one-sided reach ≥ θ·ATR within the horizon", where reach =
max(up-excursion, down-excursion) measured on the M15 path. Base rates @24h:

| θ (ATR) | 0.5 | 0.75 | 1.0 | 1.25 | 1.5 | 2.0 | 2.5 | **3.0** |
|---|---|---|---|---|---|---|---|---|
| base rate | 98% | 97% | 96% | 95% | 93% | 86% | 76% | **65%** |

EUR/USD **almost always moves** — even 1.0 ATR/24h fires 96% of the time (a tiny
threshold is a useless label). We therefore **balance-select** the primary
threshold as the one nearest a 50% base rate — **θ = 3.0 ATR @ 24h (65.1%)** — a
structural choice made with no reference to any model or to test/sealed data.

## 4. Move model results (Stage A)

| Window | Test period | train n | ROC-AUC |
|---|---|---|---|
| 1 | 2021-12 → 2022-09 | 14,499 | 0.718 |
| 2 | 2022-09 → 2023-06 | 19,013 | 0.690 |
| 3 | 2023-06 → 2024-02 | 23,503 | 0.710 |
| 4 | 2024-02 → 2024-11 | 27,981 | 0.723 |
| 5 | 2024-11 → 2025-08 | 32,534 | 0.692 |
| 6 | 2025-08 → 2026-04 | 37,003 | 0.664 |
| **OOS all** | | | **0.697** (PR-AUC 0.787) |
| **Sealed** | 2026-05 → 2026-08 | | **0.720** |

MOVE is genuinely and stably predictable. Features that carry it: ATR percentile,
compression (12/96-bar range ratio), realised vol, range contraction — i.e.
**volatility clustering / compression-before-expansion**.

## 5. Move confidence analysis — the crucial caveat

Does higher MOVE confidence mean larger realised movement? **In ATR units, yes;
in pips and in move/cost, no.** (24h, OOS)

| Coverage | avg reach (ATR) | avg reach (pips) | move/cost |
|---|---|---|---|
| 100% | 4.22 | 59.0 | 29.5× |
| 50% | 4.93 | 61.6 | 30.8× |
| 20% | 5.49 | 62.6 | 31.3× |
| 10% | 5.79 | 62.4 | 31.2× |
| 5% | 6.01 | 62.3 | 31.2× |

Reach-in-ATR climbs 42% (4.22→6.0) but **reach-in-pips is flat (~60)**. The
resolution: high MOVE-confidence selects **low-ATR compression** periods that
revert to a *normal-sized* pip expansion — large *relative* to their small entry
ATR, ordinary in absolute terms. Across horizons the pip "lift" of the top decile
is even **below 1.0× at 1–4h** (compression stays quiet short-term) and only ~1.1×
at 12–72h. **Economic conclusion: the MOVE detector does not find bigger-than-
normal moves; it finds quiet-now periods.** Move/cost is already ~30× for the
whole market at 24h — magnitude was never the binding constraint.

## 6. Direction label definitions

Two future-movement labels compared (never candle colour): **dominant excursion**
(which side reached farther) and **terminal return sign** at 24h. Both give the
same story (§7); dominant excursion is primary.

## 7. Direction results (Stage B, on MOVE-positive timestamps)

| Window | acc | | OOS AUC | 0.483 |
|---|---|---|---|---|
| 1..6 | 0.494 / 0.462 / 0.462 / 0.512 / 0.524 / 0.490 | | **Sealed AUC** | **0.435** |

Accuracy straddles 0.5 with no consistency; the OOS **AUC is below 0.5**.
**Direction is not predictable.**

## 8. Direction confidence analysis — anti-calibrated

| Coverage | accuracy | avg signed pips | MFE/MAE |
|---|---|---|---|
| 100% | 0.490 | +0.01 | 0.99 |
| 50% | 0.478 | −0.84 | 0.96 |
| 20% | 0.466 | −3.73 | 0.91 |
| 10% | 0.459 | −8.25 | 0.86 |
| 5% | 0.445 | −8.78 | 0.83 |

Accuracy **decreases** as coverage narrows and signed returns turn **negative** —
the model's most-confident direction calls are its *worst*. Confidence is not
merely uninformative, it is mildly perverse. Sealed is worse still: 43.9% → 32.8%
at the top 5%. **Selectivity does not help direction; it hurts.**

## 9. Anti-predictive signal test

Validation-chosen trend inversion (pick normal vs inverted on each fold's
validation slice, apply to test):

| Window | validation chose | test normal | test inverted |
|---|---|---|---|
| 1 | inverted | 0.491 | 0.509 |
| 2 | inverted | 0.460 | 0.540 |
| 3 | inverted | 0.473 | 0.527 |
| 4 | inverted | 0.502 | 0.498 |
| 5 | normal | 0.502 | 0.498 |
| 6 | normal | 0.553 | 0.447 |

Inversion helped in 2021–2023 and hurt in 2025–2026 — **not repeatable**.
Regime/session breakdown shows only noise-level tilts (high-vol inverted 0.514 vs
normal 0.487; Asia inverted 0.510) — ~1 point, within sampling error. **The
`eurusdbot3-1` "anti-predictive momentum" is noise, not an exploitable inversion.**

## 10. MFE/MAE analysis (the natural geometry)

**Unconditional** (prospectively achievable) median MFE vs MAE for the chosen
direction, by horizon:

| Horizon | median MFE (ATR) | median MAE (ATR) | ratio |
|---|---|---|---|
| 4h | 0.77 | 0.86 | 0.90 |
| 12h | 1.58 | 1.84 | 0.86 |
| 24h | 2.86 | 3.30 | 0.87 |
| 72h | 3.62 | 4.21 | 0.86 |

**The natural geometry is ~1:1 (slightly adverse-skewed).** A picked direction
sees about as much heat as reward — exactly what "no directional edge" implies.

> ⚠️ A *conditional-on-correct* cut looks like 5:1 (median MFE 4.71 / MAE 0.91 ATR;
> for correct trades adverse comes early ~3h, favorable late ~17h). **This is
> look-ahead/survivorship** — it conditions on already knowing the trade wins.
> Since direction is 49% predictable, it is **not achievable** and must not be
> used to justify a wide target.

## 11. Horizon analysis

MOVE predictability (AUC ~0.70) is stable across the horizon; the *pip* content
of MOVE-confidence is weak-negative intraday (1–4h) and weakly positive at 12–72h.
Direction is ~random at every horizon. Median reach grows 8→18→49→77 pips at
1/4/24/72h — movement scales with time as expected, but **direction never
resolves**.

## 12. Cost-to-move analysis

At 24h, ≥5× move/cost occurs in **97–100%** of candidates at every MOVE-confidence
level, ≥20× in ~66–71%. The ratio is **flat across confidence (~30×)** — the MOVE
detector adds nothing here. Movement dwarfs cost on its own; the money is lost on
direction, not on failing to find movement.

## 13. Session analysis

Direction accuracy by session is 49–50% everywhere (London 0.503, NY 0.496, Asia
0.490, overlap 0.504) — no session carries directional information. MOVE magnitude
is (trivially) larger in London/NY/overlap.

## 14. Volatility-regime analysis

Low-vol (ATR pct < 0.5): direction 0.503 normal / 0.498 inverted. High-vol:
0.487 / 0.514. The only faint tilt (high-vol slightly favouring inversion, ~1.3
pts) is within noise and did not survive as a repeatable walk-forward choice (§9).

## 15. News ablation

Stage A ROC-AUC: **no-news 0.6965 vs with-news 0.6947** — scheduled-news proximity
does **not** improve MOVE prediction. Direction is random with price features
alone; news was not separately modelled for Stage B because there is no direction
signal for it to sharpen (and the frozen news features already failed to help in
`eurusdbot3-1`). **News helps neither magnitude nor direction here.**

## 16. Baselines (direction, identical MOVE-positive OOS timestamps, n=17,566)

| Source | acc | Source | acc |
|---|---|---|---|
| **move-v1 model** | **0.490** | trend | 0.496 |
| random | 0.496 | inverted trend | 0.504 |
| always up | 0.495 | momentum | 0.505 |
| always down | 0.505 | inverted momentum | 0.495 |
| combined normal | 0.501 | combined inverted | 0.499 |

Everything is 49–51%. **No baseline — and not the model — beats random.**

## 17. Walk-forward windows

Reported in full in §4 (Stage A) and §7 (Stage B). No window removed; the weak
ones (e.g. Stage B W2/W3 at 0.46) are shown.

## 18. Sealed test (run once, frozen)

- Stage A AUC **0.720**, base rate 63.1% — MOVE predictability **confirmed**.
- Stage A pip monotonicity **flat** (~40–44 pips across confidence; move/cost ~20–22×) — confirms magnitude is not actionable.
- Stage B AUC **0.435**, accuracy 43.9% → **32.8%** at top-5% confidence, signed pips negative — **direction failure confirmed, and worse under confidence.**

## 19. Data-derived R:R analysis

Unconditional geometry (§10) is ~**1:1**. **1:3 is not supported by EUR/USD's
actual excursions** for a prospectively-chosen direction — it only appears if one
could pre-select winners (which the direction model cannot). The excursion data
says a symmetric 1:1-ish structure is the natural fit — and even that is
loss-making once direction is a coin flip and costs apply.

## 20. NET trade simulation (frozen predictions — reported as evidence, edge absent)

Top-20%-confidence direction picks (MOVE-positive), 1.0 ATR stop, sweep TP, NET
of spread + 0.5 pip slippage:

| R:R | trades | WR | Net exp | PF |
|---|---|---|---|---|
| 1:1 | 3,513 | 41.8% | −0.202 R | 0.67 |
| 1:1.5 | 3,513 | 34.1% | −0.186 R | 0.73 |
| 1:2 | 3,513 | 30.1% | −0.136 R | 0.81 |
| 1:2.5 | 3,513 | 27.7% | −0.070 R | 0.91 |
| 1:3 | 3,513 | 25.6% | **−0.012 R** | 0.98 |

**Every R:R is NET-negative.** 1:3 is merely the least-negative (≈ breakeven-minus-
costs, WR 25.6% ≈ the 25% random-walk barrier) — the identical spread-dominated
wall found in `eurusdbot3-1`. No account simulation is run (edge is not positive).

## 21. Failure analysis — what exactly failed

- **Move detection: partial success but economically inert.** Predictable in ATR
  terms (compression clustering), flat in pips and move/cost. Right that "moves
  happen"; useless for finding *bigger* moves.
- **Direction: the decisive failure.** ≤ random at every coverage, session,
  regime, and horizon; confidence is anti-calibrated. No inversion is repeatable.
- **Exit geometry: mis-specified by prior hypothesis.** The natural excursion is
  ~1:1, not 1:3.
- **Costs: the finisher.** With a coin-flip direction, the ~2-pip round-trip turns
  a ~breakeven gross into a reliable net loss at every R:R.
- Net: **multiple components fail, but direction is the root cause.** Movement and
  cost-headroom are fine; there is simply no exploitable information about *which
  way*.

## 22. FINAL VERDICT

**MOVE_EDGE_FOUND (statistical, not actionable) · NO_DIRECTION_EDGE · NO_TRADE_EDGE.**
Do **not** proceed to paper trading. EUR/USD's *timing* of large ATR-relative
moves is predictable; its *direction* is not, at any horizon, session, regime, or
confidence level tested — and the natural geometry plus costs give no tradeable
structure.

---

## Direct answers to the 20 final questions

1. **Predict when EUR/USD makes a meaningful move?** Statistically yes (AUC ~0.70, stable, sealed 0.72) — but it detects *quiet/compression* periods that revert to normal-sized pip moves, not larger-than-normal moves.
2. **Horizon where MOVE predictability is strongest?** Roughly flat 0.66–0.72 AUC across windows; label is most *balanced* at 24h. Pip-magnitude signal is weakly best at 12–72h and weak-negative at 1–4h.
3. **Does MOVE confidence correlate with actual displacement?** In ATR units yes (+42% top-vs-all); **in pips essentially no (flat ~60 pips)**; move/cost flat ~30×.
4. **After MOVE, predict UP vs DOWN better than random?** No — 49.0% OOS, 43.9% sealed (≤ random).
5. **Directional accuracy at 100/50/30/20/10%:** 0.490 / 0.478 / 0.480 / 0.466 / 0.459 (sealed: 0.439 / 0.436 / 0.429 / 0.388 / 0.333). It *falls* with coverage.
6. **Does directional confidence mean anything?** Yes — perversely: higher confidence → **lower** accuracy and **negative** signed returns.
7. **Were the anti-predictive trend/momentum signals genuinely invertible?** No — inversion helped 2021–23, hurt 2025–26; not repeatable; regime tilts are noise-level.
8. **Strongest repeatable information?** Volatility/compression → **MOVE magnitude (in ATR)**. Nothing repeatable for **direction**.
9. **Does news improve MOVE prediction?** No (AUC 0.6965 → 0.6947).
10. **Does news improve DIRECTION prediction?** No basis for it — direction is random; news failed to help in the frozen prior experiment too.
11. **Median MFE / MAE for correct high-confidence predictions?** Conditional-on-correct 4.71 / 0.91 ATR (**look-ahead — not achievable**); **unconditional ~2.86 / 3.30 ATR at 24h (~1:1)**.
12. **What R:R naturally fits?** ~**1:1** (unconditional geometry), slightly adverse-skewed.
13. **Is 1:3 supported, or too ambitious?** **Not supported** — too ambitious; it only "fits" survivorship-selected winners.
14. **Predicted movement vs costs?** Large (~30× at 24h) — but flat across confidence, so no *incremental* advantage. Magnitude is not the problem.
15. **Survive walk-forward?** MOVE yes (0.66–0.72 all windows). DIRECTION no.
16. **Survive sealed?** MOVE yes (0.72). DIRECTION no (0.435, degrades with confidence).
17. **Any frozen config with positive NET expectancy?** **No** (best −0.012 R at 1:3).
18. **Proceed to forward paper trading?** **No.**
19. **What failed — move / direction / geometry / costs / multiple?** **Multiple, root cause = direction.** Move detection is inert-not-broken; geometry was mis-hypothesised (really ~1:1); costs finish off a coin-flip direction.
20. **Single highest-value next experiment?** Stop trying to predict *direction* from EUR/USD price/vol/news at H1–D1 — the evidence across two experiments says it isn't there. The one remaining unexplored lever is an **exogenous directional signal** (e.g. cross-asset / rate-differential / DXY-basket lead-lag, or order-flow/positioning data) tested *only* on the compression-detected MOVE windows this experiment can already identify. If a genuine direction signal exists anywhere, that is where it would pay off — because the movement and the cost headroom are already there; only the arrow is missing.

---

### Research-integrity notes
Chronological throughout; no random splits; MOVE threshold balance-selected (not tuned on skill); thresholds/models fit on train/validation only; sealed evaluated once and not tuned against; no look-ahead (HTF completed-only, news causal); the tempting 5:1 conditional-on-correct geometry is explicitly flagged as unusable; every walk-forward window, weak confidence bucket, and failed horizon is shown.
