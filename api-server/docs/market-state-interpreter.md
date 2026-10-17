# Market State Interpreter v1

The interpreter is deterministic synthesis of **validated research and the existing OANDA structure engine**, not another research model or trading strategy. It never requests OpenAI, grants entry permission, changes a confirmation, sets a risk threshold, or edits an approved plan. It has no calibrated probability or demonstrated predictive edge.

## Lifecycle and storage

Before research, `technicalSummaryFor` can supply compact price context to the existing strict research prompt. It no longer calls the plan generator or proposes BUY/SELL plans. After research passes the existing schema, URL/citation, pair-direction and calendar validation, completion delivery obtains fresh OANDA data, generates initial plans once per watcher, interprets the data, stores a snapshot, and stores the unapproved plans. The snapshot ID is frozen into those new plans.

Scheduled or later research on accepted plans obtains a new technical read and interpretation, without running the plan generator or modifying approved conditions. Existing evidence updates and notifications continue independently if interpretation fails. Research interpretation cannot confirm, cancel or execute either side. BUY and SELL retain their independent confirmation paths and existing risk/execution checks.

`market_state_snapshots` is an additive PostgreSQL table behind the existing authenticated API. This repository uses Railway PostgreSQL; there is no new Supabase client, public Data API, auth provider, or data-store migration. Records are inserted only, with engine version, research ID, source timestamps, input fingerprint, quality status and JSON contract version. Identical research/candle/calendar/plan inputs in the same clock hour are idempotent. Previous snapshots are compared, not overwritten. A cached GET retrieves the matching research interpretation; it never regenerates analysis or calls a model. Stored observations are not relabelled as current when stale.

## Required inputs and time handling

Research must use supported validated contract 2.0/2.1 for the same instrument, be fresh, and have a non-future timestamp. The verified calendar must cover the pair currencies, be available, and have a non-future read within six hours. Known missing forward-event coverage remains an explicit research limitation and partial-quality flag, not fabricated events. Current calendar verification failures hide the current interpretation on reads.

D1/H4/H1 history passes the existing Analyze V2 history, gaps and freshness checks; OHLC must be finite, positive and well formed. Only candles explicitly not forming and ending at or before the decision clock are used. No future candle can influence classification. A current executable quote is required while the market is open. While closed, the last completed OANDA candles may be used, labelled as such. A four-day wall-clock cap additionally rejects previous-week history even on weekends. Mandatory failures return `INSUFFICIENT_DATA` and explicit quality reasons, with no current interpretation or proposed opportunities. Read-time freshness checks prevent old H1/H4 observations from silently remaining current during an open market.

## Observed state definitions

Confirmed D1/H4/H1 swing structure is read by the existing `readMarketFoundation`/`readTrend` engine. The last 12 completed H1 intervals also describe the **already observed** move in H1 ATR and path efficiency (absolute net movement divided by total absolute close-to-close movement). These are operating definitions, not fitted signal thresholds:

- A recent move is directional at >=0.75 H1 ATR and >=0.35 efficiency; otherwise the existing H1 swing direction is used.
- `BULLISH_RECOVERY`: upward H1 movement against a confirmed downward D1 trend (or H4 if D1 is not trending). `BEARISH_RECOVERY` is the exact opposite: a downward countertrend pullback within an upward higher-timeframe trend. Neither means the higher trend has reversed.
- `BULLISH_TREND` / `BEARISH_TREND`: recent H1 movement agrees with H4 structure and is not counter to the established higher trend.
- `STRONG_*_TREND`: D1, H4 and H1 structure agree, recent movement is >=2 H1 ATR and efficiency >=0.65.
- `RANGE`: H4 is ranging and there is no meaningful directional H1 displacement.
- `VOLATILE_UNSTRUCTURED`: remaining conflicting/two-way structure; the UI calls this “Unstructured / two-way”. It is not an assertion that measured volatility exceeds a trading threshold.
- `INSUFFICIENT_DATA`: mandatory quality checks fail.

Continuation and invalidation levels come from existing confirmed swing/zone levels and recent completed price extremes. They explain what would strengthen or weaken the observation. They do not replace approved plan triggers. Recovery also names the protected D1 structure that has not yet reversed.

## Economic environment and forward lean

Raw validated bullish/bearish point totals remain visible. They do **not** classify observed price or automatically overwrite a research explanation.

Only pair-currency factors with returned-by-search source provenance participate in adjusted weights. Direction is re-derived from base/quote currency effects. Future-dated factors are excluded. Importance weights are 3/2/1; hypotheses count half. Recency multipliers are 1 within 24h, 0.8 within 72h, 0.5 within seven days, 0.25 when older, and 0.2 if undated. The near-term contribution of information older than 72h is additionally quarter-weighted; the swing contribution older than seven days is halved.

Related currency/topic factors form one catalyst group, with a **maximum** contribution per direction instead of a sum. Policy repricing and Treasury yields are grouped together; energy, fiscal, positioning, employment, inflation, growth and risk sentiment have separate groups. Unknown topics fall back to the cited source. This is conservative grouping, not semantic proof of independence. Conflicting descriptions remain visible within the group. Persistence is explicitly `NOT_ESTABLISHED`; prose alone cannot establish durability.

The fundamental environment is mixed when the absolute adjusted net share is <0.15. Otherwise it is slightly directional; a full directional environment requires net share >=0.35 and at least two supporting groups. No directional weights means insufficient evidence.

Near-term and swing forward preferences are separate. Price/catalyst conflict (opposing normalized catalyst score beyond 0.2) stays indeterminate. Price agreement with non-opposing evidence can support a slight preference; full directional preference additionally requires the strong observed trend, two supporting groups and catalyst score >=0.2. Strong catalysts without price confirmation can support only a slight near-term preference. A recovery against the higher trend leaves the swing reversal indeterminate. A verified range with balanced independent catalysts is neutral. Missing evidence remains indeterminate; no direction is forced. All thresholds are documented heuristics and no probability is displayed.

## Reaction provenance and opportunities

Recent verified releases are matched to completed OANDA H1 closes before and 1–2 hours after the event. Missing windows stay `UNVERIFIED`. Overlapping releases are flagged. Price movement is reported without claiming event causation or independently verified Treasury/OIS changes. Those remain reported research context unless the source data actually establishes them.

Initial opportunities copy the real generator's BUY/SELL entry zones, stops, targets, expiry, confirmation and invalidation rules. Insufficient reward/risk remains conditional and cannot bypass the existing 1.5R confirmation/execution threshold. Later interpretation updates carry research cases without inventing replacement trade levels; watched plans remain visible in their original components.

## Verification

`npm run market-state-interpreter:test` covers recovery/reversal separation, evidence conflicts, duplicate catalysts, recency/provenance, base/quote direction, missing/stale inputs, future/forming candles, reaction windows, prior snapshots and PostgreSQL idempotency/trading-table isolation. Database fixtures roll back. The existing trade-plan suite remains the authority for immutable approvals, independent opposite scenarios, confirmation and practice-only execution safety. The pre-existing observer's `market-state:test` remains separate and unchanged.
