# $100 — 2 Year Martingale Test

## VERDICT: `MARTINGALE_EVENTUALLY_BLEW_ACCOUNT`

## Data
- Target: 2024-08-01T00:00:00.000Z → 2026-08-01T00:00:00.000Z
- Actual: 2024-08-01 → 2026-07-31
- Trading days: 626
- M1 candles: 8,881,943 (missing 3,730,297)
- Source: cache

## Underlying strategy (5m Binary Master, fixed-stake accuracy)
- Individual WR: 48.73% (n=36340)
- 3m WR (separate, not in account sim): 48.87% (n=35990)
- Break-even @80%: 55.56%
- Fixed-stake EV/trade: -0.1228

## Primary unlimited Martingale
- Final balance: $56.69
- Return: -43.31%
- Sequence success: 80.00% (4/5)
- Individual WR: 26.67%
- Max drawdown: $46.56 (45.09%)
- Largest stake: $26.32
- Account blown: YES

## Method comparison
| Method | Final | Return | Max DD | Seq success | Blown |
|--------|------:|-------:|-------:|--------------:|-------|
| Fixed 1% | $0.00 | -100.00% | 100.00% | N/A | YES |
| Unlimited MG | $56.69 | -43.31% | 45.09% | 80.00% | YES |
| Max MG1 | $0.01 | -99.99% | 99.99% | 74.15% | YES |
| Max MG2 | $0.00 | -100.00% | 100.00% | 86.75% | YES |
| Max MG3 | $0.10 | -99.90% | 99.90% | 93.65% | YES |
| Max MG4 | $0.13 | -99.87% | 99.89% | 96.61% | YES |

## Martingale escalation ($100 account, $1 base @80%)
| Attempt | Stake | Cumulative risk |
|---------|------:|----------------:|
| Base | $1.00 | $1.00 |
| MG1 | $2.25 | $3.25 |
| MG2 | $5.06 | $8.31 |
| MG3 | $11.39 | $19.70 |
| MG4 | $25.63 | $45.33 |
| MG5 | $57.66 | $102.99 |
| MG6 | $129.74 | $232.73 |

## Losing streak distribution
| Losses | Count |
|--------|------:|
| 1 | 2 |
| 2 | 0 |
| 3 | 0 |
| 4 | 1 |
| 5 | 1 |
| 6 | 0 |
| 7+ | 0 |

Longest observed: 5

## Monte Carlo (10,000 runs, 5 sequences, WR=48.73%)
- Bankruptcy probability: 100.00%
- Ending > $100: 6.53%
- Median ending: $63.72
- Median max DD: 45.33%

> Reproduce: `cd api-server && npm run binary-master-martingale-2y-v1`
