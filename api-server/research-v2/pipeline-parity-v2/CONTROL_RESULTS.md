# Pipeline Parity V2 — control result

## Verdict: PARTIAL_HISTORICAL_RULE_RECOVERED — PIPELINE_PARITY_NOT_RESTORED

A blind V2 rerun was intentionally **not performed**. Recovered provenance
invalidates reach-first selection and establishes some historical cluster and
Phase-2 behavior, but still does not define a deterministic V2 selector. Making
the remaining rules from known endpoints would violate anti-backfitting.

| Control | Classification | Reason |
|---|---|---|
| USDCHF | FAILED_TO_REDISCOVER | V1 selected 12:00 due to an invalid reach-first Phase-1 ordering. A replacement historical ranking is not evidenced. |
| EURJPY | PARTIALLY_REDISCOVERED | V1 found 06:00 LONG breakout behavior, but selected close-vs-EMA20 rather than the frozen EMA20-slope gate. No historical Phase-2 ranking evidence exists. |
| NZDUSD | NOT_RUN | Final cohort exists, but discovery-selection outputs are absent. |
| CADJPY | NOT_RUN | Final cohort exists, but discovery-selection outputs are absent. |
| NZDJPY | NOT_RUN | Final cohort exists, but discovery-selection outputs are absent. |
| USDCAD | NON_EQUIVALENT_CONTROL | Frozen result came from the Structure EMA Reclaim selected-origins/frequency workflow, not proven six-model generic discovery. |

## Gate to resume

Do not test AUDCHF or any new symbol. First recover the historical selection
artifacts listed in `SELECTION_RULES.md`; then freeze the generic V2 rules and
rerun USDCHF and EURJPY before any other discovery work.
