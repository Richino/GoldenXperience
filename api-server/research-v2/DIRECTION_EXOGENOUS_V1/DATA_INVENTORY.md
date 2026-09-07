# DIRECTION_EXOGENOUS_V1 — data inventory

Honest accounting of which exogenous lanes have LOCAL historical data. No proxies were substituted for missing data.

| Lane | Local data? | What exists | Verdict |
|---|---|---|---|
| RATES / yields | **Insufficient** | Configured FRED feed exposes US DFF/DGS2 and monthly OECD German proxies, but not comparable German 2Y/10Y point-in-time vintages. Latest-revision OECD history fails the no-future-revisions requirement. | INSUFFICIENT_DATA |
| CENTRAL_BANK expectations | **No** | No fed-funds/OIS/market-implied-policy series locally. | INSUFFICIENT_DATA |
| CROSS_FX + gold | **Yes** | M15 bid/ask for EUR/USD + GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD, NZDUSD, EURGBP, EURJPY, XAUUSD, 2019-07..2026-08. | TESTED |
| POSITIONING / COT | **No** | No CFTC COT cache; publication-safe weekly positioning unavailable locally. | INSUFFICIENT_DATA |
| ORDER_FLOW / futures | **No** | Price caches carry NO volume/open-interest field; no 6E futures/order-flow data. | INSUFFICIENT_ORDER_FLOW_DATA |
| OPTIONS | **No** | No risk-reversal / implied-vol / skew data. | INSUFFICIENT_OPTIONS_DATA |

## CROSS_FX construction (the one testable lane)
Causal relative-strength features at T from bars completed <= T: USD-basket strength (from 6 USD majors), EUR-basket strength (from EUR_GBP, EUR_JPY — deliberately EXCLUDING EUR/USD so the feature is exogenous to EUR/USD's own price), EUR−USD basket differential, basket-vs-EURUSD divergence (lead/lag), individual cross momenta, and gold. Horizons 15m/30m/60m/120m on M15.
5m CROSS_FX: **limited** — only GBP_USD and USD_JPY exist at M5, too few to build a basket; not separately modelled (documented, not proxied).

## Baseline
BASE = frozen DIRECTION_MODEL features (signed price/structure/vol/time/news + frozen MOVE_MODEL OOS probability). The primary lane test uses all causally labelled direction rows. ORACLE_MOVE_EXOGENOUS.csv is a separate repeat restricted to ground-truth MOVE events. Metric of record = incremental OOS AUC of BASE+CROSS_FX over BASE.
