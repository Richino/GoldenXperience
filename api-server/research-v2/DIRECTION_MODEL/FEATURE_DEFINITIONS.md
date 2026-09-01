# DIRECTION_MODEL — feature definitions

All features are causal (completed bars <= T; calendar event TIMES known ahead, released VALUES withheld). Unlike MOVE_MODEL these are deliberately SIGNED so they can carry directional information.

| # | Feature | Group | Meaning |
|---:|---|---|---|
| 0 | `close_ema20` | trend | (close−EMA20)/ATR |
| 1 | `close_ema50` | trend | (close−EMA50)/ATR |
| 2 | `ema20_ema50` | trend | (EMA20−EMA50)/ATR (trend sign) |
| 3 | `ema20_slope4` | trend | EMA20 slope over 4 bars /ATR |
| 4 | `ema50_slope16` | trend | EMA50 slope over 16 bars /ATR |
| 5 | `ret1` | momentum | signed return 1 bar /ATR |
| 6 | `ret4` | momentum | signed return 4 bars /ATR |
| 7 | `ret16` | momentum | signed return 16 bars /ATR |
| 8 | `ret48` | momentum | signed return 48 bars /ATR |
| 9 | `consecutive` | momentum | signed consecutive same-direction bars /8 |
| 10 | `range_pos32` | structure | position in 32-bar range (−1..1) |
| 11 | `range_pos64` | structure | position in 64-bar range (−1..1) |
| 12 | `dist_prior16_high` | structure | (close−prior16 high)/ATR |
| 13 | `dist_prior16_low` | structure | (close−prior16 low)/ATR |
| 14 | `breakout_pressure` | structure | (close−64-bar midpoint)/ATR |
| 15 | `atr14_56` | volatility | ATR14/ATR56 (vol expansion) |
| 16 | `range_atr` | volatility | candle range/ATR |
| 17 | `body_signed` | volatility | signed body/ATR |
| 18 | `wick_skew` | volatility | (lower−upper wick)/ATR |
| 19 | `h1_ret4` | multitf | signed H1 4-bar return /H1 ATR |
| 20 | `h1_ema20_50` | multitf | signed H1 (EMA20−EMA50)/H1 ATR |
| 21 | `m5_ret6` | multitf | signed M5 6-bar return /ATR |
| 22 | `hour_sin` | time | hour sine |
| 23 | `hour_cos` | time | hour cosine |
| 24 | `sess_asia` | time | Asia flag |
| 25 | `sess_london` | time | London flag |
| 26 | `sess_overlap` | time | overlap flag |
| 27 | `sess_ny` | time | New York flag |
| 28 | `news_signed_recent` | news | currency-signed decayed surprise of last event (+EUR / −USD bullish) |
| 29 | `news_imminent` | news | exp(−mins-to-next-event/30) |
| 30 | `spread_atr` | liquidity | next-bar spread/ATR |
| 31 | `move_prob` | move_conf | frozen MOVE_MODEL causal OOS P(MOVE) at this horizon |

`move_prob` is the frozen MOVE_MODEL's causal out-of-sample P(MOVE) at the matching horizon. Volume is unavailable in the caches (no volume feature).

Groups (9): trend, momentum, structure, volatility, multitf, time, news, liquidity, move_conf.
