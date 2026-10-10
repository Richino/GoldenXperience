# Phase 2: quote movement engine

The engine measures received OANDA quotes over rolling 5-second, 30-second, and
180-second windows. It does not predict the next candle, estimate a win
probability, call AI, or execute orders. Chart patterns are handled separately by
the [phase-3 observer](MARKET_PATTERNS.md), which now shares the standalone capture
command. Candles and news remain in the phase-1 recording.

## Run it

The standalone phase-1 capture command now also feeds the movement engine. Every
30 seconds it prints the recorder health and each pair's current measurements:

```powershell
npm.cmd --workspace api-server run market-recording -- capture EUR_USD,AUD_JPY --seconds=60
```

This starts the quote observer and context collector, without starting the API's
existing trading workers. Each received quote updates the bounded observation
window. Metrics are calculated when read, without any AI call per tick.

Replay a recording at a specific receive-time cutoff:

```powershell
npm.cmd --workspace api-server run market-recording -- movement data/market-recordings/SESSION.ndjson --instrument=EUR_USD --until=2026-10-09T14:00:05Z
```

The same engine consumes both live quotes and recorded raw payloads. Replay keeps
all pairs' records so their sequence numbers cannot create artificial gaps.
It observes feed events and never turns candles into synthetic ticks. Unknown
pairs and recordings without an OANDA practice session header are rejected.

Output includes `snapshot` at the requested cutoff (or last record time), plus
`lastQuoteSnapshot` at the last quote's receive time. A clean end marker makes
the final state paused/closed; the latter field is explicitly historical and
can itself be paused if that quote was unusable. Neither field proves that the
recording had uninterrupted coverage; use the phase-1 audit too.

To expose measurements from the API's existing practice stream, configure:

```dotenv
MARKET_MOVEMENT_ENABLED=true
```

Then authenticated owner GET `/api/market-movement?instrument=AUD_JPY` returns a
snapshot. Pairs must be subscribed through `MARKET_STREAM_INSTRUMENTS`. The
observer is disabled by default and cannot activate with live-mode credentials.
Recording is a separate switch. This phase adds backend and CLI functionality;
it opens no additional API stream and performs no migration, deployment, or
environment edits. The mascot and Analyze integration belong to later phases.

## What the numbers mean

All price distances use the instrument catalog's pip size. Durations use actual
broker timestamps with nanosecond precision, not a presumed 250 ms cadence.

| Measurement | Calculation / interpretation |
| --- | --- |
| Net movement | Last midpoint minus first midpoint, in pips |
| Velocity | Net movement / observed seconds; signed pips/second |
| Activity speed | Sum of absolute midpoint changes / observed seconds |
| Acceleration | Second-half velocity minus first-half velocity, divided by elapsed half-duration; pips/second squared |
| Directional efficiency | Absolute net movement / total path; 0 to 1 |
| Tick persistence | (Up transitions minus down transitions) / moving transitions; -1 to 1 |
| Quote direction | Up/down only when both bid and ask have progressed in that direction; otherwise flat or mixed |
| Bid/ask agreement | Counts of transitions where both sides increased/decreased |
| Excursions | Highest/lowest midpoint relative to the window start |
| Pullback / rebound | Current midpoint distance from window high / low |
| Spread | Current, maximum, and change in spread, in pips |
| Time distribution | Time above/below/at the starting midpoint, holding each previous observed quote until the next observation |
| Update rate | Observed transitions / elapsed seconds; not market trade volume |

`direction=flat` describes endpoints. A flat window can still have high activity
and range. Efficiency and persistence are descriptors, not confidence scores.
For example, an ask-only widening can increase midpoint velocity while the bid
does not rise; that window is `mixed`, and the spread change is visible.
FX broker quotes do not establish actual buyer/seller order flow or centralized
market volume. Time distributions describe observed quote holds, not the unknown
path between samples.

Acceleration compares observed endpoints around the elapsed-time midpoint. It is
null unless both halves span at least 0.5 seconds. A very short interval can have
a very large numeric velocity; it remains `warming` and is not an alert.

## Quality and continuity

Each window includes its observed duration, coverage ratio, sample count, and
`warming` / `ready` status. `ready` requires at least three samples and 80% of the
window duration. Overall readiness follows the 5-second window; longer windows
have their own status. These are engineering coverage rules, not tested trading
thresholds. Windows end at the last accepted quote; quote and receive ages show
how far that is from `asOf`. No pre-window movement is borrowed for a full span.

The engine rejects invalid/crossed/nonpositive bid/ask, unknown tradeability,
nontradeable quotes, malformed timestamps, receive/broker clock regressions,
broker timestamps more than one second in the future, and quotes over five
seconds old on arrival. A snapshot also pauses once its latest quote or reception
is over five seconds old. These cutoffs are intentionally stricter than the
existing order-entry freshness limit and do not change execution behavior.

Feed errors, malformed stream messages, reconnects, recording sequence/connection
changes, invalid quotes, and observed quote intervals over five seconds clear
measurement windows. The next usable quote starts a new baseline rather than
counting the missing interval as a surge. A quiet interval is a continuity break
for these measurements; it does not prove dropped broker messages.

Same-timestamp identical quotes are counted as duplicates and cannot refresh
freshness. New timestamps with unchanged prices are retained. Conflicting quotes
at the same timestamp invalidate the window. A broker-time watermark prevents
repeated older quotes from re-establishing a valid window after rejection.
Heartbeats never refresh quote age. Mock data never enters the engine.

Only the trailing 180 seconds are retained, with a hard ceiling of 4,096 samples
per pair. Reaching the ceiling clears the window and exposes `lastBreak` rather
than silently claiming complete coverage. Counters and reasons remain visible.

## Verification and next gate

```powershell
npm.cmd --workspace api-server run market-movement:test
npm.cmd --workspace api-server run market-recording:test
npm.cmd --workspace api-server run typecheck
```

Tests cover known-speed rises/falls, JPY pip scaling, oscillation, unchanged
quotes, irregular/nanosecond timing, acceleration, retracement, widening spreads,
invalid/stale quotes, duplicates, outages, independent pairs, bounded windows,
sequence/clock breaks, actual stream-parser integration, and repeatable as-of
replay through actual recorded files.

The existing genuine capture contains a stale nontradeable quote, so it can verify
that the engine refuses to invent active movement. Sustained live measurements
still need a moving-market capture. Before adding trading thresholds, collect
those samples and inspect spread behavior, gaps, and replay agreement. The phase-3
pattern observer builds on this foundation; profitability remains untested.
