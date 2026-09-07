# Recovered chat provenance

## Status

`RECOVERED_CHAT_PROVENANCE` is historical source evidence supplied from the
original research conversations and stated to predate this parity audit. It is
not a post-audit selection target. It is distinct from `REPOSITORY_PROVENANCE`,
which consists of committed reports, registries, code, and validation artifacts.

## USDCHF

- Phase 1: primary **11:00 UTC**; movement cluster **10:00–12:00 UTC**
- 11:00 movement: displacement **1.557R**, MFE **2.540R**, reach-1R **93.07%**
- Phase 2: **4-vote consensus**, **SHORT**, consensus <= -3
- Phase 2: overall **50.61%**; LONG **47.86%**; SHORT **54.34%**;
  predicted-side reach-1R **60.20%**
- Phase 3 bear structure: approximately **+0.408R/trade** pre-cost

This proves the prior reach-first rank is wrong: the prior audit measured a
slightly higher reach-1R rate at 12:00, but the original process selected 11:00.

## NZDUSD

- Phase 1: primary **11:00 UTC**; movement cluster **10:00–12:00 UTC**
- 11:00 movement: displacement **1.317R**, MFE **2.187R**, reach-1R **89.09%**
- Phase 2: **4-vote consensus**, **LONG**, consensus >= +3
- Phase 2: LONG **56.38%**; SHORT **46.40%**
- Phase 3 bull structure: N=102, WR=52.94%, PF=1.903,
  **+0.384R/trade** pre-cost

## EURJPY

- Phase 1 primary: **06:00 UTC**
- Phase 2: **EMA20 slope**, **LONG**
- Phase 3: previous-high breakout
- Phase 4/final: 01:00–05:00 UTC range breakout

The original Phase-1 and complete Phase-2 scorecards have not been recovered.
No missing metric is inferred from the frozen final cohort.

## CADJPY

- Phase 1 cluster: **10:00–13:00 UTC**; primary **11:00 UTC**
- 11:00 movement: displacement **1.454R**, MFE **2.321R**, reach-1R **90.14%**
- 11:00 Phase 2 favored LONG; EMA + price LONG accuracy approximately **56.68%**
- The 11:00 Phase-3 branch failed across all recorded checks.
- The pre-identified secondary **12:00** was then tested—no additional hours
  were searched. Its 4-vote consensus branch favored LONG: **58.61%** LONG
  versus **45.40%** SHORT. That branch became the frozen strategy.

## NZDJPY

- Phase 1 cluster: **22:00–00:00 UTC**; primary **23:00 UTC**
- 23:00 movement: displacement **1.212R**, MFE **1.896R**, reach-1R **86.79%**
- Phase 2: 4-vote consensus, LONG; **58.14%** LONG versus **44.79%** SHORT

## Supported conclusion

The evidence supports cluster-based—not reach-first—Phase 1 behavior, and a
pre-identified primary→secondary fallback. It also supports favored-side
accuracy and consensus agreement as Phase-2 considerations, without a 55%
cutoff and without maximizing overall accuracy. It does **not** establish a
generic within-cluster primary-hour rule, a cluster qualification threshold, a
cross-model ranking, an adequate-N rule, or a tie-break.
