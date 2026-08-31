# binary-double-bollinger-1m-v1 — FINAL REPORT

# VERDICT: `NO_EDGE`

The "double Bollinger → rejection → momentum confirmation → 1-minute reversal"
method shows **no evidence of next-minute directional edge** on 12 major FX
pairs over the last 12 complete trading days. Every component variant with a
usable sample size sits within statistical noise of 50%, and **adding the
momentum confirmations (Heikin Ashi, Stochastic, CCI, ADX) does not improve the
BB-only result — the two most selective additions (Heikin Ashi and ADX) make it
worse.** No variant's 95% CI reaches the 55.6% break-even required for an 80%
binary payout; every variant has negative expectancy at all payouts from 70% to
90%.

> This is a research artifact only. Nothing here is integrated into any live,
> adaptive, or binary engine, and per the brief nothing will be regardless of
> outcome.

---

## Dataset

| Field | Value |
| ----- | ----- |
| Source | OANDA practice `/v3/instruments/{pair}/candles`, `price=M` (mid), `granularity=M1` |
| Fetched | 2026-08-29 (candles complete through 2026-08-28 20:59 UTC, Friday close) |
| Trading days (12, UTC) | 2026-08-13, -14, -17, -18, -19, -20, -21, -24, -25, -26, -27, -28 |
| Window start | 2026-08-13T00:00Z (first selected-day candle) |
| Window end | 2026-08-28T20:59Z |
| Pairs (12) | EUR/USD, GBP/USD, USD/JPY, AUD/USD, NZD/USD, USD/CAD, USD/CHF, EUR/GBP, EUR/JPY, GBP/JPY, AUD/JPY, EUR/AUD |
| Candle type | Market M1 OHLC (mid). Heikin Ashi computed from it for the HA confirmation only; **settlement uses actual market mid price, never HA.** |

The 12 pairs are exactly the project's `STREAM_INSTRUMENTS` universe — no
substitution, no synthetic data.

### Per-symbol coverage (selected 12 days only)

| Pair | M1 candles | Intra-window gaps >1m | Max gap (min) |
| ---- | ---------: | --------------------: | ------------: |
| EUR/USD | 16645 | 62 | 3061 |
| GBP/USD | 16673 | 39 | 3061 |
| USD/JPY | 16668 | 37 | 3061 |
| AUD/USD | 16547 | 134 | 3061 |
| NZD/USD | 16564 | 103 | 3061 |
| USD/CAD | 16661 | 47 | 3061 |
| USD/CHF | 16600 | 98 | 3061 |
| EUR/GBP | 16518 | 170 | 3061 |
| EUR/JPY | 16684 | 25 | 3061 |
| GBP/JPY | 16688 | 22 | 3061 |
| AUD/JPY | 16678 | 27 | 3061 |
| EUR/AUD | 16695 | 19 | 3061 |

The two ~3061-minute gaps per pair are the weekends inside the window
(Fri 21:00 → Mon 00:00). Sub-hour gaps are illiquid minutes with no ticks. A
signal is only settled when the immediately following minute exists
(`entryTime − signalClose = 60s`); signals straddling any gap are skipped, so
gaps cannot leak into settlement.

---

## Overall Full-Method Result (variant I)

| | |
| --- | --- |
| Signals | 28 (25 decided, 3 ties) |
| Wins | 8 |
| Losses | 17 |
| Ties | 3 |
| Win Rate | **32.0%** (Wins / (Wins+Losses)) |
| 95% CI (Wilson) | 17.2% – 51.6% |

**The full five-indicator method fires only 28 times in 200k+ candle-minutes and
is `INSUFFICIENT_SAMPLE` on its own.** Its point estimate is below 50%, and its
CI does not reach break-even at any payout. The meaningful conclusion comes from
the high-sample component variants below, not from this degenerate full stack.

---

## Results By Pair

Win-rate formula: `WR = Wins / (Wins + Losses)`; ties excluded from the
denominator and reported separately.

### Full method (variant I) — sample too small per pair

| Pair | Signals | Wins | Losses | Ties | WR |
| ---- | ------: | ---: | -----: | ---: | -: |
| EUR/USD | 0 | 0 | 0 | 0 | — |
| GBP/USD | 0 | 0 | 0 | 0 | — |
| USD/JPY | 3 | 1 | 1 | 1 | 50.0 |
| AUD/USD | 0 | 0 | 0 | 0 | — |
| NZD/USD | 4 | 1 | 2 | 1 | 33.3 |
| USD/CAD | 3 | 2 | 1 | 0 | 66.7 |
| USD/CHF | 3 | 0 | 3 | 0 | 0.0 |
| EUR/GBP | 1 | 0 | 0 | 1 | — |
| EUR/JPY | 4 | 1 | 3 | 0 | 25.0 |
| GBP/JPY | 3 | 1 | 2 | 0 | 33.3 |
| AUD/JPY | 3 | 0 | 3 | 0 | 0.0 |
| EUR/AUD | 4 | 2 | 2 | 0 | 50.0 |

Every cell here is `INSUFFICIENT_SAMPLE`. Do not read anything into 66.7% (2/3)
or 0.0% (0/3).

### Primary broad variant A (BB2 rejection) — the sample that actually informs

| Pair | Signals | Wins | Losses | Ties | WR |
| ---- | ------: | ---: | -----: | ---: | -: |
| EUR/USD | 1906 | 870 | 839 | 197 | 50.9 |
| GBP/USD | 2208 | 1019 | 984 | 205 | 50.9 |
| USD/JPY | 2148 | 985 | 1007 | 156 | 49.4 |
| AUD/USD | 1639 | 738 | 693 | 208 | 51.6 |
| NZD/USD | 1766 | 797 | 767 | 202 | 51.0 |
| USD/CAD | 1920 | 883 | 840 | 197 | 51.2 |
| USD/CHF | 1688 | 810 | 735 | 143 | 52.4 |
| EUR/GBP | 2250 | 882 | 868 | 500 | 50.4 |
| EUR/JPY | 2591 | 1210 | 1219 | 162 | 49.8 |
| GBP/JPY | 2600 | 1230 | 1238 | 132 | 49.8 |
| AUD/JPY | 2477 | 1141 | 1176 | 160 | 49.2 |
| EUR/AUD | 2507 | 1200 | 1139 | 168 | 51.3 |

Range 49.2%–52.4%. The best pair (USD/CHF, 52.4% on n=1545 decided) has a 95% CI
of roughly 49.9%–54.9% — it still includes 50% and never reaches the 55.6%
break-even. The distribution is a tight cloud around a coin flip.

---

## Best Component Variant

Ranked by decided-sample win rate, with expectancy at an 80% payout
(`EV = WR·0.80 − (1−WR)`, break-even 55.56%):

| Variant | Description | Trades | Decided | Wins | Losses | Ties | WR | 95% CI | EV@80% |
| ------- | ----------- | -----: | ------: | ---: | -----: | ---: | -: | ------ | -----: |
| B | BB3 rejection only | 4147 | 3770 | 1947 | 1823 | 377 | **51.6%** | 50.0–53.2 | −0.070 |
| E | BB rejection + CCI | 12944 | 11752 | 5953 | 5799 | 1192 | 50.7% | 49.8–51.6 | −0.088 |
| A | BB2 rejection only | 25700 | 23270 | 11765 | 11505 | 2430 | 50.6% | 49.9–51.2 | −0.090 |
| D | BB rejection + Stochastic | 6688 | 6041 | 3048 | 2993 | 647 | 50.5% | 49.2–51.7 | −0.092 |
| C | BB rejection + Heikin Ashi | 1487 | 1349 | 630 | 719 | 138 | 46.7% | 44.1–49.4 | −0.159 |
| F | BB rejection + ADX | 99 | 87 | 40 | 47 | 12 | 46.0% | 35.9–56.4 | −0.172 |
| G | BB + HA + Stochastic | 783 | 705 | 318 | 387 | 78 | 45.1% | 41.5–48.8 | −0.188 |
| H | BB + HA + Stoch + CCI | 778 | 701 | 316 | 385 | 77 | 45.1% | 41.4–48.8 | −0.189 |
| I | FULL (all five) | 28 | 25 | 8 | 17 | 3 | 32.0% | 17.2–51.6 | −0.424 |

The "best" variant is **B (BB3 rejection), at 51.6%** — but its CI (50.0–53.2%)
barely clears 50% and falls far short of every payout break-even. Its edge over
BB2 (50.6%) is +1.0pp with heavily overlapping CIs: not significant. Every
variant has **negative expectancy at 70%, 75%, 80%, 85%, and 90% payouts** (see
`RESULTS.json → variants[*].ev`).

Ordering by sample size instead of raw WR (to avoid rewarding small-n noise), the
only variants with tight enough CIs to trust — A, B, D, E (n = 3.7k–23k) — all
land in 50.5%–51.6%. C, F, G, H, I are progressively smaller and progressively
worse, which is the opposite of what an edge that "stacks" would show.

---

## BB2 vs BB3

| Extension | Decided | WR | 95% CI |
| --------- | ------: | -: | ------ |
| BB2 touch/rejection (variant A) | 23270 | 50.6% | 49.9–51.2 |
| Between BB2–BB3 | 22006 | 50.7% | 49.9–51.4 |
| BB3 touch (no rejection) | 0 | — | definitionally empty* |
| BB3 penetration + rejection (variant B) | 3770 | 51.6% | 50.0–53.2 |

*On M1, essentially every candle whose high pierced the 3σ band also closed back
inside it within the same minute (a wick, not a body), so the rejection-based
candidate set contains no "touched BB3 but closed beyond it" rows. See notes.

**Greater statistical extension buys almost nothing.** Going from the 2σ cloud
(50.6–50.7%) to a full 3σ penetration-and-rejection (51.6%) adds ~1 percentage
point, well inside the combined confidence intervals. This is the closest thing
to a signal in the entire study, and it is not statistically distinguishable
from noise, nor is it profitable at any modeled payout.

---

## Binary Profitability

Break-even `WR = 1 / (1 + payout)`:

| Payout | Break-even WR | Best variant (B, 51.6%) beats it? | BB2 (A, 50.6%)? |
| -----: | ------------: | --------------------------------- | --------------- |
| 70% | 58.82% | No | No |
| 75% | 57.14% | No | No |
| 80% | 55.56% | No | No |
| 85% | 54.05% | No | No |
| 90% | 52.63% | No | No |

No variant clears break-even at **any** payout, including the generous 90% case.
A 51.6% strategy is not "profitable because it beats a coin flip" — against an
80% payout it loses ~7 cents per dollar risked.

---

## Direction

Full method (n=25) splits UP 45.5% (n=11) / DOWN 21.4% (n=14) — both
`INSUFFICIENT_SAMPLE`. On the informative variant A sample there is **no durable
directional asymmetry**: per-pair UP and DOWN win rates both scatter around 50%
(UP range 48.4%–54.1%, DOWN range 47.9%–53.4%), with the higher side flipping
pair to pair (e.g. NZD/USD favours UP 54.1%, AUD/USD favours DOWN 53.4%). No
consistent "works better long" or "works better short" effect survives across
pairs.

---

## Session / Time

Variant A by session (UTC hour buckets):

| Session | Decided | WR |
| ------- | ------: | -: |
| Asia (21–06) | 8672 | 51.3% |
| London (07–11) | 5272 | 49.4% |
| London/NY overlap (12–15) | 4523 | 50.1% |
| New York (16–20) | 4803 | 50.9% |

Daily variant-A WR ranges 49.0%–54.3% across the 12 days with no standout. The
effect is **not concentrated** in any session, hour, or day — it is a uniform
~50% everywhere, which is exactly the fingerprint of no edge rather than a
regime-specific edge being averaged away. (Full per-hour and per-day tables in
`RESULTS.json` and `DAILY_RESULTS.csv`.)

### Interpretation tests (source description is ambiguous — labeled as such)

Stochastic neutral-zone gating on the BB+Stoch base (require the cross to
originate from an extreme): unrestricted 50.5% (n=6041), 20/80 zone 50.7%
(n=5064), 30/70 zone 50.6% (n=5730) — no improvement. CCI zone gating on the
BB+CCI base: unrestricted 50.7%, |CCI|>100 51.1%, |CCI|>200 52.3% (n=325, wide
CI). None reach break-even. These confirm the neutral-zone choice does not
rescue the method.

---

## Lookahead Audit

**No future information enters signal generation.** Verified points:

1. **Indicator causality.** BB(20,2/3), Stochastic(6,3,3), CCI(21), ADX/DMI and
   Heikin Ashi are all computed with strictly backward-looking windows; the value
   at index `i` uses only candles `≤ i`. All are single-pass, left-to-right.
2. **Signal on completed candle.** A signal is recognized on candle `i` only
   after it has closed. Every field tested (`high/close` vs bands, HA colour of
   `i` and `i-1`, %K/%D cross at `i`/`i-1`, CCI slope `i` vs `i-1`, DI/ADX at
   `i`/`i-1`) references candle `i` or earlier — never `i+1`.
3. **Entry after confirmation.** Entry price is `open[i+1]` (the first price of
   the minute *after* the signal candle closed) — the strategy never enters "into"
   the signal candle it just read.
4. **Settlement 60s later.** Expiry price is `close[i+1]`, exactly 60 seconds
   after entry, using **actual market mid** — the synthetic Heikin Ashi close is
   never used for settlement.
5. **No gap leakage.** Settlement requires `time[i+1] − time[i] == 60000ms`;
   any signal whose next minute is missing (weekend, illiquid gap) is dropped, so
   a "60-second" trade can never silently span a gap.
6. **Band/indicator warmup.** Iteration starts at `i = 21`, after BB/CCI/Stoch
   warmup, so no signal is emitted on a partially-formed indicator.

No place in the pipeline recognizes a reversal using candle `i` and then pretends
entry happened before `i` closed.

---

## Plain answers

1. **Does the exact full method show a next-minute directional edge?** No.
   32.0% on 25 decided trades — below chance and `INSUFFICIENT_SAMPLE`; the
   informative components are all ~50%.
2. **How many signals?** Full method: 28 (25 decided). Across all A–I variants:
   28,432 signal-instances logged.
3. **Overall WR?** Full method 32.0%; the trustworthy broad variants 50.5–51.6%.
4. **Best pairs?** USD/CHF (52.4%), AUD/USD (51.6%), EUR/AUD (51.3%) on variant
   A — all within noise of 50%.
5. **Worst pairs?** AUD/JPY (49.2%), USD/JPY (49.4%), EUR/JPY & GBP/JPY (49.8%).
6. **Did BB3 rejection beat BB2?** Marginally (51.6% vs 50.6%, +1.0pp), CIs
   overlap — not statistically significant, not profitable.
7. **Did Stochastic improve BB-only?** No (50.5% vs 50.6%, essentially flat).
8. **Did CCI improve results?** No (50.7% vs 50.6%, negligible).
9. **Did ADX improve results?** No — it *degrades* to 46.0% (n=87, and small).
10. **Did Heikin Ashi improve results?** No — it *degrades* to 46.7%.
11. **Most incremental predictive value?** None positive. The only marginally
    positive lever is raw BB3 extension (+1.0pp), and it is not significant.
    Among the confirmations, CCI is the least harmful.
12. **Least value?** Heikin Ashi and ADX — both actively hurt, and stacking them
    (variants G/H/I) drives WR down to 45% and then 32%.
13. **Broad or concentrated?** Broadly, uniformly ~50% across all 12 pairs and
    all sessions — i.e. broadly *no* edge, not a concentrated one.
14. **Beat break-even at 80% payout (55.56%)?** No variant does, at any payout.
15. **Justify a much larger historical sample?** **No.** The high-sample
    components (A/B/D/E, n = 3.7k–23k) already pin the win rate at 50–51.6% with
    tight CIs; more data would only shrink the interval around ~51%, still below
    every payout break-even. The confirmations subtract rather than add. There is
    no positive signal to scale. A larger sample is not warranted for this
    price-only method.

---

*Artifacts: `RESULTS.json`, `TRADES.csv` (28,432 rows, fully auditable),
`PAIR_RESULTS.csv`, `VARIANT_RESULTS.csv`, `DAILY_RESULTS.csv`,
`IMPLEMENTATION_NOTES.md`. Reproduce with `node fetch.mjs <cache>` then
`node run.mjs <cache> <outDir>`.*
