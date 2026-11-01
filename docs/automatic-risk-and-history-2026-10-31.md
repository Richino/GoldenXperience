# Automatic risk budgets and historical estimates

The user approved automatic capture of the configured sizing budget and reconstruction of supported historical estimates on October 31, 2026.

## New single-entry manual orders

The exact unrounded dollar budget used by `manualPositionSize` is saved before broker submission. It uses the same account balance and selected Settings percentage as the existing sizing calculation. The reporting capture does not recalculate units, change stops/targets or place additional requests at the broker. Scheduled orders capture the sizing snapshot when they activate. A supplied accounting-budget override remains authoritative. The original budget survives subsequent balance, policy and stop changes.

The source is `sizing_policy`, with planning balance and selected percentage recorded separately. Actual fill-time equity is not asserted. Missing cost evidence can still make **net** R unavailable even when the denominator is recorded. Risk is an accounting reference, not a loss cap without a protective stop.

The standard ticket explains the automatic default and retains an optional override and optional net reward objective. Other strategy/news/OCO sizing and execution engines were not migrated by this change.

## Historical repair

- 99 manual-entry estimates were saved in the separate `metadata.historicalRiskEstimate` field.
- Three linked manual entries lacked a usable broker link and were skipped.
- Each reconstructed manual estimate requires the original app-owned OANDA order and exact opening fill, matching account, instrument, direction, transaction IDs, client ID and units.
- The benchmark is original order-to-sizing-stop distance × units opened by that fill × the historical USD loss-conversion factor from the opening fill. USD-quoted pairs use 1. The persisted sizing distance is used; where absent, only the original order's stop-on-fill can substitute. No current stop, FX quote, balance, risk setting, ATR reconstruction or legacy R supplies the denominator.
- Partial opening fills allocate the order benchmark proportionally to opened units. Independently opened trades retain separate keys.
- Strategy estimates use their stored original `nominal_risk_amount`; rejected broker intents are excluded. They are calculated on read, without updating strategy financial records.
- Estimates use reported dollar P/L, whose cost completeness is not asserted. They are labeled **Estimated** and remain excluded from verified-R aggregates. `resultR` stays null unless the original verified contract is satisfied; separate `estimatedRMultiple`, `estimatedRiskUsd` and basis fields carry the reconstructed comparison.

Fresh audit: **380 raw closed records**, **357 eligible closed journal records**, **352 journal records with estimated R**, **5 journal records without sufficient evidence**, and **0 verified R records**. Raw-source counts include imports/rejections and must not be interpreted as unique executed trades. All 26 records in the October 14–29 New York window remain in the audit cohort.

## Real examples

| Trade | Preserved reported P/L | Reconstructed sizing amount | Estimated R | Old audit-only R |
|---|---:|---:|---:|---:|
| EUR/USD `a327e0c7…` | -$566.1993 | $927.07353 | -0.61073829 | -0.9785 |
| EUR/USD `92e2f33e…` | -$870.8853 | $465.90570 | -1.86923083 | -0.8182 |
| AUD/CHF `d341ad22…` | +$2,021.4592 | $901.554208 | +2.24219374 | +2.2250 |
| AUD/CHF `6515a354…` | +$1,833.6777 | $922.614548 | +1.98747972 | +1.3197 |

The cross-currency conversion basis is documented by [OANDA's order-fill schema](https://developer.oanda.com/rest-live-v20/transaction-df/#OrderFillTransaction). It is a historical sizing estimate, not a claim that the estimated amount was explicitly agreed before entry.

## Preservation and verification

Closed financial fingerprints matched before and after both the preview and applied repair. Original paper P/L, prices, stop/target fields, legacy R and broker executions were not rewritten. Only derived estimate metadata was added. The broker was accessed through GET requests; no test trade was submitted. The repair is idempotent: reruns retain existing estimate snapshots.

Passed: both type checks, both existing risk suites, new automatic-budget/estimate tests, Home tests, and focused lint on the reporting module, journal and Home activity components. Tests cover save-before-submit, blocked submission on failed persistence, immutable overrides, scheduled activation snapshots, cross-currency evidence, account/order/trade isolation and verified-stat exclusion. Broad pre-existing chart/ticket lint issues are outside this change. No production build or deployment is claimed.

Browser verification: the signed-in journal displays historical estimates and retains the original dollar results. The AUD/CHF detail shows +$2,021.46, +2.24R Estimated and the $901.55 benchmark, plus its evidence explanation. Screenshots: `outputs/historical-r-estimate-detail.png` and `outputs/historical-r-estimates-journal.png`. The automatic-budget default, explanation and override inputs were verified in a temporary chart tab; the untouched draft was cancelled and the tab closed. Ticket screenshot: `outputs/automatic-risk-budget-ticket.png`. A new actual broker lifecycle remains fixture-tested only.

Artifacts: `outputs/historical-risk-estimates-preview.json`, `outputs/historical-risk-estimates-applied.json`, `outputs/risk-historical-audit.json`.

Rollback: revert the new reporting/UI capture changes together. Remove only `historicalRiskEstimate` from the exact pending-entry IDs recorded in the applied audit if the derived metadata needs removal; retain financial source rows and captured pre-entry plans. No schema migration is required.
