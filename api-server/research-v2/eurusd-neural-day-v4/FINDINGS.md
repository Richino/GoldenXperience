# EUR/USD Neural Day Engine V4 - Higher Volume

Verdict: **VOLUME_IMPROVED_BUT_TARGET_NOT_MET_EDGE_UNCERTAIN**

## Architecture

V4 evaluates every eligible EUR/USD M15 decision during London and New York hours. Separate past-only neural heads estimate positive-return and full-target probabilities for both long and short. The side with the higher estimated net R is selected, then compared with a rolling session-specific threshold using only preceding scores. Development selected the **NEW_YORK_ONLY** arm.

## Results

| Period | Trades | Trades/day | Profitable rate | Target rate | Expectancy | PF | Total R | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Development | 109 | 0.421 | 44.04% | 22.02% | 0.066R | 1.165 | 7.19R | 12.27R |
| Later historical check | 100 | 0.386 | 41.00% | 24.00% | 0.006R | 1.013 | 0.59R | 7.05R |

## Evidence status

The later check produced **0.386 trades/day**, above V2's 0.236/day but below V4's development goal of 0.75/day. Its expectancy 95% interval is **-0.184R to 0.196R**, which crosses zero widely. The 2025-08 through 2026-07 period is also **not pristine unseen data** because earlier V2/V3 work already inspected it. V4 remains research-only and is not connected to practice or live execution.

V4 increased frequency above V2 and finished barely positive, but it missed the 0.75-trades/day goal and its expectancy interval includes substantial losses. This is an uncertain near-breakeven result, not a confirmed edge.
