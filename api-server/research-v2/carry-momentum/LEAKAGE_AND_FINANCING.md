# Carry-momentum leakage & financing audit (wave 1)

## Leakage audit — PASS (design)

| Check | Status |
| --- | --- |
| Future candle leakage | PASS — exit at entryIdx+holdBars only; features use closes ≤ signal bar |
| Yield timestamps | PASS — `availableAt` = obs+1d (daily) or first of next month (monthly) |
| Revised economic data | PASS — FRED vintage not used; OECD monthly with publication lag |
| Timezone | PASS — UTC close_time from OANDA |
| Pair sync | PASS — intersection timeline of closeTimes |
| Rolling features | PASS — lookback ends at signal bar |
| Rank construction | PASS — ranks from same-bar currency scores |
| Lookahead daily close | PASS — H1 bar close at decision; no next-day close |
| Future financing | PASS — financing estimated from PIT yields at entry, not future |
| Target overlap | PASS — stride ≥ holdBars (purged) |
| Train/dev overlap | PASS — chronological zones |
| Scaler leakage | PASS — z-score within cross-section at t only |
| Portfolio rebalance | PASS — decisions on closed bars |
| Execution prices | PASS — ask entry / bid exit (long), inverse short; skip if quote null |

## Financing limitation

Historical OANDA financing rates are **not** in the database. Net results include a **conservative estimate** from PIT yield differentials (`signedCarry × holdDays/365 × 0.01 × price`). Report gross (spread+slip only) vs estimated financing separately in experiment rows (`avgSpread`, `avgFinancing`).

## H4 / D1 data blocker

Cross-sectional universe needs many pairs. Inventory shows H4 deep history only for EUR_USD / GBP_USD / USD_JPY (and short AUD_CHF). Full 8-currency ranking on native H4 is **not feasible** without backfill. Wave used H1 with daily decision stride (24 bars) as H4/D1 proxy.
