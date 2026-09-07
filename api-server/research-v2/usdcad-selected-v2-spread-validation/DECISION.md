# USDCAD V2 four-leg research decision — FINAL

**Status tags:** `RESEARCH_ONLY` · `NO_EDGE_AFTER_COSTS` · `REJECTED` · `USDCAD_V2_REJECTED`

Date: 2026-09-06

## Decision

Four-leg **GX USDCAD Structure EMA Reclaim V2 — Selected Origins — 1 to 2 RR** is rejected as the USDCAD research candidate.

It remains preserved as historical research evidence only. It must not be restored, redeployed, or used to reintroduce dropped hours.

## Rejected book

- Pair: USDCAD
- Timeframe: H1
- Legs: 09:00 LONG, 10:00 SHORT, 11:00 LONG, 11:00 SHORT
- Trades: 181
- EXEC PF: 1.016
- EXEC expectancy: +0.010R/trade
- Classification: NO EDGE
- Verdict: MARGINAL_AFTER_COSTS

Do **not** restore:

- 09:00 LONG
- 10:00 SHORT
- 11:00 SHORT

The isolated V2 11:00 LONG subset (49 trades, EXEC PF 1.397, EXEC expectancy +0.214R) is superseded by V3, which contains those 49 trades plus four restored 11:00 LONG signals.

## Replacement

Frozen USDCAD research candidate:

**GX USDCAD Structure EMA Reclaim V3 — 11:00 LONG Only — 1 to 2 RR**

See `api-server/research-v2/usdcad-v3-1100-long-spread-validation/DECISION.md`.

## Confirmations

- `USDCAD_V2_REJECTED`
- `RESEARCH_ONLY`
- `NO_EDGE_AFTER_COSTS`
- `NO_DEPLOYMENT`
- `NO_BROKER_ORDERS`

All V2 source, validation, trade-level, raw-result, and OANDA cache artifacts in this directory are intentionally retained.

## Preserved artifacts (do not delete)

- `REPORT.md`
- `TRADES.csv`
- `RAW_RESULTS.json`
- `TRADINGVIEW_SOURCE.csv`
- `data/USD_CAD-H1-MBA.json`
- `data/USD_CAD-M1-TV181-MBA.json`
