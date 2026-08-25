# Actual Momentum Trade Inversion Test

Generated: 2026-08-25

## Scope

This is a research-only counterfactual on the current four-family paper-engine
records. It includes every closed, resolved trade whose `strategy_family` is
`momentum` at test time: 31 trades, sequences 35 through 101. No production
strategy, paper position, or database row was changed.

For every original Momentum trade, the test keeps the original decision time,
stop distance, target distance, and outcome resolver. It flips only direction:
the counterfactual fills on the other side of the bid/ask book at the original
entry bar, mirrors the stop and target around that fill, and pays its own spread.
Exits are resolved with the production `labelOutcome` rules, including the
16:45 ET forced close, 48-hour horizon, and conservative ambiguity handling.

OANDA Practice M15 bid/ask data resolved all 31 counterfactuals. There were no
missing quotes and no ambiguous outcomes.

## Matched Results

| Arm | Trades | Wins | Losses | Win rate | Net expectancy (R/trade) | Total R | Profit factor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Original, as traded | 31 | 11 | 20 | 35.5% | -0.1924 | -5.9639 | 0.5826 |
| Inverted direction | 31 | 14 | 17 | 45.2% | 0.0634 | 1.9661 | 1.1356 |
| Difference (inverted - original) | 0 | +3 | -3 | +9.7 pp | +0.2558 | +7.9300 | +0.5530 |

## Conclusion

Inverting all recorded Momentum trades outperformed the original direction on
this exact matched set. The inverse arm changes -5.96R into +1.97R and lifts
profit factor from 0.58 to 1.14 after its own bid/ask spread.

This is plausible evidence that the current Momentum direction is wrong more
often than useful, but it is not proof of an edge. The sample covers only 31
trades from 19-24 August 2026, with many forced-close outcomes. Do not switch
the production direction from this result alone. Continue the frozen paper
experiment and retest on a larger, non-overlapping sample before making a
family-wide direction change.

## Reproduction

Run from `api-server`:

```powershell
$env:OUT = (Join-Path (Get-Location) 'momentum-actual-inversion-test.json')
npx.cmd tsx scripts/_actual_inversion.ts
```

Then filter the output JSON's `trades` to `family === "momentum"` and compare
`origR` with `invR`.
