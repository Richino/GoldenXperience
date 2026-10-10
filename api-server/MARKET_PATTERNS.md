# Phase 3: deterministic pattern observer

This adds a separate pattern observer to phases 1 and 2. It evaluates broker
candles and updates provisional shapes from each usable received quote. It does
not modify the frozen Pattern V1 experiment, call AI, create trade proposals, or
place orders. A confirmed pattern means its geometry/close rule was observed;
it does not mean the direction will succeed.

## Use it

Standalone capture now feeds both movement and pattern observers:

```powershell
npm.cmd --workspace api-server run market-recording -- capture EUR_USD,AUD_JPY --seconds=120
```

This starts the practice quote stream and context collector without starting the
API's trading workers. Every 30 seconds it prints movement and pattern snapshots.
Replay through the same observer, in receive order:

```powershell
npm.cmd --workspace api-server run market-recording -- patterns data/market-recordings/SESSION.ndjson --instrument=EUR_USD --until=2026-10-09T14:30:00Z
```

Relative filenames resolve from the repository root. The requested pair must be
in the recording's session header. All rows are read to preserve sequence checks.
`snapshot` describes the cutoff; `lastQuoteSnapshot` is explicitly historical at
the last quote's receive time. An earlier view requires replaying that prefix;
the engine refuses to backdate its current in-memory pattern state.

To export every derived transition as NDJSON, including events outside the
bounded snapshot history, use:

```powershell
npm.cmd --workspace api-server run market-recording -- patterns data/market-recordings/SESSION.ndjson --instrument=EUR_USD --events
```

Each event carries its rule version and sequence. For a clean NDJSON file, use
`npm.cmd --silent --workspace api-server run market-recording -- ... --events`
to suppress npm's command headers. Export awaits stdout backpressure between
input rows; the API event buffer remains bounded.

For the API's existing practice connection, configure:

```dotenv
MARKET_PATTERNS_ENABLED=true
```

Authenticated owner GET `/api/market-patterns?instrument=AUD_JPY` returns evidence,
frame quality, movement, and recent lifecycle events. This also enables the shared
movement observer. The flag defaults to false and is refused in live mode.
No environment edits or deployment were performed by this phase.

The API reuses its pricing connection and a single context collector. M1 context
refreshes approximately every minute; M5/M15/H1/H4 approximately every five
minutes. Initial history is 256 candles per timeframe; requests are serial and
do not overlap. When recording selects fewer pairs than the observer, only the
selected pairs' context is written to that log. Other observed pairs do not
silently expand the session header or recordings.

## Supported rules

The version is `quote-pattern-observer@1`. These are explicit engineering
definitions, with unvalidated trading thresholds. Distances use the instrument's
catalog pip size. No pattern contributes an invented confidence percentage.

| Family | Detections | Definition |
| --- | --- | --- |
| Candle shapes | Doji, lower/upper wick rejection, large body | Range >=1 pip. Doji body <=10% of range. Rejection wick >=60%, opposite wick <=15%, body <=35%. Large body >=80%. |
| Two-candle shapes | Bullish/bearish engulfing, inside/outside bar | Opposite-color bodies with full body engulfment and a larger current body; strict high/low containment or expansion for inside/outside. |
| Three-candle shapes | Morning/evening star-like | First body >=60% of its range; middle body <=30% of first range; third closes through the first body's midpoint in the opposite direction. No exchange-session gap requirement. |
| Pivot structures | Double top/bottom | Alternating high-low-high or low-high-low; outer pivots within tolerance; both legs >=1 ATR; outer pivots >=4 bars apart. Confirmation requires a close beyond the intervening neckline plus buffer. |
| Pivot structures | Head-and-shoulders and inverse | Five alternating pivots, similar shoulders; head extension >=0.5 ATR, shoulder-to-neck legs >=0.5 ATR. A projected neckline close confirms. |
| Compression | Ascending, descending, symmetric triangle | Three highs and three lows fitting converging boundaries; middle touches within tolerance, current width >=0.5 ATR, apex within three formation spans. A boundary close supplies direction. |
| Levels | Range break up/down | Prior 20-bar box height >=2 ATR, at least two touches near each edge; current close beyond the edge plus buffer. |
| Levels | High/low sweep reclaim | Current wick exceeds a prior 20-bar extreme plus buffer and closes back inside it. This observes a price reclaim, not actual stop orders or institutional liquidity. |

Structure scale is the mean true range of up to 14 available completed bars,
floored at 1 pip. Pivot reach is two completed candles on either side; meaningful
legs require 0.5 ATR. Tolerance is max(1 pip, 0.25 ATR); breakout buffer is
max(0.1 pip, 0.1 ATR). Head-and-shoulders necklines and triangle boundaries are
projected through timestamped anchors. Related labels may overlap; they are not
independent votes. Change the rule version when changing these definitions.

## Lifecycle and evidence

Each detection has a stable pair/timeframe/anchor ID, rule family, direction,
anchors, measured evidence, boundary/invalidation geometry, revision, discovery
time, and latest update time. States are `forming`, `confirmed`, `invalidated`,
or `expired`. The event buffer retains earlier revisions and their original
evidence. Repeated identical snapshots do not emit duplicate confirmations.

- Forming candle shapes can disappear and reappear as their body/wicks change.
  Their revisions preserve that history. They cannot confirm through tick passage.
- Closed broker candles confirm candle geometry. Structural patterns wait for a
  closed candle beyond their specified boundary. `confirmedCandleTime` is the
  broker candle's open timestamp; add the timeframe duration for its close time.
  `confirmedObservedAt` is when the collector actually received the evidence.
- `previewBoundaryBreak` reports a provisional crossing without confirming it.
  `currentUpper`/`currentLower` expose projected boundaries for the current bar.
- A later completed close beyond invalidation changes state, retaining the
  original confirmation time. Candle shapes expire after more than six elapsed
  bars; structures after more than twenty, or at a triangle apex.
- Historical bootstrap detections are marked `historicalOnDiscovery`; fetching
  old candles cannot turn their pattern into a new live trade recommendation.

H4 preview buckets follow the offset inferred from the broker's latest candle,
rather than midnight UTC. Tick updates preserve observed midpoint highs/lows and
update the close. A newly observed candle's provisional open is the first sampled
quote, which may differ from the broker's true open. Only the final broker candle
can confirm it. The sampled path may omit intermediate price movements.

## Quality and bounds

Per-frame `dataState` and `reason` are separate from historical pattern states.
A historical confirmed shape can remain in the output while the live feed is
paused. The entire response has `actionable=false`; no trade-selection authority
is attached. A current data state is a feed-quality statement, not a trading edge.

Mock, malformed, future completed, unsorted, duplicate-time, and impossible OHLC
snapshots cannot support detections. Candle times normalize equivalent UTC
timestamp precision. A missing/incomplete candle splits history into contiguous
segments; patterns cannot span a weekend, interval/alignment change, or data gap.
A revision of an already completed candle pauses that frame until the observer
is restarted, preserving prior events rather than silently rewriting evidence.

Unusable quotes affect their own pair. Stream errors/reconnects invalidate quote
previews and require authoritative context resynchronization. A genuine later
snapshot can restore a provisional shape or confirm its final geometry.
Tick observations never manufacture completed candles; if the previous candle
has not been received as complete, the next interval waits for broker context.
M1 context older than 150 seconds and other frames older than 10 minutes pause.
Phase-2 quote freshness and clock checks also apply. Calendar snapshots are
preserved, but this phase does not interpret news impact.

History is bounded to 256 contiguous candles and 128 stored detections per
pair/timeframe, plus 256 recent events across the observer. API snapshots expose
up to 32 detections per frame, prioritizing active structures, then active candle
shapes, then terminal history; `omittedPatterns` makes clipping visible. They
include up to 64 recent events for the requested pair. Full derived event history
can be exported from the raw log with `--events` using the same rule version. This is not
a durable outcome journal or an alert delivery service.

## Validation and next gate

```powershell
npm.cmd --workspace api-server run market-patterns:test
npm.cmd --workspace api-server run market-movement:test
npm.cmd --workspace api-server run market-recording:test
npm.cmd --workspace api-server run pattern-v1:test
npm.cmd --workspace api-server run typecheck
```

Tests cover each supported family and negative controls, delayed pivots, JPY pip
scaling, broker H4 alignment, provisional revocation/reappearance, boundary
confirmation, invalidation, expiration, duplicate suppression, corrupt/stale
context, gaps, revisions, pair isolation, reconnect/resync, bounded histories,
selective recording, and deterministic cutoff replay through actual files.

The genuine phase-1 capture also replays its candle snapshots across all five
timeframes. Its nontradeable quote leaves live observation paused. A sustained
moving-market capture remains necessary to verify real-time previews and close
transitions. Pattern labels and thresholds have not been shown profitable.
Next, inspect those events during an open market before connecting them to the
AI explanation/mascot or any proposed entry plan.
