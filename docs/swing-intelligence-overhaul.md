# GX swing intelligence implementation handoff

This implementation adds an opt-in, persistent, analysis-only 2–5 trading day engine to the existing application. It does not replace GX's authenticated HTTP API, cited research contract, candle provider, chart, approved plans or journals. The actual backend is Node's HTTP server and `pg`, not Fastify or a Supabase client. Migration naming and execution follow `api-server/scripts/migrate.ts`.

Implementation status: source written and manually inspected. No migration was applied, provider request issued, process started, test created/executed, compiler/linter/build invoked, or deployment performed for this overhaul. There is no runtime or trading validation claim.

## Files created

| File | Responsibility |
| --- | --- |
| `api-server/src/swing/config.ts` | Central provisional settings, account identity hash, error redaction |
| `api-server/src/swing/market.ts` | OANDA-only D1/H4/H1/M15 context, quality checks, existing structure/zones and release-reaction calculations |
| `api-server/src/swing/research.ts` | Existing cited Responses research plus strict independent candle interpretation and bounded hourly news checks |
| `api-server/src/swing/movement.ts` | Configurable bounded quote windows, existing movement math, zone residence and UTC H1/H4 observation aggregates |
| `api-server/src/swing/decision.ts` | Stable zone identities, reaction classification, separate BUY/SELL eligibility and broker-aware risk sizing |
| `api-server/src/swing/store.ts` | Scoped repositories, durable jobs/budgets, idempotent lifecycle transitions and decision history |
| `api-server/src/swing/service.ts` | Account worker ownership, recovery, scheduling, event coalescing and orchestration |
| `frontend/src/lib/swing-intelligence.ts` | Shared analysis DTOs; no execution command contract |
| `frontend/src/components/analysis/swing-intelligence-card.tsx` | Market/AI/evidence/zone/movement/scenario/usage panel and manual analysis controls |
| `frontend/src/components/analysis/swing-intelligence.module.css` | Existing GX theme variables and responsive layout |
| `api-server/migrations/065_swing_intelligence.sql` | Additive persistence, indexes and private server access |
| `api-server/.env.swing.example` | Opt-in configuration example; contains no credentials |
| `docs/swing-intelligence-overhaul.md` | This handoff |

## Existing files modified by this overhaul

| File | Change |
| --- | --- |
| `api-server/src/server.ts` | Authenticated swing routes, stream observation hooks, explicit worker startup/shutdown, session-scoped WebSocket updates and configured swing instruments |
| `api-server/src/market-movement.ts` | Exports its existing measurement function for reuse; existing measurement implementation/default windows are retained |
| `api-server/src/intelligence/openai-research.ts` | Optional per-call output-token cap, preserving existing callers and validation |
| `api-server/src/intelligence/market-state-interpreter.ts` | Exports the existing completed-H1 release-reaction calculation for reuse |
| `frontend/src/lib/market-stream/use-market-stream.ts` | Dispatches authenticated swing notifications through the existing browser connection |
| `frontend/src/components/signals/signal-workspace.tsx` | Swing panel plus distinct A/B zone overlays, excluded from historical replay |
| `frontend/src/components/dashboard/ledger-plans.tsx`, `frontend/src/components/analysis/swing-plan-rows.tsx` | Shows swing analysis progress, results and accepted watches inside Home's Plans section |

Earlier news-straddle and calendar-cache changes already present in the working tree are separate work. Existing automated test files were not changed as part of this overhaul.

## Operational boundary

The new modules never call order submission, modification, pending-order cancellation, position closure, trade-plan confirmation or an order executor. Eligibility is analysis for manual review. No swing scenarios are inserted into the existing executable plan queues.

Existing trading integrations remain intact and retain their existing settings. Enabling swing intelligence does not enable them or disable them. To review this feature on an isolated API with other mutating workers off, keep the existing `ENABLE_SCHEDULERS=false` configuration and explicitly enable only the swing analysis worker.

Both new flags default off:

```dotenv
SWING_INTELLIGENCE_ENABLED=true
SWING_ANALYSIS_WORKER_ENABLED=true
SWING_INSTRUMENTS=EUR_USD
```

The feature flag exposes analysis for configured pairs. The worker flag opts that API instance into the dedicated analysis loop. A PostgreSQL account-level advisory lock chooses one worker. The API shows an unavailable state until the migration and worker are available. A second API instance can read stored analysis; initiation is intended through the designated worker instance.

Raw OANDA observations feed bounded buffers only. No new AI call, SQL query or broker request runs from the per-quote callback. Important touches/invalidation candidates are coalesced in memory and wake the analysis worker on the next event-loop turn; an already busy worker finishes its current work first, with a five-second fallback pulse. A hard crash between an observed touch and persistence can lose that unpersisted observation; it is not reconstructed as a confirmed touch. This is analysis, not an execution/latency guarantee.

## Market and AI workflow

1. Retrieve actual OANDA `D` (represented internally as D1), H4, H1 and M15 candles with explicit source/connection checks. Mock fallback responses are rejected. Raw broker timestamps and completed status are retained. Only completed candles enter structural calculations; forming candle open times are identified separately.
2. Reuse GX's completed-candle normalization, market-session logic, swing classifier and structural-zone builder. D1/H4/H1 remain independent. ATR, directional closes, body strength, displacement, acceleration, close location, range recovery and volatility ratios are deterministic facts. M15 failure is reported without pretending it invalidates otherwise usable D1/H4/H1 structure.
3. Read the verified weekly calendar and existing actual-release integration. Reuse actual-versus-forecast calculations and completed-H1 reaction windows. Price reaction is an observation, not proof of causation. Revisions are unavailable, not inferred.
4. Use the existing `runResearch` Responses pipeline with the actual completed candle arrays and calculated context attached to its technical input. Search-returned URLs and the existing fundamental schema validator remain authoritative. A partial report or report requiring validation drops does not complete a swing assessment.
5. Make a second bounded Responses call without web search. It receives the validated fundamental report, the actual candles, deterministic facts, calendar, source timestamps and previous assessment. It independently interprets D1/H4/H1, BUY/SELL evidence, contradictions, the swing lean, changes and invalidation.
6. Strict runtime schema validation rejects malformed output, unknown source IDs, numerical technical levels absent from supplied OANDA/structure evidence, and zone proposals outside calculated candidates. Proposed AI zones are advisory; deterministic geometry remains authoritative.
7. Persist the full assessment, original validated fundamental report, evidence/source registry, per-stage usage and source timestamps. Failure does not replace the last successful assessment with fabricated success. Freshness gates prevent old research from granting eligibility after a new high-impact actual becomes available.

Source URL membership is verified against retrieved sources; that does not independently authenticate every prose assertion or source publication timestamp. AI prose remains an interpretation. Calendar numeric fields come from providers and structural execution numbers come from code.

## Zones and decisions

The default two candidates are a pullback/reversal zone and a distinct breakout/continuation boundary. They are selected from confirmed D1/H4 swing clusters according to the combined context. If one or both defensible zones are unavailable, the reason is stored and displayed. A valid existing zone remains the same zone while price enters it; a temporary `MIXED` support/resistance label does not erase a touched setup.

Boundaries are immutable within a zone generation. Confirmed supporting-structure or thesis changes expire the old analysis explicitly. Source assessment IDs, technical/fundamental support, swing references, BUY/SELL hypotheses and invalidation envelopes accompany each zone. A trading-hour TTL excludes the regular weekend closure; nothing resets at midnight. Explicitly stopping and restarting monitoring creates a new analysis campaign. It does not revive a previous expired scenario silently.

Persisted lifecycle:

```text
WATCHING → TOUCHED → EVALUATING → ELIGIBLE / REJECTED / EXPIRED
```

Rejected/evaluating/eligible analysis can be reassessed when evidence changes. Expired generations remain terminal. Revision checks and row locks protect transitions. A stop invalidates only the new analysis records, including in-flight evaluation races; broker state is untouched.

On touch, store executable bid/ask, broker time, spread, boundaries, D1/H4 reads, movement windows, current assessment reference, fundamental context, calendar, invalidation and quality issues. A feed gap resets crossing continuity; the engine does not infer a zone touch across missing quotes. Invalidation observations are retained until the next persistence pulse even if price immediately returns.

Reaction classification distinguishes rejection, breakout acceptance, continuation, failed breakout, consolidation and insufficient data. Meaningful movement/quality changes, the initial observation window, completed H1/H4 context changes, account refreshes and new research trigger reevaluation. Full research and risk calculations do not run on each quote.

BUY and SELL are evaluated independently:

- Aggressive: a qualified actual touch and structural directional support; a reversal candle is not mandatory.
- Balanced: an adequately covered, directionally supported initial zone reaction.
- Conservative: the covered reaction plus a post-touch completed H1 structural confirmation.

There is no claim that one entry style is more profitable. A D1 bearish structure can coexist with a qualified H4 BUY recovery; the contradiction remains visible. The combined directional lean is separate from entry eligibility.

Each proposal uses current executable entry pricing, a stop beyond a real zone/swing with an ATR buffer, opposing structural targets, spread impact, intended account risk, and size rounded down to OANDA unit precision. Missing targets remain null. The first target must fit the provisional reward/risk and D1 holding-horizon envelope. Account risk settings can reduce, never increase, the configured risk cap.

Read-only OANDA practice account endpoints supply NAV, currency, instrument pip/precision/size constraints, loss conversion, open trades and pending entries. Unknown protective stops/conversions block aggregate-risk approval. Existing same-instrument exposure blocks duplicated proposals. Neither side reserves or executes broker exposure. Multiple scenarios remain alternatives.

Financing is explicitly unavailable; no multi-day financing impact is invented. Historical expectancy is unavailable unless independently validated results have been supplied to `swing_expectancy` for the exact user/account/instrument/version/style/side. That table stores sample count, expectancy, optional win rate, evidence source and validation time; this task does not populate it with invented performance or run a research experiment.

## Observed movement and recovery

Configurable 15s/60s/5m/15m windows reuse GX's nanosecond timestamp parsing and existing movement math. Additional metrics include positive/negative path distance, alternating directions, consecutive moves, intrabar high/low recovery, failed extensions, spread extremes and residence above/inside/below the selected zone. Velocity/acceleration require observation coverage and minimum samples. Unchanged quotes are not directional moves.

Movement is normalized against H4 ATR, spread, observed quote frequency and an in-process New York-hour activity baseline. The baseline is unavailable until sufficiently populated and is not a calibrated historical session distribution. Raw buffers and baseline warm-up restart with the process. Persisted post-touch state is retained while live statistics warm again.

H1/H4 quote aggregates use explicit UTC observation buckets. They are labelled quote summaries and do not replace OANDA's broker-aligned completed candle history. Gap/reset counts accompany them. No global traded-volume or complete forex order-flow inference is made.

Persist one aggregate bucket per configured interval, with only the latest H1/H4 summaries. Retention removes only this feature's older movement aggregates, never journals, assessments, source evidence, approved plans or existing research. All in-memory quote and historical summary buffers have fixed bounds.

## Scheduling, budgets and failure handling

- Daily: one deduplicated assessment campaign per actively monitored pair, using the configured UTC schedule boundary. Starting a monitor without an assessment queues initial research.
- Calendar: inexpensive existing feed/cache checks detect newly available material actuals. Actual/forecast/previous fingerprints deduplicate release work. Observed completed-candle reactions are attached when available.
- Hourly: with no new commercial provider installed, the fallback performs one explicitly paid, bounded Responses web search. It stores retrieved sources, materiality, facts and limitations. Repeated source/fact fingerprints avoid another comprehensive assessment. A genuinely material result can invoke the two-stage assessment. The fallback can be disabled explicitly.
- H4 close: deterministic structure refresh always runs. Meaningful condition/displacement changes can request research; an unchanged candle boundary alone does not invoke AI.
- Request identity, partial unique indexes and worker claims prevent overlapping jobs for the same tenant/pair. Account budget allocation is locked transactionally across instruments/users sharing that broker account.
- Definite pre-provider data failures retry with bounded exponential backoff. Uncertain provider outcomes are not automatically reposted after a timeout/crash. Expired running leases are marked failed, with an explicit reason.
- No usable assessment is published unless every required stage completes and validates. Usage includes failed attempts when a response is available, search counts, input/output tokens, latency and estimated cost. Missing prices or usage remain unknown, never zero-cost success.
- The default six-job daily limit is **jobs**, not API requests. A full assessment normally consumes two requests; an hourly material-news job can consume three. The ledger counts actual per-stage requests.
- Optional USD budgeting requires the existing OpenAI input/output/search price configuration. Queued/running work reserves a configured amount; failed/unknown outcomes retain a conservative allowance. This is an application estimate/reservation guard, not a guaranteed provider billing cap. Configure a provider-side spend limit for a hard billing boundary. Existing non-swing AI workloads retain their existing budgets.

## Database migration

`065_swing_intelligence.sql` adds:

| Table | Data |
| --- | --- |
| `swing_monitors` | Tenant/account-scoped opt-in, style, latest market, schedule state |
| `swing_assessments` | Complete validated AI/fundamental assessments and source times |
| `swing_fundamental_evidence` | Factor/source audit records |
| `swing_technical_snapshots` | Deduplicated measured structural context |
| `swing_zones` | Immutable geometry, lifecycle and revision snapshots |
| `swing_zone_events` | Touches, changes, invalidations and decision history |
| `swing_movement_aggregates` | Bounded-retention summary buckets, no raw quotes |
| `swing_scenarios` | Latest independent BUY/SELL conditional proposals |
| `swing_research_jobs` | Durable deduplication, leases, status and reservations |
| `swing_ai_usage` | Per-stage usage, cost, latency and failures |
| `swing_expectancy` | Owner-supplied, independently validated historical results |

Tables have indexes for scoped latest/active/time queries and uniqueness for jobs, generations, events and aggregate buckets. New tables enable RLS and revoke public/browser-role table access. GX uses its own sessions/users rather than Supabase Auth; no inappropriate `auth.uid()` policy is introduced. The existing privileged server database role must own these tables or have the required server-side access; browser Data API grants are intentionally absent. No existing table/record is dropped.

## Authenticated API inventory

All routes use the existing session authorization and validate the instrument. All repositories scope tenant records by user ID and hashed broker account identity. The shared chart socket retains public price behavior; private swing notifications are sent only after checking the session for that user and instrument. REST polling remains the fallback when cross-origin socket cookies are unavailable.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/swing-intelligence?instrument=EUR_USD` | Combined dashboard snapshot |
| POST | `/api/swing-intelligence/monitor` | Start analysis; body `{ "instrument":"EUR_USD", "style":"BALANCED" }` |
| POST | `/api/swing-intelligence/analyze` | Start/rejoin analysis and return the queued job or cached result before showing confirmation |
| GET | `/api/swing-intelligence/plans` | Current user's swing analyses and saved watches, scoped to the broker account |
| POST | `/api/swing-intelligence/accept` | Save the reviewed assessment/scenario and zone snapshot for entry-condition watching; validates current ownership, levels and freshness |
| DELETE | `/api/swing-intelligence/monitor?instrument=EUR_USD` | Stop analysis and invalidate only its scenarios |
| POST | `/api/swing-intelligence/research` | Queue/join research; body `{ "instrument":"EUR_USD", "force":false }` |
| GET | `/api/swing-intelligence/assessment` | Latest assessment and freshness |
| GET | `/api/swing-intelligence/evidence` | Fundamental factors, retrieved sources, calendar |
| GET | `/api/swing-intelligence/structure` | Current D1/H4/H1/M15 data/context |
| GET | `/api/swing-intelligence/zones` | Active zones and unavailable reasons |
| GET | `/api/swing-intelligence/zones/:id` | Scoped zone, lifecycle history and post-touch movement |
| GET | `/api/swing-intelligence/movement` | Live observed movement summary |
| GET | `/api/swing-intelligence/control` | Separate D1/H4/pressure controls and preferred lean |
| GET | `/api/swing-intelligence/scenarios` | Conditional BUY/SELL hypotheses |
| GET | `/api/swing-intelligence/decisions` | Decision/eligibility history |
| GET | `/api/swing-intelligence/changes` | Material lifecycle and bias events |
| GET | `/api/swing-intelligence/research` | Latest job, current-day usage and worker status |

GET subresources also take `?instrument=...`. WebSocket messages use `type: "swing-intelligence"` with event/instrument/time and optional zone ID; no credentials or broker account identifier is sent. Meaningful touch, evaluation, control, eligible, invalidation, bias and stale-data changes notify the existing browser stream. Dashboard reads are deduplicated in-flight, coalesced around notifications and polled every ten seconds as a fallback. Tick-price updates continue through the existing chart stream.

## New environment settings

All numbers below are provisional operating choices, **not empirically validated thresholds**. Existing `ANALYZE_V2.SWING` and its shared regime/zone settings supply the remaining structural defaults. Invalid supplied configuration fails explicitly.

| Variable | Default |
| --- | --- |
| `SWING_INTELLIGENCE_ENABLED` | `false` |
| `SWING_ANALYSIS_WORKER_ENABLED` | `false` |
| `SWING_INSTRUMENTS` | `EUR_USD` |
| `SWING_ENTRY_STYLE` | `BALANCED` |
| `SWING_HOLDING_DAYS` | `5` (allowed 2–5) |
| `SWING_QUOTE_MAX_AGE_MS`, `SWING_QUOTE_GAP_MS` | `5000`, `5000` |
| `SWING_MAX_QUOTE_SAMPLES`, `SWING_MOVEMENT_WINDOWS` | `12000`, `15,60,300,900` |
| `SWING_MIN_MOVEMENT_SAMPLES`, `SWING_MIN_WINDOW_COVERAGE` | `12`, `0.8` |
| `SWING_CONTROL_EFFICIENCY`, `SWING_CONTROL_PROGRESS_ATR`, `SWING_CONTROL_PERSISTENCE` | `0.35`, `0.01`, `0.2` |
| `SWING_CONTROL_D1_WEIGHT`, `SWING_CONTROL_H4_WEIGHT`, `SWING_CONTROL_PRESSURE_WEIGHT`, `SWING_CONTROL_AI_WEIGHT`, `SWING_CONTROL_LEAN_THRESHOLD` | `3`, `2`, `1`, `1`, `2` |
| `SWING_ZONE_MIN_WIDTH_ATR`, `SWING_ZONE_MAX_WIDTH_ATR`, `SWING_ZONE_MAX_DISTANCE_ATR` | `0.15`, `0.8`, `6` |
| `SWING_ZONE_TTL_TRADING_HOURS`, `SWING_ZONE_INVALIDATION_ATR` | `120`, `2` |
| `SWING_BREAKOUT_ACCEPTANCE_ATR`, `SWING_ACCEPTANCE_SECONDS` | `0.08`, `45` |
| `SWING_INITIAL_OBSERVATION_SECONDS`, `SWING_REACTION_ATR` | `60`, `0.05` |
| `SWING_PIVOT_REACH`, `SWING_STRUCTURE_MIN_LEG_ATR` | `3`, `1` |
| `SWING_MIN_STOP_ATR`, `SWING_MAX_STOP_ATR`, `SWING_STOP_BUFFER_ATR` | `0.8`, `4`, `0.2` |
| `SWING_MIN_REWARD_RISK`, `SWING_MAX_TARGET_D1_ATR`, `SWING_MAX_SPREAD_STOP_SHARE` | `1.5`, `3`, `0.15` |
| `SWING_MAX_RISK_PERCENT`, `SWING_MAX_AGGREGATE_RISK_PERCENT` | `1`, `3` (account settings can lower these) |
| `SWING_NEWS_BLACKOUT_MINUTES` | `30` before/after high-impact release |
| `SWING_STRUCTURE_REFRESH_MS`, `SWING_ACCOUNT_REFRESH_MS` | `60000`, `30000` |
| `SWING_RESEARCH_CACHE_HOURS`, `SWING_DAILY_RESEARCH_HOUR_UTC` | `24`, `6` |
| `SWING_HOURLY_NEWS_CHECKS`, `SWING_HOURLY_SEARCH_ENABLED` | `true`, `true` (only runs after worker/monitor opt-in) |
| `SWING_NEWS_MATERIALITY_IMPACT`, `SWING_MATERIAL_STRUCTURE_CHANGE_ATR` | `3`, `1` |
| `SWING_DAILY_RESEARCH_LIMIT`, `SWING_MAX_SEARCHES` | `6` jobs/day/account, `3` searches/full research |
| `SWING_MAX_AI_SPEND_USD`, `SWING_AI_REQUEST_RESERVE_USD` | unset USD guard, `1` reserve/job |
| `SWING_RETRY_BACKOFF_MS`, `SWING_RESEARCH_TIMEOUT_MS` | `60000`, `300000` |
| `SWING_OPENAI_MODEL` | existing `OPENAI_RESEARCH_MODEL`, then `OPENAI_ANALYSIS_MODEL`, then existing app fallback |
| `SWING_REASONING_EFFORT` | `low` |
| `SWING_AGGREGATE_SECONDS`, `SWING_AGGREGATE_RETENTION_DAYS` | `60`, `30` |

Provider requirements remain the existing `DATABASE_URL`, OANDA practice account ID/API token/environment, and `OPENAI_API_KEY`. Reuse `OPENAI_WEB_SEARCH_TOOL` and the existing `OPENAI_PRICE_INPUT_PER_MTOK`, `OPENAI_PRICE_OUTPUT_PER_MTOK`, `OPENAI_PRICE_WEB_SEARCH_CALL` for cost estimates. No additional commercial news subscription, package dependency, AI agent service or authentication system is required. No credential or full configuration object is returned to the frontend.

## Manual review and startup — for the owner to perform

These are handoff instructions, not commands that were executed during implementation.

1. Review the new modules and additive SQL, particularly permissions, worker ownership, cost reservations and the scenario risk checks. The feature is off by default.
2. On your chosen review database, apply migrations through the existing runner: from `api-server`, `npm run db:migrate`. The server role must have the intended private-table access. Existing migration 052 supplies the instrument catalog.
3. Configure real practice OANDA credentials and OpenAI credentials in the existing server environment. Merge the needed keys from `.env.swing.example`; do not put secrets in frontend variables. Set the two swing flags to `true` only on the intended analysis host. Keep other trading workers configured independently.
4. Start the existing API/frontend with your usual commands (`npm run dev` in each workspace). No new service or process command is required. Open `/chart?instrument=EUR_USD`.
5. Press **Analyze**. The button shows **Analyzing…** until the server acknowledges the request, then a short confirmation offers **View Plans**. Home's existing **Plans** section shows progress, followed by **Review result**. Review links open `/chart?instrument=...&swing=review` and display the plan in a desktop modal or phone sheet. The main view shows entry zone, stop, target, conditions and **Accept BUY/SELL plan**; supporting research is collapsed. The server's configured entry style is used. The chart remains subscribed while the sheet is closed. Disabled workers and budget failures show an error, never a false started confirmation.
6. Review zero, one or two supported zones, their actual swing references, boundaries, TTL and the separate BUY/SELL hypotheses. Confirm the chart's purple A and blue B overlays match the stored geometry. Historical replay excludes these live overlays.
7. Observe a naturally occurring practice-market zone touch if desired. Review the persisted touch snapshot, coverage warm-up, pressure/reaction, style-specific eligibility and all blocker reasons. Manually assess source freshness, reward/risk, conversion, account exposure and spread. No trade should be submitted by this engine.
8. Review material release changes, daily/hourly deduplication, budget blocks, lost-stream warm-up, worker restarts and analysis stop/restart behavior. Confirm existing approved/executed plans, broker orders and positions are not edited by a swing update.
9. Supply validated historical performance only when you have it. Until then, the panel must show expectancy as unavailable and all scenarios as provisional. Evaluate financing separately while that estimate is unavailable.

Accept saves one immutable review snapshot per pair as a `PLAN_ACCEPTED` event in the existing private event store; accepting another replaces the current watch without deleting its history. No additional migration is required beyond 065. Watching derives current readiness from the existing worker's zone/scenario checks. Changed assessments, zones, stops or targets require another review; live quote movement alone does not replace the saved terms. Acceptance never creates an order. **Stop watching** stops the pair's analysis monitor. The existing daily/hourly research schedule remains unchanged by this UI simplification.

## Explicit limitations and remaining dependencies

- The simplified flow passes frontend/API typechecks and `npx tsx scripts/test-swing-plan-flow.ts` in `api-server`. New UI modules pass scoped lint; the chart workspace retains its baseline lint errors. A temporary synthetic browser fixture exercised start, progress, completion, review, acceptance and readiness at phone/desktop sizes. The real chart review link was checked, but its connected API reported Swing Intelligence disabled. Live research, SQL persistence, migration execution, backtests and deployment were not verified in this follow-up.
- Actual deployment credentials, provider quotas, supported model capabilities, database privileges and source availability must be supplied by the owner. No service success was fabricated.
- No hard profitability, prediction reliability, market-control probability or validated heuristic expectancy is claimed.
- Financing estimates and unavailable release revisions remain null. No automatic commercial news-provider adapter or raw-quote retention pipeline was added; existing verified calendar/actuals plus the paid one-search fallback are the implemented provider boundaries.
- Quote windows do not survive restarts as raw observations; persisted lifecycle and aggregates do. Warm-up and missing observations are explicit. Very quiet sampled feeds can remain insufficient under the provisional gap/coverage settings.
- AI interpretations and all classification/eligibility thresholds need empirical evaluation. URL provenance and deterministic price validation do not prove narrative truth.
- Independent existing GX trading schedulers are preserved. This overhaul's analysis-only boundary does not globally disable previously configured trading features.

Implementation completed to the extent described above. No tests, backtests, simulations, builds, or deployments were run.

## Follow-up: chart access and local setup

The chart's phone layout intentionally locks document scrolling. The initial panel below the chart was therefore unreachable and obscured by the pinned Trade action and navigation. Chart Analyze now opens the existing portal-based `MobileSheet` above those controls, with its own scrolling content. The same data component remains mounted behind the sheet; there is no second zone subscription or polling hook. Existing plan management and native embedded analysis are preserved.

The user subsequently authorized starting the local application and analysis worker while retaining the no-tests instruction. Migration `065_swing_intelligence.sql` was applied through the existing migration runner. The local API environment enables the two swing flags for EUR/USD and EUR/GBP; `ENABLE_SCHEDULERS=false` remains unchanged. The local API was restarted. These are local setup actions, not a production deployment. No analysis campaign or paid research was started by the implementing agent, and no tests, backtests, simulations, lint, typecheck or build commands were run.
