# eurusd-exogenous-v1 — DATA INVENTORY

Inventory of exogenous historical data **actually present in the repository**,
inspected before any modelling. No source was fetched at runtime; nothing was
fabricated or synthesised from unavailable data. Derived indices (USD/EUR
strength baskets) are computed **only** from the stored cross-FX candles listed
below and are labelled as proxies.

## Usable sources (on disk, offline, reproducible)

All FX/metal candles live in `backtest-legacy-expanded/candles/` as
`{INSTRUMENT}_{H1,H4,M15}.json` with **bid/ask** OHLC and `closeTime` on a shared
OANDA grid. Timestamps align 1:1 across instruments (verified).

| Instrument | Bars (H1) | Coverage | Freq | TZ | Missing | Timestamp | Revisions | Look-ahead safe | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| EUR_USD | 44,055 | 2019-07-28 → 2026-08-25 | H1/H4/M15 | UTC | none | bar close (observation) | none | yes | target |
| USD_JPY | 44,061 | same | H1/H4/M15 | UTC | none | bar close | none | yes | **usable** |
| USD_CHF | 44,052 | same | " | UTC | none | bar close | none | yes | **usable** |
| USD_CAD | 44,064 | same | " | UTC | none | bar close | none | yes | **usable** |
| GBP_USD | 44,053 | same | " | UTC | none | bar close | none | yes | **usable** |
| AUD_USD | 44,047 | same | " | UTC | none | bar close | none | yes | **usable** |
| NZD_USD | 44,062 | same | " | UTC | none | bar close | none | yes | **usable** |
| EUR_GBP | 44,052 | same | " | UTC | none | bar close | none | yes | **usable** |
| EUR_JPY | 44,044 | same | " | UTC | none | bar close | none | yes | **usable** |
| GBP_JPY | 44,056 | same | " | UTC | none | bar close | none | yes | usable (aux) |
| AUD_JPY | 44,063 | same | " | UTC | none | bar close | none | yes | usable (aux) |
| **XAU_USD** (gold) | 41,862 | 2019-07-28 → 2026-08-25 | H1/H4/M15 | UTC | minor (fewer bars) | bar close | none | yes | **usable** (risk proxy) |

**Derived (proxy) indices**, computed causally from the above only:
- **USD strength basket ("DXY-ex-EUR")** = mean of `ret(USD_JPY), ret(USD_CHF), ret(USD_CAD), −ret(GBP_USD), −ret(AUD_USD), −ret(NZD_USD)`. Deliberately excludes EUR so it is independent of EUR_USD. Real DXY (which is 57.6% EUR) is intentionally **not** reconstructed — it would be near-tautological with EUR_USD.
- **EUR strength basket** = mean of `ret(EUR_GBP), ret(EUR_JPY)`. Excludes USD.
- **strength_diff** = EUR strength − USD strength.

## Unusable / absent sources (documented; not tested, per the stop rule)

| Family | Status | Reason |
|---|---|---|
| **US/German yields, curves (2Y/5Y/10Y)** | **UNUSABLE / INSUFFICIENT_DATA** | No yield data stored on disk (`carry-momentum/src/data/yields.jsonl` does not exist). The only wired FRED series (`frontend/src/lib/macro/rates.ts`) are **monthly** OECD long-term government yields — the module's own docstring states rate *expectations* (the week-to-week part) are "invisible at this frequency." A monthly level cannot provide per-timestamp direction over 1–72h, and a live FRED fetch would be non-reproducible and risk forward-filling monthly values into hourly bars. |
| **Fed/ECB rate expectations (STIR/OIS/futures)** | **INSUFFICIENT_DATA** | No such series in the repo. |
| **Equity indices (S&P/Nasdaq), VIX** | **INSUFFICIENT_DATA** | No index/vol candles stored (only FX + gold). |
| **COT positioning** | **INSUFFICIENT_DATA** | No COT files on disk. |
| **Order flow / OANDA order book / broker positioning** | **SKIP (no source)** | No stored historical order-book/positioning data. Per §11, skipped rather than proxied. |

## Leakage controls applied
- Every exogenous feature at entry time `t` is built only from bars with `closeTime ≤ t` (binary-search `lastIndexAtOrBefore`).
- Direction labels use the M15 path strictly **after** `t`.
- Contemporaneous cross-FX co-movement (near-tautological with EUR_USD) is reported **separately** from lagged/forward predictive value (§16 of the report); only lagged information feeds any model.
- The MOVE detector, its threshold (reach ≥ 3.0 ATR @ 24h), the dev/sealed split (sealed = 2026-05-01→), walk-forward windows and direction labels are frozen imports from `eurusd-move-v1`.
