# Data audit — eurusd_h4_breakout_retest_rejection_v1

- Instrument: EUR_USD
- Signal timeframe: OANDA H4 MBA, completed bars only
- Daily regime and breakout level: previous completed OANDA D MBA candle (started daily index minus one)
- Long only. No shorts. No weekly filter. No trailing stop. No profit lock.
- Requested window: 2018-01-01T00:00:00.000Z to 2026-09-05T00:00:00.000Z exclusive
- Warmup request: H4 2017-07-01T00:00:00.000Z; D 2016-01-01T00:00:00.000Z
- H4 bars: 14283
- D bars: 2771
- H4 from: 2017-07-02T21:00:00.000000000Z
- D from: 2016-01-03T22:00:00.000000000Z
- Reached 2018: true
- Available from: 2018-01-01T00:00:00.000Z
- History closed: 61
- Verdict: FAILS_LONG_HISTORY
- Historical financing: FINANCING_DATA_UNAVAILABLE
- Production evaluators, registries, and paper/live paths were not modified
