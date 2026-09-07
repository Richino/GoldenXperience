# Data audit — eurusd_h4_breakout_retest_swing_v1

- Instrument: EUR_USD
- Signal timeframe: OANDA H4 MBA, completed bars only
- Daily regime and breakout level: previous completed OANDA D MBA candle (`started daily index - 1`). The current session D high/low/close/EMA is not used. This avoids lookahead on a historically completed current-day candle.
- Warmup: H4 from 2022-07-01; D from 2021-01-01
- Evaluation window: 2023-01-01T00:00:00.000Z to 2026-09-05T00:00:00.000Z exclusive
- MBA source: OANDA practice API; H4/D cache reused from `eurusd-h4-bull-trend-breakout-v1-validation` (same warmup/to)
- Raw retest setups in window: 89 (53 long, 36 short)
- Skipped while a midpoint trade was open: 22
- Closed trades: 67
- Unresolved trades: 0
- Missing executable quotes: 0
- Historical financing: FINANCING_DATA_UNAVAILABLE
- Production evaluators, registries, and paper/live paths were not modified
