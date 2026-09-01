# DIRECTION_MODEL — dataset & label definition

## Task
Binary UP vs DOWN, evaluated only on meaningful-move cases. Direction only — no TP/SL, sizing, entries, or execution.

## Label
For horizon H bars after T: `up = maxHigh(T+1..T+H) - close_T`, `down = close_T - minLow(...)`. **UP = up >= down** (the larger excursion side). A net-displacement label (`close_{T+H} > close_T`) is also stored for robustness.

## Meaningful-move eligibility (from frozen MOVE_MODEL)
- Frozen MOVE thresholds (ATR units): 15m=0.75, 30m=1, 60m=1.5, 120m=2.
- **ORACLE** cases: ground-truth normalized excursion >= threshold (a move really happened).
- **CONDITIONAL** cases: frozen MOVE_MODEL causal OOS probability >= {0.50,0.55,0.60,0.65,0.70}.

## MOVE probability generation (frozen recipe, causal)
The frozen MOVE_MODEL GBT recipe (histogram GBT, 100 rounds, depth 3, lr 0.1, frozen feature set/threshold) is re-run in an expanding walk-forward (retrained every ~6 months, forward embargo) to emit out-of-sample P(MOVE) from 2021-01 onward. MOVE_MODEL itself is never modified.

## Period & splits
- Modelling window: 2021-01-01T00:00:00.000Z .. 2026-08-01T00:00:00.000Z (start bounded by MOVE-prob availability).
- Final untouched holdout: 2026-02-01T00:00:00.000Z .. 2026-08-01T00:00:00.000Z.
- Walk-forward folds: 2022-01-01..2022-07-01; 2022-07-01..2023-01-01; 2023-01-01..2023-07-01; 2023-07-01..2024-01-01; 2024-01-01..2024-07-01; 2024-07-01..2025-01-01; 2025-01-01..2025-07-01; 2025-07-01..2026-01-01. Expanding train, forward embargo = horizon length.
- Labels overlap across consecutive bars (effective N ≈ N/H); significance judged conservatively.
