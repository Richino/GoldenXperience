# H1 Next-Candle V1 — FINAL REPORT

## VERDICT: `NO_NEXT_CANDLE_EDGE`

Period: 2022-08-01 → 2026-08-01

## LOOKAHEAD_AUDIT
- Features use only candles with index < target index T
- Target candle close used only after prediction for scoring
- Verified: true

## Sealed Model
| Metric | Value |
| --- | ---: |
| Signals | 141 |
| WAITs | 74427 |
| Wins | 73 |
| Losses | 68 |
| WR | 51.77% |
| 95% CI | [43.59%, 59.86%] |

> Reproduce: `cd api-server && npm run h1-next-candle-v1`
