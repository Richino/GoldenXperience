# H1 Direction V1 — Implementation Notes

## Isolation
- Code lives only under `api-server/scripts/h1-direction-v1/`.
- Outputs under `api-server/research/h1-direction-v1/`.
- No imports from production execution, adaptive engine, binary engine, or allowlists.

## Data
- Primary: `backtest-legacy-expanded/candles/{PAIR}_H1.json` (bid/ask + mid OHLC).
- Fallback: PostgreSQL `market_candles` + `market_candle_quotes` (EUR_AUD).
- Common period = intersection of Aug 2022 → Aug 2026 target with all 12 pairs.

## Signal Timing
- Features computed on completed H1 bar index `i`.
- Signal emitted at bar close; forward prices use future H1 closes only.

## Scoring Model (deterministic, not optimized)

| Component | Max magnitude | Key inputs |
| --- | ---: | --- |
| Structure | ±0.25 | HH/HL/LH/LL, BOS vs last swing |
| EMA trend | ±0.20 | EMA20/50/200 stack, slopes normalized by ATR |
| Momentum | ±0.20 | RSI delta, MACD hist, 4H ROC, candle body/ATR |
| Volatility | ±0.10 | ATR percentile, BB width expansion/contraction |
| Price location | ±0.15 | Distance to swings/mean in ATR units |
| Regime adj | ±0.08 | Trend/breakout boost; range/low-vol penalty |

Thresholds: LONG if score ≥ +0.60, SHORT if ≤ −0.60, else WAIT.

## Horizons
Forward direction evaluated at +1, +2, +3, +4, +6, +8, +12, +24 H1 bars.

## Trading Sim
- Entry: signal bar mid close.
- SL = 1×ATR(14); TP = {1, 1.5, 2}× SL distance.
- Same-bar TP+SL → conservative SL/AMBIGUOUS.
- NET subtracts spread (from bar bid/ask) as round-trip cost in R.
