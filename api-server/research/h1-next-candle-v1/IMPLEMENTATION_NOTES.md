# H1 Next-Candle V1 — Implementation Notes

## Isolation
Code: `api-server/scripts/h1-next-candle-v1/`
Outputs: `api-server/research/h1-next-candle-v1/`

## Lookahead
Prediction at target candle T uses only completed candles with index < T.
Target open is known at decision time; close/high/low used only for scoring.

## Candle classes (ATR-normalized body on target candle)
- STRONG_BULL / STRONG_BEAR: bodyATR >= 0.50
- BULL / BEAR: 0.10 <= bodyATR < 0.50
- DOJI: bodyATR < 0.10

## Split
- DEV: 2022-08-01 → 2025-07-31 (transitions, pattern inspection)
- SEALED: 2025-08-01 → 2026-08-01 (frozen model evaluation)

## Model
Deterministic score in [-1, +1]; BUY if >= 0.60, SELL if <= -0.60, else WAIT.
See `model.ts` for component weights (pre-specified, not optimized on sealed data).

## Shapes
- Long wick: wick/range >= 0.45
- Inside/outside bar vs prior bar
- Engulfing: body engulfs prior body with opposite prior direction
- Narrow range: range/ATR < 0.50; wide: >= 1.20
