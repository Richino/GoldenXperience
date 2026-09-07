# EUR/USD Neural Day Engine V2

Verdict: **IMPROVED_BUT_STILL_NEGATIVE**

## What V1 got wrong

- V1 optimized a class-balanced target-hit classifier, not realized expectancy. Its scores were therefore rankings, not calibrated trade probabilities.
- V1 froze direction weights before August 2024; V2 retrains every six months using only earlier candles.
- V1 chose direction indirectly from two side scores. V2 has a separate pairwise direction head trained to choose the side with better executable R.
- V1 gated and recorded the following candle's close time while executing at its open; V2 aligns signal time, news distance, and next-open execution correctly.
- Development losses: 22/67 would have hit target in the opposite direction; 38/67 stopped on both sides; 31/67 never reached +0.25R first.
- Validation losses: 14/48 would have hit target in the opposite direction; 26/48 stopped on both sides; 21/48 never reached +0.25R first.

## Selected V2

- Configuration: **pairwise-mlp-positive-r-m15**
- Coverage: **3%** of past-calibrated opportunities
- Minimum pairwise direction confidence: **5%**
- Risk policy: **STATIC**
- Selection used development robust expectancy, not validation.

## Results

| Engine / period | Trades | Trades/day | Target win rate | Profitable rate | Expectancy | Profit factor | Total R | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| V1 development | 102 | 0.394 | 26.47% | 34.31% | -0.057R | 0.885 | -5.79R | 16.38R |
| V2 development | 105 | 0.405 | 21.90% | 44.76% | 0.071R | 1.192 | 7.44R | 8.29R |
| V1 validation | 67 | 0.259 | 26.87% | 28.36% | -0.110R | 0.790 | -7.36R | 10.28R |
| V2 validation | 61 | 0.236 | 13.11% | 42.62% | -0.047R | 0.876 | -2.89R | 9.04R |

## Conclusion

V2 reduced the validation loss, but it did not produce a positive edge. The objective mismatch was real, yet direction and setup quality remain insufficient.
