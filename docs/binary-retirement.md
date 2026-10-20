# Binary retirement and background-cost controls

Binary prediction collection is retired by default. `BINARY_ENABLED=true` is now required to start the baseline, logistic-shadow/adaptive, and Pattern V1 collectors. The collector entry points also reject work while retired, so a direct call cannot silently create new predictions. Historical results and prediction detail links remain readable in Journal's **Binary history** tab. The active binary Markets tab and the chart's binary-watchlist polling were removed.

On a production worker, existing active binary predictions retain the five-second verified-price settlement loop. Once no active predictions remain, that loop stops too. No historical rows are deleted, and retiring binary does not change forex order or position monitoring. On-demand historical statistics still read saved history; there is no longer a background binary collector repeatedly downloading it.

Local development against the production database uses `ENABLE_SCHEDULERS=false` and `SWING_ANALYSIS_WORKER_ENABLED=false` in the ignored `api-server/.env.local`. Live chart reads remain available. Keep production schedulers enabled for accepted forex plans and existing practice positions.

The separate forex legacy-confidence-v2 collector now exits before fetching candles or writing evaluations when its model is over 14 days old or its training timestamp is invalid/future-dated. A valid refreshed artifact restores its existing behavior after reload. This guard preserves the existing model-validity rule rather than changing strategy thresholds.

Validation: `npx tsx scripts/test-retired-background-work.ts`, Pattern V1/adaptive statistics checks, pending-entry checks, API/frontend typechecks, chart history checks, and frontend production build. The existing `binary:test` feature-history fixture fails identically against the unmodified baseline; it is unrelated to retirement. Compare subsequent Railway usage over comparable market sessions to measure actual savings.
