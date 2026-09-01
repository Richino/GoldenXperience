# MOVE_MODEL — feature definitions

All features are causal: computed from bars completed at or before prediction time T. Economic-calendar event TIMES are published ahead of the release and are therefore known at T; only the released VALUE is withheld until release.

| # | Feature | Group | Meaning |
|---:|---|---|---|
| 0 | `abs_ret1` | momentum | |log return| over 1 bar / ATR |
| 1 | `abs_ret4` | momentum | |log return| over 4 bars / ATR |
| 2 | `abs_ret16` | momentum | |log return| over 16 bars / ATR |
| 3 | `ret1_signed` | momentum | signed return 1 bar / ATR (only mild directionality; kept for momentum-of-move) |
| 4 | `ret4_signed` | momentum | signed return 4 bars / ATR |
| 5 | `atr_pips` | volatility | ATR14 in pips (volatility level) |
| 6 | `atr14_56` | volatility | ATR14/ATR56 (short vs long vol; expansion>1) |
| 7 | `rstd16` | volatility | realized stdev of returns over 16 bars / ATR |
| 8 | `rstd64` | volatility | realized stdev over 64 bars / ATR |
| 9 | `volofvol` | volatility | rstd16/rstd64 (vol acceleration) |
| 10 | `range_atr` | range | current candle range / ATR |
| 11 | `avg_range8_atr` | range | mean candle range over 8 bars / ATR |
| 12 | `width16_atr` | range | 16-bar high-low width / ATR |
| 13 | `width64_atr` | range | 64-bar high-low width / ATR |
| 14 | `eff8` | range | 8-bar efficiency ratio (trend vs chop) |
| 15 | `eff32` | range | 32-bar efficiency ratio |
| 16 | `boll_width20` | range | 20-bar Bollinger width (stdev/mean) |
| 17 | `body_ratio` | candle | |body|/range |
| 18 | `wick_ratio` | candle | (upper+lower wick)/range |
| 19 | `consec_abs` | candle | |consecutive same-direction bars|/8 |
| 20 | `range_pos32_abs` | location | |position in 32-bar range| (0 mid, 1 edge) |
| 21 | `dist_hi16_atr` | location | |distance to prior-16 high| / ATR |
| 22 | `dist_lo16_atr` | location | |distance to prior-16 low| / ATR |
| 23 | `min_edge16_atr` | location | distance to nearest 16-bar range edge / ATR (compression to breakout) |
| 24 | `dist_hi64_atr` | location | |distance to 64-bar high| / ATR |
| 25 | `dist_lo64_atr` | location | |distance to 64-bar low| / ATR |
| 26 | `hour_sin` | time | hour-of-day sine |
| 27 | `hour_cos` | time | hour-of-day cosine |
| 28 | `dow_sin` | time | day-of-week sine |
| 29 | `dow_cos` | time | day-of-week cosine |
| 30 | `sess_asia` | time | Asia session flag |
| 31 | `sess_london` | time | London session flag |
| 32 | `sess_overlap` | time | London/NY overlap flag |
| 33 | `sess_ny` | time | New York session flag |
| 34 | `h1_atr_ratio` | multitf | H1 ATR14/ATR56 (higher-TF vol expansion) |
| 35 | `h1_absret4` | multitf | |H1 4-bar return| / H1 ATR |
| 36 | `m5_rstd12` | multitf | M5 realized stdev over 12 bars / M15 ATR |
| 37 | `m5_available` | multitf | M5 coverage flag |
| 38 | `spread_atr` | spread | next-bar ask-bid spread / ATR (liquidity) |
| 39 | `news_available` | news | calendar coverage flag |
| 40 | `news_imminent` | news | exp(-minsToNextEvent/30) (scheduled release approaching) |
| 41 | `mins_to_next` | news | minutes to next scheduled event / 720 |
| 42 | `events_next120` | news | count of scheduled events in next 120 min /5 |
| 43 | `mins_since_last` | news | minutes since last event / 720 |
| 44 | `last_surprise_mag` | news | |surprise| of last released event |

**Volume: MISSING.** The M15/M5/H1 caches carry no volume field, so no volume feature is included.

Feature groups (9): momentum, volatility, range, candle, location, time, multitf, spread, news.
