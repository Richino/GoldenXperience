# H1 Sell-Only V1 — FINAL REPORT

## VERDICT: `BUY_BIAS_FOUND`

**Period:** 2022-08-01 → 2026-08-01  
**Pairs:** EUR/USD, GBP/USD, USD/JPY, AUD/USD, NZD/USD, USD/CAD, USD/CHF, EUR/GBP, EUR/JPY, GBP/JPY, AUD/JPY, EUR/AUD  
**Total H1 candles:** 298,868  
**Missing candles (all pairs):** 121,876

## Test A — Always SELL (open → close)

| Metric | Value |
| --- | --- |
| Candles | 298,700 |
| Wins | 146,058 |
| Losses | 151,820 |
| Ties | 822 |
| SELL WR | 48.90% |
| 95% CI | [48.72%, 49.08%] |
| 50% in CI? | No |

## Pair Results (open → close)

| Pair | Candles | Wins | Losses | Ties | SELL WR | Bias |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| EUR/AUD | 24890 | 12578 | 12283 | 29 | 50.53% | NO_CLEAR_BIAS |
| NZD/USD | 24898 | 12402 | 12420 | 76 | 49.81% | NO_CLEAR_BIAS |
| EUR/USD | 24893 | 12370 | 12451 | 72 | 49.69% | NO_CLEAR_BIAS |
| EUR/GBP | 24891 | 12354 | 12403 | 134 | 49.63% | NO_CLEAR_BIAS |
| GBP/USD | 24891 | 12296 | 12529 | 66 | 49.40% | NO_CLEAR_BIAS |
| USD/CHF | 24891 | 12292 | 12501 | 98 | 49.38% | NO_CLEAR_BIAS |
| AUD/USD | 24891 | 12208 | 12603 | 80 | 49.05% | BUY_BIAS |
| USD/CAD | 24891 | 12182 | 12623 | 86 | 48.94% | BUY_BIAS |
| AUD/JPY | 24891 | 11943 | 12900 | 48 | 47.98% | BUY_BIAS |
| USD/JPY | 24891 | 11838 | 12997 | 56 | 47.56% | BUY_BIAS |
| GBP/JPY | 24891 | 11836 | 13021 | 34 | 47.55% | BUY_BIAS |
| EUR/JPY | 24891 | 11759 | 13089 | 43 | 47.24% | BUY_BIAS |

## Forward close-to-close SELL

| Horizon | n | SELL WR | 95% CI |
| --- | ---: | ---: | --- |
| 1H | 298688 | 49.23% | [49.05%, 49.41%] |
| 2H | 298676 | 49.02% | [48.84%, 49.20%] |
| 3H | 298664 | 48.81% | [48.63%, 48.99%] |
| 4H | 298652 | 48.73% | [48.55%, 48.91%] |
| 6H | 298628 | 48.75% | [48.57%, 48.92%] |
| 8H | 298604 | 48.68% | [48.50%, 48.85%] |
| 12H | 298556 | 48.55% | [48.37%, 48.73%] |
| 24H | 298412 | 47.99% | [47.81%, 48.16%] |

## Model Comparison (24H close-to-close)

| Method | Signals | Wins | Losses | WR |
| --- | ---: | ---: | ---: | ---: |
| Always SELL | 298412 | 143194 | 155098 | 47.99% |
| Frozen model SHORT | 7057 | 3270 | 3785 | 46.34% |
| Inverted frozen SHORT | 7057 | 3785 | 3270 | 53.63% |

> Reproduce: `cd api-server && npm run h1-sell-only-v1`
