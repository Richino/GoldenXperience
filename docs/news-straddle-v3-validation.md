# News Straddle v3 validation — 2026-10-17

## Timing, stop and 1%-per-trade verification — 2026-10-18

33 fake-broker checks and the rollback-only PostgreSQL checks pass. New defaults size each order to 1% of NAV, so a $10,000 USD account with a 16-pip EUR/USD stop sizes to 62,500 units and $100 planned loss at the original stop (−1R). The combined event reserve is 2% because OCO cancellation is not atomic. Account per-trade/aggregate ceilings remain enforced separately, and previously approved smaller runs are not increased. Typechecks pass for API/frontend, and the changed UI passes scoped lint.

The timing check verifies no submission before the last ten seconds and submission at the configured T−2s target. A simulated fill at T−1.5s verifies immediate opposite cancellation. These are pending STOP entries: the actual fill depends on price reaching the entry and may occur after the release, within the existing window. There is no guaranteed pre-release market entry.

BUY and SELL threshold checks confirm no trailing request at +9.9 executable pips, activation at +10, a 7-pip native trailing distance, approximately +3 protected pips at activation, retention of the original stop, and no backward movement when price reverses. Both broker order bodies and position observations have no fixed take-profit. No actual broker order was submitted by this verification; actual release execution and Railway deployment remain unverified.

## Grouped-release update — 2026-10-18

29 fake-broker checks pass, including same-time grouping, both currencies of a pair, duplicate calendar rows, one BUY/SELL pair for three releases, and cancellation when a secondary release changes. PostgreSQL rollback checks also cover persistence of all approved members, immutable membership on retries, and one shared risk budget across currencies at the same time. API/frontend typechecks and scoped frontend lint pass. The development preview shows three releases with one countdown and one Accept button; no actual setup was armed.

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
