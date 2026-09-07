VERDICT:
REJECT_LONG

TradingView parity:
TV trades: 29
Backend trades: 35
TV WR: 37.93%
Backend WR: 28.57%
TV PF: 0.98
Backend PF: 0.800

Parity class: CLOSE
Count is CLOSE (35 vs 29). Win rate is weaker (28.57% vs 37.93%): backend has 1 fewer winner and 7 more losers. That is extra signals, not a 29-vs-120 blowup. TradingView PF 0.98 is likely raw-price P/L; backend PF 0.80 is exact +2R/−1R fills. Frozen rules were not changed to chase the TV win rate.

Full historical validation:
Period: 2005-01-02T18:00:00.000000000Z to 2026-09-04T20:00:00.000000000Z
Trades: 180
Trades/year: 8.18
Wins: 56
Losses: 124
WR: 31.11%
PF: 0.902
Net R: -12.140
Expectancy R/trade: -0.067
Max DD: 19.000
Avg hold: 22.511 h
Median hold: 10.000 h
Max hold: 177.000 h
WR 95% Wilson CI: 24.80% to 38.21%

Midpoint / ideal:
WR: 32.78%
PF: 0.975
Net R: -3.000
Expectancy: -0.017

Realistic execution:
WR: 31.11%
PF: 0.902
Net R: -12.140
Expectancy: -0.067

First half:
Trades: 90
WR: 34.44%
PF: 1.048
Expectancy: 0.032

Second half:
Trades: 90
WR: 27.78%
PF: 0.769
Expectancy: -0.167

Years >=40% WR:
6 / 22

Walk-forward / chronological stability:
FAIL

40% direction rule:
FAIL

Final classification:
REJECT_LONG

## Year by year (executable)

| Year | Trades | Wins | Losses | WR | PF | Net R | Exp R | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2005 | 11 | 2 | 9 | 18.18% | 0.444 | -5.000 | -0.455 | 5.000 |
| 2006 | 11 | 5 | 6 | 45.45% | 1.667 | 4.000 | 0.364 | 5.000 |
| 2007 | 9 | 1 | 8 | 11.11% | 0.246 | -6.130 | -0.681 | 8.130 |
| 2008 | 6 | 2 | 4 | 33.33% | 1.000 | 0.000 | 0.000 | 3.000 |
| 2009 | 4 | 2 | 2 | 50.00% | 2.000 | 2.000 | 0.500 | 2.000 |
| 2010 | 8 | 3 | 5 | 37.50% | 1.200 | 1.000 | 0.125 | 3.000 |
| 2011 | 5 | 0 | 5 | 0.00% | 0.000 | -5.010 | -1.002 | 5.010 |
| 2012 | 6 | 2 | 4 | 33.33% | 1.000 | 0.000 | 0.000 | 3.000 |
| 2013 | 10 | 3 | 7 | 30.00% | 0.857 | -1.000 | -0.100 | 4.000 |
| 2014 | 9 | 5 | 4 | 55.56% | 2.500 | 6.000 | 0.667 | 1.000 |
| 2015 | 12 | 6 | 6 | 50.00% | 2.000 | 6.000 | 0.500 | 3.000 |
| 2016 | 5 | 0 | 5 | 0.00% | 0.000 | -5.000 | -1.000 | 5.000 |
| 2017 | 8 | 2 | 6 | 25.00% | 0.667 | -2.000 | -0.250 | 3.000 |
| 2018 | 6 | 2 | 4 | 33.33% | 1.000 | 0.000 | 0.000 | 2.000 |
| 2019 | 10 | 3 | 7 | 30.00% | 0.857 | -1.000 | -0.100 | 4.000 |
| 2020 | 1 | 0 | 1 | 0.00% | 0.000 | -1.000 | -1.000 | 1.000 |
| 2021 | 9 | 2 | 7 | 22.22% | 0.571 | -3.000 | -0.333 | 7.000 |
| 2022 | 14 | 6 | 8 | 42.86% | 1.500 | 4.000 | 0.286 | 2.000 |
| 2023 | 9 | 4 | 5 | 44.44% | 1.600 | 3.000 | 0.333 | 3.000 |
| 2024 | 10 | 1 | 9 | 10.00% | 0.222 | -7.000 | -0.700 | 7.000 |
| 2025 | 5 | 1 | 4 | 20.00% | 0.500 | -2.000 | -0.400 | 4.000 |
| 2026 | 12 | 4 | 8 | 33.33% | 1.000 | 0.000 | 0.000 | 4.000 |

Best year: 2014 (6.000R)
Worst year: 2024 (-7.000R)
Profitable years: 10
Losing years: 11

## Trade frequency (completed trades)

- average trades/year: 8.18
- median trades/year: 9.00
- min trades in a calendar year: 1
- max trades in a calendar year: 14
- approximate trades/month: 0.68

## Cost scenarios

| Scenario | N | WR | PF | Net R | Exp R |
|---|---:|---:|---:|---:|---:|
| MIDPOINT_IDEAL | 180 | 32.78% | 0.975 | -3.000 | -0.017 |
| BID_ASK_EXECUTABLE | 180 | 31.11% | 0.902 | -12.140 | -0.067 |
| ROUND_TRIP_0.5_PIP | 180 | 32.78% | 0.941 | -7.265 | -0.040 |
| ROUND_TRIP_0.8_PIP | 180 | 32.78% | 0.922 | -9.825 | -0.055 |
| ROUND_TRIP_1.0_PIP | 180 | 32.78% | 0.909 | -11.531 | -0.064 |
| ROUND_TRIP_1.5_PIP | 180 | 32.78% | 0.878 | -15.796 | -0.088 |
| ROUND_TRIP_2.0_PIP | 180 | 32.78% | 0.849 | -20.062 | -0.111 |

## Chronological windows (executable)

| Window | N | WR | PF | Net R | Exp R |
|---|---:|---:|---:|---:|---:|
| early | 54 | 27.78% | 0.766 | -9.140 | -0.169 |
| middle | 63 | 34.92% | 1.073 | 3.000 | 0.048 |
| recent | 63 | 30.16% | 0.864 | -6.000 | -0.095 |
| 2005-2006 | 22 | 31.82% | 0.933 | -1.000 | -0.045 |
| 2007-2008 | 15 | 20.00% | 0.495 | -6.130 | -0.409 |
| 2009-2010 | 12 | 41.67% | 1.429 | 3.000 | 0.250 |
| 2011-2012 | 11 | 18.18% | 0.444 | -5.010 | -0.455 |
| 2013-2014 | 19 | 42.11% | 1.455 | 5.000 | 0.263 |
| 2015-2016 | 17 | 35.29% | 1.091 | 1.000 | 0.059 |
| 2017-2018 | 14 | 28.57% | 0.800 | -2.000 | -0.143 |
| 2019-2020 | 11 | 27.27% | 0.750 | -2.000 | -0.182 |
| 2021-2022 | 23 | 34.78% | 1.067 | 1.000 | 0.043 |
| 2023-2024 | 19 | 26.32% | 0.714 | -4.000 | -0.211 |
| 2025-2026 | 17 | 29.41% | 0.833 | -2.000 | -0.118 |

## KEEP_LONG checklist

1. Overall WR >= 40.00% after realistic costs: FAIL
2. Positive expectancy after realistic costs: FAIL
3. PF > 1 after realistic costs: FAIL
4. Adequate sample: PASS (180 trades)
5. No obvious recent/OOS collapse: FAIL
6. Not driven almost entirely by one period: PASS

Rejection / caution notes:
- Executable WR 31.11% is below the frozen 40.00% rule.
- Executable expectancy is not positive.
- Executable profit factor is not greater than 1.
- Second-half / recent sample collapses.


This validation is LONG only. It was not compared to a USDJPY swing short model.

NO STRATEGY RULES WERE CHANGED. NO PRODUCTION CODE WAS MODIFIED. NO ORDERS WERE PLACED.
