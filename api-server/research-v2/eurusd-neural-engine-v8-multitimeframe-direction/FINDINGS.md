# EUR/USD neural engine V8: multi-timeframe direction

## Verdict

`NO_2024_EXECUTABLE_DIRECTION_EDGE`

Trading stays disabled. The 2026 final holdout was not opened.

## What changed

- Kept the V7 Stage-1 opportunity definition: either executable long or short can reach `+1.5R` before `-0.75R` within 60 minutes.
- Added causal 2-hour, 4-hour, 12-hour, 24-hour, and 48-hour price context to Stage 2.
- Compared the conditional neural direction against EMA trend, higher-timeframe trend/momentum, short momentum, mean reversion, and candle direction.
- Trained on 2022-2023 and selected only on 2024, using next-M5-open bid/ask execution.

## 2024 result at approximately 2 trades per market day

| Direction rule | Trades | Win rate | Better-path accuracy | Total R | Expectancy | Profit factor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 12-hour momentum | 629 | 27.50% | 52.94% | -100.46R | -0.160R | 0.698 |
| EMA12/EMA48 trend | 628 | 27.23% | 51.11% | -105.16R | -0.167R | 0.685 |
| 15-minute momentum | 629 | 26.71% | 45.63% | -119.16R | -0.189R | 0.646 |
| Conditional neural | 628 | 24.68% | 42.52% | -144.25R | -0.230R | 0.586 |
| 12-hour/48-hour EMA trend | 628 | 21.82% | 52.23% | -182.34R | -0.290R | 0.494 |

Stage 1 still showed useful opportunity lift: the unfiltered 2024 target-path rate was 26.31%, while the best 2/day stream contained a target path on 40.38% of entries. That does not become profit because Stage 2 selected the target side only 52.94% of the time and many non-target paths still lost after spread.

## Conclusion

Longer price history slightly improved the best forced direction result versus V7, but it remained decisively negative and far below the 40% win gate. Multi-timeframe price trend is not the missing executable direction edge at this frequency.

