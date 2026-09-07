# Data audit — eurusd_15m_trend_pullback_reclaim_v1

- Instrument: EUR_USD
- Signal timeframe: OANDA M15 MBA, completed bars only
- Daily bias: OANDA D MBA, previous completed daily candle only
- Warmup: M15 from 2022-07-01; D from 2021-01-01 (D fetch returned history back to 2008-11-13)
- Evaluation window: 2023-01-01T00:00:00.000Z to 2026-09-05T00:00:00.000Z exclusive
- M15 bars used: 105000 completed MBA candles after warmup clip
- No midpoint proxy when bid/ask were required
- Unresolved trades: 0
- Production evaluators, registries, and paper/live paths were not modified
