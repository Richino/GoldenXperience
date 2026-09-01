# MOVE_MODEL — data audit

## Price data
- EUR/USD M15: 176,185 rows, 2019-07-28T21:15:00.000Z .. 2026-08-25T23:30:00.000Z.
- EUR/USD H1: 44,055 rows, 2019-07-28T22:00:00.000Z .. 2026-08-25T23:00:00.000Z.
- EUR/USD M5: 223,753 rows, 2023-08-28T03:20:00.000Z .. 2026-08-27T03:15:00.000Z — **coverage starts 2023-08**, so M5 features carry an availability flag and are neutral before then.

| Audit | M15 | H1 | M5 |
|---|---:|---:|---:|
| Rows | 176185 | 44055 | 223753 |
| Duplicate timestamps | 0 | 0 | 0 |
| Non-monotonic rows | 0 | 0 | 0 |
| Sub-threshold unexpected weekday gaps | 21 | 1 | 23 |

**Volume: MISSING** across all three caches (no volume field present).

## News data
- 801 high-impact EUR/USD calendar events, 2024-08-01T12:30:00.000Z .. 2026-07-30T12:30:00.000Z.
- Sources (absent from this branch, read from git history): `master:api-server/research-v2/eurusd-ff-high-impact-aug2024-jul2025/events.json` (462 rows, SHA-256 bd3e48d0e8a064c6331138324c0206409c6f8bf37d349af63abb5c85f8f922a2); `master:api-server/research-v2/eurusd-ff-high-impact-aug2025-jul2026/events.json` (339 rows, SHA-256 725a5fadd81c59b01ae99a6d77788ef1586a5b6ae223b29e7f782a1d347b1368).
- Only event TIMES (published ahead) are used as forward-looking features; the released VALUE is used only for the surprise magnitude of PAST events. News features carry an availability flag and are neutral before 2024-08.

## Leakage controls
- Every rolling feature stops at T; H1/M5 joins use the last bar with timestamp <= T.
- Labels look strictly forward from T+1; folds are chronological with a forward embargo.
- Standardization, GBT bin edges and the ATR-rule threshold are fit on training rows only.
- The final holdout was not consulted for any threshold, horizon, or feature decision.
