# Phase 1: practice market observations

The recorder provides data collection and receive-order replay. The standalone
capture command now also feeds the [phase-2 movement engine](MARKET_MOVEMENT.md)
and [phase-3 pattern observer](MARKET_PATTERNS.md). No AI or new order execution
is included.

## Capture without starting trading workers

From the repository root:

```powershell
npm.cmd --workspace api-server run market-recording -- capture EUR_USD,AUD_JPY
```

Stop with Ctrl+C to flush and write the end marker. For a finite capture:

```powershell
npm.cmd --workspace api-server run market-recording -- capture EUR_USD --seconds=60
```

The script loads existing environment files without printing credentials,
requires OANDA practice credentials, and never starts the API or its trading
schedulers. Instruments are explicit; the default is EUR_USD.

Each run prints its absolute NDJSON filename under `data/market-recordings/`.
That directory is excluded from Git. Existing recorded files are never replaced.

## Audit and replay

Use the file printed by capture. Relative filenames resolve from the repository
root even when invoked through the npm workspace:

```powershell
npm.cmd --workspace api-server run market-recording -- audit data/market-recordings/SESSION.ndjson
npm.cmd --workspace api-server run market-recording -- replay data/market-recordings/SESSION.ndjson --instrument=EUR_USD --until=2026-10-09T14:00:00Z
```

Replay outputs one JSON record per line in original receive order, suitable for
feeding the next phase. `--until` filters by when observations became available,
including candle/news snapshots. It does not sort by broker time or accelerate
an execution simulator. Old broker timestamps and unchanged quotes are retained.
Corrupt/truncated lines fail replay visibly instead of silently being skipped.

## What gets saved

- Session version/ID, ordered sequence number and reconnect number.
- Every received PRICE message before normalization/UI filtering, including
  unchanged and invalid quotes. Full original broker timestamps are preserved.
- Bid, ask, midpoint, spread, tradeability, receive timestamp, broker age,
  validation reasons, and the original price payload. No account ID/token.
- OANDA heartbeats and connecting/connected/error events. Locally generated
  browser heartbeats and mock stream data are not recorded.
- Genuine M1/M5/M15/H1/H4 midpoint candle snapshots, including completion flags:
  256 bars initially; recent bars afterward. M1 refreshes approximately once a
  minute, other timeframes approximately every five minutes. Requests are serial
  and cycles never overlap. Snapshot time is when the response became available.
- The calendar snapshot approximately every five minutes, including its source,
  provider timestamps and the contents available at capture time. Missing/mock
  candle or calendar responses become explicit context-error records.

Audit reports sequence gaps, clock/broker-time regressions, invalid/stale quotes,
quiet quote intervals (>5 seconds), heartbeat intervals (>20 seconds), connection
and context errors, and clean shutdown. Quiet periods do not prove lost ticks;
markets may be inactive. Clean shutdown does not mean complete market coverage.
If `connectedEvents=0`, the pricing handshake never completed in that recording.

## Reuse the API's existing connection

Optional API configuration:

```dotenv
MARKET_RECORDING_ENABLED=true
MARKET_RECORDING_INSTRUMENTS=EUR_USD,AUD_JPY
MARKET_RECORDING_DIR=/absolute/persistent/path/market-recordings
```

Recording pairs must also be subscribed through `MARKET_STREAM_INSTRUMENTS`.
The recorder is disabled by default and cannot activate in live mode. Its status
is available at authenticated GET `/api/market-recording/status`. This switch only
controls recording; it does not enable/disable existing trading workers.

Use a persistent volume before enabling production capture. Container-local
files do not survive replacement. No production deployment, migration, or
environment changes are part of this phase.

## Storage and quality boundaries

Writes are serialized and batched every second. Shutdown flushes the queue; an
abrupt kill can lose the final buffered second or leave a truncated append.
Missing end markers and corrupt tails remain visible in the audit/replay.
There is no automatic deletion or rotation: keep each capture below 512 MiB and
start another session as needed. An 8 MiB buffer ceiling and 512 MiB session
ceiling stop acceptance with an explicit error instead of unlimited growth.
Disk-write failures are not retried blindly because an append may have partially
succeeded. Check recorder status and restart after resolving storage problems.

OANDA samples its quote stream at at most four prices/second/instrument. This log
preserves all messages received, not every market transaction or intermediate
price. The stream has 20-second connection/read watchdogs and reconnects after
failure. A reconnect begins a new connection number; gaps are not filled with
synthetic ticks.

## Validation

```powershell
npm.cmd --workspace api-server run market-recording:test
npm.cmd --workspace api-server run typecheck
```

Tests exercise actual stream parsing with split chunks, all-pair normalization,
duplicate retention, broker timestamp precision, as-of replay, outages, invalid
quotes, buffer/disk failures, and corrupt recording tails. Forward verification
with genuine moving quotes remains necessary during an available market session.
