# Historical selection reconstruction

## Evidence reviewed

`REPOSITORY_PROVENANCE` is committed repository material. `RECOVERED_CHAT_PROVENANCE` is the supplied original-research conversation record, which predates this audit and is preserved separately in `RECOVERED_CHAT_PROVENANCE.md`.

| Pair | Frozen final origin/rule | Selection provenance present? | Comparable generic control? |
|---|---|---|---|
| USDCHF | 11:00 SHORT, consensus <= -3, LH+LL | Recovered cluster and Phase-2 metrics | Yes, mandatory once rules are complete |
| EURJPY | 06:00 LONG, EMA20 slope, previous-high + pre-range break | Recovered origin/model only | Yes, mandatory once rules are complete |
| NZDUSD | 11:00 LONG, consensus >= +3, HH+HL | Recovered cluster and Phase-2 side metrics | Likely, but not yet provable |
| CADJPY | 12:00 LONG, consensus, previous-high break, body/outer-25% | Recovered primary failure and secondary process | Likely, but not yet provable |
| NZDJPY | 23:00 LONG, consensus, body/outer-25%, 0.10 ATR break | Recovered cluster and Phase-2 side metrics | Likely, but not yet provable |
| USDCAD | 11:00 LONG, Structure EMA Reclaim V3 | Older selected-origins/frequency workflow | **No — NON_EQUIVALENT_CONTROL** |

## What can be reconstructed

The frozen registries prove final implementation rules, entry hour, ATR
definition, and 3-H1 exit geometry. Recovered chat provenance supplies limited
USDCHF/NZDUSD Phase-1/2 selection data. The relevant directories were introduced
together by commit `205ea37`; repository history contains no earlier committed
discovery scorecards for these pairs.

## Phase 1 finding

Recovered provenance shows USDCHF and NZDUSD selected the 10:00–12:00 cluster
with 11:00 primary. The prior runner placed USDCHF 12:00 ahead only because it
sorted reach-1R first. This invalidates reach-first ranking; it does not prove
a generic within-cluster primary-hour rule.

The requested Pareto check is negative as a complete selector: USDCHF 11:00
beats 12:00 on displacement/MFE but loses on reach-1R, so neither hour is
Pareto-dominant. Historical selection of 11:00 proves reach was confirmation,
not a deciding global rank. The recovered NZDUSD, CADJPY, and NZDJPY records
provide selected-hour metrics but not their neighboring-hour metrics, so they
cannot establish a broader non-weighted dominance rule.

## Phase 2 finding

The final cohorts demonstrate these final model families:

- USDCHF / NZDUSD: four-vote consensus + directional structure.
- EURJPY: EMA20 slope + breakout.
- CADJPY / NZDJPY: consensus + breakout/body-extreme rules.

USDCHF and NZDUSD show that the selected consensus side was the better-accuracy
side (54.34% SHORT vs 47.86% LONG; 56.38% LONG vs 46.40% SHORT). USDCHF also
records 50.61% overall and 60.20% predicted-side reach-1R. Competing-model
tables remain unavailable, so a generic cross-model priority cannot be frozen.

NZDUSD additionally proves the chosen consensus model was not selected for the
highest overall accuracy: EMA20-vs-EMA50 had 52.31% overall versus consensus
50.98%, while consensus had the clearer LONG/SHORT separation (56.38% / 46.40%).
CADJPY and NZDJPY further support consensus where it produces strong favored-side
separation. They do not supply sample sizes or every competing-model table, so
“meaningful” separation and the cross-model tie-break remain undefined.

## Procedural fallback finding

The CADJPY record establishes a historical pre-commitment: Phase 1 identified
11:00 primary and 12:00 secondary before direction/trade testing. The 11:00
branch failed Phase 3; only the already identified 12:00 branch was then tested.
No arbitrary further-hour search occurred. This procedure is generic and is
frozen in `SELECTION_RULES.md`; it does not establish how the two candidates
were originally selected.

## USDCAD caveat

USDCAD's registry explicitly supersedes `USDCAD_STRUCTURE_EMA_RECLAIM_V2_SELECTED_ORIGINS` and its report calls it a Structure EMA Reclaim selected-origins strategy. It is not evidence that the six-model generic pipeline historically selected 11:00 LONG. It must not influence V2 generic selection rules.
