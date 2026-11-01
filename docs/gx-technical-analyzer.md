# GX Technical Analyzer v1.4

Open `/technical-analyzer` from the desktop sidebar or the link at the top of Markets on mobile. The existing Chart analysis is unchanged. This feature uses no LLM, auth provider, external service, or new package, and cannot submit broker orders.

## Data and architecture

- `api-server/src/technical-analyzer.ts`: verified Practice quotes, cached four-frame history, owner/account-scoped immutable issuance, on-demand settlement and statistics.
- `frontend/src/lib/technical-analyzer/engine.ts`: pure indicators, confirmed structure, zones, independent horizon rules, calendar and statistics.
- `frontend/src/lib/technical-analyzer/validation.ts`: exact expiry candle selection and chronological, purged development/holdout comparison.
- `frontend/src/lib/technical-analyzer/report.ts`: complete report and supplied independent research prompt; clipboard API, selection fallback and visible manual copy.
- `frontend/src/components/technical-analyzer/`: responsive interface using GX theme tokens.
- API: authenticated `POST /api/technical-analyzer/analyze` with `{ "instrument": "USD_JPY" }`; `GET /api/technical-analyzer/history` optionally filters `?instrument=USD_JPY`.
- Reuses the existing instrument catalog, owner session, database pool, EMA/ATR calculations, OANDA quote/candle client and NY17 candle clock. Explicitly rejects mock data and live-account configuration.

Requests share 420 candles per frame, exclude incomplete candles, validate OHLC and order/alignment, and require at least 260 completed candles. Latest candles cache for 60 seconds; historical expiry requests cache for one hour. Failed requests are evicted. Unexpected gaps in the latest 20 bars or stale completed candles make the technical snapshot UNAVAILABLE. Missing/corrupt/insufficient history fails the analysis without issuing a forecast. Older unexplained gaps are disclosed.

Market closure and stale quotes are independent of candle-based technical availability. Closed-market snapshots can produce BULLISH, BEARISH or NO EDGE assessments from valid completed candles, while remaining excluded from forward scoring. A stale live quote during trading hours blocks scoring but does not fabricate NO EDGE. NO EDGE is reserved for technical ambiguity. None of these states establishes predictive validation. The old v1.0 reports retain their original issued forecasts; only new v1.1 reports use the corrected separation.

The holiday calendar contains only the explicitly published OANDA FX closures for Christmas 2025 and New Year 2026, verified against [OANDA's schedule](https://www.oanda.com/ca-en/trading/holiday-trading-hours/). Those absences are classified as expected closures rather than unexpected gaps. Other bank holidays are not assumed to close forex. Uncovered future holiday schedules must be verified before adding them. An expiry with no exact observed D1 close remains pending regardless of the calendar.

NY 17:00 daily alignment and Friday weekly alignment follow the existing client and [OANDA candle alignment definitions](https://developer.oanda.com/rest-live-v20/pricing-ep/). Times returned by OANDA are UTC; UI displays America/New_York with DST. A trading day means the next Monday–Friday 17:00 NY boundary; 1D can be a partial day. An issue exactly at Friday close expires on Monday, adjusting for DST. Weekly context uses completed Friday-aligned candles, including their subsequent trading week.

## Initial rules (not validated)

Model version: `gx-technical-1.4.0`. Change the version whenever rules or indicator definitions change after release. `RULES`, `LEAN_RULES`, `EVIDENCE_RULES`, `ZONE_RULES` and the horizon weights are the documented configuration surface; no user-facing optimizer is provided. Earlier forecasts stay immutable and reviewable; legacy reports keep their original evidence labels. New reports and statistics use v1.4.

## Directional lean, evidence and continuation risk

The main forecast cards now show three separate concepts:

- **Directional lean:** BULLISH, BEARISH, UNCLEAR or UNAVAILABLE.
- **Lean evidence:** STRONG, MODERATE, MIXED, WEAK or UNAVAILABLE. Legacy ALIGNED labels remain readable.
- **Continuation risk:** LOW, CAUTION, HIGH or UNAVAILABLE, with the specific reasons.

The lean reuses the existing horizon-weighted trend/structure group. A score >=0.15 leans bullish; <=-0.15 leans bearish; scores within that neutral band are UNCLEAR. This informational neutral band is an initial documented rule, not a calibrated forecast or evidence of a statistical advantage. It allows consistent HH/HL or LH/LL structure to communicate direction without requiring full price/EMA20/50/200 alignment. It does not change the original group weights or indicator calculations.

Evidence grades the independent directional groups, separately from entry/location risk and the stricter assessment. Apply these rules in order:

1. Unreliable required candles: UNAVAILABLE. Lean inside the ±0.15 neutral band: WEAK / UNCLEAR.
2. Material directional opposition: MIXED. This means momentum opposes the lean by at least 0.12 normalized units, or clearly opposing timeframe trend/structure evidence carries at least 35% of the horizon weight. A frame is clearly opposed when its existing trend/structure group points the other way by at least 0.3. A secondary 20%-weight disagreement is not treated as a 35%-weight opposition.
3. STRONG requires absolute weighted trend/structure >=0.6, confirming momentum >=0.12 in the same direction, and weighted ADX >=18, without the material opposition above.
4. MODERATE requires absolute trend/structure >=0.3 and either positive momentum agreement or ADX >=18. This also covers incomplete momentum confirmation or insufficient trend strength when the stronger rule does not pass.
5. Other directional cases are WEAK.

Support/resistance proximity, exhaustion, divergence/failed-breakout cautions, a missing full EMA alignment on a secondary timeframe, or an arbitrary count of warning messages do not automatically downgrade directional evidence. They remain visible in continuation risk and contradiction details. Strong bearish evidence can coexist with HIGH bounce risk at major support. Material momentum or timeframe opposition still yields MIXED, even when indicators appear strong elsewhere. A recorded `evidenceReasons` array exposes group values and the actual opposing timeframe weight for audit. The strict forecast gates, directional lean neutral band, horizon weights, indicator calculations and scoring are unchanged in v1.4. New strict-assessment evidence labels also stop treating location warnings as a directional disagreement; strict NO EDGE remains MIXED, and a strict directional call is ALIGNED unless material directional opposition exists. Original historical labels remain untouched. STRONG measures technical agreement, not a calibrated win rate.

Continuation risk combines opposing levels, exhaustion, momentum disagreement, confirmed divergence/failed breakouts, material timeframe opposition, weak trend strength and weak directional evidence. A major opposing zone or exhaustion gives HIGH risk; other detected conflicts give CAUTION; no detected elevated factors gives LOW. LOW does not mean no risk or assured continuation. Required bad/missing candle data remains UNAVAILABLE across all three concepts.

`Forecast.bias` remains the strict assessment with unchanged directional/exhaustion thresholds. It is shown in expandable details and exports rather than being the main directional headline. Snapshots log the lean, evidence and continuation-risk rationale at issuance. Exact-expiry scoring stores `leanCorrect` separately from strict `correct`; history reports separate eligible completed sample sizes and accuracies. NO EDGE may abstain from the strict sample while its directional lean is measured in the lean sample. UNCLEAR, UNAVAILABLE, pending, ineligible and legacy records without a recorded lean are not counted as directional lean calls. Flat outcomes count as misses. Overlap and selection bias still apply; different sample accuracies are not directly comparable as if they were matched experiments.

## Indicator gauges and timeframe controls

The 1H/4H/1D/1W selector changes only indicator readings. The 1–5 trading-day cards change only the forecast detail. Gauge votes do not feed the five-horizon decision engine. This distinction prevents correlated moving averages from being presented as forecast confidence.

Each timeframe calculates EMA and SMA periods 10, 20, 30, 50, 100 and 200 (12 actual rows). Price more than 0.01 ATR above/below an average is Buy/Sell; within that band is Neutral. Oscillators are RSI14, Stochastic(14,3,3), CCI20, ADX14/DI, Momentum10, MACD(12,26,9), Williams %R14 and Awesome Oscillator(5,34). Each row exposes its exact classification rule in the expandable table; the formulas and rules live in `ratings.ts`. No unsupported indicators or TradingView counts are substituted.

Category score is (Buy count - Sell count) / observed row count. Overall score is the mean of the oscillator and moving-average category scores, giving equal weight to both groups. Overall displayed counts sum the actual 20 rows. Scores <= -0.5 mean Strong Sell; below -0.1 Sell; >= 0.5 Strong Buy; above 0.1 Buy; otherwise Neutral. Gauge scores are normalized technical vote summaries, not calibrated probabilities. These are documented GX rules, not a claim of TradingView numerical parity. Legacy immutable reports show only readings actually recorded at issuance.

The default research export is concise and follows the selected timeframe. All five horizon conclusions, key contradictions, invalidation and nearby major zones are included, followed by the original independent research prompt. Optional Full Technical Export retains detailed calculations, events, diagnostic messages and the frozen snapshot. Clipboard API and manual fallbacks are preserved. Data Quality, detailed scenarios and forecast history are collapsed by default.

| Horizon | Frame weights |
| --- | --- |
| 1D | H1 60%, H4 40% |
| 2D | H1 20%, H4 80% |
| 3D | H4 50%, D1 50% |
| 4D | H4 20%, D1 80% |
| 5D | D1 65%, W1 35% |

Within each frame the trend group combines EMA alignment/slope (65%) and confirmed HH/HL or LH/LL structure (35%). EMA alignment requires price and EMA20/50/200 ordering and an agreeing five-bar EMA20 slope. The momentum group combines MACD histogram direction and capped RSI displacement from 50. ADX gates strength rather than casting another directional vote. Exhaustion can block a directional call; location is assessed separately as continuation risk.

Directional calls require absolute trend group >= 0.45, agreeing momentum >= 0.12 and weighted ADX >= 18. Weighted exhaustion >= 0.5 forces NO EDGE; a frame is extended at RSI >75/<25 or price more than 2 ATR from EMA20. These directional thresholds are unchanged in v1.2. NO EDGE now names the failed directional/exhaustion gates explicitly. It is not a recommendation to enter a position.

A nearby opposing zone no longer automatically erases BULLISH/BEARISH bias. `levels.ts` records a separate `levelRisk` object with severity, the actual zone, primary-frame ATR distance and rationale. Opposing H4/D1/W1 zones within 0.6 primary-horizon ATR cause CAUTION; a qualifying major zone causes HIGH continuation risk. Where multiple nearby opposing zones exist, a qualifying major zone takes priority, then proximity. Directionally aligned calls with any nearby opposing level retain their bias but show MIXED evidence, exact opposing levels, break/retest conditions and invalidation. HIGH continuation risk is not a probability or an execution recommendation.

Major requires H4/D1/W1, at least three observed pivot reactions, and mean rejection >=0.25 zone-frame ATR. Two or more reactions without enough major-level evidence are DEVELOPING; a single reaction is MINOR. H1 never qualifies as major. Reactions are historical confirmed-pivot observations, not independent statistical samples. These are transparent initial classification thresholds, not empirically calibrated level-strength estimates. Zone bounds, clustering and indicator calculations are unchanged.

Read-only comparison against the five saved v1.1 snapshots:

```
npx.cmd tsx scripts/check-technical-analyzer-level-risk.ts
```

This re-evaluates rules against frozen issue-time inputs without writing to the database or modifying original reports. For those snapshots, AUD/NZD 3D–5D becomes BULLISH, EUR/USD 5D and NZD/USD 1D become BEARISH, all with MIXED evidence and separate level caution. The other 20 horizons remain NO EDGE for unresolved directional evidence. This diagnostic is not a backtest or evidence of improved predictive accuracy.

EMA uses an SMA seed. ATR and directional movement use Wilder smoothing. ADX starts with the mean of the first 14 DX readings. RSI uses Wilder gain/loss averages and returns 50 for a flat series. MACD uses 12/26 EMA and a 9 EMA signal seeded after valid MACD values begin. [StockCharts identifies its RSI as Wilder RSI](https://help.stockcharts.com/scanning-and-alerts/scan-writing-resource-center/scan-syntax-reference/scan-syntax-technical-indicators); tests include the standard rounded-close worksheet example yielding 70.464135 plus hand/analytical EMA, ATR, ADX and MACD checks.

Pivots require three strictly lower/higher bars on both sides; equal-value plateaus do not qualify. A pivot only becomes available at the third right bar's close. BOS requires a completed close beyond an already confirmed swing by 0.1 prior ATR; an opposite-direction break after a prior break is CHoCH. A return through the level in the following three bars is a failed breakout, recorded only when observed and using the original prior-ATR buffer. These are explicit operational definitions, not universal structure definitions.

RSI divergence requires two confirmed like-kind swings, at least five RSI points of divergence, no more than 60 bars between pivots, and a latest pivot within 20 bars. It is disclosed as reversal risk, not proof of a reversal. Consolidation means a 12-bar high/low span below 2.5 ATR.

Zones merge the last 100 confirmed swings into clusters no wider than 0.3 current frame ATR, pad by 0.05 ATR, count pivot reactions and report mean rejection distance in ATR. A close beyond a zone by 0.1 ATR flips its role. A subsequent touch that closes beyond the zone in the new role marks a retest. Current zone bounds are a snapshot of current evidence; they are not a claim that those exact bounds were available historically. Historical forecasts must use their original stored zones. H1 levels are distinguished from H4/D1/W1 levels.

The range is reference price ± D1 ATR14 × sqrt(horizon). This is a heuristic volatility envelope, not a fitted distribution, confidence interval, predicted high/low or trading target. Scenarios specify close/retest conditions. If an observed support/resistance level is unavailable, the scenario explicitly labels its one-ATR fallback.

## Persistence and evaluation

Run `npm.cmd run db:migrate` in `api-server` to apply migrations 068–069. The original forecast/snapshot and settlement outcome have database triggers rejecting UPDATE and DELETE. Mutable retry bookkeeping is separate. Failure to persist prevents issuance. Issuance is protected by an advisory transaction lock and a unique owner/account/model/hour/completed-candle fingerprint. Repeat clicks in that bucket return the original quote and full report; they do not create additional observations.

Opening or refreshing history evaluates up to 50 matured rows against an exact completed OANDA D1 candle whose close boundary equals the recorded expiry. This does not run a new background worker. Missing candles and provider failures remain pending and retry after six hours, allowing later forecasts to advance instead of being blocked behind missing holiday candles. A pending record can therefore require a later history refresh to settle. Outcomes can be written once only. No current price, next candle or synthetic price substitutes for a missing expiry close.

Statistics use current-version observations through a compact metadata query; the most recent 100 original reports across versions remain reviewable. Strict accuracy includes completed, eligible BULLISH/BEARISH strict calls only; NO EDGE and UNAVAILABLE are excluded. Lean accuracy has its own recorded-direction sample and excludes UNCLEAR/UNAVAILABLE. Flat outcomes are misses for directional calls. Strict bull/bear rates use separate denominators. The displayed strict baseline is the issue-time D1 close versus EMA20, frozen and evaluated on the same strict-call sample; it is not a matched baseline for the larger lean sample. Pair and regime breakdowns use frozen labels. This baseline is not a profitability benchmark.

Non-overlap is selected greedily in issue-time order within pair+horizon, excluding issues before the previous selected expiry. The UI shows its sample size and accuracy alongside overlapping results. Currency pairs and different horizons remain correlated. Do not infer statistical independence or profitability from these percentages.

For chronological comparison, export frozen history rows (the API `rows` format; for more than 100 records export owner-scoped database rows), choose a future split before examining outcomes, and run:

```
npx.cmd tsx scripts/validate-technical-analyzer.ts history.json 2026-12-01T00:00:00Z
```

Optional `--reapply-rules` evaluates current decision rules on the original saved indicator/zone snapshots. This supports rule-only comparisons; indicator or zone algorithm changes require a fresh historical candle replay, which is not implemented. The utility purges forecasts crossing the split, rejects snapshots with future close timestamps, separates development and holdout, requires one frozen source version, and deduplicates IDs. No training or numerical calibration occurs. A holdout inspected repeatedly during tuning is no longer out of sample.

## Verification

```
# api-server
npx.cmd tsx scripts/test-technical-analyzer.ts
npx.cmd tsx scripts/test-technical-analyzer-db.ts
npm.cmd run typecheck
# frontend
npx.cmd tsc --noEmit
npm.cmd run build
```

The DB test creates an isolated schema inside a transaction and rolls everything back. The 50 deterministic checks cover calculations, alignment, DST/weekends, expected holiday closures versus genuine gaps, pivot delays, breaks, zone strength, separate lean/evidence/risk, preserved strict gates, strong bearish/bullish evidence at opposing levels, exhaustion/reversal cautions without an evidence veto, minor versus material timeframe disagreement, momentum opposition boundaries, unavailable data, separate outcomes, legacy preservation, independent horizons, expiry scoring, chronological purging, metrics, exports and clipboard fallbacks. The captured OANDA fixture `technical-eurusd-daily-20261030.json` yields RSI14 37.50348564, ADX14 47.43679862 and EMA20 1.12198552, matching the supplied approximate observations without hardcoded indicator outputs.

Browser verification covers all four indicator timeframes, all five forecast horizons, separate selectors, compact major zones, actual OANDA data, preserved reports, dark/light themes, mobile layout without page overflow, and successful concise/full clipboard paste round trips. A Friday after-close deterministic test confirms technical availability with scoring excluded. Physical iPhone/installed-PWA clipboard behavior and predictive performance require future observation; browser emulation is not device proof.
