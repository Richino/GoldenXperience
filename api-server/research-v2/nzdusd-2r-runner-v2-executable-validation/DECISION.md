# NZDUSD Corrected 2R Runner V2 — final research decision

Status: **NZDUSD_RUNNER_V2_REJECTED**
Classification: **NO_RUNNER_EDGE**
Frozen base: **FROZEN_V1_UNCHANGED**

## Decision

The runner overlay (only trades reaching executable +2R keep running: activation +2.00R, protected floor +1.80R, trail 0.20R behind executable MFE, 48h max lifetime) does **not** improve the frozen NZDUSD Bull Consensus Structure V1 exit and is **rejected**. Entry rules were not changed; the frozen strategy is untouched.

Under the spec-mandated conservative primary chronology the runner returns **+0.1582R/trade** versus the frozen **+0.1898R/trade** — a delta of **−0.0316R/trade** (−3.1609R total). It is worse than frozen in every year. This is **NOT** a RUNNER_CANDIDATE_FOR_PORTFOLIO_TEST and must not replace the frozen exit.

## Evidence (exact validation figures — do not force parity with the TradingView diagnostic)

| Metric | Frozen EXEC | Runner EXEC (conservative primary) |
|---|---:|---:|
| Trades | 100 | 100 |
| Win rate | 48.00% | 48.00% |
| Profit factor | 1.380 | 1.317 |
| Total R | +18.9782R | +15.8173R |
| Expectancy R/trade | +0.1898R | +0.1582R |
| Average winner R | +1.4359R | +1.3700R |
| Average loser R | −0.9605R | −0.9605R |

- Baseline parity gate: **PASS** (100 matched / 48.00% / 1.380 / +18.9782R / +0.1898R).
- Non-runner parity: **73/73 exact**, 0 mismatches (activation = the frozen +2R target, so non-runners inherit the frozen result by construction).
- Runners: **27/100**. Conservative average **+1.8116R**, median **+1.8000R**, max **+2.0395R**. Baseline +2R winners converted: 27; runner < baseline: 26; runner ≈ baseline: 0. Conservative ≥+2.5R / ≥+3R / ≥+4R / ≥+5R: **0 / 0 / 0 / 0**.
- Extension gain **+0.1059R** against a giveback of **−3.2668R** on the +2R winners → net **−3.1608R**.

## Optimistic bound is not evidence of an edge

The optimistic ceiling is +0.2438R/trade (Δ +0.0540). It is not repeatable: **16 of 27** runner trades contain same-minute MFE/stop ambiguity, and trades **42 and 24 alone contribute ~+5.22R of the ~+5.40R** optimistic improvement. Both are 12:30 UTC US-data spikes. The optimistic bound is a two-trade artifact, not a trailing edge.

## M1 resolution limit — preserved, not resolved

The 0.20R trail is ~1.8–3.6 pips on the tested trades, frequently smaller than the movement inside a single OANDA M1 candle. Hence 16/27 runners are intraminute-ambiguous and the conservative/optimistic bounds straddle the frozen expectancy. Resolving the exact chronology would require OANDA **tick** bid/ask. Tick ordering was **not fabricated**. This limitation is preserved as-is.

## Overnight finding

No runner crossed the 17:00 New York rollover; none remained open in the 6-12h, 12-24h, or 24-48h buckets; the longest runner was ~3.82h (even optimistically). The 48h cap never bound. There is **no evidence** that letting NZDUSD winners run overnight improves performance. All figures are **EXEC BEFORE FINANCING** (no financing fabricated).

## Year stability (preserved exactly — do not add a year filter)

| Year | Trades | Runners | Frozen PF | Frozen Total R | Frozen Exp | Runner PF | Runner Total R | Runner Exp |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2023 | 33 | 9 | 1.198 | 3.6398R | 0.1103R | 1.130 | 2.3940R | 0.0725R |
| 2024 | 23 | 9 | 1.649 | 7.7353R | 0.3363R | 1.556 | 6.6250R | 0.2880R |
| 2025 | 27 | 4 | 0.926 | −1.0433R | −0.0386R | 0.909 | −1.2960R | −0.0480R |
| 2026 | 17 | 5 | 2.577 | 8.6464R | 0.5086R | 2.477 | 8.0943R | 0.4761R |

## No post-hoc optimization

This development sample must **not** be reused to test 0.25R / 0.30R / 0.40R / 0.50R trails, a different activation threshold, a different floor, or a different maximum runner duration. Any future runner design is a separate research hypothesis requiring new out-of-sample evidence.

## Frozen NZDUSD status — unchanged

**GX NZDUSD Bull Consensus Structure V1** remains the approved research/paper candidate. Frozen EXEC benchmark stays **+0.1898R/trade, PF 1.380, 48.00% WR**. Exit stays **−1R stop, +2R target, 3H max hold**. No trailing stop, break-even, or profit lock is adopted.

No deployment. No broker orders. No exit optimization. This research candidate remains distinct from the `NZDUSD_PRE_RANGE_BREAKOUT_V1` runtime configuration, which was not touched.
