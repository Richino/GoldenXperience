// Executable bid/ask replay of the frozen EURUSD Frequency V3 cohort.
// No optimization, no rule changes. Barrier levels come straight from the Pine
// (mid-referenced off the signal-candle close and frozen ATR14); only the
// EXECUTABLE side decides whether each level was actually reached:
//   LONG  -> filled at ASK, exits/target/lock-trigger judged on BID.
//   SHORT -> filled at BID, exits/target/lock-trigger judged on ASK.
// Spread is embedded once via bid/ask; no extra spread cost is subtracted.
import fs from 'node:fs';
import path from 'node:path';
import { parseCohort, loadCandles, type Candle, type TvTrade } from './lib.js';

const BASE = path.resolve('research-v2/eurusd-frequency-v3-spread-validation');
const PIP = 10000;
const HOUR = 3600000;

const trades = parseCohort();
const h1 = loadCandles(`${BASE}/data/EUR_USD-H1-MBA.json`);
const m1 = loadCandles(`${BASE}/data/EUR_USD-M1-MBA.json`);

// --- H1 mid series + frozen Wilder ATR14 (ta.atr) at each bar index ---
const mid = h1.map((c) => ({ t: c.t, o: (c.bo + c.ao) / 2, h: (c.bh + c.ah) / 2, l: (c.bl + c.al) / 2, c: (c.bc + c.ac) / 2 }));
const h1Idx = new Map(mid.map((c, i) => [c.t, i]));
// True range series (tr[k] belongs to bar k, k>=1), then Wilder RMA(14).
const tr: number[] = [0];
for (let k = 1; k < mid.length; k++) {
  const cur = mid[k], prev = mid[k - 1];
  tr.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
}
const atrSeries: (number | null)[] = new Array(mid.length).fill(null);
{
  let rma = 0;
  for (let k = 1; k < mid.length; k++) {
    if (k < 14) continue;
    if (k === 14) { let s = 0; for (let j = 1; j <= 14; j++) s += tr[j]; rma = s / 14; }
    else rma = (rma * 13 + tr[k]) / 14;
    atrSeries[k] = rma;
  }
}

// --- M1 lookup, sorted; a cursor per trade scans forward from replay start ---
const m1Sorted = m1; // collect.ts already dedup-sorted
function firstM1IndexAtOrAfter(tMs: number): number {
  let lo = 0, hi = m1Sorted.length;
  while (lo < hi) { const md = (lo + hi) >> 1; if (m1Sorted[md].t < tMs) lo = md + 1; else hi = md; }
  return lo;
}

interface Row {
  trade_number: number;
  leg: string; direction: string; origin_utc: string;
  tv_entry_timestamp: string; resolved_utc_entry: string;
  tv_exit_timestamp: string; resolved_utc_exit: string;
  tv_entry_price: number;
  oanda_mid_entry: number; oanda_bid_entry: number; oanda_ask_entry: number; entry_spread_pips: number;
  atr_at_entry: number; initial_risk_pips: number;
  original_stop: number; target: number;
  profit_lock_trigger: number; profit_lock_stop: number;
  tv_profit_lock_activated: boolean; exec_profit_lock_activated: boolean;
  exec_profit_lock_timestamp: string;
  tv_exit_price: number;
  oanda_mid_exit: number | ''; oanda_bid_exit: number | ''; oanda_ask_exit: number | ''; exit_spread_pips: number | '';
  tv_result_r: number; exec_result_r: number | ''; spread_drag_r: number | '';
  tv_exit_reason: string; exec_exit_reason: string;
  spread_changed_outcome: boolean;
  exec_ambiguous_same_minute: boolean;
  matched: boolean; unmatched_reason: string;
}

function classifyTv(t: TvTrade, atr: number): { r: number; reason: string; lockActivated: boolean } {
  const move = t.direction === 'long' ? t.tvExitPrice - t.tvEntryPrice : t.tvEntryPrice - t.tvExitPrice;
  const r = move / atr;
  // Exit-comment semantics from the Pine: the "PROFIT_LOCK_OR_TP" comment is only
  // emitted once the lock has armed; "TP_OR_SL" means it never armed.
  const lockActivated = t.tvExitReason === 'PROFIT_LOCK_OR_TP';
  let reason: string;
  if (lockActivated) reason = r > 1.25 ? 'TARGET_2R' : 'PROFIT_LOCK_0_5R';
  else reason = r > 0 ? 'TARGET_2R' : 'ORIGINAL_STOP';
  return { r, reason, lockActivated };
}

const rows: Row[] = [];
const gapAudit: any[] = [];

for (const t of trades) {
  const i = h1Idx.get(t.resolvedEntryUtcMs);
  const base: Partial<Row> = {
    trade_number: t.tradeNumber,
    leg: t.leg, direction: t.direction,
    origin_utc: new Date(t.resolvedEntryUtcMs).toISOString(),
    tv_entry_timestamp: t.tvEntryWallNy, resolved_utc_entry: new Date(t.resolvedEntryUtcMs).toISOString(),
    tv_exit_timestamp: t.tvExitWallNy, resolved_utc_exit: new Date(t.resolvedExitUtcMs).toISOString(),
    tv_entry_price: t.tvEntryPrice, tv_exit_price: t.tvExitPrice, tv_exit_reason: t.tvExitReason,
  };
  if (i == null || atrSeries[i] == null) {
    rows.push({ ...(base as Row), matched: false, unmatched_reason: i == null ? 'NO_H1_SIGNAL_BAR' : 'ATR_WARMUP_UNAVAILABLE',
      oanda_mid_entry: NaN as any, oanda_bid_entry: NaN as any, oanda_ask_entry: NaN as any, entry_spread_pips: NaN as any,
      atr_at_entry: NaN as any, initial_risk_pips: NaN as any, original_stop: NaN as any, target: NaN as any,
      profit_lock_trigger: NaN as any, profit_lock_stop: NaN as any,
      tv_profit_lock_activated: t.tvExitReason === 'PROFIT_LOCK_OR_TP', exec_profit_lock_activated: false, exec_profit_lock_timestamp: '',
      oanda_mid_exit: '', oanda_bid_exit: '', oanda_ask_exit: '', exit_spread_pips: '',
      tv_result_r: NaN as any, exec_result_r: '', spread_drag_r: '', exec_exit_reason: 'UNMATCHED', spread_changed_outcome: false });
    continue;
  }
  const sig = h1[i];
  const atr = atrSeries[i]!;
  const entryMid = (sig.bc + sig.ac) / 2;
  const entryBid = sig.bc;
  const entryAsk = sig.ac;
  const entrySpreadPips = (entryAsk - entryBid) * PIP;

  const long = t.direction === 'long';
  const fill = long ? entryAsk : entryBid; // executable entry
  // Barrier levels (mid-referenced, exactly as Pine computes off the signal close).
  const stop = long ? entryMid - atr : entryMid + atr;
  const target = long ? entryMid + 2 * atr : entryMid - 2 * atr;
  const lockTrig = long ? entryMid + 1.25 * atr : entryMid - 1.25 * atr;
  const lockStop = long ? entryMid + 0.5 * atr : entryMid - 0.5 * atr;

  const tv = classifyTv(t, atr);

  // --- executable minute-by-minute replay ---
  const replayStart = t.resolvedEntryUtcMs + HOUR; // start of the next H1 bar
  let idx = firstM1IndexAtOrAfter(replayStart);
  let lockActive = false;
  let lockTs = '';
  let exitPrice: number | null = null;
  let exitReason = '';
  let exitCandle: Candle | null = null;
  // true when a +0.5R lock exit happened in the SAME minute the lock armed and
  // that minute also reached the +2R target (sub-minute path is unknowable ->
  // resolved pessimistically; flagged so the report can bound the effect).
  let ambiguousSameMinute = false;

  for (; idx < m1Sorted.length; idx++) {
    const c = m1Sorted[idx];
    // executable OHLC: long -> bid, short -> ask
    const o = long ? c.bo : c.ao;
    const h = long ? c.bh : c.ah;
    const l = long ? c.bl : c.al;

    if (long) {
      const activeStop = lockActive ? lockStop : stop;
      // adverse (stop) checked before favorable within the minute = pessimistic
      if (l <= activeStop) {
        exitPrice = o <= activeStop ? o : activeStop; // gap-through fills worse
        exitReason = lockActive ? 'PROFIT_LOCK_0_5R' : 'ORIGINAL_STOP';
        exitCandle = c; break;
      }
      if (!lockActive && h >= lockTrig) {
        lockActive = true; lockTs = new Date(c.t).toISOString();
        if (l <= lockStop) { exitPrice = o <= lockStop ? o : lockStop; exitReason = 'PROFIT_LOCK_0_5R'; ambiguousSameMinute = h >= target; exitCandle = c; break; }
        if (h >= target) { exitPrice = target; exitReason = 'TARGET_2R'; exitCandle = c; break; }
        continue;
      }
      if (lockActive && h >= target) { exitPrice = target; exitReason = 'TARGET_2R'; exitCandle = c; break; }
    } else {
      const activeStop = lockActive ? lockStop : stop;
      if (h >= activeStop) {
        exitPrice = o >= activeStop ? o : activeStop;
        exitReason = lockActive ? 'PROFIT_LOCK_0_5R' : 'ORIGINAL_STOP';
        exitCandle = c; break;
      }
      if (!lockActive && l <= lockTrig) {
        lockActive = true; lockTs = new Date(c.t).toISOString();
        if (h >= lockStop) { exitPrice = o >= lockStop ? o : lockStop; exitReason = 'PROFIT_LOCK_0_5R'; ambiguousSameMinute = l <= target; exitCandle = c; break; }
        if (l <= target) { exitPrice = target; exitReason = 'TARGET_2R'; exitCandle = c; break; }
        continue;
      }
      if (lockActive && l <= target) { exitPrice = target; exitReason = 'TARGET_2R'; exitCandle = c; break; }
    }
  }

  if (exitPrice == null || exitCandle == null) {
    rows.push({ ...(base as Row),
      oanda_mid_entry: entryMid, oanda_bid_entry: entryBid, oanda_ask_entry: entryAsk, entry_spread_pips: entrySpreadPips,
      atr_at_entry: atr, initial_risk_pips: atr * PIP, original_stop: stop, target,
      profit_lock_trigger: lockTrig, profit_lock_stop: lockStop,
      tv_profit_lock_activated: tv.lockActivated, exec_profit_lock_activated: lockActive, exec_profit_lock_timestamp: lockTs,
      oanda_mid_exit: '', oanda_bid_exit: '', oanda_ask_exit: '', exit_spread_pips: '',
      tv_result_r: tv.r, exec_result_r: '', spread_drag_r: '',
      exec_exit_reason: 'UNRESOLVED', spread_changed_outcome: true, matched: true, unmatched_reason: 'EXEC_UNRESOLVED_NO_BARRIER_IN_DATA' });
    gapAudit.push({ trade: t.tradeNumber, reason: 'EXEC_UNRESOLVED', replayStart: new Date(replayStart).toISOString() });
    continue;
  }

  // executable result R (spread embedded via ask entry / bid exit and vice versa)
  const execR = long ? (exitPrice - entryAsk) / atr : (entryBid - exitPrice) / atr;
  const exitBid = exitCandle.bc;
  const exitAsk = exitCandle.ac;
  const exitMid = (exitBid + exitAsk) / 2;
  const exitSpreadPips = (exitAsk - exitBid) * PIP;

  const spreadChanged = exitReason !== tv.reason || lockActive !== tv.lockActivated;

  rows.push({
    trade_number: t.tradeNumber, leg: t.leg, direction: t.direction,
    origin_utc: new Date(t.resolvedEntryUtcMs).toISOString(),
    tv_entry_timestamp: t.tvEntryWallNy, resolved_utc_entry: new Date(t.resolvedEntryUtcMs).toISOString(),
    tv_exit_timestamp: t.tvExitWallNy, resolved_utc_exit: new Date(t.resolvedExitUtcMs).toISOString(),
    tv_entry_price: t.tvEntryPrice,
    oanda_mid_entry: entryMid, oanda_bid_entry: entryBid, oanda_ask_entry: entryAsk, entry_spread_pips: entrySpreadPips,
    atr_at_entry: atr, initial_risk_pips: atr * PIP,
    original_stop: stop, target,
    profit_lock_trigger: lockTrig, profit_lock_stop: lockStop,
    tv_profit_lock_activated: tv.lockActivated, exec_profit_lock_activated: lockActive,
    exec_profit_lock_timestamp: lockTs,
    tv_exit_price: t.tvExitPrice,
    oanda_mid_exit: exitMid, oanda_bid_exit: exitBid, oanda_ask_exit: exitAsk, exit_spread_pips: exitSpreadPips,
    tv_result_r: tv.r, exec_result_r: execR, spread_drag_r: tv.r - execR,
    tv_exit_reason: t.tvExitReason, exec_exit_reason: exitReason,
    spread_changed_outcome: spreadChanged,
    exec_ambiguous_same_minute: ambiguousSameMinute,
    matched: true, unmatched_reason: '',
  });
}

// ------------------------------------------------------------------ write CSV
const cols = [
  'trade_number', 'leg', 'direction', 'origin_utc',
  'tv_entry_timestamp', 'resolved_utc_entry', 'tv_exit_timestamp', 'resolved_utc_exit',
  'tv_entry_price', 'oanda_mid_entry', 'oanda_bid_entry', 'oanda_ask_entry', 'entry_spread_pips',
  'atr_at_entry', 'initial_risk_pips', 'original_stop', 'target',
  'profit_lock_trigger', 'profit_lock_stop', 'tv_profit_lock_activated', 'exec_profit_lock_activated',
  'exec_profit_lock_timestamp', 'tv_exit_price', 'oanda_mid_exit', 'oanda_bid_exit', 'oanda_ask_exit',
  'exit_spread_pips', 'tv_result_r', 'exec_result_r', 'spread_drag_r', 'tv_exit_reason', 'exec_exit_reason',
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
fs.writeFileSync(`${BASE}/RAW_RESULTS.json`, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
fs.writeFileSync(`${BASE}/GAP_AUDIT.json`, JSON.stringify(gapAudit, null, 2));
console.log(`Replay complete: ${rows.length} rows, ${rows.filter((r) => r.matched).length} matched, ${gapAudit.length} gaps.`);
console.log(`Unresolved: ${rows.filter((r) => r.exec_exit_reason === 'UNRESOLVED').length}`);
