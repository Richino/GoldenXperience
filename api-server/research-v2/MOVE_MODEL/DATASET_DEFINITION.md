# MOVE_MODEL — dataset & label definition

## Task
Binary classification per prediction timestamp: **MOVE** vs **NO_MOVE**. Direction is deliberately not modelled.

## Label
For horizon H bars after T, let `maxHigh` / `minLow` be the extreme mid high/low over bars (T, T+H]. The volatility-normalized excursion is:

```
excursion = max(maxHigh - close_T, close_T - minLow)
normExcursion = excursion / ATR14_T
MOVE = normExcursion >= threshold
```

Horizons: 15m (1 M15 bar), 30m (2 M15 bars), 60m (4 M15 bars), 120m (8 M15 bars).
Thresholds tested (ATR units): 0.5, 0.75, 1, 1.5, 2.
Windows crossing an unexpected weekday gap are excluded from that horizon (weekend/holiday gaps are not counted as moves).

## Period & splits
- Modelling window: 2020-01-01T00:00:00.000Z .. 2026-08-01T00:00:00.000Z.
- Final untouched holdout: 2026-02-01T00:00:00.000Z .. 2026-08-01T00:00:00.000Z (never used for threshold/horizon/feature selection).
- Walk-forward folds (expanding train, all before the holdout): 2022-01-01..2022-07-01; 2022-07-01..2023-01-01; 2023-01-01..2023-07-01; 2023-07-01..2024-01-01; 2024-01-01..2024-07-01; 2024-07-01..2025-01-01; 2025-01-01..2025-07-01; 2025-07-01..2026-01-01.
- Embargo: each fold drops training samples whose forward label window would reach into the test window.
- Standardization / bin edges / rule thresholds are fit on training rows only.
- Per-horizon primary threshold (balanced classes on dev): 15m=0.75, 30m=1, 60m=1.5, 120m=2.

## Sampling
One sample per M15 bar during the modelling window (24h coverage; session encoded as a feature). Labels overlap across consecutive bars; the effective independent sample size is ~N/H and significance is judged conservatively.
