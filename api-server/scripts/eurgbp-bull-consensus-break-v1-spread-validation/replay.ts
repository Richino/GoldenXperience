// Executable bid/ask replay of the frozen EURGBP Bull Consensus Structure Break V1
// cohort. No optimization, no rule changes. Barrier levels are mid-referenced off
// the 06:00-open signal-bar close and frozen ATR14 (exactly as the Pine computes);
// only the EXECUTABLE side decides whether each level was actually reached.
//   LONG -> filled at ASK; target/stop/time-exit judged on BID.
// Spread is embedded once via bid/ask; no extra spread cost is subtracted.
import fs from 'node:fs';
import path from 'node:path';
import { parseCohort, loadCandles, INSTRUMENT, PIP, type Candle, type TvTrade } from './lib.js';

const BASE = path.resolve('research-v2/eurgbp-bull-consensus-break-v1-spread-validation');
const HOUR = 3600000;
const MAX_HOLD = 3; // future H1 bars

const trades = parseCohort();
const h1 = loadCandles(`${BASE}/data/${INSTRUMENT}-H1-MBA.json`);
const m1 = loadCandles(`${BASE}/data/${INSTRUMENT}-M1-MBA.json`);

// --- H1 mid series ---
const mid = h1.map((c) => ({ t: c.t, o: (c.bo + c.ao) / 2, h: (c.bh + c.ah) / 2, l: (c.bl + c.al) / 2, c: (c.bc + c.ac) / 2 }));
const h1Idx = new Map(mid.map((c, i) => [c.t, i]));
const N = mid.length;

// --- EMA20 / EMA50 (ta.ema: SMA seed at first `len` bars, then EMA recursion) ---
function emaSeries(src: number[], len: number): (number | null)[] {
  const out: (number | null)[] = new Array(src.length).fill(null);
  const alpha = 2 / (len + 1);
  let ema = 0;
  for (let k = 0; k < src.length; k++) {
    if (k < len - 1) continue;
    if (k === len - 1) { let s = 0; for (let j = 0; j < len; j++) s += src[j]; ema = s / len; }
    else ema = alpha * src[k] + (1 - alpha) * ema;
    out[k] = ema;
  }
  return out;
}
const closeArr = mid.map((c) => c.c);
const ema20 = emaSeries(closeArr, 20);
const ema50 = emaSeries(closeArr, 50);

// --- ATR14 (ta.atr: Wilder RMA of true range; RMA seed = SMA of first 14 TR) ---
const tr: number[] = [0];
for (let k = 1; k < N; k++) {
  const cur = mid[k], prev = mid[k - 1];
  tr.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
}
const atrSeries: (number | null)[] = new Array(N).fill(null);
{
  let rma = 0;
  for (let k = 1; k < N; k++) {
    if (k < 14) continue;
    if (k === 14) { let s = 0; for (let j = 1; j <= 14; j++) s += tr[j]; rma = s / 14; }
    else rma = (rma * 13 + tr[k]) / 14;
    atrSeries[k] = rma;
  }
}

// --- consensus + structure + breakthrough recomputation (parity), exactly per Pine ---
function signalAt(i: number): {
  score: number; votes: number[]; structure: boolean; ready: boolean;
  previous3High: number | null; threeBarBreak: boolean; breakDistAtr: number | null;
} {
  const e20 = ema20[i], e50 = ema50[i], e20b3 = i >= 3 ? ema20[i - 3] : null, atr = atrSeries[i];
  const c = mid[i].c, c3 = i >= 3 ? mid[i - 3].c : null;
  const hi = mid[i].h, lo = mid[i].l, hiPrev = i >= 1 ? mid[i - 1].h : null, loPrev = i >= 1 ? mid[i - 1].l : null;
  const h1b = i >= 1 ? mid[i - 1].h : null, h2b = i >= 2 ? mid[i - 2].h : null, h3b = i >= 3 ? mid[i - 3].h : null;
  const ready = e20 != null && e50 != null && e20b3 != null && atr != null && atr > 0 && c3 != null && hiPrev != null && loPrev != null && h3b != null;
  if (!ready) return { score: 0, votes: [0, 0, 0, 0], structure: false, ready: false, previous3High: null, threeBarBreak: false, breakDistAtr: null };
  // Phase 2 — four-vote bullish consensus (LONG)
  const vTrend = e20! > e50! ? 1 : e20! < e50! ? -1 : 0;
  const vPrice = c > e20! ? 1 : c < e20! ? -1 : 0;
  const vSlope = e20! > e20b3! ? 1 : e20! < e20b3! ? -1 : 0;
  const vMom = c > c3! ? 1 : c < c3! ? -1 : 0;
  const score = vTrend + vPrice + vSlope + vMom;
  // Phase 3 — HH + HL structure
  const structure = hi > hiPrev! && lo > loPrev!;
  // Phase 4 — close above the previous 3 completed H1 highs (current bar excluded)
  const previous3High = Math.max(h1b!, Math.max(h2b!, h3b!));
  const threeBarBreak = c > previous3High;
  const breakDistAtr = (c - previous3High) / atr!;
  return { score, votes: [vTrend, vPrice, vSlope, vMom], structure, ready, previous3High, threeBarBreak, breakDistAtr };
}

// --- M1 lookup ---
function firstM1IndexAtOrAfter(tMs: number): number {
  let lo = 0, hi = m1.length;
  while (lo < hi) { const md = (lo + hi) >> 1; if (m1[md].t < tMs) lo = md + 1; else hi = md; }
  return lo;
}

interface Row {
  trade_number: number;
  direction: string;
  origin_utc: string;
  tv_entry_timestamp: string; resolved_utc_entry: string;
  tv_exit_timestamp: string; resolved_utc_exit: string;
  tv_entry_price: number;
  oanda_mid_entry: number; oanda_bid_entry: number; oanda_ask_entry: number; entry_spread_pips: number;
  atr_at_entry: number; initial_risk_pips: number;
  consensus_score: number;
  consensus_votes: string;
  structure_ok: boolean;
  previous3High: number | '';
  break_distance_atr: number | '';
  threebar_break_ok: boolean;
  parity_consensus_ok: boolean;
  parity_structure_ok: boolean;
  parity_break_ok: boolean;
  original_stop: number; original_target: number;
  tv_exit_price: number;
  oanda_mid_exit: number | ''; oanda_bid_exit: number | ''; oanda_ask_exit: number | ''; exit_spread_pips: number | '';
  tv_result_r: number; exec_result_r: number | ''; execution_drag_r: number | '';
  tv_exit_reason: string; exec_exit_reason: string;
  spread_changed_outcome: boolean;
  exec_ambiguous_same_minute: boolean;
  matched: boolean; unmatched_reason: string;
}

// TV/MID classification of the authoritative export on the frozen OANDA R ruler.
function classifyTv(t: TvTrade, atr: number): { r: number; reason: string } {
  const r = (t.tvExitPrice - t.tvEntryPrice) / atr; // long: exit - entry
  let reason: string;
  if (t.tvExitReason === 'TIME_EXIT') reason = 'TIME_EXIT';
  else reason = r > 0 ? 'TARGET_2R' : 'ORIGINAL_STOP';
  return { r, reason };
}

const rows: Row[] = [];
const gapAudit: any[] = [];

for (const t of trades) {
  const i = h1Idx.get(t.resolvedEntryUtcMs);
  const base: Partial<Row> = {
    trade_number: t.tradeNumber,
    direction: t.direction,
    origin_utc: new Date(t.resolvedEntryUtcMs).toISOString(),
    tv_entry_timestamp: t.tvEntryWallNy, resolved_utc_entry: new Date(t.resolvedEntryUtcMs).toISOString(),
    tv_exit_timestamp: t.tvExitWallNy, resolved_utc_exit: new Date(t.resolvedExitUtcMs).toISOString(),
    tv_entry_price: t.tvEntryPrice, tv_exit_price: t.tvExitPrice, tv_exit_reason: t.tvExitReason,
  };

  if (i == null || atrSeries[i] == null) {
    rows.push({
      ...(base as Row), matched: false,
      unmatched_reason: i == null ? 'NO_H1_SIGNAL_BAR' : 'ATR_WARMUP_UNAVAILABLE',
      oanda_mid_entry: NaN as any, oanda_bid_entry: NaN as any, oanda_ask_entry: NaN as any, entry_spread_pips: NaN as any,
      atr_at_entry: NaN as any, initial_risk_pips: NaN as any, original_stop: NaN as any, original_target: NaN as any,
      oanda_mid_exit: '', oanda_bid_exit: '', oanda_ask_exit: '', exit_spread_pips: '',
      consensus_score: NaN as any, consensus_votes: '', structure_ok: false,
      previous3High: '', break_distance_atr: '', threebar_break_ok: false,
      parity_consensus_ok: false, parity_structure_ok: false, parity_break_ok: false,
      tv_result_r: NaN as any, exec_result_r: '', execution_drag_r: '', exec_exit_reason: 'UNMATCHED',
      spread_changed_outcome: false, exec_ambiguous_same_minute: false,
    });
    continue;
  }

  const sig = h1[i];
  const atr = atrSeries[i]!;
  const entryMid = (sig.bc + sig.ac) / 2;
  const entryBid = sig.bc;
  const entryAsk = sig.ac;
  const entrySpreadPips = (entryAsk - entryBid) * PIP;

  // Barrier levels: mid-referenced off signal close & frozen ATR (Pine geometry).
  const stop = entryMid - atr;          // 1 ATR below entry
  const target = entryMid + 2 * atr;    // 2 ATR above entry

  const sg = signalAt(i);
  const parityConsensus = sg.ready && sg.score >= 3;
  const parityStructure = sg.structure;
  const parityBreak = sg.threeBarBreak;

  const tv = classifyTv(t, atr);

  // --- executable minute-by-minute replay (LONG: exits judged on BID) ---
  const replayStart = t.resolvedEntryUtcMs + HOUR;          // open of future #1 (07:00 UTC)
  const scanEnd = t.resolvedEntryUtcMs + (MAX_HOLD + 1) * HOUR; // close of future #3 (10:00 UTC)
  let idx = firstM1IndexAtOrAfter(replayStart);
  let exitPrice: number | null = null;
  let exitReason = '';
  let exitCandle: Candle | null = null;
  let ambiguousSameMinute = false;
  let minutesSeen = 0;

  for (; idx < m1.length && m1[idx].t < scanEnd; idx++) {
    const c = m1[idx];
    minutesSeen++;
    const h = c.bh; // bid high (favorable for long = target side, target above)
    const l = c.bl; // bid low  (adverse for long = stop side, stop below)
    const o = c.bo; // bid open
    const hitStop = l <= stop;
    const hitTarget = h >= target;
    if (hitStop && hitTarget) {
      // same-minute both -> stop first (pessimistic), sub-minute path unknowable
      exitPrice = o <= stop ? o : stop;
      exitReason = 'ORIGINAL_STOP';
      ambiguousSameMinute = true;
      exitCandle = c; break;
    }
    if (hitStop) {
      exitPrice = o <= stop ? o : stop; // gap-through fills worse
      exitReason = 'ORIGINAL_STOP';
      exitCandle = c; break;
    }
    if (hitTarget) {
      exitPrice = o >= target ? o : target;
      exitReason = 'TARGET_2R';
      exitCandle = c; break;
    }
  }

  // TIME_EXIT: close of future #3 (the 09:00-open H1 bar) on the BID.
  if (exitPrice == null) {
    const timeBarIdx = h1Idx.get(t.resolvedEntryUtcMs + MAX_HOLD * HOUR); // 09:00-open bar
    if (timeBarIdx == null) {
      rows.push({
        ...(base as Row),
        oanda_mid_entry: entryMid, oanda_bid_entry: entryBid, oanda_ask_entry: entryAsk, entry_spread_pips: entrySpreadPips,
        atr_at_entry: atr, initial_risk_pips: atr * PIP, original_stop: stop, original_target: target,
        oanda_mid_exit: '', oanda_bid_exit: '', oanda_ask_exit: '', exit_spread_pips: '',
        consensus_score: sg.score, consensus_votes: sg.votes.join('|'), structure_ok: sg.structure,
        previous3High: sg.previous3High ?? '', break_distance_atr: sg.breakDistAtr ?? '', threebar_break_ok: sg.threeBarBreak,
        parity_consensus_ok: parityConsensus, parity_structure_ok: parityStructure, parity_break_ok: parityBreak,
        tv_result_r: tv.r, exec_result_r: '', execution_drag_r: '',
        exec_exit_reason: 'UNRESOLVED_NO_TIME_BAR', spread_changed_outcome: true,
        exec_ambiguous_same_minute: false, matched: true, unmatched_reason: 'EXEC_UNRESOLVED_NO_TIME_BAR',
      });
      gapAudit.push({ trade: t.tradeNumber, reason: 'NO_TIME_BAR', at: new Date(t.resolvedEntryUtcMs + MAX_HOLD * HOUR).toISOString(), minutesSeen });
      continue;
    }
    const tb = h1[timeBarIdx];
    exitPrice = tb.bc; // sell-to-close on BID at future #3 close
    exitReason = 'TIME_EXIT';
    exitCandle = tb;
  }

  const execR = (exitPrice - entryAsk) / atr; // long: bought at ask, sold at exit bid
  const exitBid = exitCandle!.bc;
  const exitAsk = exitCandle!.ac;
  const exitMid = (exitBid + exitAsk) / 2;
  const exitSpreadPips = (exitAsk - exitBid) * PIP;
  const spreadChanged = exitReason !== tv.reason;

  rows.push({
    trade_number: t.tradeNumber, direction: t.direction,
    origin_utc: new Date(t.resolvedEntryUtcMs).toISOString(),
    tv_entry_timestamp: t.tvEntryWallNy, resolved_utc_entry: new Date(t.resolvedEntryUtcMs).toISOString(),
    tv_exit_timestamp: t.tvExitWallNy, resolved_utc_exit: new Date(t.resolvedExitUtcMs).toISOString(),
    tv_entry_price: t.tvEntryPrice,
    oanda_mid_entry: entryMid, oanda_bid_entry: entryBid, oanda_ask_entry: entryAsk, entry_spread_pips: entrySpreadPips,
    atr_at_entry: atr, initial_risk_pips: atr * PIP,
    consensus_score: sg.score, consensus_votes: sg.votes.join('|'), structure_ok: sg.structure,
    previous3High: sg.previous3High ?? '', break_distance_atr: sg.breakDistAtr ?? '', threebar_break_ok: sg.threeBarBreak,
    parity_consensus_ok: parityConsensus, parity_structure_ok: parityStructure, parity_break_ok: parityBreak,
    original_stop: stop, original_target: target,
    tv_exit_price: t.tvExitPrice,
    oanda_mid_exit: exitMid, oanda_bid_exit: exitBid, oanda_ask_exit: exitAsk, exit_spread_pips: exitSpreadPips,
    tv_result_r: tv.r, exec_result_r: execR, execution_drag_r: tv.r - execR,
    tv_exit_reason: t.tvExitReason, exec_exit_reason: exitReason,
    spread_changed_outcome: spreadChanged,
    exec_ambiguous_same_minute: ambiguousSameMinute,
    matched: true, unmatched_reason: '',
  });
}

// ------------------------------------------------------------------ write CSV
const cols = [
  'trade_number', 'direction', 'origin_utc',
  'tv_entry_timestamp', 'resolved_utc_entry', 'tv_exit_timestamp', 'resolved_utc_exit',
  'tv_entry_price', 'oanda_mid_entry', 'oanda_bid_entry', 'oanda_ask_entry', 'entry_spread_pips',
  'atr_at_entry', 'initial_risk_pips',
  'consensus_score', 'consensus_votes', 'structure_ok', 'previous3High', 'break_distance_atr', 'threebar_break_ok',
  'parity_consensus_ok', 'parity_structure_ok', 'parity_break_ok',
  'original_stop', 'original_target',
  'tv_exit_price', 'oanda_mid_exit', 'oanda_bid_exit', 'oanda_ask_exit', 'exit_spread_pips',
  'tv_result_r', 'exec_result_r', 'execution_drag_r', 'tv_exit_reason', 'exec_exit_reason',
  'spread_changed_outcome', 'exec_ambiguous_same_minute', 'matched', 'unmatched_reason',
];
const fmt = (v: any) => {
  if (v === '' || v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? +v.toFixed(v < 10 && v > -10 ? 6 : 5) : '';
  return String(v);
};
const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => fmt((r as any)[c])).join(','))).join('\n');
fs.writeFileSync(`${BASE}/TRADES.csv`, csv);

// ------------------------------------------------------------- write RAW json
const matched = rows.filter((r) => r.matched);
const parityConsensusFails = rows.filter((r) => r.matched && !r.parity_consensus_ok);
const parityStructureFails = rows.filter((r) => r.matched && !r.parity_structure_ok);
const parityBreakFails = rows.filter((r) => r.matched && !r.parity_break_ok);
fs.writeFileSync(`${BASE}/RAW_RESULTS.json`, JSON.stringify({
  generatedAt: new Date().toISOString(),
  instrument: INSTRUMENT,
  cohortSize: trades.length,
  matched: matched.length,
  unmatched: rows.length - matched.length,
  parityConsensusFailures: parityConsensusFails.map((r) => ({ trade: r.trade_number, score: r.consensus_score, votes: r.consensus_votes })),
  parityStructureFailures: parityStructureFails.map((r) => ({ trade: r.trade_number })),
  parityBreakFailures: parityBreakFails.map((r) => ({ trade: r.trade_number, breakDistAtr: r.break_distance_atr })),
  rows,
}, null, 2));
fs.writeFileSync(`${BASE}/GAP_AUDIT.json`, JSON.stringify(gapAudit, null, 2));

console.log(`Replay complete: ${rows.length} rows, ${matched.length} matched, ${rows.length - matched.length} unmatched.`);
console.log(`Parity consensus>=+3 failures: ${parityConsensusFails.length}; HH+HL failures: ${parityStructureFails.length}; breakthrough failures: ${parityBreakFails.length}.`);
console.log(`Gaps: ${gapAudit.length}.`);
