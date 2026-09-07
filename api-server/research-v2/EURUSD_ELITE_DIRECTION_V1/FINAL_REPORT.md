# EURUSD_ELITE_DIRECTION_V1 — Final report

Final verdict: **NO_EDGE**

## Final chronological slice

- Trades: 187; win rate 21.39%; expectancy -0.1918R; total -35.86R; PF 0.522; max DD 36.85R; WAIT 67.7%.
- Best simple comparator: simple_logistic_existing_features at -0.0673R/trade. Its 34-trade final sample is below the 60-trade development minimum, so this is context, not evidence of a viable alternative.
- Walk-forward positive folds: 0/5.

## Baselines

| Model | N | Win rate | Avg R | PF | Max DD |
|---|---:|---:|---:|---:|---:|
| random | 579 | 8.3% | -0.3987 | 0.169 | 231.30 |
| always_long | 579 | 9.5% | -0.3806 | 0.196 | 220.34 |
| always_short | 579 | 7.6% | -0.4091 | 0.154 | 237.30 |
| momentum | 579 | 8.3% | -0.3987 | 0.169 | 230.85 |
| trend | 579 | 8.6% | -0.3935 | 0.177 | 227.84 |
| simple_logistic_existing_features | 34 | 29.4% | -0.0673 | 0.813 | 4.20 |
| mixture_of_experts | 187 | 21.4% | -0.1918 | 0.522 | 36.85 |

## Regimes

| Regime | N | Win rate | Avg R | PF | Max DD |
|---|---:|---:|---:|---:|---:|
| regime_1 | 167 | 21.6% | -0.1896 | 0.526 | 32.66 |
| regime_2 | 20 | 20.0% | -0.2099 | 0.485 | 7.17 |

## Sessions

| Session | N | Win rate | Avg R | PF | Max DD |
|---|---:|---:|---:|---:|---:|
| LONDON | 71 | 15.5% | -0.2802 | 0.350 | 21.60 |
| NEW_YORK | 90 | 28.9% | -0.0800 | 0.779 | 8.67 |
| OVERLAP | 26 | 11.5% | -0.3371 | 0.254 | 8.77 |

## Required answers

1. Out-of-sample directional edge: **not demonstrated**.
2. After spread/costs: **no**.
3. Strongest contributor by ablation: **relative_strength**; removing it changed expectancy by -0.0752R. The best alignment diagnostic was relative_strength, but even aligned expectancy remained -0.0683R.
4. Weakest/most harmful by ablation: **structure**; removing it improved expectancy by 0.0786R.
5. Components flagged harmful because removal improved final expectancy: **structure, momentum, regime, multi_timeframe, liquidity**.
6. News value: removing macro/news changed expectancy by -0.0410R. It helped relative to the full model but did not create a positive system.
7. Neural model beats simple models: **no**.
8. Regimes that work: **none**.
9. Regimes that fail: **regime_1, regime_2**. Regimes with no selected trades remain unproven rather than successful.
10. WAIT frequency: 67.7%.
11. +1R/-0.5R profitability: **negative**.
12. Stability: **0/5 positive walk-forward folds; not stable**.

## Judgment

The verdict is not upgraded on architecture complexity. The final slice is not organizationally pristine because earlier V5 work inspected the same calendar period, and M1 sequencing is unavailable for the full history. A production or paper-engine change is not authorized by this experiment.
