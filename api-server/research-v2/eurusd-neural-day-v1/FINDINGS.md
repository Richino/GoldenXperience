# EUR/USD Neural Day Engine V1

Verdict: **DEVELOPMENT_GATE_FAILED_VALIDATION_DIAGNOSTIC_ONLY**

## Frozen protocol

- New research line; V19 is not imported or modified.
- M15 completed-bar decisions every 30 minutes, 06:00-15:59 UTC.
- Entry is the next M15 open using OANDA bid/ask plus 0.1 pip entry slippage.
- Exit uses the executable opposite side plus 0.1 pip exit slippage.
- Stop is 1.25 ATR14 with a four-pip floor; target is twice the stop distance.
- Payoff accounting is +1.5R / -0.75R; maximum hold is three hours.
- Same-bar ambiguity is charged as a stop.
- High-impact EUR/USD news is blocked within 60 minutes.
- One open trade, maximum three entries per day, and no forced quota.

## Model selection

Architecture was selected on 2023-01-01 through 2024-07-31 by target-class AUC, not trading win rate. The execution threshold was selected once on development by positive expectancy, profit factor, sample size, monthly stability, and drawdown. No 45-52% win-rate condition was used for selection.

Selected architecture: **mlp-24-8**. Selected score threshold: **0.6438298017093913**.

## Results

| Period | Trades | Trades/day | Target win rate | Profitable rate | Expectancy | Profit factor | Total R | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Development | 102 | 0.394 | 26.47% | 34.31% | -0.057R | 0.885 | -5.79R | 16.38R |
| Unseen validation | 67 | 0.259 | 26.87% | 28.36% | -0.110R | 0.790 | -7.36R | 10.28R |

## Interpretation

No development threshold met the predeclared expectancy, profit-factor, sample-size, and monthly-stability gate. Validation was opened once only to provide the requested honest diagnostic; the engine is not eligible for deployment.

The validation result was not used to retune this run. Any next model must be a separately named experiment with a new untouched validation boundary.
