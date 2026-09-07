import fs from 'node:fs';
import assert from 'node:assert/strict';
const dir='research-v2/four-family-v2-201-trades';
const {summary:s,records}=JSON.parse(fs.readFileSync(`${dir}/RESULTS.json`,'utf8'));
const names:Record<string,string>={ema:'EMA',breakout:'Breakout',momentum:'Momentum',meanrev:'Mean reversion'};
const families=Object.entries(s.families) as [string,any][];
const fixed=(n:number|null,d=2)=>n===null?'unavailable':n.toFixed(d);
const sum=(key:string)=>families.reduce((n,[,f])=>n+f[key],0);
assert.equal(records.length,201);assert.equal(new Set(records.map((r:any)=>r.sequence)).size,201);
assert.equal(s.scope.brokerRecovered,173);assert.equal(sum('normalizedN'),201);
for(const r of records){
 assert.ok(Number.isFinite(r.normalizedR));
 if(r.measurement)assert.equal(r.measurement.financing,0);
 for(const arm of ['control','candidate','controlStress','candidateStress']){
  const a=r[arm];if(a.status==='resolved'){assert.ok(Number.isFinite(a.r));assert.ok(a.exitTime>(arm.startsWith('control')?r.original.time:r.plan.time));}
  else if(a.status==='wait')assert.equal(a.r,0);else assert.equal(a.r,null);
 }
 if(r.plan)assert.ok(r.plan.time>=Date.parse(r.time)+900000,'V2 must wait for completed confirmation');
}
const v=s.overall.candidate,c=s.overall.control,m=s.overall.matched;
assert.equal(v.resolved+v.wait+v.missing,201);
const familyRows=families.map(([f,x])=>`| ${names[f]} | ${x.normalizedN} | ${fixed(x.storedTotal)} | ${fixed(x.normalizedTotal)} | ${x.candidate.resolved} | ${x.candidate.wait} | ${x.candidate.missing} | ${fixed(x.candidate.totalR)} | ${fixed(x.candidate.perExecutedR,3)} |`).join('\n');
const replayRows=families.map(([f,x])=>`| ${names[f]} | ${x.control.resolved} | ${x.control.missing} | ${fixed(x.control.totalR)} | ${x.matched.n} | ${fixed(x.matched.controlR)} | ${fixed(x.matched.candidateR)} |`).join('\n');
const chronological=Object.entries(s.chronology).map(([period,x]:[string,any])=>`| ${period} | ${x.candidate.opportunities} | ${x.candidate.resolved} | ${x.candidate.wait} | ${x.candidate.missing} | ${fixed(x.candidate.totalR)} | ${fixed(x.candidate.perExecutedR,3)} |`).join('\n');
const policies=Object.entries(s.momentumPolicies).map(([policy,x]:[string,any])=>`| ${policy} | ${x.resolved} | ${x.wait} | ${x.missing} | ${fixed(x.totalR)} | ${fixed(x.perExecutedR,3)} |`).join('\n');
const reasons=families.map(([f,x])=>`- ${names[f]}: ${Object.entries(x.candidate.reasons).map(([reason,n])=>`${n} ${reason}`).join('; ')}.`).join('\n');
const report=`# Four-family changes and frozen-trade retest

**Decision: keep the measurement and evidence-integrity fixes; reject activation of these V2 entry candidates.** The V2 variants resolved ${v.resolved} entries at ${fixed(v.totalR)}R, or ${fixed(v.perExecutedR,3)}R per entry. They skipped ${v.wait} opportunities and left ${v.missing} unresolved. Lower total losses from entering fewer trades do not establish a profitable edge. EMA, breakout, and mean reversion barely trade under these rules.

## Scope and outcome measurement

Same 201 recorded family trades, August 19 through September 4, 2026, across 13 trading days. Excludes 29 legacy trades. All of these outcomes were already inspected: **this is development evidence, not out-of-sample validation**. This event-anchored retest does not find new opportunities the modified strategies might have generated outside the recorded sample.

Recovered all 173 submitted broker trades, including 65 rows previously represented by model closes. The remaining 28 have no broker trade ID and retain model price-risk R. Confirmed executable fill price divided by actual initial price risk removes the order-cap distortion in nominal-budget R. The original journal remains intact. Original stored total was ${fixed(sum('storedTotal'))}R; the comparable price-risk total is ${fixed(sum('normalizedTotal'))}R. The broker-only 173 total is ${fixed(sum('brokerTotal'))}R. These are normalized strategy outcomes, not percentages of account equity.

| Family | Original N | Stored R | Corrected price R | V2 resolved | V2 WAIT | V2 missing | V2 total R | V2 R/entry |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${familyRows}

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
${replayRows}

Overall control: ${c.resolved} resolved, ${c.missing} missing, ${fixed(c.totalR)}R, ${fixed(c.perExecutedR,3)}R per entry. The matched subset has ${m.n} opportunities: control ${fixed(m.controlR)}R versus V2 ${fixed(m.candidateR)}R. WAIT contributes zero on the matched opportunity denominator. Missing rows are excluded from the paired comparison, so it cannot stand in for all 201.

V2 has ${201-v.missing} known outcomes including WAIT, at ${fixed(v.perKnownOpportunityR,3)}R per known opportunity. Its win rate is ${fixed(v.winRate*100,1)}%, profit factor ${fixed(v.profitFactor,3)}, and realized-close drawdown ${fixed(v.maxDrawdownR)}R. Drawdown is based on a sum of normalized unit-risk outcomes, not account equity. At 0.5-pip stress: ${fixed(s.overall.candidateStress.totalR)}R, ${fixed(s.overall.candidateStress.perExecutedR,3)}R per resolved entry.

For one position per instrument, the control has ${s.overall.controlPortfolio.resolved} resolved, ${s.overall.controlPortfolio.wait} blocked, ${s.overall.controlPortfolio.missing} missing, ${fixed(s.overall.controlPortfolio.totalR)}R. V2 has ${s.overall.candidatePortfolio.resolved} resolved, ${s.overall.candidatePortfolio.wait} WAIT/blocked, ${s.overall.candidatePortfolio.missing} missing, ${fixed(s.overall.candidatePortfolio.totalR)}R. Missing exits block later instrument entries to session close. This replay models overlap, not broker margin, order caps, or a reconstructed equity curve.

## Chronology and momentum policies

These chronological slices are descriptive, not holdouts.

| Period | Opportunities | V2 resolved | WAIT | Missing | Total R | R/entry |
|---|---:|---:|---:|---:|---:|---:|
${chronological}

Momentum selects the earliest qualifying continuation or failed-break event, never the arm with the better realized outcome. Counts below describe those selected policies and therefore are not two independent replays of every momentum opportunity.

| Selected momentum policy | Resolved | WAIT | Missing | Total R | R/entry |
|---|---:|---:|---:|---:|---:|---:|
${policies}

Reasons and exits by family:

${reasons}

Requiring both a later directional EMA confirmation and unchanged absolute stop/target with no worse reward/risk is too restrictive: it usually demands a better entry price after waiting for directional progress. The prescribed variant fails the practical-frequency objective. Breakout and mean reversion also produce too few entries for a useful conclusion about their general mechanisms. Momentum produces a larger sample but remains materially negative. This run rejects the exact variants; it does not prove every possible confirmation strategy fails.

## Verification and artifacts

Pure regression checks passed for size-independent normalization, invalid/missing broker facts, policy/config/time isolation, delayed confirmation, missing candles, entry-minute ordering, adverse gaps, and conservative stops. PostgreSQL temporary-table tests exercised the actual immutable-snapshot upsert clauses and rolled back. The new evidence loader successfully read the current database in read-only mode: 497 eligible observations before historical broker measurements are populated. No production rows were changed and no orders were submitted.

Existing adaptive-engine, four-family execution/inversion, and paper-cycle fixture checks passed. Global API typecheck has an unrelated pre-existing error in scripts/eurusd-h1-ema-pullback-poc-ab-v1/selftest.ts:50 (24 supplied to a parameter inferred as literal 48); the files changed for this task have no remaining reported type errors.

Reproduce from api-server:

\`\`\`powershell
npx.cmd tsx scripts/four-family-v2/selftest.ts
npx.cmd tsx scripts/four-family-v2/db-selftest.ts
npx.cmd tsx scripts/four-family-v2/retest.ts
npx.cmd tsx scripts/four-family-v2/report.ts
\`\`\`

RESULTS.json contains all 201 records and measurements; SUMMARY.json contains aggregate statistics and input/code hashes. cohort.json preserves the frozen source ledger and execution mappings; cache contains read-only broker facts and original OANDA candles. DB_CHECKS.json records database verification. No V2 entry variant was activated. Code is local and uncommitted, with no deployment or production migration in this task.

**Recommendation: retain the integrity fixes and keep these V2 entries out of active execution. Any further entry revision needs a simpler explicit rule and fresh practice validation, not another claim of improvement from the same 201 trades.**
`;
fs.writeFileSync(`${dir}/REPORT.md`,report);
console.log(JSON.stringify({storedR:sum('storedTotal'),normalizedR:sum('normalizedTotal'),brokerR:sum('brokerTotal'),control:c,candidate:v,matched:m,chronology:s.chronology,artifact:`${dir}/REPORT.md`},null,2));
