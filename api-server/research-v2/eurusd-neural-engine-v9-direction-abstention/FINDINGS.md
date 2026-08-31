# EUR/USD neural engine V9: direction abstention

## Verdict

`NO_2024_EXECUTABLE_DIRECTION_EDGE_TRADING_DISABLED_FINAL_HOLDOUT_SEALED`

No 2024 arm passed. The new V9 rules were therefore not evaluated on 2025, and the 2026 final holdout remains sealed.

## What changed

V9 tested whether forced direction was the problem. It added three causal `WAIT` rules:

- neural direction must agree with the higher-timeframe EMA trend;
- fast EMA trend must agree with the higher-timeframe EMA trend;
- neural direction, higher-timeframe trend, and 12-hour momentum must all agree.

Each arm received its own outcome-blind confidence threshold so the comparison targeted the same realized frequency. The payoff remained `+1.5R / -0.75R`, with a 1.25 ATR stop, a 60-minute maximum hold, next-M5-open bid/ask fills, spread, and ambiguous bars charged as stops.

## 2024 result at approximately 2 trades per market day

| Direction rule | Trades | Win rate | Opportunity precision | Total R | Expectancy | Profit factor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 12-hour momentum, forced | 629 | 27.50% | 40.38% | -100.46R | -0.160R | 0.698 |
| Fast/higher-trend agreement | 628 | 21.82% | 39.33% | -180.48R | -0.287R | 0.499 |
| Neural/higher-trend agreement | 629 | 21.78% | 37.68% | -189.95R | -0.302R | 0.472 |
| Neural/trend/momentum agreement | 628 | 21.82% | 35.51% | -205.91R | -0.328R | 0.427 |

## Why abstention failed

Agreement produced fewer raw signals. To force those rules back to 2 trades/day, the frequency calibration had to lower the Stage-1 opportunity threshold. That admitted weaker move setups: opportunity precision fell from 40.38% for the best forced arm to 39.33%, 37.68%, and 35.51% for the abstaining arms. Agreement itself did not add enough directional accuracy to offset that damage.

## Decisive next step

Stop adding more price-only direction rules to this 60-minute engine. The evidence now covers a conditional neural model, fast and slow trends, multiple momentum windows, mean reversion, candle direction, multi-timeframe context, and agreement-based abstention; every 2-3/day arm lost materially.

The next valid experiment needs an independent directional input, such as historical news surprise, dollar/cross-pair relative strength, or another cross-market variable. It should be allowed to `WAIT` without forcing a 2/day quota. Requiring both external confirmation and 2-3 EUR/USD trades every day is likely incompatible with quality.

