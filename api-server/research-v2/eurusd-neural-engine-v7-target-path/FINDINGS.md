# EUR/USD V7 Target-Path Detector Findings

## Result

Stage 1 successfully ranks bars where either an executable long or short can reach the +1.5R target before the -0.75R stop within 60 minutes. It does not yet identify the correct direction well enough to authorize trades.

## Opportunity-detector performance

| Period | Unfiltered target-path rate | Selected rate at 2/day | Lift |
| --- | ---: | ---: | ---: |
| 2024 calibration | 26.31% | 40.00% | +13.69 percentage points |
| 2025 development diagnostic | 28.58% | 43.00% | +14.42 percentage points |

At 2.5 candidates/day, target-path precision was approximately 39% in 2024 and 41% in 2025. The lift is stable, but the absolute precision is below the previously requested 65% opportunity-quality gate.

## Direction controls

Six causal direction methods were tested on the same Stage-1 opportunities using 2024 calibration only:

- conditional neural direction;
- EMA trend;
- 12-bar momentum;
- 3-bar momentum;
- 24-bar mean reversion;
- current candle direction.

At two candidates per day, EMA trend was the least-bad 2024 direction method: 27% wins, -0.171R expectancy, and profit factor 0.68. Every direction method lost money. No method qualified for 2025 trade authorization.

## Status

- Stage 1 target-path detector: useful research signal, `WATCH` only.
- Stage 2 direction selector: failed.
- Trading enabled: no.
- Authorized 2025 trades: zero.
- 2026 final holdout: sealed.

The correct next boundary is to preserve the opportunity detector and research direction separately. Combining a valid opportunity lift with an unproven direction guess would destroy the value Stage 1 found.
