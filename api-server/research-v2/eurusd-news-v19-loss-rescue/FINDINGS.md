# EUR/USD News V19 Loss Rescue

Verdict: **EXPLORATORY_RESCUE_FOUND_REQUIRES_PROSPECTIVE_CONFIRMATION**

## What failed

Across 59 V15 opportunities, 31 lost. 16 stopped on the entry candle, 22 stopped within 15 minutes, and 23 later touched the original target after the executable stop. 13 losing trades still had the correct net 72-hour direction. UP produced 14/22 wins; DOWN produced 14/37.

## Rescue test

The audit replayed 1743 past-observable challengers: conditional wider stops, completed-candle pullbacks, fixed delays, exact executable inversions, and abstention filters. Stored baseline reproduction: 59/59 exact matches.

Recommended simple exploratory rule: **pullback_down_surprise_0_15_0.2_20_delayed_range_0**. For weak DOWN signals, wait up to 20 minutes for a 0.2-ATR pullback and otherwise enter at the end of the window. Development moved from 14/29 targets and 9.75R to 16/29 targets and 14.25R. Reused validation moved from 14/30 targets and 9.00R to 15/30 targets and 11.25R. Combined, that is 31/59 target wins (52.54%) and 25.50R. All 28 original target wins stayed target wins.

| Release | Event | Direction | Old entry UTC | New entry UTC | Baseline | Candidate |
|---|---|---:|---:|---:|---:|---:|
| 2024-08-29 | USD Prelim GDP q/q + USD Unemployment Claims | DOWN | 12:45 | 12:55 | -0.75R | +1.50R |
| 2025-07-10 | USD Unemployment Claims | DOWN | 12:45 | 13:05 | -0.75R | +1.50R |
| 2026-02-19 | USD Unemployment Claims | DOWN | 13:45 | 14:05 | -0.75R | +1.50R |

Fixed delay, exact inversion, and filtering produced zero candidates that improved both periods while preserving the original winners. The composite adds one positive time-exit outcome, but it is only about +0.003R and requires a much wider stop; it is not treated as an additional target win. 118 nearby pullback cells improved both exposed periods. This is exploratory because both periods were exposed, and the development-only winner failed on reused validation. A new prospective sample is required before changing strategy behavior.
