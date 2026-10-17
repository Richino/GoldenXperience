# News Straddle v3 — practice STOP/OCO

This version replaces new News-mode entries only. Normal manual entries, AI plans and existing version-2 news runs retain their existing behavior. The server is the repository's existing Node HTTP API; no second Fastify server is introduced.

## Approved behavior

- The user selects a verified high-impact release 15 seconds to 5 hours ahead, checks broker risk, then explicitly arms. No AI call is made. The browser countdown is display only.
- Backend preflight starts T−12s, freezes executable ask/bid-based levels around T−3s and attempts two independent native STOP submissions at T−2s. More than 250ms late means skip. Actual HTTP dispatch, acknowledgment and broker fill timestamps are distinct audit fields.
- BUY is ask + offset; SELL is bid − offset. STOP price bounds reject unacceptable entry gaps. Broker GTD expiry backs up the configurable entry window (default 60 seconds).
- Every submitted STOP includes an initial stop-loss distance on fill. No fixed TP is sent. The original stop defines 1R; realized losses can exceed it.
- Default 1% per-trade ceiling and 1% event ceiling mean 0.5% planned risk per order. This intentionally reserves for two possible fills rather than preparing 2% exposure. Sizing uses NAV, stop distance and conservative home-currency loss conversion; integer units round down. Volatility uses 14 completed contiguous fresh M1 true ranges, default 2×ATR with approved stop bounds. Invalid broker minimums/precision are rejected.
- First immutable broker fill requests cancellation of the opposite order immediately. Cancellation is confirmed through broker transaction/readback, never assumed from the request. Failure to confirm promptly triggers emergency reduction.
- At +10 executable pips (BUY exits at bid; SELL exits at ask), request a native 7-pip trailing stop. Adding it omits `stopLoss` so the original stop remains. Readback verifies actual distance/value and no weakening of confirmed protection. No automatic stop widening or repeated trailing replacement.
- Both filled, partial/unexpected netting, missing/weakened protection, unexpected TP, configured loss/spread/holding limit, or prolonged inability to verify protection trigger cancellation and closure of this setup's identified trades. Double-fill/protection exceptions latch an account news pause. Reset requires no unresolved news runs and does not arm another trade.

## Persistence and recovery

Migration `064_news_straddle_v3.sql` adds run snapshots, transaction/audit deduplication, account cursor and pause latch. One active run per account/pair; one attempt per pair and normalized currency/title/UTC day. Same-day rescheduling does not create another attempt. Concurrent currency releases at the same timestamp share the risk budget even when provider titles differ. Across pairs, the sum of both-leg planned percentages cannot exceed the smallest approved event cap or account cap. Prior attempts conservatively retain their allocation.

A dedicated account leader owns scheduling and transaction streaming. Per-run database locks and revision checks protect state. Both submission intentions are committed before either POST. Deterministic client order/trade IDs identify broker orders after timeouts. An unknown submission is reconciled/cancelled, never blindly resubmitted. Startup replay uses the persisted transaction seed/cursor; the REST cursor advances only after every transaction is processed. Stream heartbeats never advance it. New entries require a recently synchronized REST cursor and live transaction stream. Broker I/O runs outside state locks so a slow acknowledgment cannot block OCO processing.

Calendar checks continue before a fill, including after pending acceptance. A changed/missing release cancels the attempt. Every preflight/entry checks the execution kill switch; active runs cancel/close when it becomes enabled. Existing manual-entry simulation and legacy news monitors do not execute v3 rows.

`paper_trades.target` is a legacy NOT NULL column: its existing no-target convention stores the original entry as a historical placeholder. This is **not** a broker TP. Actual pending-entry target is NULL, `noTarget` is true, broker STOP bodies omit TP, and v3 owns broker-confirmed closure. The journal stop remains the original R reference while the live confirmed stop is persisted separately.

## Broker and feed limits

- These independent entries are **not atomic OCO**. Cancellation races, both fills and netting remain possible. `REDUCE_FIRST` avoids deliberately opening the opposite hedge on hedging accounts; unexpected account exposure is an exception. Concurrent manual orders are outside this strategy's ownership; GX never deliberately flattens an unrelated trade.
- T−2 is a submission target, not an acceptance guarantee. Railway scheduling, remote DB latency, network delays and broker execution can miss it. The clock gate estimates skew/uncertainty from a broker REST pricing timestamp and round-trip midpoint, requiring each ≤250ms; this is a bounded sanity check, not authenticated NTP synchronization. Host clock discipline is still required.
- Forex Factory timestamps must include an explicit timezone and must not be inferred from a date-only event. The provider cache may be up to 15 minutes old. A last-minute change not yet published by the provider cannot be detected. Title/date identity cannot reliably link a release moved to another UTC day or renamed by the provider. Official-source timestamps and stable event IDs would strengthen this.
- Stream quotes are sampled; maximum spread at the exact broker fill cannot be guaranteed. Price bounds can cancel entries. Ordinary stops/trailing stops do not guarantee exit prices or a +3 pip profit after +10 activation. Spread, gaps, slippage, activation latency and fees can change outcomes.
- During broker/network failure the existing native stop stays at the broker, but Railway cannot guarantee cancellation or emergency closure until access returns. Unresolved orders stay visibly unresolved rather than inventing a safe terminal state. If a transaction cursor cannot be backfilled, synchronization stays unready and new entries remain blocked.
- 10/7 trailing parameters are experimental. Read-only candle replays cannot verify T−2 acceptance, OCO race frequency or actual broker stop behavior.

Primary broker references: [trade dependent orders](https://developer.oanda.com/rest-live-v20/trade-ep/), [order definitions](https://developer.oanda.com/rest-live-v20/order-df/), [transaction replay/stream](https://developer.oanda.com/rest-live-v20/transaction-ep/), [instrument constraints](https://developer.oanda.com/rest-live-v20/primitives-df/), [pricing](https://developer.oanda.com/rest-live-v20/pricing-ep/).

## Operation and validation

Requires migrated PostgreSQL, OANDA practice credentials, existing pending-entry monitoring and backend schedulers. `NEWS_STRADDLE_V3_ENABLED=false` prevents new v3 arming, cancels unfilled setups and keeps managing existing filled trades. Keep the backend schedulers running while any exposure is unresolved. This implementation refuses live configuration and MT4-linked accounts.

From `api-server`: `npm run news-straddle-v3:test` runs fake-clock/broker scenarios and rollback-only persistence checks. `npm run news-straddle:test` preserves v2 regression coverage; `npm run pending-entry:test` covers the shared manual path. `npm run news-straddle-v3:replay` creates read-only historical bid/ask exit comparisons in `outputs/news-straddle-v3-replay`; set `NEWS_REPLAY_LIMIT` (1–100) or `NEWS_REPLAY_EVENTS` for an explicit sample. The replay uses identical entries, a fixed 15-pip original stop, +2R versus +10/7 trailing, spread/price-bound checks, adverse slippage and activation latency assumptions. S5 OHLC paths are sensitivity scenarios, not true tick order. Report zero eligible fills honestly; do not loosen safety thresholds to manufacture a comparison.

The development-only `/dev/news-straddle-preview` route renders synthetic broker state with no write controls. Automated checks and browser previews do not replace a supervised practice-account integration test at a real release. No actual setup is armed or broker order submitted by these tests.
