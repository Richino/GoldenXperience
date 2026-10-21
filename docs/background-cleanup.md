# Idle backtest worker and unused interface cleanup

The durable historical backtest worker now checks an empty queue every 30 seconds, rather than every second. That reduces idle queue checks from about 86,400 to 2,880 per day (96.7%). A processed job keeps the one-second cadence; errors back off to 30 seconds. Work never overlaps, and shutdown cancels the next check without rearming after an in-flight job. A newly queued historical backtest may wait up to 30 seconds before starting. The separate AI Analyze research worker and trading monitors retain their existing schedules.

Removed unused legacy dashboard binary cards, Journal/Markets tab shells, their unreferenced view components and three matching loading skeletons. The current route components (`TradesView` and `WatchlistView`) and historical prediction APIs remain intact. No trading records, research results or strategy artifacts were deleted.

Local-only diagnostic clutter was moved into the ignored `logs/cleanup-2026-10-20/` archive: 27 root stdout/stderr files and two temporary diagnostic scripts. `manifest.json` records each original path, archived path and verified SHA-256 hash. Restore an archived script to its original path before running it, so its relative imports and environment paths still resolve. Research outputs and unfinished Swing files were left in place.

Regression check: from `api-server`, run `npx tsx scripts/test-idle-research-worker.ts`. It covers startup, empty/active polling, no overlapping work, error backoff, cancellation and shutdown while a job is still in flight.

## Active order reads and private API traffic

Chart and dashboard polling use `/api/pending-entries?scope=active`. This filters history in SQL, retaining PENDING and TRIGGERING entries plus TRIGGERED entries without a confirmed closed paper trade. Missing trade rows remain visible for reconciliation. The default endpoint and `scope=all` retain historical access; no entries are deleted. Invalid scopes return 400. Run `npx tsx scripts/test-pending-entry-list-db.ts` from `api-server` for temporary-table regression checks covering active states, closed/history rows, missing trade links, pair filtering and tenant isolation.

The chart's periodic order, trade, watchlist, historical prediction and supporting candle reads skip hidden tabs. Its existing foreground refresh immediately reloads the core order, trade and market snapshots on return. Server-side order execution and trade monitoring keep their existing schedules.

The Railway frontend's server-only `API_SERVER_URL` uses `http://api.railway.internal:8080`; `NEXT_PUBLIC_API_SERVER_URL` retains the public HTTPS address. Next rewrites are resolved at build time, so changing this server-only variable requires rebuilding the frontend. Private service traffic avoids an extra public egress hop; traffic delivered to browsers is still public egress. Verify an authenticated proxied read, not just frontend `/health`, after this configuration change.

## Dormant strategy retirement and remaining idle polling

Legacy Confidence V2 and Breakout M5 automatic collectors are retired: the API no longer imports, starts or schedules either collector. Railway's `LEGACY_CONFIDENCE_V2_ENABLED` and `BREAKOUT_M5_ENABLED` are false as well. Their research artifacts and recorded trades remain; the shared trade resolver continues settling existing positions. Breakout Confidence V1 is a separate engine and is unchanged.

The AI Analyze worker checks once per minute when there are no active jobs or completion deliveries. It retains its configured active cadence (normally ten seconds) while any research job is queued, researching or validating, including jobs whose next check is still in the future. Analyze still submits immediately; enqueue and verified webhook events wake polling at the active cadence without repeatedly postponing it. Polling stays sequential and stops on server shutdown. Default idle database checks drop from about 17,280 to 2,880 per day; this is a query reduction, not a bill estimate. Historical backtest timing remains thirty seconds idle / one second active.

Home Plans skips automatic reads while hidden and refreshes on visibility return, restored pages and plan-change events. Visible idle cards refresh once per minute; cards with active jobs, plans being built, reviewable plans or monitored plans retain the ten-second refresh. Existing confirmation actions remain available. The polling and research-job regression scripts cover active/idle timing, enqueues during work, repeated wake-ups, cancelled timers, shutdown, pending provider checks and empty queues.
