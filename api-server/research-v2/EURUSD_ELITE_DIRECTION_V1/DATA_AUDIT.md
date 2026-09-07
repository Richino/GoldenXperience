# EURUSD_ELITE_DIRECTION_V1 — Data audit

## Price data

- EUR/USD M15 bid/ask: 176,185 completed records, 2019-07-28T21:15:00.000Z through 2026-08-25T23:30:00.000Z.
- EUR/USD M5 bid/ask: 223,753 records, 2023-08-28T03:20:00.000Z through 2026-08-27T03:15:00.000Z.
- H1 context: EUR/USD plus 7 liquid EUR/USD crosses and USD majors. This fixed universe avoids symbol survivorship selection during the experiment.
- M1: **MISSING locally for this full period**. M15 is the conservative barrier resolver; same-bar TP/SL collisions are charged as stops.

| Audit | M15 | M5 |
|---|---:|---:|
| Raw rows | 176185 | 223753 |
| Duplicate timestamps | 0 | 0 |
| Non-monotonic rows | 0 | 0 |
| Invalid timestamps | 0 | 0 |
| Malformed OHLC/quotes | 0 | 0 |
| Negative bid/ask spreads | 0 | 0 |
| Sub-12h unexpected weekday gaps | 21 | 23 |

Weekend/holiday gaps are expected and are not forward-filled. The cache rows do not carry a vendor completeness flag; their completed-candle status is inherited from the repository fetcher and cannot be independently reconstructed, so that field is **MISSING**.

## Relevant repository inventory inspected

- Feature/model utilities: `scripts/eurusd-neural-day-v1/model.ts` and `experiment.ts` (rolling price state, regimes, train-only normalization, and deterministic neural training).
- Existing news-aware EUR/USD research: `scripts/eurusd-neural-day-v5/` and `research-v2/eurusd-neural-day-v5/`. V5 used different, development-selected geometry; its final slice was +0.0906R/trade but its expanding walk-forward result was -0.0812R/trade. It is contextual evidence, not an apples-to-apples +1R/-0.5R baseline.
- Existing simulators/caches: `scripts/_backtest_legacy_expanded.ts`, `scripts/_backtest_breakout_m5.ts`, `backtest-legacy-expanded/`, and `backtest-breakout-m5/`.
- Existing production/paper strategies were inspected only for isolation boundaries and were not imported, called, or modified. No directly comparable frozen +1R/-0.5R GoldenXperience baseline was available; that comparator is therefore **MISSING**, not fabricated.

## News data

- 801 high-impact EUR/USD events, 2024-08-01T12:30:00.000Z through 2026-07-30T12:30:00.000Z.
- 652 actual, 636 forecast, and 652 previous values.
- The files are absent from the current research branch but present in local git history. Sources: `master:api-server/research-v2/eurusd-ff-high-impact-aug2024-jul2025/events.json` (462 rows, SHA-256 bd3e48d0e8a064c6331138324c0206409c6f8bf37d349af63abb5c85f8f922a2); `master:api-server/research-v2/eurusd-ff-high-impact-aug2025-jul2026/events.json` (339 rows, SHA-256 725a5fadd81c59b01ae99a6d77788ef1586a5b6ae223b29e7f782a1d347b1368).
- Invalid release timestamps: 0; exact duplicate event rows: 0; timestamps containing multiple simultaneous releases: 213.
- All release timestamps are explicit UTC. Actual surprises are exposed only at or after releaseTimeUtc. Multiple releases sharing a timestamp are valid simultaneous events, not deduplicated away.
- The dataset does not contain vendor publication-latency/version history, so exact sub-minute release latency and revision-vintage reconstruction are **MISSING**.

## Leakage and execution audit

- Decisions use completed bars at T; entry is the next M15 executable ask/bid.
- All rolling features stop at T. H1/M5 joins use the last timestamp <= T. News releases after T are never exposed.
- Standardization is fitted only on each training fold. Experts, fusion, calibration, development, and final slices are chronological.
- Bid/ask spread is paid directly; 0.1 pip entry and 0.1 pip exit slippage are added.
- Geometry is +1R / -0.5R with a one-ATR unit (four-pip floor), maximum three-hour hold. Geometry is isolated in `GEOMETRY` for later experiments.
- Important limitation: the 2025-11..2026-08 final slice was inspected by earlier V5 research on this branch. It is chronological OOS for this code run but not a pristine never-seen organizational holdout. Claims are downgraded accordingly.
