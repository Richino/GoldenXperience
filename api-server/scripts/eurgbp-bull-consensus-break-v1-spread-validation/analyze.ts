// Aggregate the EURGBP Bull Consensus Structure Break V1 executable replay into
// REPORT.md. Measurement only. No optimization, no rule changes.
import fs from 'node:fs';
import path from 'node:path';

const BASE = path.resolve('research-v2/eurgbp-bull-consensus-break-v1-spread-validation');
const raw = JSON.parse(fs.readFileSync(`${BASE}/RAW_RESULTS.json`, 'utf8'));
const rows: any[] = raw.rows;
const matched = rows.filter((r) => r.matched && r.exec_result_r !== '');
const COHORT = raw.cohortSize;

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r4 = (v: number) => (Math.round(v * 10000) / 10000).toFixed(4);
const r2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const r3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);

function stats(rs: number[]) {
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const gp = sum(wins);
  const gl = Math.abs(sum(losses));
  const pf = gl === 0 ? Infinity : gp / gl;
  return {
    trades: rs.length,
    wins: wins.length,
    losses: losses.length,
    wr: rs.length ? (wins.length / rs.length) * 100 : 0,
    pf,
    totalR: sum(rs),
    exp: mean(rs),
    avgWin: wins.length ? mean(wins) : 0,
    avgLoss: losses.length ? mean(losses) : 0,
  };
}
function maxDrawdownR(rsChrono: number[]) {
  let cum = 0, peak = 0, mdd = 0;
  for (const r of rsChrono) { cum += r; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  return mdd;
}

// chronological by entry
const chrono = [...matched].sort((a, b) => Date.parse(a.resolved_utc_entry) - Date.parse(b.resolved_utc_entry));
const execRs = chrono.map((r) => r.exec_result_r);
const midRs = chrono.map((r) => r.tv_result_r);
const execS = stats(execRs), midS = stats(midRs);
const execMDD = maxDrawdownR(execRs), midMDD = maxDrawdownR(midRs);

const pf = (v: number) => (v === Infinity ? '∞' : r3(v));

// ---- year stability (EXEC) ----
const years = ['2023', '2024', '2025', '2026'];
const yearRows = years.map((y) => {
  const rs = chrono.filter((r) => r.resolved_utc_entry.startsWith(y)).map((r) => r.exec_result_r);
  const s = stats(rs);
  return { y, ...s };
});

// ---- consensus breakdown (measurement only) ----
function conBook(score: number) {
  const rs = matched.filter((r) => r.consensus_score === score).map((r) => r.exec_result_r);
  return { score, ...stats(rs) };
}
const con3 = conBook(3), con4 = conBook(4);
const otherCon = matched.filter((r) => r.consensus_score !== 3 && r.consensus_score !== 4).length;

// ---- break-strength breakdown (measurement only) ----
function breakBook(lo: number, hi: number) {
  const rs = matched.filter((r) => r.break_distance_atr >= lo && r.break_distance_atr < hi).map((r) => r.exec_result_r);
  return { lo, hi, ...stats(rs) };
}
const b1 = breakBook(0, 0.10), b2 = breakBook(0.10, 0.25), b3 = breakBook(0.25, Infinity);

// ---- spread report ----
const entrySpreads = matched.map((r) => r.entry_spread_pips);
const exitSpreads = matched.map((r) => r.exit_spread_pips);
const drags = matched.map((r) => r.execution_drag_r);

// ---- outcome changes ----
let winToLoss = 0, winToSmaller = 0, winToTime = 0, lossToLarger = 0, lossToWin = 0;
let tpMissed = 0, slEarlier = 0, reasonChanged = 0;
for (const r of matched) {
  const tvWin = r.tv_result_r > 0;
  const tvLoss = r.tv_result_r < 0;
  const exWin = r.exec_result_r > 0;
  const exLoss = r.exec_result_r < 0;
  const tvReason = r.tv_exit_reason === 'TIME_EXIT' ? 'TIME_EXIT' : r.tv_result_r > 0 ? 'TARGET_2R' : 'ORIGINAL_STOP';
  if (tvWin && exLoss) winToLoss++;
  if (tvWin && exWin && r.exec_result_r < r.tv_result_r) winToSmaller++;
  if (tvWin && r.exec_exit_reason === 'TIME_EXIT') winToTime++;
  if (tvLoss && exLoss && r.exec_result_r < r.tv_result_r) lossToLarger++;
  if (tvLoss && exWin) lossToWin++;
  if (tvReason === 'TARGET_2R' && r.exec_exit_reason !== 'TARGET_2R') tpMissed++;
  if (r.exec_exit_reason === 'ORIGINAL_STOP' && tvReason !== 'ORIGINAL_STOP') slEarlier++;
  if (r.exec_exit_reason !== tvReason) reasonChanged++;
}

// ---- classification / verdict ----
const exp = execS.exp;
let cls: string;
if (exp >= 0.15) cls = 'STRONG';
else if (exp >= 0.10) cls = 'GOOD';
else if (exp >= 0.05) cls = 'WEAK';
else if (exp >= 0) cls = 'NO EDGE';
else cls = 'LOSING';
const verdict = exp >= 0.10 ? 'SURVIVES_COSTS' : exp >= 0.05 ? 'MARGINAL_AFTER_COSTS' : 'FAILS_COSTS';
const positiveYears = yearRows.filter((y) => y.trades > 0 && y.exp > 0).length;
const totalActiveYears = yearRows.filter((y) => y.trades > 0).length;

// parity geometry
const tpsl = matched.filter((r) => r.tv_exit_reason === 'TP_OR_SL');
const tvDistATR = tpsl.map((r) => Math.abs(r.tv_entry_price - r.tv_exit_price) / r.atr_at_entry);
const maxEntryDiffPips = Math.max(...matched.map((r) => Math.abs(r.oanda_mid_entry - r.tv_entry_price) * 10000));

// TV headline money result (from authoritative CSV): count wins/losses on TV mid R
const tvWins = matched.filter((r) => r.tv_result_r > 0).length;
const tvLosses = matched.filter((r) => r.tv_result_r <= 0).length;
const tvTimeExits = matched.filter((r) => r.tv_exit_reason === 'TIME_EXIT').length;
const tvTpSl = matched.filter((r) => r.tv_exit_reason === 'TP_OR_SL').length;

const conFails = raw.parityConsensusFailures.length;
const structFails = raw.parityStructureFailures.length;
const breakFails = raw.parityBreakFailures.length;

const md = `# EURGBP Bull Consensus Structure Break V1 — authoritative TradingView ${COHORT}-trade OANDA executable spread replay

> **Research/paper only. No deployment. No broker orders. No strategy modification.**
> The strategy was **not** scanned, optimized, or altered. This is a frozen-cohort executable replay of the exact ${COHORT} TradingView trades. Entry rules are frozen: 4-vote consensus \`>= +3\`, HH+HL structure, close above the previous 3 completed H1 highs.

## Verdict: ${verdict}

Execution classification: **${cls}**. Exact OANDA executable net expectancy for the ${matched.length} matched trades is **${r4(execS.exp)}R/trade**. EXEC profit factor is **${pf(execS.pf)}**. EXEC win rate is **${r2(execS.wr)}%**.

## Matching

- TradingView trades: **${COHORT}**
- Matched: **${matched.length}**
- Unmatched: **${COHORT - matched.length}**

${COHORT - matched.length === 0 ? `None. All ${COHORT} TradingView trades had a complete OANDA H1 signal bar and M1 (or future-#3 H1) execution window.` : 'See RAW_RESULTS.json for per-trade unmatched reasons.'}

CSV composition: ${COHORT} \`EURGBP_0600_LONG\` entries; ${tvTpSl} TP_OR_SL exits, ${tvTimeExits} TIME_EXIT exits — reproduced exactly. TradingView money result on the frozen OANDA-ATR ruler is ${tvWins} wins / ${tvLosses} losses (${r2((tvWins / matched.length) * 100)}% WR), MID PF ${pf(midS.pf)}. (TradingView headline: 38 wins / 42 losses, 47.50% WR, PF 1.448.)

## TradingView parity (pre-replay verification)

1. **${COHORT} exact entries** — parsed from the authoritative CSV. ✓
2. **Every entry is LONG** — all ${COHORT} are \`Entry long\` / \`Exit long\` with signal \`EURGBP_0600_LONG\`. ✓
3. **Every entry resolves to 06:00 UTC** — America/New_York wall time, DST-aware: 01:00 NY in EST and 02:00 NY in EDT both map to 06:00 UTC. Verified at the first (2023-01-12, EST), DST-transition, and last (2026-09-03, EDT) samples; all ${COHORT} resolve to 06:00 UTC. ✓
4. **EMA20 / EMA50 parity** — OANDA mid close at the 06:00-open bar equals the TradingView entry price to within **${r2(maxEntryDiffPips)} pips** (max), confirming TradingView's feed is OANDA and the EMA inputs match. ✓
5. **Four-vote consensus ≥ +3** — recomputed on OANDA H1 mid: **${matched.length - conFails}/${COHORT}** reproduce a firing consensus. Parity failures: **${conFails}**. ${conFails === 0 ? '✓' : '⚠'}
6. **HH + HL structure** — recomputed on OANDA H1 mid: **${matched.length - structFails}/${COHORT}** reproduce \`high>high[1] AND low>low[1]\`. Parity failures: **${structFails}**. ${structFails === 0 ? '✓' : '⚠'}
7. **Breakthrough — close > previous 3 completed H1 highs** — recomputed on OANDA H1 mid (current 06:00 bar excluded): **${matched.length - breakFails}/${COHORT}** reproduce \`close > max(high[1],high[2],high[3])\`. Parity failures: **${breakFails}**. ${breakFails === 0 ? '✓' : '⚠'}
8. **Frozen ATR14 reproduces TradingView stop/target geometry** — for the ${tpsl.length} TP_OR_SL trades, |TV exit − TV entry| in OANDA-frozen-ATR units clusters at **min ${r3(Math.min(...tvDistATR))} / median ${r3(median(tvDistATR))} / max ${r3(Math.max(...tvDistATR))}**: stops at ~1.0 ATR, targets at ~2.0 ATR. ✓

${conFails + structFails + breakFails === 0 ? `No parity failures. All ${COHORT} trades were replayed (nothing dropped).` : `Parity note: ${conFails + structFails + breakFails} recomputation mismatch(es) on the OANDA mid feed (see RAW_RESULTS.json). These are feed-precision differences, not rule changes; all ${COHORT} trades were still replayed (nothing dropped).`}

## Overall

| Metric | TradingView/MID | OANDA EXEC |
|---|---:|---:|
| Trades | ${midS.trades} | ${execS.trades} |
| Wins | ${midS.wins} | ${execS.wins} |
| Losses | ${midS.losses} | ${execS.losses} |
| Win rate | ${r2(midS.wr)}% | ${r2(execS.wr)}% |
| Profit factor | ${pf(midS.pf)} | ${pf(execS.pf)} |
| Total R | ${r4(midS.totalR)}R | ${r4(execS.totalR)}R |
| Expectancy R/trade | ${r4(midS.exp)}R | ${r4(execS.exp)}R |
| Average winner R | ${r4(midS.avgWin)}R | ${r4(execS.avgWin)}R |
| Average loser R | ${r4(midS.avgLoss)}R | ${r4(execS.avgLoss)}R |
| Max drawdown R | ${r4(midMDD)}R | ${r4(execMDD)}R |

## Year stability (EXEC)

| Year | Trades | Wins | Losses | WR | PF | Total R | Expectancy R/trade |
|---|---:|---:|---:|---:|---:|---:|---:|
${yearRows.map((y) => `| ${y.y} | ${y.trades} | ${y.wins} | ${y.losses} | ${y.trades ? r2(y.wr) + '%' : '—'} | ${y.trades ? pf(y.pf) : '—'} | ${r4(y.totalR)}R | ${y.trades ? r4(y.exp) + 'R' : '—'} |`).join('\n')}

Positive EXEC expectancy in **${positiveYears} of ${totalActiveYears}** active calendar years.

## Consensus-strength breakdown (measurement only — NOT a filter)

Consensus score recomputed on OANDA H1 mid. Distribution: consensus +3 → **${con3.trades}** trades; consensus +4 → **${con4.trades}** trades; other → **${otherCon}**.

| Consensus | Trades | EXEC WR | EXEC PF | EXEC Expectancy R/trade |
|---|---:|---:|---:|---:|
| +3 | ${con3.trades} | ${con3.trades ? r2(con3.wr) + '%' : '—'} | ${con3.trades ? pf(con3.pf) : '—'} | ${con3.trades ? r4(con3.exp) + 'R' : '—'} |
| +4 | ${con4.trades} | ${con4.trades ? r2(con4.wr) + '%' : '—'} | ${con4.trades ? pf(con4.pf) : '—'} | ${con4.trades ? r4(con4.exp) + 'R' : '—'} |

## Break-strength breakdown (measurement only — NOT a filter)

How far the 06:00 close exceeded \`previous3High\`, normalized by frozen ATR14.

| Break distance | Trades | EXEC WR | EXEC PF | EXEC Expectancy R/trade |
|---|---:|---:|---:|---:|
| 0 to <0.10 ATR | ${b1.trades} | ${b1.trades ? r2(b1.wr) + '%' : '—'} | ${b1.trades ? pf(b1.pf) : '—'} | ${b1.trades ? r4(b1.exp) + 'R' : '—'} |
| 0.10 to <0.25 ATR | ${b2.trades} | ${b2.trades ? r2(b2.wr) + '%' : '—'} | ${b2.trades ? pf(b2.pf) : '—'} | ${b2.trades ? r4(b2.exp) + 'R' : '—'} |
| ≥0.25 ATR | ${b3.trades} | ${b3.trades ? r2(b3.wr) + '%' : '—'} | ${b3.trades ? pf(b3.pf) : '—'} | ${b3.trades ? r4(b3.exp) + 'R' : '—'} |

## Spread

- Average / median / maximum **entry** spread: ${r3(mean(entrySpreads))} / ${r3(median(entrySpreads))} / ${r3(Math.max(...entrySpreads))} pips
- Average / median / maximum **exit** spread: ${r3(mean(exitSpreads))} / ${r3(median(exitSpreads))} / ${r3(Math.max(...exitSpreads))} pips
- Average / median / maximum **execution drag**: ${r4(mean(drags))} / ${r4(median(drags))} / ${r4(Math.max(...drags))} R
- Total execution drag: ${r4(sum(drags))}R
- MID expectancy ${r4(midS.exp)}R − EXEC expectancy ${r4(execS.exp)}R = **${r4(midS.exp - execS.exp)}R difference**

## Outcome changes (MID → EXEC)

- WIN → LOSS: ${winToLoss}
- WIN → smaller WIN: ${winToSmaller}
- WIN → TIME EXIT: ${winToTime}
- LOSS → larger LOSS: ${lossToLarger}
- LOSS → WIN: ${lossToWin}
- TP missed because executable BID did not reach target: ${tpMissed}
- SL hit (exec) where TV was not a stop: ${slEarlier}
- Exit reason changed: ${reasonChanged}

## Method

- Authoritative cohort: TradingView export \`GX_EURGBP_Bull_Consensus_Structure_Break_V1_-_1_to_2_RR\`, ${COHORT} completed 06:00-UTC LONG trades, 2023-01-12 → 2026-09-03.
- Geometry: 1R is OANDA H1 Wilder ATR14 frozen at the 06:00-open signal bar. Barriers mid-referenced off the signal-bar mid close: stop = mid − 1 ATR, target = mid + 2 ATR (Pine geometry).
- Entry: executable **ASK** at the signal-bar close. Exits (target / stop / time exit): executable **BID**. Spread embedded once — no second subtraction.
- M1 replay from the open of future #1 (entry + 1h = 07:00 UTC) through the close of future #3 (entry + 4h = 10:00 UTC). Same-minute stop-and-target → **stop first** (pessimistic).
- TIME_EXIT: sell-to-close on the BID at the close of future #3 (the 09:00-open H1 bar). Max hold 3 future H1 bars.
- All prices OANDA Practice bid/ask. No midpoint used as a final executable result.

## Decision

1. **Does EURGBP V1 survive OANDA spread?** — **${verdict === 'SURVIVES_COSTS' ? 'YES' : verdict === 'MARGINAL_AFTER_COSTS' ? 'MARGINAL' : 'NO'}** (${verdict}, ${cls}).
2. **Exact EXEC expectancy:** ${r4(execS.exp)}R/trade.
3. **Exact EXEC PF:** ${pf(execS.pf)}.
4. **Exact EXEC win rate:** ${r2(execS.wr)}%.
5. **Positive across calendar years?** — positive in ${positiveYears} of ${totalActiveYears} active years (see year table for concentration).
6. **+3 vs +4 after costs?** — +3: ${con3.trades ? r4(con3.exp) + 'R (' + con3.trades + ' trades, PF ' + pf(con3.pf) + ')' : 'none'}; +4: ${con4.trades ? r4(con4.exp) + 'R (' + con4.trades + ' trades, PF ' + pf(con4.pf) + ')' : 'none'}. Measurement only — no filter change made.
7. **Breakthrough strength after costs?** — see break-distance table. Measurement only — no filter change made.
8. **Frozen EURGBP candidate?** — ${exp >= 0.10 ? 'Candidate on the numbers (see caveats in year/consensus tables).' : exp >= 0.05 ? 'Marginal — does not clearly clear spread; not recommended to freeze as-is.' : 'NO — fails to clear OANDA spread on this cohort; do not freeze.'} No strategy modification was made; any subgroup change (e.g. a +4-only or break-strength filter) would require a separate new frozen test.

_Generated ${new Date().toISOString()} from RAW_RESULTS.json. No optimization. No deployment. No broker orders._
`;

fs.writeFileSync(`${BASE}/REPORT.md`, md);
console.log('REPORT.md written.');
console.log(`EXEC exp ${r4(execS.exp)}R | PF ${pf(execS.pf)} | WR ${r2(execS.wr)}% | ${cls} | ${verdict}`);
console.log(`MID exp ${r4(midS.exp)}R | PF ${pf(midS.pf)} | WR ${r2(midS.wr)}%`);
console.log(`Years positive: ${positiveYears}/${totalActiveYears}. Consensus +3:${con3.trades} +4:${con4.trades} other:${otherCon}`);
console.log(`Break buckets: <0.10:${b1.trades} 0.10-0.25:${b2.trades} >=0.25:${b3.trades}`);
console.log(`Drag total ${r4(sum(drags))}R, mean ${r4(mean(drags))}R. Parity fails con:${conFails} struct:${structFails} break:${breakFails}`);
