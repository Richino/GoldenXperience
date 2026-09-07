# Audit and handoff

The screen finished, but three pair replays are **incomplete**, not full 2023–2024 estimates. Only USD/CHF completed the requested development period. Do not rank or pool the differently truncated cohorts as a completed portfolio.

## Confirmed missing history

USD/CAD, EUR/JPY and GBP/JPY each had an open position when the M15 candle starting **2024-05-20 14:30 UTC** was missing. Targeted read-only OANDA requests returned neither that M15 candle nor completed M1 candles inside its interval. See `GAP_AUDITS.json` for the returned quote evidence. No candle was fabricated, forward-filled, replaced by a midpoint proxy, or inferred from a different pair.

The predeclared fail-closed policy retains one unresolved trade for each affected pair and blocks its later entries. Consequently:

- USD/CAD: 625 completed trades, plus one unresolved trade; provisional expectancy -0.145784R and PF 0.778564.
- EUR/JPY: 425 completed trades, plus one unresolved trade; provisional expectancy +0.027250R and PF 1.048357. Monthly-block 95% interval: -0.073105R to +0.130699R. This does not establish a positive edge.
- GBP/JPY: 125 completed trades, plus one unresolved trade; provisional expectancy -0.097760R and PF 0.846625.
- USD/CHF: 874 completed trades, no unresolved trade. Expectancy -0.222835R, PF 0.675380; both 2023 and 2024 negative. It fails development.

The gaps cannot be repaired from the targeted native OANDA M15 or M1 responses obtained in this run. An authoritative quote source covering that interval would be needed to complete those exact replays without changing the frozen missing-data policy. Their data-incomplete status takes precedence over historical profit rankings.

## Verification

- Replay tests passed: bid/ask exit sides, exact +2R target geometry, stop-first ambiguity, adverse opening stop gaps, missing-bar rejection, signal-bar exclusion, summer/winter New York session exits, causal ATR precomputation, and replay/live news boundary.
- Twenty real candidate entry comparisons per pair matched the full-history production Breakout evaluator: status, direction, entry, stop and target.
- Isolated TypeScript check and targeted ESLint passed for the research runner and its tests. The earlier selective-portfolio and 3% risk unit tests also passed.
- The four original strategy source hashes still match the prior selector protocol. No strategy implementations, production settings, orders or deployments were changed. NZD/USD was excluded.
- A transient Windows file-open failure occurred while saving two historical checkpoints. Resuming from the preserved checkpoints completed collection; strategy parameters and frozen protocol were not amended.

## Decision

**Admit none.** Reject the USD/CHF Breakout baseline; retain the other three as incomplete research, not validated additions. Keep 2025–2026 outcome validation unopened. Do not vary the spread threshold, reverse trades, search another holding duration, or otherwise tune this baseline to rescue its observed results.

This experiment tests an existing generic strategy on additional pairs. It does not establish new pair-specific strategies, a marked-to-market 3% USD account simulation, or a route from $100 to $10,000. Currency conversion, account-specific margin, correlated exposure, commissions/financing, and additional execution slippage remain necessary for any later portfolio-level admission test.

The earlier low-spread selector remains rejected separately: it reduced 344 control trades earning 46.68R to 80 trades earning 6.80R on previously reviewed history. That is evidence against that particular selector, not proof that all fewer-trade approaches fail.

## Reproduce

From `frontend`:

```powershell
npx.cmd tsx scripts/test-additional-pairs-v1.ts
npx.cmd tsx scripts/research-additional-pairs-v1.ts
npx.cmd tsx scripts/check-additional-pair-gap.ts
```

The research runner refuses to overwrite a mismatched frozen protocol. It reuses cached MBA data and writes research artifacts only.
