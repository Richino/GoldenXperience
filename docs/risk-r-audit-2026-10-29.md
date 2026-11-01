# Financial R reporting audit — October 29, 2026; revalidated October 31

Later October 31 follow-up: the user approved automatic capture of the configured sizing budget and explicitly labeled historical estimates. See [automatic budgets and historical repair](automatic-risk-and-history-2026-10-31.md) for the current implementation and updated 352-of-357 journal estimate coverage. Earlier missing-risk findings below refer to verified initial-risk evidence; estimates do not retroactively become verified evidence.

## Outcome and validation boundary

Implemented a financial-R compatibility projection, explicit optional pre-entry budgets, cost-aware broker cash reconstruction, verified-only analytics and prospective excursion observations. Legacy financial records remain unchanged. Code is local and has not been deployed.

After the user signed in, Home, Trades, a selected real trade and the optional entry-budget controls were verified in the browser. The untouched draft was cancelled and the separate verification tab closed. No test trade was submitted: that would violate the instruction not to execute trades. Real-data validation below was read-only; new-trade lifecycle validation uses fixtures.

## Defects found before changes

1. Manual no-stop trades could use an ATR/H1 sizing distance as their R reference without an explicit monetary risk agreement.
2. Home and Trades computed Open R from entry/current/stop distance. A later stop change could redefine the reported result.
3. Home could substitute 1% of current balance for missing nominal risk. That is not evidence of original planned risk.
4. Journal and chart APIs exposed `result_r` directly without a risk provenance classification.
5. Journal win counts and win/loss filters depended on R instead of independently available monetary results.
6. Weekly review used final stored stop/target distances for planned R, described a sizing stop as original risk, and summed missing R as zero.
7. Trades summed individual open R values as a portfolio figure rather than using total P/L / total independent planned risk.
8. Instrument-only fill lookup could associate another trade's fill on the same pair.
9. Chart labels presented price-distance target/stop ratios and fixed `-1R` stop labels as financial R.
10. Historical notifications and research terminology could mix legacy distance scores with financial R.
11. Dollar P/L alone did not establish whether financing, commission and guaranteed execution fees had been accounted for.
12. Entry-time equity and historical time-varying exposures were not reliably recorded; inventing them would fabricate return or excursion metrics.

The source inventory was captured before changes in `outputs/r-calculation-files.txt`; the initial findings were recorded in `outputs/risk-r-audit.md`.

## Canonical definitions

The implementation is `frontend/src/lib/risk-metrics.ts`.

- Realized R = verified net realized USD P/L / documented initial planned USD risk.
- Unrealized R = verified net unrealized USD P/L / documented initial planned USD risk.
- Planned net R:R = documented planned net USD reward / documented initial planned USD risk.
- Return on entry equity = 100 × verified net realized USD P/L / verified entry-time USD equity.
- Portfolio R = sum of component net P/L / sum of component original risk. Every component must be documented; duplicate component keys or missing risk invalidate the result.
- Partial-close allocations consume the original risk in proportion to the affected units; additions need separate risk components. Entry costs are allocated by units once across closed and remaining portions.
- Drawdown-adjusted result = net realized P/L / observed maximum floating loss. It is not labeled R, and zero/unknown MAE returns null.
- Summed independent unit R is a separate analytic convention, not portfolio R. It is labeled accordingly.

Initial risk must be finite, positive, recorded no later than opening, tied to the exact risk component, and in the correct currency. Later stops, ATR, MAE, final size and arbitrary default percentages cannot supply missing original risk. Ratios are not clamped to -1. Decimal inputs are divided using scaled integer arithmetic; display rounding is not fed back into denominators.

## Future manual budgets and compatibility

The single-entry manual ticket accepts an optional USD amount or percentage of equity **when planned**, plus an optional net monetary reward objective. The percentage is explicitly labeled planning-time equity; it is not misrepresented as the equity at a later pending-order fill. The dollar budget is frozen before submission and bound to the broker account and a unique position-risk key.

The budget is accounting evidence only. It does not change sizing, add a stop, modify a target, alter activation or cancellation rules, or cap the actual loss. Existing entries cannot acquire retroactive initial risk through the edit path. New ticket resets clear the optional budget, preventing accidental reuse.

No schema migration or historical backfill was applied. New entries store versioned reporting metadata in the existing JSON column. Old readers can ignore it. Historical `result_r`, broker execution records, P/L and balances are preserved; corrected fields are derived at read time, with `legacyR` retained separately.

Risk classifications are `verified`, `estimated`, `missing` and `legacy_unverified`. Verification of initial risk alone does not assert that a cost-incomplete P/L numerator is verified.

Rollback: revert the reporting projection, UI and observer wiring together. Preserve the versioned metadata for audit; no financial data rollback or deletion is necessary. Do not delete or rewrite legacy R to roll back.

## Broker accounting and excursions

`api-server/src/risk-net-cash.ts` only reads account-scoped trade and transaction resources. Commission is allocated by executed units within a fill. OANDA defines commission and execution fees in account home currency: https://developer.oanda.com/rest-live-v20/transaction-df/. Unit-based attribution across a multi-trade fill is this application's explicit allocation convention. Explicit trade fees and financing are included. Spread already embedded in bid/ask execution P/L is not subtracted again. Missing commission, fees, allocation units or closing transactions invalidate net R rather than becoming zero. Duplicate closing transactions and inconsistent unit totals are rejected.

Broker IDs identify independent positions, including trades on the same pair. Net cash is only attached to a live financial frame if the broker state still matches that frame's units and floating P/L. A changed position waits for another frame instead of mixing data.

Prospective versioned entries collect sampled broker floating cash, bid/ask movement and actual exposure. Only their analytics metadata is updated. Extrema survive reloads. The background observer samples every 15 seconds; Home snapshots can add observations. This does not claim to capture every tick. Values are labeled observed estimates. No final position size is applied to an earlier historical price path.

## Historical read-only audit

Run from `api-server`: `node --import tsx scripts/audit-risk-reporting.ts`.

- October 31 revalidation: 380 raw closed historical records audited across manual/imported and strategy tables (376 in the original October 29 audit). These are source records, not a claim of 380 unique executed trades; the journal excludes duplicate broker imports and rejected executions.
- 26 records in the October 14–29, 2026 New York window.
- No verifiable initial risk evidence was promoted to verified R in the refreshed audit: 0 included, 380 excluded.
- Source P/L was preserved in every projected record.
- Closed-record financial fingerprints, including legacy R, prices and P/L, matched before and after the read-only audit.

| Trade | Reported original P/L | Legacy R retained | Corrected financial R |
|---|---:|---:|---|
| AUD/USD `f065c827…` | $377.0734 | 0.4062 | N/A |
| NZD/USD `dc26a6e3…` | $3,318.8130 | 2.4216 | N/A |
| EUR/USD `60eab182…` | -$1,603.8546 | -1.0065 | N/A |
| EUR/USD `e756f779…` | -$612.9702 | -1.0000 | N/A |
| AUD/CHF `d341ad22…` | $2,021.4592 | 2.2250 | N/A |

These results prove missing verifiable evidence under the new contract. They do not prove that a trader never had a mental risk budget. Mental intent cannot be reconstructed from later prices or a later stop.

Full machine-readable audit: `outputs/risk-historical-audit.json`.

## Representative new-trade tests

- Documented $1,000 risk, +$1,000 net P/L => +1.00R.
- Documented $1,000 risk, -$2,500 net P/L => -2.50R, without clamping.
- Documented $2,000 risk, +$500 net P/L => +0.25R.
- Explicit no-stop $1,000 budget, +$750 verified net P/L => +0.75R after serialization/reload. Adding a later stop leaves +0.75R unchanged.
- Missing or post-entry risk => null; missing target/reward objective => null planned R:R.
- Two independently risked components with $1,000 and $3,000 budgets and combined $1,000 net P/L => portfolio R of 0.25, not the average of individual R.
- Partial-close broker fixture: $200 realized gross, allocated financing and costs => $187 realized net; remaining cash net is $90. No cost or risk is counted twice.

## Files and components changed for this task

Core calculation and compatibility:

- `frontend/src/lib/risk-metrics.ts`
- `frontend/src/lib/journal/stats.ts`
- `frontend/src/lib/home/idle.ts`
- `frontend/src/lib/chart-utils.ts`
- `frontend/src/types/forex.ts`
- `frontend/src/lib/home/financial-snapshot.ts`
- `frontend/src/lib/market-stream/use-open-positions.ts`
- `frontend/src/lib/oanda/client.ts` (non-secret account identity accessor)
- `api-server/src/risk-reporting.ts`
- `api-server/src/risk-net-cash.ts`
- `api-server/src/risk-excursion-observer.ts`
- `api-server/src/paper-cycle.ts` (reporting/filtering/notification text, not execution decisions)
- `api-server/src/pending-manual-entries.ts` (optional accounting metadata)
- `api-server/src/weekly-review.ts`
- `api-server/src/plan-review.ts`
- `api-server/src/server.ts` (read-only cash annotation and observer lifecycle)

UI:

- Dashboard: `dashboard-view.tsx`, `ledger-home.tsx`, `performance-card.tsx`, `weekly-review.tsx`.
- Trades: `trades-view.tsx`.
- Charts: `pending-entry-dialog.tsx`, `setup-chart.tsx`, `chart-ledger-parts.tsx`.
- Analysis: `analyze-card.tsx`, `manual-proposal.tsx`, `trade-health.tsx`.
- Risk: `risk-workspace.tsx`.
- Research terminology: `research-view.tsx`, `forward-view.tsx`, `experiment-equity-chart.tsx`.
- Additional compatibility surfaces: `home-rail.tsx`, `home-recent-activity.tsx`, `ledger-plans.tsx`, `signals-view.tsx`, `signal-workspace.tsx`, `plan-analyze.tsx`, `analyze-v2-panel.tsx`, `swing-intelligence-card.tsx`, the journal `plan-review.tsx`, both News Straddle ticket components, notification display and notification provider.
- `frontend/src/app/night-ledger.css`: unavailable-R reason wrapping inside its own column.
- Both package manifests and the new tests/audit script listed below.

Pre-existing unrelated work in the shared checkout was preserved. No commit, push or deployment was performed.

## Validation

October 31 continuation found and fixed three additional reporting defects: fixed-decimal division could erase very small nonzero results, repeated projections could overwrite the original legacy audit value, and fully closed trade cash could omit financing booked before its closing fills. Regression tests now preserve significant digits, fail closed for ratios outside the numeric range, preserve legacy evidence across repeated projections, include cumulative financing at full closure, and reject inconsistent closed/open exposure states. OANDA documents trade financing as the financing paid/collected for the trade and closing transaction IDs as the transactions closing portions of it: [OANDA trade schema](https://developer.oanda.com/rest-live-v20/trade-df/).

Passed:

- Frontend and API `npm.cmd run typecheck`.
- Frontend `npm.cmd run risk-metrics:test` (signed R, missing/late risk, no-stop budgets, later-stop independence, optional objectives, partials, additions, currency/cost completeness, legacy preservation, coverage, observed exposure, reloads and equity-path requirements).
- API `npm.cmd run risk-metrics:test` (read-only broker cash fixtures: partials, same-fill independent trades, commission/financing, full closure, missing costs and duplicate protection).
- Frontend `npm.cmd run home:test`.
- Focused ESLint for the canonical module, journal statistics, Dashboard financial reporting, performance card and Trades.
- Read-only database audit and financial fingerprint preservation checks.

Both type checks, both risk suites, Home tests and the read-only historical audit were rerun successfully on October 31. A production build and a newly executed broker lifecycle were not run. Existing browser evidence below is from October 29, not a fresh physical-device check.

The broader lint invocation still encounters pre-existing errors in chart refs, effect state updates and ticket date validation. Those were not suppressed or fixed by changing trading behavior.

Browser checks passed after sign-in: Home shows unavailable legacy R while preserving dollar P/L; Trades shows coverage and original dollar P/L, with the legacy value isolated in the audit details; the optional risk budget displays its non-protective accounting explanation. The draft was cancelled without submission. Screenshots: `outputs/risk-reporting-verified.png` and `outputs/risk-budget-ticket.png`. No credentials were requested in chat, and no broker trade was created. Unvisited secondary screens and full new broker lifecycles are not claimed as browser-verified.

## Remaining unavailable information and explicit limits

- Historical initial risk and initial protective-stop status without contemporaneous evidence.
- Historical MAE/MFE without reliable observations of exposure and broker cash.
- Net R when financing, commissions, fees or transaction allocation cannot be verified.
- Entry-equity return where an actual entry-time equity snapshot is absent. Planning-time equity is not relabeled entry-time equity.
- True historical account-equity drawdown where only cash-balance transactions, rather than a cash-flow-adjusted NAV path, exist.
- Planned net R:R where no explicit net reward objective is recorded.
- Non-USD broker cash R where a reliable account-currency conversion contract is absent.

Legacy strategy evaluators and execution gates retain their internal distance-based scores so this task does not change strategy behavior. Those scores are not promoted to verified financial R; research presentation identifies distance scores separately. This is a reporting correction, not a strategy-engine migration.

Recommendation: validate the next naturally initiated, explicitly budgeted practice trade through its full lifecycle before deploying this reporting change. Do not manufacture historical risk to make the R statistics look complete.
