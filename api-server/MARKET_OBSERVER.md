# Live market observer

The practice-only observer joins the recorder, movement measurements and pattern engine. It runs independently of order execution. Analyze saves a new server-generated plan version. A signal reaching TRIGGERED never submits an order; the existing entry-review workflow still requires the trader's action.

## Runtime

- `MARKET_OBSERVER_ENABLED=true` (default with practice credentials) enables movement and pattern context for the fourteen featured pairs, in addition to explicitly configured stream pairs. Set it to false to retain standalone Analyze.
- Every received broker quote enters the existing movement/pattern engines. State calculation runs every 250 ms; the chart reads the shared observer about once a second. This is OANDA's sampled stream, not every transaction in the forex market.
- M1, M5 and M15 broker candles refresh each minute; H1/H4 and the economic calendar refresh every five minutes. Candle confirmation therefore has REST-refresh latency. Forming quote previews cannot become a closed-candle confirmation.
- The directional lean describes the last twenty closed trading bars on H1, with H4 alignment and distinct 30-second quote pressure. Trading-bar context retains history across session gaps; geometric patterns never bridge a missing candle interval. Velocity, efficiency and persistence describe observations, not buy/sell order flow.
- The initial engineering thresholds require 0.3 closed-candle efficiency and half a mean true range of net movement for a directional lean. Quote pressure requires a covered 30-second window, 0.35 efficiency and 0.5 pips net. Direction changes persist for three seconds. None of these thresholds establish a trading edge.
- Missing or stale quotes, H1/H4/execution context, unknown calendar coverage, high-impact pair news from 30 minutes before through 15 minutes after release, and wide spreads block new signals. The spread limits are 5 pips or 30% of M1 mean true range with a one-pip floor. News and spread restrictions do not erase observations of a previously triggered hypothetical signal.

## Plans and journal

Apply `npm.cmd --workspace api-server run db:migrate` before enabling monitoring. Migration 054 adds separate observer plans and events. It changes no existing strategy or trade tables.

Normal plans use a new M5 closed candle; Swing plans use H1. A priced plan freezes the existing Analyze V2 entry zone, entry reference, stop and target. The trigger boundary is the last closed execution candle's high plus 0.1 pip for a long, or low minus 0.1 pip for a short. The entire confirming candle must start after plan creation. Confirmation remains usable for one following execution interval, while the executable ask (long) or bid (short) must enter the frozen zone within 25% of the original stop distance from the entry reference. This additional monitoring trigger is an experimental rule, not a validated improvement to Analyze V2.

Plans move through WATCHING, READY, TRIGGERED, PAUSED and INVALIDATED/EXPIRED/CLOSED. Normal expires after four hours and Swing after forty-eight (or the analyzer's explicit lifetime). A missing execution plan becomes a watch condition with nullable levels; it cannot trigger. New versions expire older active versions atomically. Completed versions and state changes remain in PostgreSQL. A disconnected/restarted observer cannot reconstruct an intervening path: triggered signals close with `unknown_after_gap` instead of invented wins/losses. Observed stop/target outcomes describe executable quote crossings; they are not fill-adjusted trading results.

The journal serializes writes, retains rapid transitions before flushing, refuses stale writes to terminal plans, pauses new signals while storage is unavailable and bounds its pending event backlog. API reads and mutations require the existing owner session.

## AI and chart bubble

`MARKET_OBSERVER_AI_ENABLED=true` (default when the existing OpenAI key is available) lets the configured analysis model select up to three relevant evidence IDs. The app renders the original measured facts verbatim, so the model cannot invent a level, change a plan or claim a win probability. Existing Analyze explanations remain available in the analysis card. There is one AI request in flight globally, a 90-second per-pair cooldown, a maximum of twenty calls per hour and a five-minute context refresh. Only recently viewed pairs and active plans request highlights; mathematical measurements continue without AI.

The chart mascot opens evidence, pattern states, change conditions, frozen plan levels and the plan journal. It can be minimized, stays above the mobile chart toolbar and Trade button, pauses on a connection failure and disappears during chart replay. Pair changes cannot display a previous pair's result.

## Verification and operation

```
npm.cmd --workspace api-server run market-observer:test
npm.cmd --workspace api-server run market-observer:db-test
npm.cmd --workspace api-server run market-patterns:test
npm.cmd --workspace api-server run market-recording -- observer data/market-recordings/SESSION.ndjson --instrument=EUR_USD --events
```

Run the database check from `api-server`; it uses rollback-only fixtures against the configured database. Replay consumes the original receive order and includes calendar/feed failures, with no AI calls or execution schedulers. `--until=ISO` restricts observations to those available at that receive-time cutoff.

Raw NDJSON recording remains separately opt-in through `MARKET_RECORDING_ENABLED` and `MARKET_RECORDING_INSTRUMENTS`. Use a persistent volume for `MARKET_RECORDING_DIR` in production. The recorder has explicit session/buffer caps and reports incomplete coverage when full; it does not provide unlimited tick storage. Observer plans/events are durable in PostgreSQL even when raw recording is off. Do not mistake the bounded in-memory movement window for a saved tick archive.

Before relying on Monday's observations, check that fresh tradeable quotes arrive, movement windows warm, all timeframes resynchronize, calendar coverage is current, and a saved plan survives reload/restart. Closed-market and synthetic checks verify mechanisms; they do not validate profitability. Collect prospective signal outcomes, spread, interruptions and a simple baseline before changing thresholds or granting execution authority.
