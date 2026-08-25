# Actual Breakout Trade Inversion Test

Generated: 2026-08-24

## Scope

This is a research-only counterfactual on the current four-family paper-engine
records. It includes every closed, resolved trade whose `strategy_family` is
`breakout` at test time: 28 trades, sequences 32 through 103. No production
strategy, paper position, or database row was changed.

For every original breakout trade, the test keeps the original decision time,
stop distance, target distance, and outcome resolver. It flips only direction:
the counterfactual fills on the other side of the bid/ask book at the original
entry bar, mirrors the stop and target around that fill, and pays its own spread.
Exits are resolved with the production `labelOutcome` rules, including the
16:45 ET forced close, 48-hour horizon, and conservative ambiguity handling.

OANDA Practice M15 bid/ask data resolved all 28 counterfactuals. There were no
missing quotes and no ambiguous outcomes.

## Matched Results

| Arm | Trades | Wins | Losses | Win rate | Net expectancy (R/trade) | Total R | Profit factor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Original, as traded | 28 | 9 | 19 | 32.1% | -0.0447 | -1.2513 | 0.9023 |
| Inverted direction | 28 | 8 | 20 | 28.6% | -0.3154 | -8.8312 | 0.5584 |
| Difference (inverted - original) | 0 | -1 | +1 | -3.6 pp | -0.2707 | -7.5799 | -0.3439 |

## Conclusion

Inverting all recorded breakout trades is worse on this exact matched set. It
lowers win rate, turns a small -1.25R original loss into -8.83R, and reduces
profit factor from 0.90 to 0.56. This does not prove that the original breakout
strategy has an edge: its own expectancy remains slightly negative. It does
rule out a blanket inverse-breakout switch for the observed trades.

The sample is only 28 trades across 19-24 August 2026, so it is not enough to
support parameter changes. Keep recording the original breakout arm; retest
after a materially larger, non-overlapping sample before considering any
family-level rule change.

## Reproduction

Run from `api-server`:

```powershell
$env:OUT = (Join-Path (Get-Location) 'breakout-actual-inversion-test.json')
npx.cmd tsx scripts/_actual_inversion.ts
```

Then filter the output JSON's `trades` to `family === "breakout"` and compare
`origR` with `invR`.
