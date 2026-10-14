# Analyze pullback distance audit — October 13, 2026

Read-only database inspection plus OANDA historical bid/ask M1 candles, valued at 2026-10-13T11:12:05Z. Latest 100 observer plans yielded six distinct pair/mode/direction/entry geometries with a pullback monitor. Four NORMAL plans have complete four-hour market observations; SWING observations are incomplete.

| Plan | Distance to pullback zone at creation | Largest retracement toward zone | Zone overlap within natural lifetime |
|---|---:|---:|---|
| EUR/USD NORMAL, Oct 12 08:23 New York | 32.4 pips | 4.5 pips | No, over four hours |
| USD/JPY NORMAL, Oct 12 19:33 New York | 16.8 pips | 1.1 pips | No, over four hours |
| GBP/USD NORMAL, Oct 12 01:09 New York | 3.1 pips | 7.4 pips | Yes |
| EUR/USD NORMAL, Oct 12 00:34 New York | 4.7 pips | 19.7 pips | Yes |
| USD/JPY SWING, Oct 12 19:34 New York | 46.3 pips | 70.1 pips | Yes, next morning; incomplete lifetime |
| EUR/USD SWING, Oct 13 06:51 New York | 52.5 pips | 1.6 pips | No within first 21 minutes; not an expired failure |

## Implementation findings

- Web/chart Analyze calls the observer service, which uses Analyze V2 and creates a conditional pullback monitor when no executable V2 trade exists. Native embedded flow uses a separate runMarketAnalysis path.
- conditionalPullbackPlan in api-server/src/market-observer-plan.ts selects an active structural zone and validates target/stop geometry, but does not limit current-price-to-zone distance or assess remaining lifetime versus the retracement required.
- Historical AT_ZONE or TRIGGERED context can still produce a watch area well behind current price. Candle contact before plan creation is not fresh executable confirmation.
- The zone builder allows nonstructural areas up to 15 primary ATRs away and exempts structural zones from even that distance bound. This is a map-building allowance, not an appropriate entry-distance check.
- Fallback zones are price-ascending; selecting candidates[0] can choose deeper support first for longs. Each of the six reconstructed examples had one eligible active zone, so this ordering issue does not explain their distances.
- Reconstructed historical primary ATR distances: EUR/USD NORMAL 32.4 pips was approximately 7.13 M15 ATRs; USD/JPY NORMAL 16.8 pips was approximately 4.32 M15 ATRs. EUR/USD SWING 52.5 pips was about 2.44 H4 ATRs. Reconstructed foundation uses historical candles with quote=null, not a recovery of the exact original live quote packet.

## Limits and recommendation

Reference prices are approximated by the previous completed M1 bid/ask close. M1 high/low overlap establishes only possible zone contact, not an accepted broker quote, post-touch candle confirmation or a fill. These subsequent paths extend to natural expiry even when the user stopped or replaced a monitor early; do not label them actual monitored failures. No profitability comparison or calibrated fill probability was established.

Add a separately tested entry-distance gate to conditional plan creation, expressed relative to primary volatility and different for NORMAL and SWING. Show far areas as distant watch levels instead of entry plans. Fix fallback ordering, but do not invent nearby levels or force market entries to increase fills. Existing frozen plans must retain their geometry. Select numerical thresholds prospectively and evaluate missed entries and resulting trade quality, not fill rate alone.

No runtime trading rules, saved plans, orders, settings or deployment were changed in this audit.
