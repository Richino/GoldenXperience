# TREND_PULLBACK_V2_FROZEN — EUR/USD

Frozen 2026-10-02, developed only on EUR/USD 2008-01-01 → 2023-12-31.
Config: `FROZEN.json` (SHA-256 `b47c787d1f35af731e2bfc50f27dc7a0dfa0349ae60c134af3b102a30fa236b9`).
Engine at freeze: `frontend/scripts/tp-v2/engine.mts` (git blob 35c945bf), `lib.mts` (git blob b56ac9ab).

All prices are OANDA EUR_USD mid candles: H4 and D, both aligned to 17:00 America/New_York.
"ATR" = 14-period Wilder ATR of H4 mid candles (first 14 bars: simple running mean of true range).
Every decision is made at the close of an H4 candle, from candles that have closed by then.

## Trend detection
1. Take the last 100 completed **daily** candles whose close time is at or before the H4 decision time.
2. Fit an ordinary least-squares line to their closes (x = 0..99).
3. If R² ≥ 0.30 and slope > 0 → trend UP; R² ≥ 0.30 and slope < 0 → trend DOWN; otherwise NO TREND (no order).
4. Trade only in the trend direction.

## Pullback detection (described for UP; DOWN is the exact mirror: highs↔lows, above↔below)
The impulse leg is tracked on H4 candles, every candle, whether or not a trade is open:
- State: A = leg origin (low), B = leg high, C = lowest low since B (empty after B is set).
- Each candle, in order:
  - if its low < A: restart the leg — A = this low, B = this high, C empty, new leg id;
  - else if its high > B: if (B − C) ≥ 2.0 × ATR then A = C (the pullback low becomes the new origin); B = this high; C empty; new leg id;
  - else C = min(C, this low).
- The leg qualifies when B − A ≥ 1.5 × ATR.
- Pullback level L = B − 0.66 × (B − A). If L ≤ A, no order.
- A valid pullback setup exists at the close when: the leg qualifies, C is empty or C > L (the level has not been touched yet), the H4 close > L, and no trade has already been entered on this leg id.

## Entry
- If the setup exists at the H4 close: place a BUY LIMIT at L (SELL LIMIT for DOWN) that works only during the next H4 candle; it is cancelled at that candle's close and the rules are re-evaluated (the level moves when B moves).
- Fill: buy limit fills when the ASK trades at or below L, at L (or the ask open if a bar opens below L). Sell limit fills when the BID trades at or above L.
- One position at a time. No new orders while a position is open. One entry per leg id.

## Stop loss
- 40.0 pips from the fill price (long: fill − 0.0040; short: fill + 0.0040).
- Exit on BID for longs, ASK for shorts; stop exits pay 0.2 pip slippage; gaps through the stop fill at the open.

## Take profit
- 60.0 pips from the fill price (1.5R).
- If one M5 bar touches both stop and target, the stop is assumed hit first. On the fill bar itself only the stop can be hit.
- Time exit: close at market after 20 days if neither is hit (never triggered in development).

## Filters
- News: no order is placed at an H4 close if a high-impact (TradingView importance "high") EUR or USD calendar event is scheduled within the next 240 minutes. The calendar covers 2013 onward; before 2013 this filter is inactive.
- No other filter (session, day, volatility, spread, regime filters were tested and rejected by the pre-set rule).

## Position / risk assumptions
- 1R = 40 pips. Risk a fixed fraction of equity per trade (e.g. 1%) → units = (equity × 1%) / (0.0040 × USD per unit per price unit). Results are reported in R.
- Costs: OANDA historical bid/ask spread, 0.2 pip slippage on stop exits, no commission (OANDA spread-only account), financing/swap NOT modelled.

## Development results (2008–2023, net of costs)
473 trades, 46.1% win, avg win +1.50R, avg loss −1.01R, expectancy +0.150R, PF 1.28, +70.9R, max DD 12.1R, longest losing streak 9, 29.8 trades/yr, 13/16 years positive (negative: 2008, 2016, 2018).
Gross (mid): +0.179R. Mirror (opposite direction): −0.200R.
Walk-forward of the full selection procedure (2012–2023): 229 trades, +0.097R, PF 1.17, t 1.06.

## Known weaknesses recorded before the unseen test
- Pullback depth is the fragile parameter: 0.66 is a peak (+0.15R); the 0.45–0.75 neighbourhood averages ≈ +0.05R.
- 3,854+ configurations were evaluated; best-of-many selection inflates in-sample results. Walk-forward kept roughly one-third of the training expectancy.
- Disclosure: earlier, separate research in this repo (V1 swing mode, 2021–2026, 14 pairs) touched 2024–2026 EUR/USD data with a different rule. None of it was used here.
