# Data inventory — GX POC SWING LONG ONLY V1

Source: OANDA practice API MBA (mid/bid/ask) via getResearchCandles

## H1

- earliest: 2005-01-02T18:00:00.000000000Z
- latest: 2026-09-04T20:00:00.000000000Z
- count: 137442
- weekday gaps > 61 minutes (non-weekend): 1308
- duplicate timestamps: 0

## H4

- earliest: 2004-07-01T17:00:00.000000000Z
- latest: 2026-09-04T17:00:00.000000000Z
- count: 35084
- weekday gaps > 4h+1m (non-weekend): 430
- duplicate timestamps: 0

## Quotes and volume

- mid prices available: yes
- bid prices available: yes
- ask prices available: yes
- volume field available: yes
- volume kind: OANDA FX tick volume on the candle.volume field. Not centralized exchange volume.
- timezone / DST: OANDA candle times are UTC. Weekend gaps are expected. No DST shift is applied to bar opens.

Weekend gaps are expected for FX. Weekday gaps are mostly exchange holidays and short outages; they were not filled. History was not fabricated. Warmup requested H1 2005-01-01T00:00:00.000Z, H4 2004-07-01T00:00:00.000Z; evaluation ends 2026-09-05T00:00:00.000Z exclusive.
