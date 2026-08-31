# EUR/USD News V13 Spread Gate

Verdict: **NO_DEVELOPMENT_GATE_VALIDATION_NOT_USED**

This challenger does not modify V12 or authorize orders. It tests whether spread relative to the ATR stop is an execution-quality gate. Development selected no threshold. Validation was not used.

## Loss diagnosis

Across the descriptive 35-trade V13 sample, 21 trades lost. 19 stopped on the entry M5 candle and the remaining 2 stopped within five minutes. The two M5 candles that touched both levels were checked with M1 bid/ask candles; both touched the stop first.

Direction alone does not explain the losses: 10 losing trades still had the correct net direction after 72 hours, while 11 were wrong at the 72-hour close. Inverting every losing signal would only have won 6 times and would also have lost 15 times. The original target was touched later in 20 of 21 losses, after the executable stop had already occurred.

The dominant observed failure is therefore entry/stop geometry during post-news two-sided volatility. The fixed one-ATR stop is typically only about four pips, while 19 of 21 losing entries occurred after confirmation had already traveled at least one ATR. This is diagnosis, not proof that simply widening the stop is profitable; a wider stop changes risk, target distance, holding time, and expectancy and needs a matched replay.

## Exploratory conditional fix

Rule: only when direction is DOWN and surpriseStrength<0.25, set stop distance to max(pre-release ATR, 0.5 * first-15-minute post-release range); retain the 2:1 target-to-stop geometry; all other opportunities use V13 unchanged.

- Development: 8/15 wins, 6.75R, PF 2.286.
- Reused validation: 8/20 wins, 3.00R, PF 1.333.
- Combined descriptive sample: 16/35 wins, 9.75R, PF 1.684.
- Conversion: all 14 original winners stayed wins; 2 original losses became wins.

identified after both periods were exposed; descriptive only and not eligible for promotion without a new prospective sample.

| Release | Direction | Baseline | Candidate | Candidate stop pips |
|---|---:|---:|---:|---:|
| 2024-11-22 | DOWN | -0.75R | 1.50R | 13.72 |
| 2025-09-25 | DOWN | -0.75R | 1.50R | 18.37 |

## Frequency expansion

The highest-frequency rule that held the original combined 45.71% win-rate floor in both exposed yearly periods uses surprise strength >=0.035, ATR <=6 pips, 15-minute confirmation, and a 4-hour event cooldown. Execution and the conditional weak-short stop remain unchanged.

| Sample | Trades | Wins | Win rate | Total R | PF |
|---|---:|---:|---:|---:|---:|
| Development | 29 | 14 | 48.28% | 9.75R | 1.867 |
| Reused validation | 30 | 14 | 46.67% | 9.00R | 1.750 |
| Combined descriptive | 59 | 28 | 47.46% | 18.75R | 1.806 |

The expansion preserved 16/16 original winners and added 24 trades at 50.00% wins and 9.00R. chosen after both periods were exposed; descriptive only and requires a new prospective sample.

## Robustness and management

9 of 25 nearby threshold/range settings improved both exposed periods and preserved every baseline winner. This is evidence of a local plateau, but it remains exploratory because both periods were exposed.

| Surprise threshold | Range factor | Development | Reused validation |
|---:|---:|---:|---:|
| 0.25 | 0.50 | 6.75R | 3.00R |
| 0.25 | 0.60 | 6.75R | 3.00R |
| 0.25 | 0.75 | 6.75R | 1.49R |
| 0.30 | 0.50 | 6.75R | 3.00R |
| 0.30 | 0.60 | 6.75R | 3.00R |
| 0.30 | 0.75 | 6.75R | 1.49R |
| 0.35 | 0.50 | 6.75R | 3.00R |
| 0.35 | 0.60 | 6.75R | 3.00R |
| 0.35 | 0.75 | 6.75R | 1.49R |

No tested break-even or partial-profit rule improved both periods while preserving all candidate winners (0 passing candidates).

| Management rule | Development | Reused validation | Combined | Preserved all wins |
|---|---:|---:|---:|---:|
| break_even_after_close_0_50r | 7.50R | -3.00R | 4.50R | no |
| break_even_after_close_0_75r | 7.50R | 0.00R | 7.50R | no |
| break_even_after_close_1_00r | 6.75R | 1.50R | 8.25R | no |
| partial_25_then_be_after_close_0_75r | 7.14R | 0.20R | 7.33R | yes |
| partial_25_then_be_after_close_1_00r | 6.60R | 1.59R | 8.18R | yes |
| partial_50_then_be_after_close_0_75r | 6.78R | 0.39R | 7.17R | yes |
| partial_50_then_be_after_close_1_00r | 6.44R | 1.67R | 8.12R | yes |

## Every losing trade

| Release | Event group | Direction | Minutes to stop | 72h direction | Inverse | Primary diagnosis |
|---|---|---:|---:|---:|---:|---|
| 2024-08-29 | USD Prelim GDP q/q + USD Unemployment Claims | DOWN | 5 | RIGHT | WIN | 72h direction right; immediate whipsaw hit stop before target |
| 2024-10-17 | USD Retail Sales m/m + USD Core Retail Sales m/m | DOWN | 0 | WRONG | LOSS | 72h direction wrong; two-sided path later touched original target |
| 2024-11-22 | EUR French Flash Manufacturing PMI + EUR French Flash Services PMI | DOWN | 0 | RIGHT | LOSS | 72h direction right; immediate whipsaw hit stop before target |
| 2025-02-05 | USD ADP Non-Farm Employment Change | DOWN | 0 | RIGHT | LOSS | 72h direction right; immediate whipsaw hit stop before target |
| 2025-02-07 | USD Non-Farm Employment Change + USD Unemployment Rate + USD Average Hourly Earnings m/m | DOWN | 0 | RIGHT | LOSS | 72h direction right; immediate whipsaw hit stop before target |
| 2025-06-04 | USD ADP Non-Farm Employment Change | UP | 0 | WRONG | LOSS | 72h direction wrong; two-sided path later touched original target |
| 2025-06-06 | USD Non-Farm Employment Change + USD Average Hourly Earnings m/m | DOWN | 0 | WRONG | LOSS | 72h direction wrong; two-sided path later touched original target |
| 2025-07-02 | USD ADP Non-Farm Employment Change | UP | 0 | WRONG | WIN | 72h direction wrong; two-sided path later touched original target |
| 2025-08-01 | USD Non-Farm Employment Change | UP | 0 | RIGHT | LOSS | 72h direction right; immediate whipsaw hit stop before target |
| 2025-08-15 | USD Retail Sales m/m | UP | 0 | WRONG | LOSS | 72h direction wrong; two-sided path later touched original target |
| 2025-09-05 | USD Non-Farm Employment Change | UP | 0 | WRONG | WIN | 72h direction wrong; two-sided path later touched original target |
| 2025-09-16 | USD Retail Sales m/m + USD Core Retail Sales m/m | DOWN | 0 | RIGHT | WIN | 72h direction right; immediate whipsaw hit stop before target |
| 2025-09-25 | USD Unemployment Claims + USD Final GDP q/q | DOWN | 0 | WRONG | LOSS | 72h direction wrong; two-sided path later touched original target |
| 2025-10-24 | EUR German Flash Manufacturing PMI + EUR German Flash Services PMI | UP | 0 | RIGHT | LOSS | 72h direction right; immediate whipsaw hit stop before target |
| 2025-12-04 | USD Unemployment Claims | DOWN | 0 | RIGHT | LOSS | 72h direction right; immediate whipsaw hit stop before target |
| 2025-12-09 | USD JOLTS Job Openings | DOWN | 0 | WRONG | WIN | direction wrong; original target never touched within 72h |
| 2026-02-11 | USD Unemployment Rate + USD Average Hourly Earnings m/m + USD Non-Farm Employment Change | DOWN | 0 | WRONG | LOSS | 72h direction wrong; two-sided path later touched original target |
| 2026-02-19 | USD Unemployment Claims | DOWN | 5 | WRONG | LOSS | 72h direction wrong; two-sided path later touched original target |
| 2026-04-01 | USD ADP Non-Farm Employment Change | DOWN | 0 | RIGHT | LOSS | 72h direction right; immediate whipsaw hit stop before target |
| 2026-04-23 | EUR German Flash Manufacturing PMI + EUR German Flash Services PMI | DOWN | 0 | WRONG | LOSS | 72h direction wrong; two-sided path later touched original target |
| 2026-07-30 | USD Advance GDP q/q | UP | 0 | RIGHT | WIN | 72h direction right; immediate whipsaw hit stop before target |

## 100-trades-per-year challenge

Verdict: **REQUESTED_GATE_NOT_MET**. No tested expansion reached at least 100 trades in each yearly period while keeping at least 45% wins, positive expectancy, and profit factor above 1 in both periods.

| Family | Development | Reused validation | Combined R | Gate |
|---|---:|---:|---:|---:|
| All-release price confirmation | 189 @ 35.98% | 144 @ 29.86% | -9.21R | reject |
| Broad numeric news | 138 @ 31.16% | 114 @ 31.58% | -17.96R | reject |
| News plus fixed-session technical | 135 @ 41.48% | 122 @ 32.79% | +23.25R | reject |
| Correlated news entry ladder | 121 @ 36.36% | 115 @ 34.78% | +10.65R | reject |

The honest frontier remains the V15 rule: 29 development trades at 48.28% and +9.75R, plus 30 reused-validation trades at 46.67% and +9.00R. That is about 30 trades per year, not 100. The 100-per-year target cannot be represented as achieved by duplicating or accepting lower-quality entries.
