# EUR/USD V12: news surprise-strength filter

## Verdict

`VALIDATION_GATE_FAILED`

Trading remains disabled. The development result reached the requested 40% win gate, but it did not reproduce in the locked later period.

## Method

- Stage-1 training: EUR/USD OANDA Practice M5, 2022-2023.
- Direction: user-supplied ForexFactory non-inflation/rate actual-versus-forecast majority vote.
- Development: August 2024 through July 2025.
- Validation: August 2025 through July 2026, opened only after development qualified.
- Decision: 15 minutes after release, after three completed M5 candles.
- Entry: next M5 open with executable bid/ask.
- Confirmation: the first 15-minute move must agree with the news direction.
- Volatility gate: pre-release ATR14 at or below 5.53 pips.
- Stop: 1.0 pre-release ATR14.
- Target: 2.0 stop distances.
- Payoff: `+1.5R / -0.75R`.
- Maximum hold: 72 wall-clock hours.
- Ambiguous bars: charged as stops.

## Development selection

The only qualifying tier kept the strongest 50% of releases by normalized actual-versus-forecast magnitude.

| Period | Trades | Wins | Win rate | Total R | Expectancy | Profit factor | Max drawdown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Development 2024-2025 | 22 | 9 | 40.91% | +3.75R | +0.170R | 1.385 | 3.00R |
| Validation 2025-2026 | 28 | 9 | 32.14% | -0.75R | -0.027R | 0.947 | 3.75R |

## What the evidence proves

- Economic-surprise direction contains more directional information than the price-only neural and trend rules.
- The 60-minute Stage-1 opportunity score did not help select 72-hour news trades; stronger Stage-1 tiers reduced the development win rate.
- Surprise magnitude produced a 40.91% development win rate, but that result was not stable out of sample.
- Continuing to change thresholds after seeing the validation loss would be curve-fitting, not improvement.

## Decisive next step

The current historical calendar has been exhausted for model selection. A trustworthy winning-rate claim now requires new unseen releases collected forward in shadow mode with this rule frozen. Do not alter the threshold, stop, target, or event mapping during collection.

Minimum promotion gate:

- at least 60 new executable shadow trades;
- win rate at least 40%;
- positive expectancy and profit factor above 1;
- no change to the frozen rule during the sample;
- practice/shadow only until the gate passes.

