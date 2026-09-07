# Four-family changes and frozen-trade retest

**Decision: keep the measurement and evidence-integrity fixes; reject activation of these V2 entry candidates.** The V2 variants resolved 32 entries at -19.09R, or -0.596R per entry. They skipped 162 opportunities and left 7 unresolved. Lower total losses from entering fewer trades do not establish a profitable edge. EMA, breakout, and mean reversion barely trade under these rules.

## Scope and outcome measurement

Same 201 recorded family trades, August 19 through September 4, 2026, across 13 trading days. Excludes 29 legacy trades. All of these outcomes were already inspected: **this is development evidence, not out-of-sample validation**. This event-anchored retest does not find new opportunities the modified strategies might have generated outside the recorded sample.

Recovered all 173 submitted broker trades, including 65 rows previously represented by model closes. The remaining 28 have no broker trade ID and retain model price-risk R. Confirmed executable fill price divided by actual initial price risk removes the order-cap distortion in nominal-budget R. The original journal remains intact. Original stored total was -12.33R; the comparable price-risk total is -44.80R. The broker-only 173 total is -42.37R. These are normalized strategy outcomes, not percentages of account equity.

| Family | Original N | Stored R | Corrected price R | V2 resolved | V2 WAIT | V2 missing | V2 total R | V2 R/entry |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| EMA | 67 | 8.32 | -4.04 | 2 | 64 | 1 | -1.36 | -0.678 |
| Breakout | 38 | -5.21 | -15.19 | 2 | 36 | 0 | -2.04 | -1.022 |
| Momentum | 80 | -14.88 | -24.75 | 27 | 47 | 6 | -14.66 | -0.543 |
| Mean reversion | 16 | -0.55 | -0.82 | 1 | 15 | 0 | -1.03 | -1.030 |

The corrected recorded result and V2 total have different execution counts and exit mechanisms. They are not a matched treatment estimate. Actual cash P&L, financing, and nominal-budget R remain separate in every recovered measurement. All recovered financing values are zero; commissions were not collected separately. Price R includes executable spread and fill slippage, but is not an exact all-fees cash return. See the [OANDA trade fields](https://developer.oanda.com/rest-live-v20/trade-df/) and [transaction fields](https://developer.oanda.com/rest-live-v20/transaction-df/).

## What changed locally

- New additive execution-price-risk-v2 measurement uses actual broker entry, initial units, rounded initial stop, and confirmed close. Order-size caps cannot artificially change strategy R. Cash and sizing-conversion estimates remain explicitly separate.
- Generic four-family broker orders await confirmed broker closes; successful close requests cannot become invented model fills. A bounded reconciliation pass can add missing broker measurements to historical rows after deployment, with retry cooldowns. It has not been applied to the production database in this task.
- Adaptive evidence now isolates the current config and direction policy. Momentum uses only the matching current forward inversion arm, excludes duplicate shadows and old/opposite policies, and excludes broker orders lacking valid comparable measurements. The evidence version is logged with each candidate's statistics. No synthetic gross return is reconstructed from capped cash P&L; gross evidence is conservatively set equal to comparable price R when a valid gross reconstruction is unavailable.
- Selected or trade-linked evaluation snapshots retain their original geometry, conditions, and features across later ticks. Suppression reasons are recorded for valid candidates that were not selected.
- Research-only V2 functions implement EMA delayed confirmation, a distinct later breakout retest and reclaim, raw momentum continuation versus failed-break reversal, and mean-reversion failed range escape. Frozen V1 configurations and active entry routing are unchanged.

## Comparable executable replay

Both arms use executable M1 bid/ask and an additional 0.1 pip adverse slippage per entry and exit; stress uses 0.5 pip. Confirmation uses only completed M15 bars. Stops and targets are fixed, competing post-entry levels stop first, and missing candles remain missing. End-of-session exit is 16:45 New York time. No thresholds changed after the initial run.

An entry-minute integrity defect in the initial control was corrected before final reporting: the minute open could precede the recorded fill. Controls now use broker openTime/fill where available; any entry-minute barrier touch with unknown ordering is unresolved. This affects the control, not V2. See [REPLAY_CORRECTION.md](REPLAY_CORRECTION.md); the original [PROTOCOL.md](PROTOCOL.md) is retained unchanged.

| Family | Control resolved | Control missing | Control total R | Matched opportunities | Matched control R | Matched V2 R |
|---|---:|---:|---:|---:|---:|---:|
| EMA | 59 | 8 | -5.65 | 59 | -5.65 | -1.36 |
| Breakout | 36 | 2 | -14.34 | 36 | -14.34 | -2.04 |
| Momentum | 63 | 17 | -22.14 | 61 | -20.12 | -9.60 |
| Mean reversion | 14 | 2 | -1.97 | 14 | -1.97 | -1.03 |

Overall control: 172 resolved, 29 missing, -44.10R, -0.256R per entry. The matched subset has 170 opportunities: control -42.08R versus V2 -14.02R. WAIT contributes zero on the matched opportunity denominator. Missing rows are excluded from the paired comparison, so it cannot stand in for all 201.

V2 has 194 known outcomes including WAIT, at -0.098R per known opportunity. Its win rate is 21.9%, profit factor 0.206, and realized-close drawdown 19.32R. Drawdown is based on a sum of normalized unit-risk outcomes, not account equity. At 0.5-pip stress: -20.62R, -0.644R per resolved entry.

For one position per instrument, the control has 168 resolved, 6 blocked, 27 missing, -40.04R. V2 has 32 resolved, 163 WAIT/blocked, 6 missing, -19.09R. Missing exits block later instrument entries to session close. This replay models overlap, not broker margin, order caps, or a reconstructed equity curve.

## Chronology and momentum policies

These chronological slices are descriptive, not holdouts.

| Period | Opportunities | V2 resolved | WAIT | Missing | Total R | R/entry |
|---|---:|---:|---:|---:|---:|---:|
| earlier | 138 | 23 | 109 | 6 | -14.80 | -0.644 |
| Aug31-Sep4 | 63 | 9 | 53 | 1 | -4.28 | -0.476 |

Momentum selects the earliest qualifying continuation or failed-break event, never the arm with the better realized outcome. Counts below describe those selected policies and therefore are not two independent replays of every momentum opportunity.

| Selected momentum policy | Resolved | WAIT | Missing | Total R | R/entry |
|---|---:|---:|---:|---:|---:|---:|
| momentum-retest-continuation-v2 | 9 | 3 | 2 | -3.04 | -0.338 |
| momentum-failed-break-v2 | 18 | 2 | 4 | -11.62 | -0.645 |

Reasons and exits by family:

- EMA: 37 Delayed reward/risk below frozen V1; 6 No confirmation within four bars; 6 Spread ceiling; 15 Original stop crossed before confirmation; 1 Missing executable entry minute; 1 STOP; 1 SESSION_CLOSE.
- Breakout: 15 Original stop crossed before confirmation; 16 No confirmation within four bars; 4 Delayed reward/risk below frozen V1; 2 STOP; 1 Original executable stop reached while waiting.
- Momentum: 11 No confirmation within four bars; 19 STOP; 31 Raw momentum did not break the frozen range; 4 Spread ceiling; 1 Missing M1 at 2026-08-20T20:38:00.000Z; 2 Missing M1 at 2026-08-21T18:33:00.000Z; 1 TARGET; 7 SESSION_CLOSE; 1 Missing M1 at 2026-08-25T18:37:00.000Z; 1 Confirmation outside entry session; 1 Missing M1 at 2026-08-26T19:39:00.000Z; 1 Missing M1 at 2026-08-27T20:39:00.000Z.
- Mean reversion: 5 Original stop crossed before confirmation; 2 Less than 1R to original mean; 3 No confirmation within four bars; 1 Mean reversion no longer non-trending; 1 STOP; 1 Original executable stop reached while waiting; 3 Delayed reward/risk below frozen V1.

Requiring both a later directional EMA confirmation and unchanged absolute stop/target with no worse reward/risk is too restrictive: it usually demands a better entry price after waiting for directional progress. The prescribed variant fails the practical-frequency objective. Breakout and mean reversion also produce too few entries for a useful conclusion about their general mechanisms. Momentum produces a larger sample but remains materially negative. This run rejects the exact variants; it does not prove every possible confirmation strategy fails.

## Verification and artifacts

Pure regression checks passed for size-independent normalization, invalid/missing broker facts, policy/config/time isolation, delayed confirmation, missing candles, entry-minute ordering, adverse gaps, and conservative stops. PostgreSQL temporary-table tests exercised the actual immutable-snapshot upsert clauses and rolled back. The new evidence loader successfully read the current database in read-only mode: 497 eligible observations before historical broker measurements are populated. No production rows were changed and no orders were submitted.

Existing adaptive-engine, four-family execution/inversion, and paper-cycle fixture checks passed. Global API typecheck has an unrelated pre-existing error in scripts/eurusd-h1-ema-pullback-poc-ab-v1/selftest.ts:50 (24 supplied to a parameter inferred as literal 48); the files changed for this task have no remaining reported type errors.

Reproduce from api-server:

```powershell
npx.cmd tsx scripts/four-family-v2/selftest.ts
npx.cmd tsx scripts/four-family-v2/db-selftest.ts
npx.cmd tsx scripts/four-family-v2/retest.ts
npx.cmd tsx scripts/four-family-v2/report.ts
```

RESULTS.json contains all 201 records and measurements; SUMMARY.json contains aggregate statistics and input/code hashes. cohort.json preserves the frozen source ledger and execution mappings; cache contains read-only broker facts and original OANDA candles. DB_CHECKS.json records database verification. No V2 entry variant was activated. Code is local and uncommitted, with no deployment or production migration in this task.

**Recommendation: retain the integrity fixes and keep these V2 entries out of active execution. Any further entry revision needs a simpler explicit rule and fresh practice validation, not another claim of improvement from the same 201 trades.**
