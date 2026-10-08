# Morning Market Scanner

Market selection for Normal mode. It never invokes Analyze, submits an order, or calculates an executable entry/stop/target. A shortlist is not evidence of positive expectancy.

## Architecture and changed files

- `frontend/src/lib/strategy/ny-tradability.ts`: the existing shared NY engine now exposes Normal qualification, causal M15 structure with H1 context, measurements, reference levels, actual news, rejection/caution reasons, and deterministic ranking.
- `api-server/src/market-selection-service.ts`: account instrument discovery, shared broker/calendar reads, bounded workers, retries, separate M15/H1 caches, instrument policy validation, and archival of scan inputs into existing candle/quote tables. Markets and the chart pair picker call this same service through the existing `/api/ny-tradability` endpoint.
- `api-server/src/morning-market-scanner.ts`: background schedule, PostgreSQL overlap lock, slot idempotency, persistent manual cooldown, deadlines, history and current snapshot reads.
- `api-server/src/server.ts`: scheduler startup/shutdown and authenticated read/refresh/scheduled routes. Existing trade loops and Analyze entry rules are unchanged.
- `api-server/migrations/053_morning_market_scans.sql`: immutable completed runs and a singleton current pointer/cooldown. Existing `market_candles` and `quote_snapshots` store input prices; no competing candle table.
- `frontend/src/lib/strategy/morning-scan.ts`: shared schedule, freshness, snapshot types, and chart URL.
- Home wiring: `frontend/src/app/(workspace)/page.tsx`, `frontend/src/components/dashboard/dashboard-view.tsx`, `ledger-home.tsx`, new `morning-market-picks.tsx` and its CSS module. Existing theme tokens/navigation remain.
- `frontend/src/components/signals/tradability-tag.tsx`: Markets/picker show the same Qualified/Caution/Rejected status and relative suitability as Home.
- `frontend/src/lib/oanda/client.ts`: read-only account discovery and optional abort signals on existing read helpers.
- `frontend/src/lib/calendar/forex-factory.ts`: fresh, current-week calendar coverage for selection; stale UI fallback is not accepted as current selection risk data.
- Test/replay scripts: `api-server/scripts/test-morning-scanner*.ts`, `fixtures/morning-scan.ts`, `replay-morning-scanner.ts`; updated `test-ny-tradability.ts` reflects the earlier start.

## Exact schedule and setup

The existing always-running Railway API process checks the clock every 30 seconds, including once at startup. `Intl` resolves **America/New_York**. No UTC offset or browser timer drives scans.

- Monday–Friday **06:30 ET**: first scan, normally within 30 seconds of the boundary.
- **06:35** evaluation and **06:45** publication are target milestones; completed results publish immediately. There is no artificial wait.
- Revalidate every five-minute slot through **10:55 ET**; stop at **11:00 ET**. Restarting during the window catches up the current slot, rather than replaying every missed broker request.
- The job has a **three-minute deadline**, broker requests retain the existing eight-second default timeout, and job SQL has a 15-second statement timeout.
- A PostgreSQL session advisory lock prevents overlap across replicas. A unique `version:ET-date:five-minute-slot` key prevents duplicate scheduled/manual jobs. Interrupted RUNNING attempts are recovered as FAILED. Completed snapshots remain immutable.
- Manual refresh uses the same job and slot. It has a database-backed **60-second cooldown**, and repeated refreshes within a completed five-minute slot reuse that run. Refresh is disabled outside the morning window.

Required existing configuration: `DATABASE_URL`, `OANDA_ACCOUNT_ID`, and `OANDA_API_KEY` or `OANDA_API_TOKEN`. Keep `OANDA_ENVIRONMENT=practice` for GX. Run `npm.cmd --workspace api-server run db:migrate` before the new API starts; Railway already runs this as pre-deploy.

Optional settings:

| Variable | Default / purpose |
|---|---|
| `ENABLE_SCHEDULERS` | Existing scheduler switch; any value except `false` enables jobs. |
| `MORNING_SCAN_ENABLED` | Enabled unless `false`; does not change trade execution settings. |
| `MORNING_SCAN_CLOSED_DATES` | Comma-separated ET dates, e.g. `2026-12-25`; configure known full broker closures. No assumption that every public holiday closes forex. |
| `MORNING_SCAN_INSTRUMENT_POLICIES` | JSON keyed by instrument; overrides objective, movement/cost/room ratios, news requirement/caution horizon, minimum score and ranking weights. Invalid settings fail the scan visibly. |
| `MORNING_SCAN_JOB_TOKEN` | Optional Bearer token for external POST `/api/morning-picks/scheduled`. Missing/wrong token is denied. The internal scheduler needs no public cron endpoint or token. |

The API must remain running. No additional cron service is needed on the current infrastructure; disabling/sleeping all API replicas prevents scheduling, and Home will mark old results stale. Existing owner authentication protects GET `/api/morning-picks` and POST `/api/morning-picks/refresh`.

Example instrument override:

```json
{"GBP_JPY":{"minRecentRangeObjectiveRatio":0.8,"maxSpreadObjectiveRatio":0.12}}
```

## Qualification and ranking

Only completed candles whose close is at/before evaluation enter any calculation. Pivots require right-side confirmation. Invalid/stale/missing candles or executable bid/ask never receive a favorable replacement. Default quote age <= five minutes (future timestamp tolerance five seconds); M15 lag <=20 minutes; H1 lag <=80 minutes after close; minimum history 120 M15 / 30 H1 candles.

- **Structure**: confirmed M15 HH/HL or LH/LL for Normal; H1 context. Range/unclear is rejected; transition or opposing H1 is caution.
- **Movement**: ATR(14), last two-hour range, realized close-to-close movement, London-so-far range, and the existing same-clock instrument baseline. Defaults require M15 ATR >=15p ×0.15 and two-hour range >=15p ×0.6; unavailable baseline rejects. >3× baseline is caution. These are provisional suitability filters, not a prediction that 15 pips will occur.
- **Cost**: actual ask-bid using the catalog's broker pip precision; discovery verifies metadata matches. Existing spread/M15 ATR hard block >0.4; >15p ×0.15 objective cost rejects; >0.2 ATR is caution. Instrument overrides support stricter/different horizon assumptions.
- **Levels**: existing M15/H1 S/R, confirmed swings, Asia, London established so far, previous UTC-day high/low (explicitly labeled), equal highs/lows within 0.1 ATR. No eventual London extrema. Opposing room <15p ×0.5 is caution; no mapped opposing level is unverified, not unlimited room.
- **Liquidity context**: approach, sweep/rejection, or two completed closes accepting beyond an existing level. London-so-far extrema are not counted as their own sweep. Existing setup factor uses the London range established *before* the recent observation bars. Context is not proof of institutional activity or profitable reversal.
- **News**: actual high-impact events for either currency. Block 15 minutes before/after; another 15 minutes settling when movement/spread remain abnormal. Upcoming high impact within 60 minutes is caution. Events show timestamp, minutes from scan and 08:00–11:00 ET overlap. No invented 08:30/10:00 releases. Unavailable/stale/wrong-week calendar is UNKNOWN and rejected by default.
- **Session**: observed same-hour activity, spread and session levels determine suitability for all discovered pairs; no fixed “NY favorites” whitelist. Holidays/unusual closures use configured dates and broker tradeable flags; stale quotes cannot masquerade as open markets.

Rank only QUALIFIED results: normalized existing factors weighted **structure 30 / volatility 20 / room 25 / spread 20 / setup context 5**, out of 100 *suitability points*. Default minimum 55. ATR/ranges/realized movement are correlated context and gates, not extra independent score bonuses. Sort descending score, then instrument for deterministic ties. Deduplicate instruments; take at most five, never fill missing places with caution/rejected pairs. Shared currencies are flagged; this is common exposure, not a numerical correlation estimate.

The fresh calendar supports AUD/CAD/CHF/EUR/GBP/JPY/NZD/USD. Other broker currencies are scanned but receive UNKNOWN required news risk and are rejected; they are not silently assumed safe. Discovery intersects broker CURRENCY instruments with GX's navigable catalog and verifies pip metadata. New broker instruments require the existing GX catalog/navigation to support them first.

## UI, persistence and broker cost

Home server-loads existing results, then reads persisted state every 30 seconds. It does not scan on mount. Rows show bias, M15/H1, explanation, spread/ATR/range, news status and chart link; expandable details show levels, measured room, realized movement, event times, input timestamps and points. Caution/rejected markets have separate disclosure lists. Chart links preselect the pair and preserve the existing optional Analyze workflow.

Results become stale after seven minutes, on a failed newer run, or on a different ET date. Stale saved results have an explicit warning. Closed markets hide recommendations; no eligible pairs is a valid empty state; provider outages are distinguishable from ordinary rejection. A failed refresh preserves the old result with a warning.

Snapshots record mode/version/date, start/evaluation/completion timestamps, duration, statuses, policies, factors, ranks, levels, news, reasons, input timestamps, provider failures and common exposure. Current state points to a successful/partial/closed run; failed runs do not overwrite the last successful one. Completed candles are deduplicated in `market_candles`, and live sampled bid/ask are stored in `quote_snapshots` for later replay. No orders/trade rows are written.

Instrument discovery caches for 24 hours. Up to four instrument workers (eight candle requests) operate per batch. Pricing is batched at 40; completed M15 history caches to its next close +5s, H1 to its own next close +5s. Identical fresh quote batches share a five-second cache; calendar uses the existing 15-minute single-flight cache. Retry transient 429/50x/timeouts up to twice with 0.5/1s backoff, respecting the job abort. Archived unchanged candles are not rewritten each five-minute scan.

## Validation and honest limits

Validated shared-engine tests, scanner unit tests, provider integration, and isolated PostgreSQL integration cover schedule/DST/closures, discovery, causal trend/levels, movement/cost, news UNKNOWN/blocks, deterministic ranking/empty/<5, duplicate jobs/overlap, stale/missing data, deadline/failure recovery, manual cooldown and persistent reads. Scoped frontend ESLint, API/frontend TypeScript and production build pass. Narrow browser checks cover the actual Home state and the same component with labeled fixtures, stale/closed/unavailable states, expanded rejections, theme tokens and pair-preselected chart navigation.

Commands from their owning directories:

```text
api-server: npm.cmd run ny-tradability:test
api-server: npx.cmd tsx scripts/test-morning-scanner.ts
api-server: npx.cmd tsx scripts/test-morning-scanner-provider.ts
api-server: npx.cmd tsx scripts/test-morning-scanner-db.ts
api-server: npm.cmd run typecheck
frontend: npm.cmd run typecheck
frontend: npm.cmd run build
```

`docs/morning-scan-fixture.json` is a labeled synthetic example: EUR/USD, GBP/USD and USD/JPY qualify at 79 suitability points, 0.6p spread, 16.8p ATR; NZD/USD is rejected for imminent high-impact news, EUR/GBP for 20.6p spread. These are test outputs, never hardcoded live picks.

Read-only historical readiness replay (`npx.cmd tsx scripts/replay-morning-scanner.ts YYYY-MM-DD,...`) sampled Oct 5–8 at 06:35, 07:00 and 09:30 ET. The existing archive lacked fresh quote snapshots at all 12 cutoffs; it also lacks a versioned historical calendar coverage manifest. All strict shortlists were empty. This proves a data-readiness limitation, not that the scanner is profitable or unprofitable. The report is `docs/morning-scan-historical-readiness.json`. Subsequent-movement, stability and downstream Analyze expectancy comparisons are not valid yet; accumulate the new snapshots/quotes before claiming them. No historical risk data was replaced with current data.

Next operational check: observe the first live weekday 06:30 ET job and its 06:35 revalidation in Railway logs / Home. The implementation and schedules are tested; a future scheduled run cannot be claimed as already observed.
