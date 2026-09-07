# EUR/USD Neural Day Engine V3 - Three-Class Opportunity Gate

Verdict: **PROMISING_SMALL_SAMPLE_UNCERTAIN**

## Gate

Before direction is considered, a past-only model classifies each setup as one-sided movement, two-sided whipsaw, or insufficient movement. The selected gate is **logistic-executable-asymmetry** and retains **25%** of V2-qualified opportunities.

## Results

| Period / engine | Trades | Trades/day | Target win rate | Profitable rate | Expectancy | PF | Total R | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Development V2 | 105 | 0.405 | 21.90% | 44.76% | 0.071R | 1.192 | 7.44R | 8.29R |
| Development V3 | 51 | 0.197 | 21.57% | 47.06% | 0.094R | 1.286 | 4.78R | 3.25R |
| Validation V2 | 61 | 0.236 | 13.11% | 42.62% | -0.047R | 0.876 | -2.89R | 9.04R |
| Validation V3 | 12 | 0.046 | 25.00% | 66.67% | 0.408R | 2.788 | 4.90R | 1.23R |

## Sample warning

Validation contains only **12 trades across 4 active months**. The 95% Wilson interval for the profitable rate is **39.1%-86.2%**. The observed improvement is promising, but the sample is too small to establish a durable edge.

## Interpretation

The gate improved profitable win rate and produced positive historical validation expectancy after costs, but only 12 validation trades occurred across 4 active months. This is an uncertain small-sample discovery, not a proven edge, and it was not connected to practice or live execution.
