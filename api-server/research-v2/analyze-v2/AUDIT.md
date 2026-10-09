# Analyze Engine V2 — Phase 1 audit (2026-10-08)

Read-only audit of the live Analyze feature against the V2 spec (engine +
liquidity add-on). No code was changed. Decision taken with the owner: where
the spec conflicts with earlier choices, **the spec wins** (configurable
minimum 1:1.5 instead of fixed 1:2, Normal aims for ~15 pips where structure
allows, targets from structure instead of 2× stop).

## 1. What Analyze is today

| Piece | File | Role |
|---|---|---|
| Fetch + run | `frontend/src/lib/strategy/run-market-analysis.ts` | Client-side GETs (M5/M15/H1/H4/D1 candles, pricing, calendar), runs Normal + Swing. Shared by Chart and Markets. |
| Engine | `frontend/src/lib/strategy/market-analysis.ts` (`analyzeMarket`) | Regime → zone → entry → stop/target → decision. Pure function. |
| Structure | `frontend/src/lib/strategy/market-regime.ts` (`classifyMarketRegime`) | Confirmed pivots (reach 3), ATR-filtered swings, HH/HL · LH/LL · range · transition, zones. |
| Timeframes | `frontend/src/lib/strategy/timeframe-roles.ts` | NORMAL H4 ctx · **H1 primary** · M15 setup · M5 exec; SWING D1 · H4 · H1 · M15. `LEGACY_NORMAL` = M15 primary · H1 context. |
| News | `newsCheck` in `trend-pullback-v1.ts` | High-impact events for both currencies; *delays* the order (`activateAfter`) rather than blocking. |
| UI | `components/analysis/analyze-card.tsx`, `pending-entry-dialog.tsx` (plan view) | Card (desktop) / sheet (phone); Review entry → entry form. Never places orders. |
| Server | `api-server/src/pending-manual-entries.ts` | Sets order lifetime by setup tag (Normal 4h, Swing 48h), cancels at target. |

There is **no AI in the live Analyze**. The old GPT route
(`api-server/src/manual-analysis.ts`, `/api/manual-analysis`) is separate and
no longer reachable from Markets (only from old `?proposal=manual-analysis` links).

## 2. What is already right (retain)

- **One authoritative classifier.** Analyze uses only `market-regime.ts` swing
  structure; EMA/regression (`regime.ts`) feed Market selection (pair strength),
  not Analyze. No indicator voting. ✔ spec §5.
- **Causal pivots.** `confirmedPivots` never confirms the last `reach` candles;
  forming candles are dropped (`complete !== false`). Replays slice candles. ✔ §17.
- **Close-based breaks.** Breaks need two closes past `0.15 ATR` or one past
  `0.75 ATR`; wicks don't break structure. ✔ §5/§8 spirit.
- **Volatility-scaled thresholds** (min leg 1 ATR, tolerances in ATR). ✔
- **Context never overrides primary**; conflict is reported. ✔ §5.
- **NO TRADE exists** for transition, mid-range and weak ranges, with execution
  null. ✔ §13 partially.
- **Both currencies' news** are checked (not USD-only). ✔ §9 partially.
- **Market selection is separate**: NY tradability lives only in the pair
  pickers and Markets, not in Analyze. ✔ §3.
- **Never auto-executes**; Review entry only fills the form. ✔ §21.17.
- **Pure, deterministic function** — same snapshot + config → same result. ✔

## 3. Defects against the spec (must change)

Ordered by how much they can mislead a decision.

1. **Every trend produces a trade.** In UPTREND/DOWNTREND `analyzeMarket`
   always calls `finishTrade`. The setup state (PULLBACK / CONTINUATION /
   UNCLEAR) is reported but never gates anything; there is no entry trigger.
   A trend that is still running away gets a limit order anyway. Violates
   "never force a trade" (§1, §7).
2. **Failed news check reads as "no news".** If the calendar request fails or
   isn't connected, `newsEvents` is undefined and the result says
   *"No high-impact news found"*. Violates §9 / rule 14 (needs `NEWS_UNKNOWN`).
3. **Stale quote silently falls back to a candle close.** `run-market-analysis`
   drops a quote older than 2 min, then `analyzeMarket` uses the last
   *completed primary* close (an H1 close in Normal — up to an hour old) as
   "current price", and still returns LONG/SHORT. Violates §10/§17.
4. **Mid prices everywhere.** Entry, stop, target and R are computed on mid.
   Spread only enters the stop buffer when a structure stop is used; the
   default stop has none. No ask/bid entry, no bid/ask exits, no effective R.
   Violates §10.
5. **Target is always 2× the stop.** No check for room to the next
   resistance/support; no structural target; no minimum-R-after-costs gate.
   Violates §12 (and the owner now wants configurable 1:1.5 minimum).
6. **Stop is sized from daily range first, structure second.** The stop is
   `0.34 × avg daily range` (Normal) / `1 ×` (Swing), then snapped to a level
   only if one lies within 0.6–1.4× of that distance. That is a volatility
   stop, not a thesis stop. Violates §11.
7. **Entry is pulled toward price by a fill-rate cap** (70% fill), so the
   entry often sits *above* the support it is named after. Defensible for
   fills, but it means the "pullback into structure" claim can be false; must
   be reported or replaced by a confirmed-trigger entry. §7.
8. **News delays, never blocks.** High-impact news inside the window holds the
   order until 15 min after release; there is no "block new entries 30 min
   before / 15 min after" gate, and no medium-impact caution tier. §9.
9. **Range trades are offered** (HIGH-confidence ranges, buy support / sell
   resistance). Spec §6: don't assume a profitable reversal exists. The
   owner's replay already found medium-confidence range trades lost.
10. **No liquidity assessment** in Analyze at all (add-on spec): no PDH/PDL,
    Asia/London highs-lows, equal highs/lows, sweep/reclaim status, or
    stop-exposure check.
11. **Zones are thin.** Zones are pivot clusters whose *touch count is used as
    strength* (spec says don't); no SUPPORT/RESISTANCE/MIXED type, source
    timeframe, created-at, broken/active status, or merge rule beyond a
    fixed tolerance.
12. **No UNCLEAR state**: insufficient data is reported as TRANSITION.
13. **No volatility/abnormal-market checks**: no TR vs ATR, gap, spread
    widening, or stale-candle detection.
14. **Confidence label**: `regimeConfidence` (HIGH/MEDIUM/LOW from swing count
    and impulse size) is shown in the UI as "x confidence". It isn't a
    probability, but it reads like one. Replace with checklist statuses (§16).
15. **Display bug**: `market-regime.ts` interpolates prices with `toFixed(5)`
    — wrong digits for JPY pairs in the reason text.
16. **Normal timeframes differ from the spec.** Spec: M15 primary · H1 higher
    · M5 refinement. Live: H1 primary · H4 context · M15 setup. The spec's
    layout already exists as `LEGACY_NORMAL_ROLES`
    (`api-server/scripts/compare-normal-hierarchy.ts` compares them).
17. **No tests for `analyzeMarket`.** `api-server/scripts/test-analyze-pipeline.ts`
    tests a *different* pipeline (see §4). No integration fixtures for the 12
    scenarios in spec §19.
18. **No diagnostics record** beyond `marketAnalysisContext` saved *only when
    an order is placed*; analyses that end in NO TRADE leave no trace (§18).

## 4. Duplicate / obsolete logic

| Module | Used by | Recommendation |
|---|---|---|
| `api-server/src/manual-analysis.ts` (GPT, forced direction, confidence 1–100, fixed 2R) | `/api/manual-analysis`; UI reachable only via old links (`ManualProposalModal` on chart) | **Remove** route + modal path. Forbidden by §14/§16; replay showed no edge (28.9% vs 29.2% opposite). |
| Stage 1–7 pipeline: `market-condition.ts`, `sr-structure.ts`, `price-reaction.ts`, `trade-proposal.ts`, `timeframe-profiles.ts` | `trade-monitor.ts` (Trade health card), `test-analyze-pipeline.ts`, research scripts | **Keep for Trade health for now**; don't feed it into Analyze. Second competing analyzer — a candidate to fold into V2's S/R later. |
| `pullback-watch.ts` | nothing | **Remove** (dead). |
| `trend-pullback-v1.ts` | only `newsCheck` (Analyze), its test, dead `pullback-watch` | **Move** `newsCheck` into the V2 news module; retire the rest. |
| `regime.ts` (regression slope/R²), EMA bias | pair strength / strategies (market selection) | **Keep** out of Analyze (diagnostic only, if ever). |
| `liquidity-levels.ts`, `liquidity-confirmation.ts` | `liquidity-strategy` (paper strategy), `test-liquidity.ts` | **Reuse** `mapLiquidityLevels` (Asia range, daily/weekly extremes) and `findSweep` as the base of the V2 liquidity module; verify DST handling first. |
| `amd*.ts`, `session-sr`, `frozen-4h-sr`, `last-day-sr`, `fvg` | chart overlays | **Keep**; overlays, not Analyze. |
| `close-outlook.ts` | its test only | Out of scope; flag. |

## 5. Proposed V2 shape (for approval before Phase 2)

Keep it in the existing files' style: pure functions in `lib/strategy/`, one
orchestrator, no new services, DB or AI framework.

```
run-market-analysis.ts      fetch + data-quality (fresh quote, closed candles, NEWS_UNKNOWN)
market-regime.ts            + UNCLEAR, pivot confirmedAt, JPY-safe text      (modify)
analyze-v2/zones.ts         typed S/R zones: type, tf, createdAt, lastTouch, broken/active, ATR merge
analyze-v2/pullback.ts      state machine: NONE → DEVELOPING → AT_ZONE → TRIGGERED | INVALIDATED | EXPIRED
analyze-v2/liquidity.ts     PDH/PDL, Asia/London H-L, EQH/EQL, swings; UNTESTED/SWEEP_CANDIDATE/
                            SWEPT_AND_RECLAIMED/BREAKOUT_ACCEPTED/INCONCLUSIVE; CLEAR/CAUTION/BLOCK/UNKNOWN
analyze-v2/risk.ts          news buffers (30m before / 15m after high; medium = caution), TR/ATR, gaps, spread
analyze-v2/plan.ts          structural stop + buffer, structural target, ask/bid entry/exits, effective R
analyze-v2/decide.ts        12 checks → PASS/CAUTION/FAIL/UNKNOWN → LONG / SHORT / NO_TRADE (+ watch zone)
analyze-v2/config.ts        per-mode parameters (documented), minR 1.5, Normal ~15-pip preference
market-analysis.ts          thin adapter producing today's MarketAnalysis for the UI, then retired
```

AI layer (Phase 5): optional explanation only, fed the structured result,
schema-validated, can't change numbers or decisions; deterministic result is
shown if it fails.

Tests (Phase 7): unit tests per module + the 12 integration fixtures from §19,
run as `node --test` scripts in the existing `scripts/test-*.ts` style; a
replay of V2 vs today on the same candles with spread, by mode and direction,
train / validation / untouched-test split.

## 6. Things the owner should know before Phase 2

- **Expect fewer trades, not better ones.** Every structure/pullback variant
  replayed so far (trend-pullback swing, V2 EUR/USD, S/R fades, fresh zones,
  fib, volume profile, sweeps) came out NO_EDGE after spread. V2 makes
  Analyze consistent, honest and testable; it is not expected to create an
  edge, and the backtest must be allowed to say so.
- **The 15-pip Normal target is spread-sensitive.** At 1:1.5 a 15-pip target
  means a ~10-pip stop; a 1.5-pip spread is ~15% of risk — about the size of
  the loss in earlier small-stop tests (V5, fresh zones). The min-R-after-
  costs gate will turn many Normal setups into NO_TRADE; that is intended.
- **Switching Normal to M15 primary** changes which trades Analyze proposes.
  The old H1-primary layout stays available for replay comparison.
- **Orders already saved** carry `market-regime-*-v1` tags and lifetimes; V2
  orders should get new tags (`analyze-v2-normal`, `analyze-v2-swing`) so
  forward-test results stay separable.

## 7. Phase 2 status (2026-10-08) — deterministic foundation

Built in `frontend/src/lib/strategy/analyze-v2/` (not yet wired into the UI;
Phase 3 adds the plan and the LONG / SHORT / NO_TRADE decision on top):

- `config.ts` — per-mode parameters. NORMAL M15 / H1 / M5, SWING H4 / D1 / H1;
  min R 1.5, Normal 15-pip target preference.
- `instrument-math.ts` — pips, rounding, ask/bid entry and exit sides,
  effective R from executable prices, level ordering.
- `data-quality.ts` — sort / de-duplicate / split the forming candle, gaps
  that ignore the weekend (DST-aware), stale candles, quote checks (missing =
  UNKNOWN; stale or crossed = FAIL and never used as a price).
- `structure.ts` — the one trend read (UPTREND / DOWNTREND / RANGE /
  TRANSITION / UNCLEAR) with evidence, structure level and swing confirmation
  times; alignment ALIGNED / OPPOSED / HIGHER_NOT_TRENDING / … .
- `zones.ts` — typed zones from meaningful swings on primary + higher TF:
  SUPPORT / RESISTANCE / MIXED, ACTIVE / BROKEN (+flipped), relevance,
  created / last-reaction times; reaction count reported, not scored.
- `pullback.ts` — NOT_APPLICABLE / NO_PULLBACK / DEVELOPING / AT_ZONE /
  TRIGGERED / EXPIRED / INVALIDATED with a single closed-candle trigger rule.
- `foundation.ts` — `readMarketFoundation`, pure and deterministic.

`market-regime.ts` changes (backward compatible): swings carry
`confirmedAt`; reads carry `sufficient` and `transitionKind`; prices print at
the pair's precision (fixes the JPY text bug in live Analyze too).

Tests: `npm run analyze-v2:test` (25 synthetic tests: causality, structure,
alignment, zones, pullback states both directions, data checks, DST, quotes,
determinism). Live smoke: `api-server/scripts/smoke-analyze-v2.ts`.
Pre-existing failure, unrelated: `trend-pullback-v1:test` ("MIXED" vs
"BULLISH"; that module has no local changes).

## 8. Phase 3 status (2026-10-08) — qualification engine, now live

- `risk.ts` — news for both currencies: high impact blocks from 30 min before
  to 15 min after; medium is a caution; later releases in the holding window
  are exposure (caution). Calendar unreadable = NEWS_UNKNOWN; with
  `RISK_POLICY.news.blockWhenUnknown = true` (default) that blocks entries.
  Volatility: last candle > 2.5 ATR caution, > 4 ATR block; gaps > 1 ATR caution.
- `plan.ts` — entry at the executable side (ask/bid) once the trigger has
  closed; stop past the pullback extreme + 0.1 ATR + spread (> 3 ATR fails);
  target = 15 pips Normal when it fits before the first structural obstacle
  and meets 1.5R, else the minimum R, never past the obstacle; Swing targets
  the obstacle. Normal targets over 30 pips fail. R from executable prices.
- `decide.ts` — 12 checks (data, timeframe spacing, structure, higher TF,
  pullback, trigger, stop, target, R, spread share, news & volatility, price
  rules) → LONG / SHORT only when none is FAIL or UNKNOWN; NO_TRADE has
  `execution: null`, a headline naming the first blocker, and a watch zone
  only when the pullback, trigger or a news wait is all that is missing.
- `adapter.ts` / `context.ts` — V2 shown through the existing Analyze card;
  orders saved with setup `analyze-v2-normal` (2h lifetime) /
  `analyze-v2-swing` (16h), envelope version 1 under 8,000 chars.
- `run-market-analysis.ts` now runs V2 for Chart and Markets. The old engine
  (`market-analysis.ts::analyzeMarket`) is kept for replay comparison only.

Tests: 42 (`npm run analyze-v2:test`), incl. the §19 scenarios except the two
liquidity ones (Phase 4). Live 2026-10-08 ~19:50 ET, 10 pairs × 2 modes: all
NO_TRADE — M15 mostly UNCLEAR (contracting swings), H4 ranges, H4/D1
conflicts, one AT_ZONE waiting for its trigger; ForexFactory returned 429 so
news was UNKNOWN throughout.

Not yet: liquidity (Phase 4), AI explanation (Phase 5), checklist UI
(Phase 6), historical replay of V2 (Phase 7), logging of NO_TRADE analyses.

## 9. Phase 4 status (2026-10-08) — liquidity and news

News was integrated in Phase 3 (`risk.ts`). Phase 4 adds `liquidity.ts`:

- **Levels** (price, kind, sources, timeframe, formedAt, status, crossedAt,
  resolvedAt): previous trading day high/low (17:00 NY roll), Asia and London
  session high/low (same windows as the chart overlay: Asia 00:00 UTC → London
  08:00, London → NY 08:00; DST per city; completed windows only; NORMAL),
  prior day / prior 5-day high/low from D1 (SWING), equal highs/lows (two
  confirmed pivots within max(0.1 ATR, spread), ≥5 bars apart, nothing clearly
  beyond in between), last 4 meaningful swings, range boundaries. Same-kind
  levels within 0.1 ATR merge (earliest formation wins).
- **Status** from closed candles after formation, cross buffer =
  max(0.05 ATR, spread): UNTESTED, SWEEP_CANDIDATE (crossed, no closed verdict
  — a lone wick-and-close-back is still only a candidate), SWEPT_AND_RECLAIMED
  (closed back inside and the next closed candle didn't re-break),
  BREAKOUT_ACCEPTED (two closes beyond or one ≥0.5 ATR, still holding),
  INCONCLUSIVE (accepted then failed, or reclaimed then re-broken).
- **Assessment** (CLEAR / CAUTION / BLOCK / UNKNOWN) for a qualified plan:
  BLOCK only for a named rule — price holding beyond an accepted breakout
  against the trade. CAUTION: stop within 0.3 ATR beyond a resting level, a
  resting level within 1 ATR behind the stop, or a resting opposite level
  before the target. A sweep-and-reclaim in the trade's favour during the
  pullback is reported as confirmation (wording: price-action context, not
  proof of stops, not a measured edge); it does not change the status.
  Unswept levels alone never block. Missing levels → CAUTION in the decision
  (UNKNOWN never blocks here, since liquidity is supporting context).
- **Decision**: 13th check `liquidity` (evaluated only for a qualified plan;
  the level map and nearest-above/below with pip distances are always in
  `result.liquidity`). Saved order context gains `liquidity: { risk,
  stopExposed, confirmed }`.

Tests: 52 (`npm run analyze-v2:test`), adding DST session windows (summer,
winter and the US-before-UK week), wick vs confirmed reclaim, accepted vs
failed breakout, session/previous-day levels from completed windows only,
BLOCK/CAUTION/CLEAR rules, short mirror, and the decision wiring.

Not modelled (data limits): spread widening history and abnormal bid/ask
movement (candles are mid only; only the live spread is known); commission;
slippage. The with/without-liquidity comparison the add-on asks for belongs
to the Phase 7 replay.

## 10. Phase 5 status (2026-10-08) — AI explanation

- `frontend/src/lib/strategy/analyze-v2/explain.ts` (shared, pure): the facts
  handed to the model (`explanationFacts`: decision, headline, structure,
  setup, plan numbers as display strings, evaluated checks, news, volatility,
  liquidity, invalidation, watch), the strict JSON schema (decision echo +
  summary / direction / location / support / risks / levels, length-capped),
  the rules sent with every request, and `validateExplanation`.
- Guards (applied on the server and again in the app): the answer must echo
  the engine's decision; every number in it must appear in the facts (digits
  after a letter — M15, H1 — are names, not numbers); no win-probability or
  odds language; schema and lengths enforced. Any failure → no explanation,
  the deterministic analysis stands alone ("Explanation unavailable; the
  analysis above is complete.").
- `api-server/src/analyze-explain.ts` + `POST /api/analyze/explain` (owner
  auth like every /api route): existing OpenAI setup (OPENAI_API_KEY,
  OPENAI_ANALYSIS_MODEL — currently gpt-5.6-terra), Responses API with
  strict json_schema, 20 s timeout. The facts payload is shape-checked and
  capped at 16 KB; a NO_TRADE cannot carry a plan.
- App: `explain-client.ts` (one request per result, cached) and an
  "Explanation" block in the Analyze card/sheet under the checks, with a
  "More detail" disclosure and the note "Written by AI from the checks above;
  it cannot change them." One call per mode viewed (~5 s).

The old forced-direction GPT route (`/api/manual-analysis`) is untouched and
still slated for removal (audit §4).

Tests: frontend 56 (adds facts, faithful answer, wrong decision, invented
number, probability talk, missing/oversized fields, server-side facts
parsing); api-server `npm run analyze-explain:test` 5 with a stubbed model
(faithful answer returned, changed decision rejected, invented price
rejected, outage → error, missing key → error). Live: two real calls
(synthetic LONG, live USD/CAD swing NO_TRADE) both passed the guards; the
in-app call on USD/CAD normal rendered in the card.

## 11. Phase 6 status (2026-10-08) — Analyze screen

`components/analysis/analyze-v2-panel.tsx` renders a V2 result inside the
existing Analyze card (desktop chart side column, Markets desktop dialog) and
sheet (phone), keeping the canvas top bar, Normal/Swing switch and actions:

- **A Decision** — Long (lime) / Short (orange) / No trade, 1:R from the
  executable plan, and one line: "Bullish setup qualified. …" or "No
  actionable setup. N checks are blocking a trade." No confidence labels.
- **C Trade plan** (LONG/SHORT only) — buy-at-ask / sell-at-bid entry, stop,
  target; stop and target pips, R after spread, spread and its share of risk,
  order lifetime; invalidation, stop basis, target basis, cautions.
- **F No trade** — "Why not": every evaluated FAIL/UNKNOWN check with its
  reason; "Watch · …" only when the engine gives a watch condition, otherwise
  "Nothing to watch yet". Never a hypothetical entry.
- **Checks** — all 13 with ✓ / ! / ✕ / ? chips and reasons; checks not
  reached are dimmed "Not reached: …". Summary chip counts in the header.
- **B Market structure** — primary and higher trend, alignment, last swing
  high/low, the level that holds the trend, nearest support below and
  resistance above (relevance, role reversal), pullback state/zone/depth,
  evidence.
- **D Market risk** — news state (Unknown is labelled as such), volatility,
  live spread or "Unknown: no live quote", last candle time (ET), quote age at
  analysis, upcoming events (blocking ones in red), any non-passing data check.
- **Liquidity** — nearest level above/below with status and pips, stop
  exposure, sweep confirmation, findings, and the price-action disclaimer.
- **E Explanation** — the Phase 5 AI block, last.

Sections B/D/liquidity and the checklist are collapsible (closed by default)
so the 340 px desktop card stays readable. Development preview of every
state from synthetic candles: `/dev/analyze-preview` (404 in production;
explanations canned, no AI call).

Verified: preview (LONG, SHORT with explanation loading, NO TRADE waiting /
HTF conflict + news / calendar unknown) at desktop width; live Markets sheet
at 375 px (scrolls inside the sheet, explanation loads after the numbers).

## 12. Phase 7 — validation (2026-10-09)

**Checks:** frontend `analyze-v2:test` 56 ✓ · api `analyze:test` 42 ✓ ·
api `analyze-explain:test` 5 ✓ · pending-entry checks ✓ (run without a
database) · `tsc` frontend + api ✓ · lint on all changed files ✓ ·
`next build` ✓ (run directly; `npm run build` also regenerates the icons).
Pre-existing, unrelated: `trend-pullback-v1:test` fails ("MIXED" vs
"BULLISH"); other files' pre-existing lint errors.

**Historical replay** (`scripts/replay-analyze-v2.ts`, results in
`replay-2026-10-09-365d.{txt,json}`): 365 days to 2026-10-09, EUR/USD,
GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD; OANDA bid/ask candles;
V2 fills at the next M15 open on ask/bid, exits on bid/ask, stop-first;
**no news filter** (no historical calendar), no commission or slippage, no
time stop. Nothing was fitted; splits reported for honesty only.

| | trades | win rate | avg R (95% ±) | PF | max DD | stop-outs | spread/R |
|---|---|---|---|---|---|---|---|
| NORMAL V2 | 474 | 27.4% | **−0.274 ± 0.107** | 0.62 | 140.9R | 73% | 18% |
| NORMAL V2, no liquidity check | 479 | 27.6% | −0.271 ± 0.106 | 0.63 | 142.3R | 72% | 18% |
| NORMAL old engine | 1501 | 30.9% | −0.088 ± 0.069 | 0.87 | 190.5R | 69% | 8% |
| SWING V2 | 61 | 18.0% | **−0.499 ± 0.272** | 0.39 | 31.6R | 82% | 9% |
| SWING old engine | 224 | 34.8% | +0.001 ± 0.182 | 1.00 | 32.4R | 65% | 3% |

- NORMAL V2 by split: development −0.291R (253), validation −0.573R (107),
  untouched test +0.045 ± 0.240R (114). Long −0.376R, short −0.194R. Every
  pair negative (−0.09 to −0.47R).
- Break-even win rate at V2's average win (1.65R) is 37.8%; actual 27.4%.
  Approximate gross (adding back the entry spread) is still −0.10R: the
  setup loses before costs, and the spread (18% of an ~8-pip risk) roughly
  triples the loss. Losers rarely went far in favour first (avg +0.41R,
  14% reached +1R), so the tight stop under the pullback low is taken by
  ordinary noise.
- Funnel (NORMAL): 169,102 evaluations → 43% trending → 15,336 confirmed
  triggers → 474 qualified. Of rejected triggers, 13,359 failed the target
  check (not enough room to the impulse high at 1.5R), 3,188 spread, 2,906
  higher timeframe.
- Liquidity: blocking it changed 5 trades; no measurable effect.
  Sweep-confirmed trades: 18 (Normal) and 6 (Swing) — too few to say
  anything. CAUTION vs CLEAR trades: −0.255R vs −0.301R (no difference).

**Verdict: NO_EDGE (negative).** V2 makes Analyze consistent, explainable
and reproducible, but its trend-pullback entries lost money in this replay,
more than the old engine in both modes. The spec's success criterion is
reproducibility and honesty, which V2 meets; it is not evidence of a
profitable strategy. Any change (e.g. stop placement) must be judged on new
forward data, since the whole year has now been seen.

## 13. v2.1 — stop behind the structure level (2026-10-09, frozen for forward test)

Chosen after seeing §12 (owner's option 3), set before any new numbers:
`plan.stopAnchor = "STRUCTURE_LEVEL"` (latest higher low / lower high, or the
pullback extreme if deeper), `maxStopAtr` 3 → 6; nothing else changed.
`ANALYZE_V2_STRATEGY = "analyze-v2.1"` (saved with every order). Also fixed:
a target set exactly at the minimum R could round to 1.49R and fail its own
check; it is now nudged out a tick (never past the obstacle) — this alone
adds ~27 Normal trades a year in the replay.

In-sample comparison on the same 365 days (`replay-2026-10-09-365d-v2.1.txt`;
not evidence for v2.1, since this year shaped the choice):

| | trades | win rate (b/e) | avg R | gross R | stop-outs |
|---|---|---|---|---|---|
| NORMAL v2.1 | 446 | 28.5% (38%) | −0.252 ± 0.111 | −0.085 | 72% |
| NORMAL v2.0 | 501 | 27.7% (38%) | −0.271 ± 0.104 | −0.099 | 72% |
| NORMAL old | 1501 | 30.9% (34%) | −0.088 ± 0.069 | −0.010 | 69% |
| SWING v2.1 | 52 | 17.3% (35%) | −0.507 ± 0.297 | −0.416 | 83% |
| SWING v2.0 | 61 | 18.0% (36%) | −0.499 ± 0.272 | −0.412 | 82% |
| SWING old | 224 | 34.8% (35%) | +0.001 ± 0.182 | +0.026 | 65% |

v2.1 ≈ v2.0. Why: by the time the trigger closes, the pullback low has
usually confirmed as the latest swing low, so it *is* the structure level;
and setups where the structure level is further away mostly fail the 6 ATR
stop limit or the 1.5R room / 30-pip Normal cap. The stop change does not
address what loses: entries at a confirmed turn with ~1.5R to the impulse
extreme win 28% against a 38% break-even.

**Forward test:** score only post-freeze data, as it accumulates:
`npx tsx scripts/replay-analyze-v2.ts --since=2026-10-09` (≈ 35 Normal
trades a month across the 7 majors; ~100 needed before reading anything).
Live orders from Analyze carry `frozen.strategy = "analyze-v2.1"`.
