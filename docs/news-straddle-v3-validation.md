# News Straddle v3 validation — 2026-10-17

- API and frontend TypeScript checks passed.
- 25 fake-broker/fake-clock v3 scenarios passed, including all ten requested cases, deterministic submission recovery, partial fills, protection regression, kill switch, disabling new entries while retaining open-trade management, matching exit comparisons, and mocked practice-only transport.
- Rollback-only PostgreSQL checks passed: duplicate-request identity despite JSONB key ordering, immutable approved settings, active-pair exclusion, shared simultaneous-release risk budget, NULL broker target, immutable original journal stop, closure and transaction deduplication. Temporary fixture tables isolate existing app rows. No test broker calls.
- Existing version-2 News Straddle suite: 38 checks passed, DB fixtures rolled back. Existing pending manual-entry suite passed.
- Chart overlay: 14 checks passed, including native bid/ask-derived v3 entries and preservation of existing v2 behavior. Calendar suite passed, including explicit-timezone provenance.
- Scoped lint passed for new News components, version routing, pair picker, chart overlay, calendar/client additions and development preview. The shared pending-entry dialog has two existing `react-hooks/purity` findings at its `Date.now()` checks inside the manual save handler, confirmed in HEAD. With only that existing rule disabled, its scoped lint passed; this change only hides the old cancel footer for v3.
- The normal production Turbopack build passed in an isolated worktree after installing frontend dependencies from its own lockfile. Production `/health` returned 200. The synthetic `/dev/news-straddle-preview` returned 404 in production. Existing development API `/health` returned 200.
- Browser checks: desktop News ticket, 375px ticket, desktop synthetic status and 375px synthetic status. Mobile DOM measurements showed no horizontal overflow. Arming stayed disabled with no eligible release. No write/arm/close control was activated. Screenshot evidence is under `outputs/news-v3-*.png`.

## Historical comparison result

Read-only OANDA S5 bid/ask history was evaluated around 100 distinct archived EUR/USD high-impact release timestamps. The two synchronized OHLC path scenarios each produced **zero eligible fills** with the same 10-pip offset, 60-second entry window, 3-pip spread cap, 2-pip entry bound and 0.5-pip adverse slippage assumptions. Events were skipped for no entry, spread expansion or a bound violation. No thresholds were relaxed to create trades.

Therefore fixed +2R versus +10/7 trailing performance is **not measurable in this sample**. Zero eligible fills is not a zero-return strategy estimate. The matched-entry deterministic fixtures verify both possible tradeoffs, not profitability. S5 candles cannot establish actual intrabar ordering, T−2 acceptance or OCO cancellation latency; the report explicitly records these limitations.

Reproduce from `api-server` with `NEWS_REPLAY_LIMIT=100 npm run news-straddle-v3:replay` (set the environment variable with the host shell's syntax). Local report: `outputs/news-straddle-v3-replay/REPORT.md`, with assumptions, raw cached broker candles and comparison JSON alongside it.

## Release boundary

Migration 064 was applied. No actual strategy was armed or OANDA order submitted. The implementation is local and has not been deployed to Railway. A supervised practice-account release test remains necessary before claiming broker execution acceptance. Live-money execution remains blocked.

Recommendation: first collect a broker-confirmed practice run with timestamped tick data. Use that evidence to assess timing, OCO latency and fill frequency before changing entry or exit parameters.
