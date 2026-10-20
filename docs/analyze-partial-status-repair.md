# Analyze partial-status repair and October 18 audit

Implemented and verified locally on October 18–19, 2026. No release, new GPT research run, plan approval, or broker order was performed for this repair.

## Exact diagnosis

The original research job `c98bcc8f-e98f-4438-8db7-1437eabc2b69` completed successfully against research `f820bd9b-3771-459b-a746-f709417ae220`. Its research cutoff was **2026-10-18 22:41:06.397 UTC**, with zero validation drops and 121 returned source references. Its watcher stored:

> NO_VALID_SETUP — Market data is not usable: Latest H4 candle closed 2983 min ago; the feed looks stale.

That was a data-validation failure incorrectly labelled a strategy rejection. The elapsed-wall-clock H4 freshness rule counted the closed weekend. The October 18 technical recovery work already replaced that rule with completed trading-interval validation. This repair preserves and tests that fix, including an independent broker-history reconstruction.

The later snapshot `d60c5cfc-f59b-4246-8097-5b346c9b3eb5`, generated **2026-10-19 01:27:50.597 UTC**, had:

```json
{"analysisStatus":"ANALYSIS_COMPLETE","quality":{"status":"PARTIAL","issues":[]}}
```

It had already produced pending BUY and SELL plans. Its `PARTIAL` value described research coverage: missing retail sentiment, synchronized yields, updated positioning, sovereign spread, verified Sunday reaction, and a deliberately deferred technical summary. It did **not** indicate a failed technical check. `MarketStateRead` nevertheless treated `quality.status === PARTIAL` as proof that new plans were blocked. That banner was false for the recovered result.

An additional read-side defect used that same research-quality flag to check only H1 freshness. Consequently, optional research gaps could prevent a missing H4 completion from being detected on later reads. Complete technical snapshots now revalidate D1, H4, and H1 regardless of research coverage.

## Candle verification

Historical OANDA midpoint candles were independently retrieved with explicit New York 17:00 alignment and an end cutoff of **2026-10-18 22:42:59.990 UTC**. This is a reconstruction from broker history, not a claim that the original HTTP payload was retained. Historical `complete` flags are filtered against the replay clock so a candle that completed later cannot leak into the reconstruction.

| Timeframe | Last completed open UTC | Derived completion UTC | Result at original cutoff |
|---|---|---|---|
| D1 | Oct 15 21:00 | Oct 16 21:00 | Valid Friday context |
| H4 | Oct 16 17:00 | Oct 16 21:00 | Valid Friday context; Sunday H4 not due |
| H1 | Oct 18 21:00 | Oct 18 22:00 | Current completed H1 |
| M15 | Oct 18 22:15 | Oct 18 22:30 | Current completed M15 |

Each recorded timeframe has 299 completed candles after excluding the bar not yet complete at the cutoff. The first Sunday H4 interval completes at **Oct 19 01:00 UTC / Oct 18 21:00 EDT**. The next D1 interval completes Monday at **21:00 UTC / 17:00 EDT**. Thus the later screenshot's Sunday 21:00 EDT H4 close and Friday D1 close are compatible, not evidence that the components used different market sessions.

Fresh live reads also passed all required candle checks. Provenance records instrument, granularity, received and completed counts, `complete`, open and completion timestamps, forming candle, request/receive time, cache age, alignment version, next expected completion, and each validation check. OANDA reads do not retain an indefinite candle cache: concurrent identical requests share one flight; the next read fetches again.

## Operation dependencies and repaired behavior

The executable dependency map is `ANALYZE_DEPENDENCIES` in `trade-plan-generator.ts`.

| Operation | Mandatory inputs | Missing optional inputs |
|---|---|---|
| H1 observation | Valid completed H1 history | Higher-timeframe gaps do not erase H1 |
| M15 fallback observation | Valid completed M15 history | Cannot imply D1/H4 direction |
| Complete swing interpretation | Fresh validated research; valid D1/H4/H1 structure inputs | Missing calendar limits event reactions; missing live quote does not erase completed price structure |
| Swing breakout/retest plan | D1 targets/volatility, H4 structure/zones/ATR, H1 confirmation history | Calendar/quote restrictions remain attached to entry safety |
| Swing support/resistance reversal | D1 targets/volatility, H4 zones/ATR, H1 rejection and structure-turn rules | Same independent entry safety |
| Short-term trade plans | No separate short-term plan generator is installed in this pipeline | The near-term outlook is not a short-term trading strategy |
| Execution | Approved immutable version, later confirmation, fresh broker bid/ask, spread, verified calendar, risk/account/exposure/slippage checks | Missing execution dependencies block execution |

An organized H4 trend is not a global dependency of the installed conditional reversal/breakout engine. `UNCLEAR`, `RANGE`, and `TRANSITION` are valid structure classifications. Insufficient history, malformed candles, stale completed intervals, and unavailable indicators are separate failures.

The generator owns plan eligibility. The service no longer discards its valid result merely because the interpreter has incomplete optional evidence. Research must still be fresh and validated before generation; an old environment override can no longer bypass this ordering. Both consumers receive the same market read and clock. Every new plan records `analysisInputs.dataSnapshotId`; the interpretation records the same source ID. Mismatches fail closed.

Generated levels are validated **before** recording eligibility and retiring earlier pending plans. Failed generated levels cannot be reported as conditional opportunities or discard earlier plans. Approved plans remain immutable. Existing pending plans were preserved during this repair.

Technical completion and plan results remain separate, using the existing API enums:

- `ANALYSIS_COMPLETE` + `PLANS`: conditional scenarios available.
- `ANALYSIS_COMPLETE` + `NO_VALID_SETUP`: strategies evaluated; no candidate qualified.
- `ANALYSIS_COMPLETE` with indeterminate swing: valid data, uncertain direction.
- `ANALYSIS_PARTIAL` with a plan-input failure: qualified observations retained; affected swing evaluations skipped.
- `TECHNICAL_DATA_UNAVAILABLE` or `DATA_VALIDATION_FAILED`: required data could not be used; never described as a completed no-setup search.

Research evidence coverage can remain `quality.status=PARTIAL` in any otherwise complete technical assessment. That value no longer controls plan gating or technical freshness.

## Calendar and research handoff

The original persisted calendar was `available=true` with empty released/upcoming arrays. It was a recorded successful empty slice, not an unavailable calendar. The original raw provider payload was not retained, so the record does not prove that no economic releases existed outside that slice.

During live verification, the provider independently returned **HTTP 429**. It was reported as unavailable, not as zero events. At **2026-10-19 02:24 UTC**, a subsequent read recovered to `CALENDAR_AVAILABLE_NO_EVENTS`, with coverage through **October 25 04:00 UTC**. These are distinct verified outcomes. Conditional technical planning remains possible during an outage; execution still requires calendar verification. The actuals enrichment already fails independently without destroying the underlying schedule. The display calendar now rejects a nonempty feed from the wrong week instead of assigning it current coverage.

Ordinary research can disclose an unavailable schedule. Calendar failure alone no longer invalidates otherwise fresh cached research and repeatedly authorizes paid reruns. Verified newly available releases, TTL expiry, or an explicit refresh can still justify research refresh. News Mode and execution-calendar validation were not relaxed.

The original research input explicitly set `deferredUntilResearchValidation=true`, with null price and empty trend/ATR/zones/plans. That is intentional. Fresh OANDA technical analysis follows validated research. The UI now labels old limitations as **research-stage** evidence limits; future prompts explicitly explain the deferral. No second GPT run was introduced.

Fresh complete reports continue to be reused by pair. Currency-specific cited evidence is also derived from fresh persisted reports across pairs as a small source-discovery cache. Those hints must be checked against recent developments and returned by the new run's search before they can become citations. They do not substitute another pair's direction or authorize a trade.

## News coverage audit

The saved provider response was retrieved read-only. Of six web tool calls, the five search actions used queries concentrated on October 16, central-bank policy, rates, and positioning; the remaining action was an open. No saved query targeted October 17–18 French unrest, and the returned-source ledger and validated factors did not include the new weekend development. Zero validator drops rules out a recorded citation-validation rejection as the explanation for this omission. The evidence supports inadequate source discovery, rather than proving a model omission after retrieval.

Reuters reported new nationwide unrest on **October 17**, before the October 18 research cutoff: [Reuters via MarketScreener](https://www.marketscreener.com/news/latest/Mass-protests-in-France-spiral-into-worst-riots-in-years-12624680/) lists publication October 17 at 09:41 EDT and modification at 16:28 EDT. [October 18 Reuters reporting via Internazionale](https://www.internazionale.it/ultime-notizie-reuters/2026/10/18/france-faces-aftermath-of-worst-unrest-in-years) describes the aftermath and renewed clashes. These are new developments relative to the saved October 16 fiscal-risk factor. Political/fiscal risk is relevant to euro context, but an adverse EUR/USD effect or a verified market reaction does not follow from the event alone.

The prompt now puts cutoff-relative, preceding-72-hour reporting for both currencies, including weekend political and geopolitical developments, in the initial search batch. The configured search budget is unchanged. Provenance validation remains mandatory, and factors with observed event timestamps after cutoff are rejected. The old research report was not retroactively rewritten with evidence from this separate audit. No paid run was launched to test whether a future model follows the new coverage instruction; that remains an explicit limitation.

## UI, diagnostics, persistence and notifications

- Daily/H4/H1 structure is visible above the three outlook rows. Choppy movement, recent ATR displacement, directional efficiency, structural direction, and forward lean remain distinct.
- Swing explanations identify valid timeframe disagreement as uncertainty rather than missing data. Classification rules were not made more decisive.
- The sheet shows completed no-setup, partial technical analysis, unavailable technical data, and invalid data separately. Each rejected side retains its reason; a qualified opposite side remains visible.
- Without a verified market snapshot, the fallback is explicitly labelled **Research context**, with current price structure unknown.
- Technical retries reuse stored research. Open sheets poll persisted interpretation state every 20 seconds; this starts neither model research nor plan generation.
- A verified current calendar failure is also visible as an entry-specific pause, with the provider's recorded reason; it does not turn completed technical analysis into an incomplete analysis.
- New generation snapshots persist structured checks, input timestamps, snapshot ID, analysis ID, per-side evaluated/skipped status, and rejection codes inside the existing JSON snapshot. No schema migration was needed.
- Legacy watcher rows that mislabelled a data failure `NO_VALID_SETUP` are normalized on read while preserving their stored rejection reason. Future completion notices include the concrete plan failure and point to a technical retry. Existing historical notifications were not rewritten.

The displayed SELL scenario still estimates below the existing 1.5R entry requirement. This repair does not make it executable, improve its reward/risk, or alter its approved rules. The unchanged monitor and execution checks remain authoritative.

## Validation

- API and frontend TypeScript: pass.
- Frontend production build: pass.
- New Analyze status suite: **18** deterministic checks using fixed clocks and recorded broker/research fixtures.
- Candle recovery: **35** deterministic checks, including Sunday reopening, Friday D1 carry-forward, DST, missing completed intervals, alignment/provenance, malformed responses, and bounded retries.
- Trade-plan suites: generator **17**, confirmation **38**, monitor **12**, executor **30**, market intelligence **26**, research jobs **24**, lifecycle **21**, interpreter **18**, plus state/settings suites. PostgreSQL lifecycle, duplicate-persistence, approval-version, and snapshot tests roll back their writes.
- Frontend Analyze V2: **60** tests; calendar suite passes.
- Browser: actual EUR/USD sheet verified; isolated complete/no-setup, partial-H4, and unavailable-data screens checked at phone width. The existing unrelated React inline-script development warning remains.
- Focused lint: new status module, market-read components and preview pass. Changed tracked files match HEAD's **14** lint errors with **zero introduced** findings. Full repository lint remains failing: **147 errors / 104 warnings**, including existing research/script debt.
- Live practice integration: read-only OANDA history and current candle/quote/calendar reads verified. The technical-only refresh persisted an interpretation snapshot and preserved the two pending plan IDs and levels. No new research, approvals, execution attempts, or broker orders were submitted by this repair.

## Files changed for this repair

Runtime API: `src/intelligence/{market-state-interpreter,market-state-store,research-service,research-jobs,openai-research,research-contract}.ts`, `src/{trade-plan-generator,trade-plan-service}.ts`.

Frontend: `src/lib/trade-plans/{analysis-status,market-state,api}.ts`; `src/lib/strategy/candle-clock.ts`; `src/lib/strategy/analyze-v2/{data-quality,foundation}.ts`; `src/lib/oanda/client.ts`; `src/lib/calendar/forex-factory.ts`; `src/components/trade-plans/{market-state-read,market-read,plan-analyze}.tsx`; `src/components/trade-plans/market-read.module.css`; `src/app/dev/plan-analyze-preview/preview.tsx`.

Diagnostics/tests: API `scripts/{audit-analyze-status,record-oct18-analysis,diagnose-candle-data,test-analyze-status,test-market-intelligence,test-market-state-interpreter}.ts`; recorded `scripts/fixtures/{oct18-oanda-analysis,oct18-research}.json`; frontend `src/lib/trade-plans/fixtures/completed-market-state.json`; API `package.json` test command; this report.

Other dirty files predate this request and were preserved. No database migration, commit, deployment, or automatic retroactive change to existing plans was made.

Evidence artifacts are in `outputs/analyze-status-audit.json`, `outputs/analyze-research-search-audit.json`, `outputs/partial-analysis-live-final.jsonl`, and `outputs/partial-*-tests.log` / `outputs/partial-frontend-build.log` / `outputs/partial-full-lint.log`. Audit artifacts stay local and are not runtime dependencies.

**Recommendation:** keep the strict execution and confirmation gates. The verified repair is to stop presenting uncertain direction or incomplete optional research coverage as broken technical data. Any calendar outage must block entry until verification recovers; a recovered calendar alone does not authorize a trade.
