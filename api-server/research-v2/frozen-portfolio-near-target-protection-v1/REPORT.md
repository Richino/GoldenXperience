# Frozen portfolio near-target protection v1

Research / paper only. Entries were not regenerated. No deployment. No broker orders. No entry-rule changes.

## Classification: NO_MEANINGFUL_IMPROVEMENT

Best aggregate variant among the five is **V0 (frozen baseline)**.
Closest protection variant is V4 (−0.0005R/trade vs V0). No protection rule beats the frozen book on this sample.

OOS: **not deserved**. This is the same historical development sample, and the aggregate delta is below the +0.02R materiality reference.

## Baseline sanity

- USDCHF: published 0.2664 vs V0 0.2664 (Δ 0); usable M1 103/103; INCLUDED
- USDCAD: published 0.228 vs V0 0.2283 (Δ 0.0003); usable M1 53/53; INCLUDED
- GBPUSD: published 0.196 vs V0 0.1961 (Δ 0.0001); usable M1 98/98; INCLUDED
- NZDUSD: published 0.1898 vs V0 0.1898 (Δ 0); usable M1 100/100; INCLUDED
- AUDUSD: published 0.118 vs V0 0.1181 (Δ 0.0001); usable M1 195/195; INCLUDED
- USDJPY: published 0.0802 vs V0 0.0802 (Δ 0); usable M1 271/271; INCLUDED
- EURUSD: published H1 EXEC +0.078 vs this run's M1 V0 +0.0936 (Δ +0.0156); usable M1 356/356; INCLUDED with the note below

Excluded from aggregate: none.

EURUSD diagnosis: the frozen published number used H1 MBA stop-first. This experiment uses M1 bid/ask, as required for a +1.80R trigger. M1 V0 produced 139 wins vs the H1 137-win published book (WR 39.04% vs 38.48%, PF 1.154 vs 1.127). Entries, stops, targets, and 1R distances are the same frozen cohort. The pair is kept because variants are compared to this M1 V0, not mixed with H1. Protection still lowers EURUSD vs its own M1 baseline. NZDUSD keeps 2 unmatched M1 gaps and USDJPY keeps 1 unresolved window out of EXEC.

## Geometry notes

All seven books are 1R stop / 2R target systems. EURUSD V1 uses midpoint ATR stop/target; executable 1R is |executable entry − original stop| (MIDPOINT_LEVELS), matching the frozen cost-validation R. USDJPY V6 preserves each trade's frozen TV risk distance (ATR14 fallback on TIME_EXIT rows). No geometry was silently altered.

## Portfolio

| Variant | Trades | Wins | WR | PF | Total R | Exp R/trade | Avg win | Avg loss | Max DD | Pairs + | Pairs - |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V0 FROZEN BASELINE | 1176 | 524 | 44.56% | 1.249 | 155.8446 | 0.1325 | 1.493 | -0.961 | 25.0926 | 0 | 0 |
| V1 1.80R TRIGGER / LOCK +1.00R | 1176 | 530 | 45.07% | 1.239 | 148.7491 | 0.1265 | 1.453 | -0.962 | 25.2266 | 3 | 4 |
| V2 1.80R TRIGGER / LOCK +1.25R | 1176 | 530 | 45.07% | 1.247 | 153.5873 | 0.1306 | 1.462 | -0.962 | 24.0072 | 4 | 3 |
| V3 1.80R TRIGGER / LOCK +1.50R | 1176 | 530 | 45.07% | 1.250 | 155.2078 | 0.1320 | 1.465 | -0.962 | 24.0072 | 3 | 4 |
| V4 LITERAL 90% TRAIL | 1176 | 530 | 45.07% | 1.250 | 155.2193 | 0.1320 | 1.465 | -0.962 | 24.0072 | 4 | 3 |

Entry count is identical across variants for every included pair.

## Pair expectancy

| Pair | Baseline | +1.00 lock | +1.25 lock | +1.50 lock | 90% trail | Best | Δ | Improved? |
|---|---:|---:|---:|---:|---:|---|---:|---|
| USDCHF | 0.2664 | 0.2593 | 0.2558 | 0.2596 | 0.2613 | V0 | 0.0000 | false |
| USDCAD | 0.2283 | 0.2413 | 0.2602 | 0.2629 | 0.2764 | V4 | 0.0480 | true |
| GBPUSD | 0.1961 | 0.2019 | 0.2030 | 0.2049 | 0.2061 | V4 | 0.0101 | true |
| NZDUSD | 0.1898 | 0.1874 | 0.1949 | 0.1875 | 0.1917 | V2 | 0.0051 | true |
| AUDUSD | 0.1181 | 0.0859 | 0.0923 | 0.1009 | 0.0971 | V0 | 0.0000 | false |
| USDJPY | 0.0802 | 0.0859 | 0.0933 | 0.0921 | 0.0878 | V2 | 0.0131 | true |
| EURUSD | 0.0936 | 0.0862 | 0.0864 | 0.0873 | 0.0886 | V0 | 0.0000 | false |

Pair-specific bests were **not** adopted as a new frozen rule.

## Rescue vs clip (aggregate of included pairs)

- V1: rescues 6 trades / 11.146R; clips 16 TP-path trades / -15.142R
- V2: rescues 6 trades / 12.396R; clips 21 TP-path trades / -14.514R
- V3: rescues 6 trades / 13.448R; clips 39 TP-path trades / -17.222R
- V4: rescues 6 trades / 14.150R; clips 75 TP-path trades / -20.796R

## Year stability (portfolio)

- 2023: V0 0.051 · V1 0.067 · V2 0.067 · V3 0.066 · V4 0.064
- 2024: V0 0.202 · V1 0.184 · V2 0.189 · V3 0.193 · V4 0.192
- 2025: V0 0.098 · V1 0.079 · V2 0.088 · V3 0.087 · V4 0.092
- 2026: V0 0.202 · V1 0.198 · V2 0.201 · V3 0.204 · V4 0.201

Years where best variant ≥ baseline: 1/4.

## Same-minute ambiguity

Conservative primary results never assume trigger-before-reversal in the arming minute. Ambiguous minutes: **77**. Optimistic bound is in AMBIGUOUS_INTRAMINUTE.csv.

## Source references

- USDCHF: api-server/research-v2/usdchf-bear-consensus-v1-spread-validation/
- USDCAD: api-server/research-v2/usdcad-v3-1100-long-spread-validation/
- GBPUSD: api-server/research-v2/gbpusd-frequency-v3-spread-validation/
- NZDUSD: api-server/research-v2/nzdusd-bull-consensus-structure-v1-spread-validation/
- AUDUSD: api-server/research-v2/executable-cost-validation/ (GX AUDUSD Strong Consensus Structure V1)
- USDJPY: api-server/research-v2/usdjpy-v6-spread-validation/
- EURUSD: api-server/research-v2/executable-cost-validation/ (EURUSD London Breakout V1; not rejected Frequency V3)

## Decision

1. Baseline portfolio expectancy: **0.1325R/trade**
2. V1 +1.00R lock: **0.1265R**
3. V2 +1.25R lock: **0.1306R**
4. V3 +1.50R lock: **0.1320R**
5. V4 90% trail: **0.1320R**
6. Best aggregate: **V0 frozen baseline** (closest protection: V4)
7. Delta of closest protection vs baseline: **-0.0005R/trade**
8. PF before/after (V0 vs V4): **1.249 / 1.250**
9. WR before/after (V0 vs V4): **44.56% / 45.07%**
10. Total R before/after (V0 vs V4): **155.84 / 155.22**
11. Pairs improved / worsened vs V0 under V4: **4 / 3** of 7
12. Classification: **NO_MEANINGFUL_IMPROVEMENT**
13. Separate OOS validation deserved?: **NO**

No deployment. No live activation. No broker orders. No entry-rule modifications.
