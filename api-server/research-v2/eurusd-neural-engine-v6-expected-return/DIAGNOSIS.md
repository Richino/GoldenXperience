# EUR/USD Neural Engine V6 Failure Diagnosis

## Direct conclusion

The engine failed because it was forced to satisfy a trade-frequency quota even though its confidence score did not identify positive-expectancy entries. Direction errors were secondary. Most evaluated entry points did not contain a reachable +1.5R target path in either direction before the stop or timeout.

## What the audit proved

- The former V5 configuration produced 686 development trades, a 29.88% win rate, -145.29R total, and -0.212R expectancy.
- At the V5 entry points, neither direction could hit the target within 60 minutes 76.82% of the time.
- V5's highest-confidence quintile won only 28% and lost about -0.23R per trade. Confidence was not ranking trade quality.
- Changing the stop scale or extending the holding period to 120 or 240 minutes did not produce positive expectancy. Longer holds mainly allowed the stop to be reached before the target.
- Retraining V6 on continuous executable R improved the meaning of the label, but did not create an edge.
- With V6 trained only on 2022-2023, every predeclared 2024 calibration tier failed. The broadest break-even-qualified tier took 251 trades (0.80/day), won 32%, returned -33.82R, had -0.135R expectancy, and a 0.71 profit factor.
- The stricter 0.50/day and 0.25/day tiers also lost money. Reducing frequency alone did not repair the model.

## Root cause

1. **Forced entries:** targeting 2-3 trades per day pushed the threshold below a defensible quality level.
2. **Miscalibrated confidence:** higher neural output did not reliably correspond to higher realized executable R.
3. **Weak opportunity selection:** most candidate bars did not offer a target-reaching path on either side.
4. **Direction was not the main failure:** inversion also lost. Correctly identifying the better of two bad paths still produced a losing trade.
5. **Execution geometry was not the sole failure:** smaller stops and longer holding windows remained negative.

## Implemented fix

- Train only on 2022-2023.
- Calibrate the trade/WAIT threshold only on 2024.
- Require at least 150 calibration trades, at least 40% wins, positive expectancy, and profit factor above 1.
- If no tier qualifies, set the engine to disabled and emit `WAIT` instead of forcing trades.
- Keep 2025 as development validation and 2026 sealed unless all gates pass.

## Current status

No 2024 tier qualified. Trading is disabled, 2025 contains zero authorized trades, and the 2026 final holdout remains sealed. This fixes the loss-producing behavior, but it does not prove a profitable EUR/USD edge.
