# Pipeline Parity V2 — selection-rule status

## Status: PARTIAL_HISTORICAL_RULE_RECOVERED — NOT FROZEN

No V2 discovery-selection rule is approved. Recovered original-conversation
records establish material USDCHF/NZDUSD behavior, but do not establish the
deterministic selector required to reconstruct a generic process. Choosing a
rule now because it makes known controls pass would be endpoint backfitting.

## Phase 1

The following candidate ordering was investigated but is **not adopted**:

1. mean absolute 3H close displacement / frozen ATR14
2. mean maximum 3H excursion / frozen ATR14
3. percentage reaching a 1 ATR excursion

It corrects the known USDCHF ordering defect relative to the prior audit's
`reach -> excursion -> displacement` sort. Recovered chat provenance shows
USDCHF and NZDUSD both used the 10:00–12:00 cluster with 11:00 primary. It does
not prove this proposed lexicographic ordering was the historical generic rule.

Therefore none of the following is frozen: hour qualification, contiguous-hour
cluster threshold, primary-hour selection inside a cluster, or secondary-hour
selection. Any numeric qualification threshold would be newly invented.

### Pareto / multi-metric check

Pure Pareto dominance cannot explain the recovered USDCHF choice. The prior
audit measured 11:00 as stronger than 12:00 on displacement and MFE, while
12:00 was stronger on reach-1R. Neither dominates the other, yet 11:00 was the
historical primary. The records therefore establish that reach-1R is a quality
confirmation rather than a primary global rank, but do not identify the
non-weighted rule that resolves this trade-off. Neighbor-hour metrics needed to
perform the same check for NZDUSD, CADJPY, and NZDJPY are not recovered.

## Phase 2

No generic model or side-ranking rule is frozen. Recovered provenance identifies
USDCHF SHORT consensus (54.34% vs 47.86% LONG) and NZDUSD LONG consensus
(56.38% vs 46.40% SHORT), while EURJPY identifies EMA20-slope LONG. This
supports favored-side accuracy and consensus agreement without a 55% cutoff,
but does not establish cross-model priority, a sample-size rule, excursion
confirmation rule, or a tie-break.

The prior audit's `largest absolute LONG/SHORT dominant-excursion gap` is
explicitly rejected as non-parity-safe. A replacement cannot be justified from
the available evidence.

## Primary → secondary procedure — FROZEN

This procedural rule is established by the recovered CADJPY record and may be
used once Phase-1 rules are independently frozen:

1. Identify and record the primary and one legitimate secondary in Phase 1,
   before Phase 2 begins.
2. Test the primary branch through Phase 3.
3. Test the recorded secondary only when the primary branch fails Phase 3.
4. Do not rescan, rank new hours, or mine further candidates after that point.

This freezes the *fallback procedure*, not the unresolved rules that select the
primary/secondary candidates.

## Minimum sample requirement

Phase 3's existing robustness floor remains `N >= 30`. No Phase-1 or Phase-2
minimum sample requirement is frozen because the historical selection records
that would establish one are absent.

## Phase 3 — unchanged mechanics

- Wilder ATR14 frozen at the completed origin H1 candle
- entry at origin close
- next three completed H1 candles only
- stop = 1 ATR; target = 2 ATR
- time exit at the close of future H1 candle #3
- UTC timestamps
- conservative stop-first handling when both barriers occur in one bar

## Required evidence before a V2 freeze

Recover a pre-final-selection artifact (or versioned script plus its immutable
output) containing, for each tested pair/hour: Phase-1 metrics, Phase-2 model
metrics by LONG/SHORT, explicit selected primary/secondary hours, and the
selection decision. Once recovered, freeze a rule **before** rerunning controls.
