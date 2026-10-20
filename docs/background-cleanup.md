# Idle backtest worker and unused interface cleanup

The durable historical backtest worker now checks an empty queue every 30 seconds, rather than every second. That reduces idle queue checks from about 86,400 to 2,880 per day (96.7%). A processed job keeps the one-second cadence; errors back off to 30 seconds. Work never overlaps, and shutdown cancels the next check without rearming after an in-flight job. A newly queued historical backtest may wait up to 30 seconds before starting. The separate AI Analyze research worker and trading monitors retain their existing schedules.

Removed unused legacy dashboard binary cards, Journal/Markets tab shells, their unreferenced view components and three matching loading skeletons. The current route components (`TradesView` and `WatchlistView`) and historical prediction APIs remain intact. No trading records, research results or strategy artifacts were deleted.

Local-only diagnostic clutter was moved into the ignored `logs/cleanup-2026-10-20/` archive: 27 root stdout/stderr files and two temporary diagnostic scripts. `manifest.json` records each original path, archived path and verified SHA-256 hash. Restore an archived script to its original path before running it, so its relative imports and environment paths still resolve. Research outputs and unfinished Swing files were left in place.

Regression check: from `api-server`, run `npx tsx scripts/test-idle-research-worker.ts`. It covers startup, empty/active polling, no overlapping work, error backoff, cancellation and shutdown while a job is still in flight.
