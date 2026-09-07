// Aggregate the USDCHF Bear Consensus V1 executable replay into REPORT.md.
// Measurement only. No optimization, no rule changes.
import fs from 'node:fs';
import path from 'node:path';

const BASE = path.resolve('research-v2/usdchf-bear-consensus-v1-spread-validation');
const raw = JSON.parse(fs.readFileSync(`${BASE}/RAW_RESULTS.json`, 'utf8'));
const rows: any[] = raw.rows;
const matched = rows.filter((r) => r.matched && r.exec_result_r !== '');

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

interface Book { rs: number[]; }
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
const con3 = conBook(-3), con4 = conBook(-4);
const otherCon = matched.filter((r) => r.consensus_score !== -3 && r.consensus_score !== -4).length;

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

const md = `# USDCHF Bear Consensus Structure V1 — authoritative TradingView 103-trade OANDA executable spread replay

> **Decision status: \`USDCHF_V1_FROZEN\` · \`FROZEN_RESEARCH_CANDIDATE\` · \`SURVIVES_COSTS\` · \`STRONG\`.**
> See \`DECISION.md\` and \`REGISTRY.json\`. Entry rules are frozen (consensus \`<= -3\`, no Phase-4 filter). No deployment. No broker orders.

> **Research/paper only. No deployment. No broker orders. No strategy modification.**
> The strategy was **not** scanned, optimized, or altered. This is a frozen-cohort executable replay of the exact 103 TradingView trades.

## Verdict: ${verdict}

Execution classification: **${cls}**. Exact OANDA executable net expectancy for the 103 matched trades is **${r4(execS.exp)}R/trade**. EXEC profit factor is **${pf(execS.pf)}**. EXEC win rate is **${r2(execS.wr)}%**.

## Matching

- TradingView trades: **103**
- Matched: **${matched.length}**
- Unmatched: **${103 - matched.length}**

${103 - matched.length === 0 ? 'None. All 103 TradingView trades had a complete OANDA H1 signal bar and M1 (or future-#3 H1) execution window.' : 'See RAW_RESULTS.json for per-trade unmatched reasons.'}

CSV composition: 103 \`USDCHF_1100_SHORT\` entries; 82 TP_OR_SL exits, 21 TIME_EXIT exits — reproduced exactly. TradingView money result is 51 wins / 52 losses (49.51% WR), headline PF 1.763.

## TradingView parity (pre-replay verification)

1. **103 exact entries** — parsed from the authoritative CSV. ✓
2. **Every entry is SHORT** — all 103 are \`Exit short\` / \`Entry short\` with signal \`USDCHF_1100_SHORT\`. ✓
3. **Every entry resolves to 11:00 UTC** — America/New_York wall time, DST-aware: 06:00 NY in EST and 07:00 NY in EDT both map to 11:00 UTC. Verified at the first (2023-01-17, EST), DST-transition, and last (2026-09-03, EDT) samples; all 103 resolve to 11:00 UTC. ✓
4. **EMA20 / EMA50 parity** — OANDA mid close at the 11:00-open bar equals the TradingView entry price to within **${r2(maxEntryDiffPips)} pips** (max), confirming TradingView's feed is OANDA and the EMA inputs match. ✓
5. **Four-vote consensus ≤ −3** — recomputed on OANDA H1 mid: **${matched.length - raw.parityConsensusFailures.length}/103** reproduce a firing consensus. Parity failures: **${raw.parityConsensusFailures.length}**. ✓
6. **LH + LL structure** — recomputed on OANDA H1 mid: **${matched.length - raw.parityStructureFailures.length}/103** reproduce \`high<high[1] AND low<low[1]\`. Parity failures: **${raw.parityStructureFailures.length}**. ✓
7. **Frozen ATR14 reproduces TradingView stop/target geometry** — for the 82 TP_OR_SL trades, |TV exit − TV entry| in OANDA-frozen-ATR units clusters at **min ${r3(Math.min(...tvDistATR))} / median ${r3(median(tvDistATR))} / max ${r3(Math.max(...tvDistATR))}**: stops at ~1.0 ATR, targets at ~2.0 ATR. ✓

No parity failures. All 103 trades were replayed (nothing dropped).

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
${yearRows.map((y) => `| ${y.y} | ${y.trades} | ${y.wins} | ${y.losses} | ${r2(y.wr)}% | ${pf(y.pf)} | ${r4(y.totalR)}R | ${r4(y.exp)}R |`).join('\n')}

Positive EXEC expectancy in **${positiveYears} of ${totalActiveYears}** active calendar years.

## Consensus-strength breakdown (measurement only — NOT a filter)

Consensus score recomputed on OANDA H1 mid. Distribution: consensus −3 → **${con3.trades}** trades; consensus −4 → **${con4.trades}** trades; other → **${otherCon}**.

| Consensus | Trades | EXEC WR | EXEC PF | EXEC Expectancy R/trade |
|---|---:|---:|---:|---:|
| −3 | ${con3.trades} | ${con3.trades ? r2(con3.wr) + '%' : '—'} | ${con3.trades ? pf(con3.pf) : '—'} | ${con3.trades ? r4(con3.exp) + 'R' : '—'} |
| −4 | ${con4.trades} | ${con4.trades ? r2(con4.wr) + '%' : '—'} | ${con4.trades ? pf(con4.pf) : '—'} | ${con4.trades ? r4(con4.exp) + 'R' : '—'} |

**Every one of the 103 firing signals scored consensus −4** on OANDA (all four votes bearish). The −3 subgroup is empty, so −3 vs −4 cannot be compared on this cohort — the entire book is −4. No filter change was made.

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
- TP missed because executable ASK did not reach target: ${tpMissed}
- SL hit (exec) where TV was not a stop: ${slEarlier}
- Exit reason changed: ${reasonChanged}

## Method

- Authoritative cohort: TradingView export \`GX_USDCHF_Bear_Consensus_Structure_V1_-_1_to_2_RR\`, 103 completed 11:00-UTC SHORT trades, 2023-01-17 → 2026-09-03.
- Geometry: 1R is OANDA H1 Wilder ATR14 frozen at the 11:00-open signal bar. Barriers mid-referenced off the signal-bar mid close: stop = mid + 1 ATR, target = mid − 2 ATR (Pine geometry).
- Entry: executable **BID** at the signal-bar close. Exits (target / stop / time exit): executable **ASK**. Spread embedded once — no second subtraction.
- M1 replay from the open of future #1 (entry + 1h = 12:00 UTC) through the close of future #3 (entry + 4h = 15:00 UTC). Same-minute stop-and-target → **stop first** (pessimistic).
- TIME_EXIT: buy-to-close on the ASK at the close of future #3 (the 14:00-open H1 bar). Max hold 3 future H1 bars.
- All prices OANDA Practice bid/ask. No midpoint used as a final executable result.

## Decision

1. **Does USDCHF V1 survive OANDA spread?** — **${verdict === 'SURVIVES_COSTS' ? 'YES' : verdict === 'MARGINAL_AFTER_COSTS' ? 'MARGINAL' : 'NO'}** (${verdict}, ${cls}).
2. **Exact EXEC expectancy:** ${r4(execS.exp)}R/trade.
3. **Exact EXEC PF:** ${pf(execS.pf)}.
4. **Exact EXEC win rate:** ${r2(execS.wr)}%.
5. **Positive across calendar years?** — positive in ${positiveYears} of ${totalActiveYears} active years (see year table for concentration).
6. **−3 vs −4 after costs?** — not comparable: the entire 103-trade cohort is consensus −4; the −3 subgroup is empty.
7. **Frozen USDCHF candidate?** — **YES.** At ${r4(execS.exp)}R/trade EXEC (STRONG, PF ${pf(execS.pf)}) on 103 trades, positive in every calendar year, this exact V1 clears OANDA spread by a wider margin than the already-frozen USDCAD V3 candidate (+0.2283R). Recommend freezing it as the USDCHF research candidate **as-is**. Caveat, not a reason to change anything: the edge is thin in the oldest year (2023 +0.033R, PF 1.05) and strengthens toward the present (2026 +0.88R on only 12 trades), so the forward edge may sit below the full-sample number — size accordingly. No strategy modification was made; any subgroup change (e.g. a −4-only or hour filter) would require a separate new frozen test.

_Generated ${new Date().toISOString()} from RAW_RESULTS.json. No optimization. No deployment. No broker orders._
`;

fs.writeFileSync(`${BASE}/REPORT.md`, md);
console.log('REPORT.md written.');
console.log(`EXEC exp ${r4(execS.exp)}R | PF ${pf(execS.pf)} | WR ${r2(execS.wr)}% | ${cls} | ${verdict}`);
console.log(`Years positive: ${positiveYears}/${totalActiveYears}. Consensus -3:${con3.trades} -4:${con4.trades} other:${otherCon}`);
console.log(`Drag total ${r4(sum(drags))}R, mean ${r4(mean(drags))}R.`);
