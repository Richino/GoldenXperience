# GX Heavy Absorption v1

Price-action and OANDA mid-candle tick-activity proxy, available in the existing chart Indicators menu. Enabled by default; settings persist locally. No orders are created. Scores are weighted heuristics, not probabilities.

## Implementation

- `frontend/src/lib/indicators/absorption.ts`: reusable completed-candle engine, incremental append API, prior-20 relative volume/structure, previous-14 true-range ATR, rejection gates, weighted score, four-bar confirmation/invalidation/expiration, stable event IDs and latest 35 zones.
- `frontend/src/lib/indicators/absorption-settings.ts`: validated localStorage preferences with shared React subscriptions and an in-memory fallback.
- `frontend/src/components/charts/absorption-overlay.tsx`: historical detection/confirmation markers, selected-signal details, separate current H4 context, development diagnostics and new-bar alert delivery.
- `chart-box-primitive.ts`: native price/logical-bar zone projection and hit testing, shared with existing overlays.
- `absorption-settings.tsx`, `absorption.module.css`, `indicator-select.tsx`, `chart-sheet-controls.tsx`: desktop/mobile controls and presentation.
- `setup-chart.tsx`, `signal-workspace.tsx`, `chart-utils.ts`: chart integration, one-time default migration, replay alert suppression, and provider refresh after candle boundaries. Streaming quotes cannot certify completed OHLCV.
- `api-server/src/absorption-alerts.ts`, `server.ts`: owner-authenticated alert route. Recalculates requested events against genuine OANDA history and uses existing notification storage/push with stable per-event deduplication keys.

Candidate timestamps identify candle opens. The information panel separately shows the closing time at which detection/confirmation became available. Confirmation markers appear on the later confirming candle. Expired/invalidated zones remain faint historical records; they cannot confirm later. Confirmed records never transition again. Current H4 context does not describe the trend at the historical signal's time and never changes its score.

## Validation

Run `npm run absorption:test` in each workspace. Run `npx tsx scripts/check-absorption-history.ts` in `api-server` with existing OANDA Practice environment configuration for a read-only provider check. It validates 1,000 requested candles for EUR/USD, GBP/USD and USD/JPY on H1, H4 and D, batch/incremental parity, frozen confirmations and unique event IDs. It does not send notifications or execute orders.

Additional chart, Fibonacci and AMD regression tests, both TypeScript checks, focused runtime lint and frontend production build cover integration. Browser checks cover marker/zone selection, computed details, settings persistence and responsive layout. Browser emulation does not prove behavior on physical iOS/Android devices.

## Limits

- Tick activity is neither centralized traded volume nor bid/ask delta. Directional accuracy and profitability have not been established by these correctness tests.
- Alerts run for the selected chart while it is open and obtaining provider-completed bars. This is not an always-on multi-pair scanner. Initial history, replay, instrument/timeframe changes and settings changes establish a fresh alert baseline. Server-side recency checks reject old/forged events, and existing database deduplication prevents repeat notifications across reloads/devices. Push delivery still depends on the user's existing subscription/provider configuration.
- Missing/invalid OHLCV or missing traded bars invalidate unconfirmed candidates and reset the lookback. Closed-session gaps are allowed. Price levels and completed flags come from OANDA; provider corrections or changing settings legitimately recalculate the historical analysis.
- Calculation is memoized by completed OHLCV and settings; it does not recalculate on every price tick. New completed history is recalculated linearly from the loaded series; the reusable engine also supports incremental append. Zone storage and overlay work are bounded at 35 zones.
