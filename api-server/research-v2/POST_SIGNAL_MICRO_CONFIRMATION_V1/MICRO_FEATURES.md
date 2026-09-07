# POST_SIGNAL_MICRO_CONFIRMATION_V1 — Micro-feature & architecture spec

Resolution-parameterised design. A single knob `stepSeconds` sets the sampling
step: **300** on today's M5 data, **1** if a 1-second/tick feed is added later.
Every window is expressed in seconds and mapped to `ceil(window/stepSeconds)`
observation steps, so the same code runs on both. On M5 the sub-bar windows
(30–180 s) collapse to 0 steps and are reported as **UNOBSERVABLE**, not guessed.

## Observation lifecycle (after the frozen engine fires — engine is NOT modified)

1. **Signal snapshot** (T0): timestamp, pair, original direction, proposed entry
   (next executable bid/ask), spread, session, volatility regime, MOVE_MODEL
   probability. No entry is taken at T0.
2. **Observe** the path over the max window, sampling each `stepSeconds` step
   from completed bars only (no look-ahead: step k uses the bar completed at
   T0 + k·stepSeconds).
3. **Confirm early or wait**: emit a decision as soon as the learned score clears
   the frozen threshold, else at the max window.
4. **Recalculate entry** at the confirmation bar's executable price (never the T0
   price); recompute spread, SL, TP, size, R:R.

## Path features (all relative to the ORIGINAL proposed entry, vol-normalised by ATR at T0)

- **Excursion:** max favorable excursion (MFE), max adverse excursion (MAE),
  final displacement, distance-above, distance-below.
- **Occupancy:** % time above entry, % time below entry, entry-crossing count.
- **Micro-structure:** micro HH, HL, LH, LL counts; directional persistence
  (net displacement / total path length); pullback depth (deepest counter-move
  vs favorable extreme).
- **Kinematics:** upward velocity, downward velocity, acceleration (change in
  signed velocity), all in ATR-normalised units per step.
- **Range dynamics:** range expansion / compression (window range vs T0 ATR),
  time near range high, time near range low.
- **Breakout:** breakout attempts, failed-breakout attempts, time spent outside
  range after a breakout, rejection speed after a failed breakout.

## Micro range & state (measured, not rule-of-thumb)

Maintain `confirmationHigh`, `confirmationLow`, `confirmationRange` across the
window. Classify the observed path into one of:
`UP_PRESSURE`, `DOWN_PRESSURE`, `CHOP`, `BREAKOUT_UP`, `BREAKOUT_DOWN`,
`FAILED_BREAKOUT`, `UNRESOLVED` — from the measured features above, never from
"N green bars = LONG".

## Chop detection

A dedicated signal: high entry-crossing frequency **and** low net displacement
**and** low directional persistence → high CHOP/WAIT probability. Tested as a
predictor of poor trades in its own right.

## Directional pressure (learned, not hand-assigned)

Compute LONG_PRESSURE and SHORT_PRESSURE evidence vectors independently
(more time above entry, positive displacement, HH/HL, shallow pullbacks,
stronger up-velocity, pressure/acceptance above `confirmationHigh`; mirrored for
SHORT). Weights are **learned from the training folds only** (logistic /
gradient-boosted). No arbitrary confidence percentages.

## Breakout + acceptance

Distinguish **BREAK → HOLD → CONTINUE** from **BREAK → IMMEDIATE RETURN**.
Acceptance features: time outside range, distance outside range, successful
retest, inability to re-enter through the broken level, post-break continuation,
post-break velocity. The experiment tests whether requiring acceptance beats
acting on the first breakout.

## Decision output

`LONG` / `SHORT` / `WAIT`, plus calibrated `P_LONG`, `P_SHORT`, `P_CHOP`.
When the original direction and the micro-confirmation direction disagree, emit
`ORIGINAL_LONG_MICRO_SHORT_CONFLICT` (or the mirror) and **WAIT** — reversal is
NOT taken automatically; conflicts are logged for separate later analysis.

## Evaluation geometry

Confirmed entries scored under (a) the engine's current TP/SL and (b) a
configurable `+1R / −0.5R` (and any 2:1 variant), with realistic spread paid and
entry/exit slippage. Baselines A–F: immediate entry vs 30/60/120/180/300 s
confirmation, plus adaptive early confirmation. On M5 only the 300 s (=1 bar)
and the minute-scale proxy windows (5–30 min) are computable; the rest are
reported UNOBSERVABLE.

## Validation

Strict chronological walk-forward, frozen untouched final holdout, thresholds
selected on training/validation only, calibration checked (does higher micro
confidence → higher realised success?), and per-family ablation. The success
bar is **incremental out-of-sample expectancy** over the original engine after
paying for fewer trades, later entries, spread and slippage — not a higher win
rate alone.
