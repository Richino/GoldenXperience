# OANDA candle / Analyze recovery implementation

Implemented locally on October 18, 2026 (New York). No commit, push, Railway deployment, research submission, plan approval, or broker order was performed.

## Confirmed cause and the reported ages

The saved EUR/USD snapshot 201799d3-a045-4e2a-80b6-7826d6b5da13 was generated at 2026-10-18T22:42:59.990Z. Its completed H4 and D1 candles ended Friday 2026-10-16T21:00:00Z; H1 ended Sunday 2026-10-18T22:00:00Z. Its only recorded technical issue was the H4 age of 2983 minutes.

The old intraday validator subtracted clock time from the candle end after reopening. It counted the closed weekend against H4, although the first new aligned Sunday H4 candle did not finish until Monday 01:00 UTC (Sunday 21:00 New York). This was a false feed-staleness rejection.

The market-state read path revalidated saved timestamps against the current clock without refreshing candles. At 2026-10-19T00:11Z, the same Friday H4 close is 3071 minutes old and that saved Sunday H1 close is 131 minutes old. Those two later numbers are reproduced deterministically; they do not require different server clocks. A saved H1 assessment really does require a new technical read by then; accepting Friday H4 does not make old H1 fresh.

The interpreter then rejected its entire assessment for any mandatory-input issue. The generator returned NO_VALID_SETUP even for unusable inputs, and the sheet rendered every empty plan list as no setup. These were separate classification failures. A further foundation bug discarded valid daily structure when primary H4 candles were absent.

Chart updates use streamed/REST prices and a separate short candle cache. Analyze fetches OANDA directly; its candle request is not served from the historical database cache. The recorded evidence establishes valid Friday H4 data and a current Sunday H1 read at snapshot creation. It does not establish an upstream OANDA outage, UTC conversion error, or stale Supabase candle cache as the incident's cause. The exact failed D1 header request and the transient +3.03% payload were not recorded, so their precise original inputs cannot be reconstructed.

## Implemented behavior

- Explicit OANDA dailyAlignment=17, alignmentTimezone=America/New_York and unsmoothed mid candles. Validate pair, granularity, timestamps, completion flags, duplicates and OHLC; sort out-of-order valid responses. Retry transient transport failures at most three times. Failures return an empty error result, never generated candles.
- One session-aware candle clock derives daily/H4 boundaries across DST, excludes weekends, daily broker maintenance and NZD's extra break, and detects completed trading intervals missing beyond a two-minute publication grace. Historical integrity and latest freshness remain separate checks. No synthetic weekend candles or blanket 72-hour exemption.
- Explicit verified holiday/interruption overrides are supported with OANDA_TRADING_INTERRUPTION_WINDOWS, a JSON array of {instrument,from,to}. Use a supported pair or * and UTC ISO timestamps. Unknown interruptions remain missing-data failures; holiday closures are never inferred from a national holiday or an empty calendar.
- Independent H1/M15 partial observations retain validated research and valid D1 context. Missing required inputs block new persisted plans. Full interpretation, partial interpretation, technical unavailability, validation failure and successful evaluation with no setup remain distinct. Unavailable structure is not invented.
- Confirmed structure and confirmations require completion flags and elapsed candle ends. Historical candles do not satisfy post-plan confirmation. D1 targets require actual daily volatility. Live quote, spread, news, risk, approval, immutable-plan, atomic reservation and practice-only safeguards remain enforced.
- Technical retry calls only the existing generation endpoint and reuses validated research. It does not invoke the research submission endpoint. Background leases, watcher delivery and notification deduplication remain. Replayed delivery uses the job ID as analysis ID; a transaction advisory lock reuses persisted analysis/side/setup plans without duplicating events.
- Analysis input snapshots persist request/receive times, alignment version, each timeframe's health and completion times, quote timestamp, calendar health and a snapshot ID in existing JSON. Logs link analysis/job/research/data/market-state IDs and the persisted outcome. Concurrent candle requests share a flight; analysis retains no persistent candle cache. Failed older cache responses cannot delete a newer chart entry.
- The dashboard reports completed D1 and M15 structure with candle timestamps in its tooltip. Missing H4 no longer erases valid D1. The failure and partial sheets expose technical retry and retain research. Home and notifications no longer present technical failure as no opportunity.
- Calendar statuses distinguish available-with-events, available-empty, unavailable, stale and validation-failed. Empty valid weekly feeds retain coverage; malformed/stale cached feeds cannot clear news gates.
- Price change is display-only against the last verified completed daily close, labelled Daily, independent of chart timeframe. A missing baseline is unavailable; rounding precedes sign selection to prevent negative zero. The old formula was a percentage, but its baseline was the preceding selected-chart candle and therefore changed with chart data/timeframe.

Broker conventions were checked against [OANDA instrument definitions](https://developer.oanda.com/rest-live-v20/instrument-df/), [OANDA's instrument API schema](https://github.com/oanda/v20-openapi/blob/master/yaml/separate/v20_instrument.yaml), and [OANDA US trading hours](https://www.oanda.com/us-en/trading/hours-of-operation/).

## Verification

- 35 deterministic candle-recovery checks: Sunday/Friday/weekend cases, H1/H4/D1 expected completions, DST, verified interruptions, M5/NZD breaks, malformed/order/duplicate responses, retry bounds, single-flight, partial/no technical data, research reuse, no setup versus failed analysis, historical/future confirmation exclusion and daily percentage/calendar behavior.
- Existing trade-plan suite passed: generator 17, confirmation 32, monitor 12, executor 28, intelligence 25, research jobs 24, lifecycle 21 and interpreter 17, plus state/settings checks. Database persistence, replay, job overlap, approval immutability and atomic reservations were exercised inside rolled-back transactions. The new persistence replay check verifies one row and no repeated events.
- Frontend Analyze V2: 60 checks passed. Calendar and pending manual-entry regression suites passed.
- API and frontend TypeScript checks passed. Production Next.js build passed. git diff --check passed.
- Full repository lint was run and remains blocked by existing debt. Comparing changed frontend sources to HEAD found 14 existing errors on each side and zero introduced diagnostics after repairs. The comparison is recorded in outputs/candle-lint-comparison.json.
- Browser fixture verification at 390x844: the data-unavailable heading and retry button fit; the partial state retains completed D1/H1 context while marking H4 unavailable and blocking plans. The existing development warning at layout.tsx:79 about an inline script remains outside this change.
- Read-only live OANDA practice verification at 2026-10-19T01:18:22Z: 299 completed candles plus one forming candle per requested timeframe; D1 closed Friday 21:00 UTC, H4 and H1 closed Monday 01:00 UTC, M15 closed 01:15 UTC. All currentness checks passed. Existing validated research combined into ANALYSIS_COMPLETE and the pure generator produced conditional BUY and SELL scenarios with zero model/search calls. Nothing was persisted or executed in that live probe.

## Migrations and remaining limits

No migration is needed: additional source/status fields fit the existing JSON snapshots and watcher text result columns. Interpreter version is bumped to v1.1.0 so older invalid snapshots are not silently relabelled current.

This is a tested local implementation, not a production deployment. A new authenticated browser research-to-plan run against deployed Railway services and live trade execution were not performed. Release API and frontend together, then verify both deployments and both health endpoints. Broker holiday overrides require verified published dates; there is no invented universal holiday calendar. The live generator result establishes correct data flow, not profitable trade quality.

## Files changed

- api-server/package.json
- api-server/scripts/diagnose-candle-data.ts
- api-server/scripts/fixtures/analysis-input.ts
- api-server/scripts/test-candle-recovery.ts
- api-server/scripts/test-market-state-interpreter.ts
- api-server/scripts/test-plan-lifecycle.ts
- api-server/scripts/test-trade-plan-generator.ts
- api-server/src/intelligence/calendar-snapshot.ts
- api-server/src/intelligence/market-state-interpreter.ts
- api-server/src/intelligence/market-state-store.ts
- api-server/src/intelligence/research-jobs.ts
- api-server/src/intelligence/research-service.ts
- api-server/src/server.ts
- api-server/src/trade-plan-confirmation.ts
- api-server/src/trade-plan-generator.ts
- api-server/src/trade-plan-monitor.ts
- api-server/src/trade-plan-service.ts
- api-server/src/trade-plans.ts
- frontend/scripts/test-analyze-v2.ts
- frontend/src/app/dev/plan-analyze-preview/preview.tsx
- frontend/src/components/charts/trend-label.tsx
- frontend/src/components/dashboard/ledger-plans.tsx
- frontend/src/components/signals/signal-workspace.tsx
- frontend/src/components/trade-plans/market-read.tsx
- frontend/src/components/trade-plans/market-state-read.tsx
- frontend/src/components/trade-plans/plan-analyze.tsx
- frontend/src/lib/calendar/forex-factory.ts
- frontend/src/lib/oanda/calendar.ts
- frontend/src/lib/oanda/client.ts
- frontend/src/lib/oanda/price-change.ts
- frontend/src/lib/strategy/analyze-v2/data-quality.ts
- frontend/src/lib/strategy/analyze-v2/foundation.ts
- frontend/src/lib/strategy/candle-clock.ts
- frontend/src/lib/strategy/session.ts
- frontend/src/lib/trade-plans/api.ts
- frontend/src/lib/trade-plans/fixtures/partial-market-state.json
- frontend/src/lib/trade-plans/market-state.ts
- frontend/src/types/forex.ts
