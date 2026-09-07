# AUDJPY Bull Consensus V1 research decision — FINAL

**Status tags:** `AUDJPY_V1_REJECTED` · `RESEARCH_ONLY` · `FAILS_COSTS` · `NO_EDGE` · `REJECTED`

Date: 2026-09-06

## Decision

**GX AUDJPY Bull Consensus V1 1 to 2 RR** is rejected. It must not be deployed, frozen as an approved AUDJPY candidate, or sent to a broker.

The exact TradingView cohort had 247 trades. OANDA executable bid/ask replay resolved 246 and left one unresolved because the M1 record is missing at 2024-06-19 15:57 UTC. No price was fabricated.

| Metric | OANDA EXEC |
|---|---:|
| Win rate | 47.15% |
| Profit factor | 1.045 |
| Expectancy | +0.0224R/trade |
| Total | +5.5027R |
| Spread drag | 0.1325R/trade |
| Total spread drag | 32.6071R |

The strategy is **NO_EDGE** under the stated classification threshold and therefore **FAILS_COSTS**.

## Preserved findings — do not turn them into rules

- Calendar years: 2023 negative, 2024 positive, 2025 negative, 2026 positive. Do not derive a year filter.
- All 246 resolved qualifying signals scored +4; the +3 subgroup has zero trades. Do not change the frozen gate from `>= +3` to `== +4`.
- Time exits account for 19.1514R of the 32.6071R total execution drag; TP/SL exits account for 13.4556R. Do not change max hold from three future H1 bars based on this same sample.

No 1-, 2-, 4-, or 5-bar variants, trailing stops, profit locks, break-even rules, exit changes, or filters were tested or authorized here. Any future redesign is a separate hypothesis and requires an out-of-sample protocol.

## Confirmations

- `AUDJPY_V1_REJECTED`
- `FAILS_COSTS`
- `NO_EDGE`
- `NO_SAME_SAMPLE_EXIT_OPTIMIZATION`
- `NO_DEPLOYMENT`
- `NO_BROKER_ORDERS`

## Preserved artifacts — do not delete

- `REPORT.md`
- `TRADES.csv`
- `RAW_RESULTS.json`
- `TRADINGVIEW_SOURCE.csv`
- `PINE_SOURCE.pine`
- `data/AUD_JPY-H1-MBA.json`
- `data/AUD_JPY-M1-MBA.json`
