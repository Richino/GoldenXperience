# EURUSD research decision — FINAL

**Status tags:** `RESEARCH_ONLY` · `MARGINAL_AFTER_COSTS` · `REJECTED_REPLACEMENT`

Date: 2026-09-05

## Decision

- **KEEP:** the previously validated **EURUSD London Breakout V1** strategy
  (356 trades, EXEC WR 38.48%, EXEC PF 1.127, EXEC expectancy **+0.078R/trade**).
- **REJECT AS REPLACEMENT:** **GX EURUSD London Breakout V3 — Selected Frequency
  Legs — 1.25R Profit Lock**.

V3 is **not** promoted, **not** deployed, and remains research-only.

## Why V3 was rejected

Authoritative TradingView cohort (234 trades, 116 wins / 118 losses) replayed
against historical OANDA M1 bid/ask execution:

| Metric | OANDA EXEC |
|---|---:|
| Trades | 234 |
| Win rate | 48.72% |
| Profit factor | 1.125 |
| Total R | +15.79R |
| Expectancy | **+0.0675R/trade** |
| Avg execution drag | 0.156R/trade |
| Total execution drag | 36.5R |
| Classification | **WEAK** |
| Verdict | **MARGINAL_AFTER_COSTS** |

Sensitivity on the 3 ambiguous sub-minute (news) trades: **+0.0675R** (pessimistic)
to **+0.0911R** (optimistic). Even the optimistic case does not justify replacing
the existing 356-trade EURUSD strategy.

### Comparison

| Strategy | Trades | EXEC expectancy |
|---|---:|---:|
| OLD EURUSD (validated) | 356 | +0.078R |
| V3 Selected Frequency Legs | 234 | +0.0675R |

V3 reduces trade frequency by ~34%, does **not** improve executable expectancy,
does **not** materially improve executable PF, and therefore must **not** replace
the old strategy.

## Profit-lock finding (preserve — NOT a strategy improvement)

- TradingView profit-lock activations: **78**
- OANDA executable / M1 activations: **116**

This difference was traced to TradingView's `process_orders_on_close` / H1
order-emulator timing versus chronological OANDA M1 replay (a moved +0.5R stop
becomes active only on the next H1 bar, so fast intrabar runners are mislabeled).
The extra executable activations are a measurement/granularity artifact and must
**not** be read as a V3 edge. See `REPORT.md` → "Execution-modeling notes".

## Active-strategy audit (code-verified, read-only; no DB writes)

| | Before | After |
|---|---|---|
| EURUSD active strategy | London Breakout **V1** (shadow, `executionEnabled: false`) | London Breakout **V1** (shadow, `executionEnabled: false`) — unchanged |

Evidence in the working tree:

- `frontend/src/lib/strategy/strategies/eurusd-strategy.ts` — definition is **V1**
  ("GX 1H A London Breakout Only V1", 1:2, no leg filter, no profit lock). No V3
  logic present.
- `frontend/src/lib/strategy/strategies/index.ts` — EURUSD entry has
  `executionEnabled: false`; EURUSD is **not** in `ENABLED_PAIR_STRATEGY_IDS`
  (`[GBPUSD, USDJPY, AUDUSD, NZDUSD]`) and `evaluateEnabledPairStrategies()`
  returns `[]` for `EUR_USD`. EURUSD is therefore never evaluated or executed in
  the live paper/practice pipeline.
- `api-server/migrations/039_register_eurusd_strategy.sql` — registers EURUSD **V1**
  as `status: 'shadow'`, `executionEnabled: false`.
- No V3 "Selected Frequency Legs" / "1.25R Profit Lock" / 7-hour leg filter exists
  anywhere in the codebase. The only "Frequency V3" markers belong to **GBPUSD**
  (a separate, unrelated strategy — untouched).

**Conclusion:** V3 was never applied to the active EURUSD implementation, so there
was nothing to revert. V1 remains the active (shadow) EURUSD strategy.

## Confirmations

- OLD EURUSD VALIDATED STRATEGY = **ACTIVE** (shadow; not executing by design)
- V3 SELECTED FREQUENCY = **REJECTED**
- V3 RESEARCH ARTIFACTS = **PRESERVED**

No deployment. No broker orders. No changes to USDJPY, GBPUSD, AUDUSD, USDCAD,
NZDUSD, or any other pair.

## Preserved artifacts (do not delete)

- `REPORT.md`
- `TRADES.csv`
- `RAW_RESULTS.json`
- `METRICS.json`
- `TRADINGVIEW_SOURCE.csv`
- `PINE_SOURCE.pine`
