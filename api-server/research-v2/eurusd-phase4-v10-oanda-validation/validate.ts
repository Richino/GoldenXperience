/**
 * EURUSD Phase 4 V10 (1:1) — executable BID/ASK validation of the frozen
 * TradingView cohort. RESEARCH ONLY. No production code, no broker orders.
 *
 * Replays the 197 exact TradingView entries against OANDA Practice M1 bid/ask.
 * Entry family origin hours (UTC): 07_EXTREME_LONG=07, 08_BODY_LONG=08,
 * 10_BODY_INV_LONG=10. TV timestamps are America/New_York; converted to UTC.
 *
 * Execution model (LONG only, 1:1, SL/TP = 1 ATR14 frozen at origin, max 6 H1 bars):
 *   - process_orders_on_close: entry fills at the ORIGIN H1 candle close = origin+1h.
 *   - Entry pays OANDA ASK; long TP/SL are triggered on executable BID high/low.
 *   - Walk M1 bid/ask up to 6h; if TP and SL both inside one M1 bar -> AMBIGUOUS.
 *   - No fill by 6h -> time exit at executable BID.
 *   Method A FROZEN_LEVEL_PARITY: TP/SL = TV mid entry +/- ATR (entry still pays ASK).
 *   Method B REAL_FILL_1R:        TP/SL = actual ASK fill +/- ATR.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIR = import.meta.dirname;
for (const line of (() => { try { return readFileSync(resolve(DIR, "../../.env"), "utf8").split(/\r?\n/); } catch { return []; } })()) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}
const env = (k: string) => (process.env[k] ?? "").trim().replace(/^["']|["']$/g, "");
const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const host = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const PIP = 0.0001;

// ---------- America/New_York -> UTC ----------
function nyOffset(y: number, mo: number, d: number, h: number): number {
  const secondSunMar = (() => { const f = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ((7 - f) % 7) + 1 + 7; })();
  const firstSunNov = (() => { const f = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ((7 - f) % 7) + 1; })();
  const afterStart = mo > 3 || (mo === 3 && (d > secondSunMar || (d === secondSunMar && h >= 2)));
  const beforeEnd = mo < 11 || (mo === 11 && (d < firstSunNov || (d === firstSunNov && h < 2)));
  return afterStart && beforeEnd ? -4 : -5;
}
function nyToUtc(local: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local.trim())!;
  const [, ys, mos, ds, hs, mis] = m; const y = +ys!, mo = +mos!, d = +ds!, h = +hs!, mi = +mis!;
  return new Date(Date.UTC(y, mo - 1, d, h - nyOffset(y, mo, d, h), mi));
}

// ---------- OANDA fetch ----------
async function fetchCandles(gran: string, price: string, fromISO: string, toISO: string) {
  const out: any[] = []; let cursor = fromISO; const toMs = Date.parse(toISO);
  const stepMs = gran === "M1" ? 60_000 : 3_600_000;
  for (let g = 0; g < 400; g++) {
    const url = `${host}/v3/instruments/EUR_USD/candles?price=${price}&granularity=${gran}&from=${encodeURIComponent(cursor)}&count=5000`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`OANDA ${gran} ${r.status}: ${await r.text()}`);
    const j: any = await r.json(); const batch = j.candles ?? []; if (!batch.length) break;
    for (const c of batch) { if (Date.parse(c.time) > toMs) break; out.push(c); }
    const last = batch.at(-1); if (Date.parse(last.time) >= toMs || batch.length < 5000) break;
    cursor = new Date(Date.parse(last.time) + stepMs).toISOString();
  }
  return out;
}
function atr14(cs: { h: number; l: number; c: number }[]) {
  const v: (number | null)[] = []; let prev: number | null = null;
  for (let i = 0; i < cs.length; i++) { const pc = cs[i - 1]?.c ?? cs[i]!.c; const tr = Math.max(cs[i]!.h - cs[i]!.l, Math.abs(cs[i]!.h - pc), Math.abs(cs[i]!.l - pc)); if (i < 13) { v.push(null); continue; } if (prev === null) { let s = 0; for (let j = i - 13; j <= i; j++) { const jpc = cs[j - 1]?.c ?? cs[j]!.c; s += Math.max(cs[j]!.h - cs[j]!.l, Math.abs(cs[j]!.h - jpc), Math.abs(cs[j]!.l - jpc)); } prev = s / 14; } else prev = (prev * 13 + tr) / 14; v.push(prev); }
  return v;
}

interface TVTrade { num: number; setup: string; nyEntry: string; originUtc: Date; tvEntry: number; exitReason: string; tvExit: number; duration: number; netPnl: number; }
const SETUP_HOUR: Record<string, number> = { "07_EXTREME_LONG": 7, "08_BODY_LONG": 8, "10_BODY_INV_LONG": 10 };

function parseCohort(): TVTrade[] {
  const txt = readFileSync(resolve(DIR, "tradingview-trades.csv"), "utf8").replace(/^﻿/, "");
  const rows = txt.split(/\r?\n/).filter((l) => l.trim());
  const h = rows[0]!.split(","); const iNum = h.indexOf("Trade number"), iType = h.indexOf("Type"), iTime = h.indexOf("Date and time"), iSig = h.indexOf("Signal"), iPrice = h.findIndex((c) => c.startsWith("Price")), iPnl = h.findIndex((c) => c.startsWith("Net PnL")), iDur = h.indexOf("Duration (bars)");
  const byNum = new Map<number, any>();
  for (const row of rows.slice(1)) { const c = row.split(","); const num = +c[iNum]!; const t = byNum.get(num) ?? { num }; if (c[iType] === "Entry long") { t.setup = c[iSig]; t.nyEntry = c[iTime]; t.tvEntry = +c[iPrice]!; } else { t.exitReason = c[iSig]; t.tvExit = +c[iPrice]!; t.duration = +c[iDur]!; t.netPnl = +c[iPnl]!; } byNum.set(num, t); }
  return [...byNum.values()].map((t) => ({ ...t, originUtc: nyToUtc(t.nyEntry) })).sort((a, b) => a.originUtc.getTime() - b.originUtc.getTime());
}

// resolve one method: returns {reason, exitPrice, ambiguous}
function resolveM1(m1: any[], tp: number, sl: number) {
  for (const c of m1) {
    const bh = +c.bid.h, bl = +c.bid.l;
    const tpIn = bh >= tp, slIn = bl <= sl;
    if (tpIn && slIn) return { reason: "AMBIGUOUS", exitPrice: sl, ambiguous: true };
    if (tpIn) return { reason: "TP", exitPrice: tp, ambiguous: false };
    if (slIn) return { reason: "SL", exitPrice: sl, ambiguous: false };
  }
  const last = m1.at(-1); return { reason: "TIME", exitPrice: last ? +last.bid.c : NaN, ambiguous: false };
}

async function main() {
  const cohort = parseCohort();
  console.log(`Parsed ${cohort.length} TV trades.`);

  // ---- cohort match / timestamp verification ----
  const setupCounts: Record<string, number> = {}; let tsMismatch = 0; const mismatchRows: string[] = [];
  const seen = new Set<string>(); let dupes = 0;
  for (const t of cohort) {
    setupCounts[t.setup] = (setupCounts[t.setup] ?? 0) + 1;
    const key = `${t.originUtc.toISOString()}|${t.setup}`; if (seen.has(key)) dupes++; else seen.add(key);
    const expH = SETUP_HOUR[t.setup]; const gotH = t.originUtc.getUTCHours();
    if (gotH !== expH || t.originUtc.getUTCMinutes() !== 0) { tsMismatch++; mismatchRows.push(`${t.num},${t.setup},${t.nyEntry},${t.originUtc.toISOString()},expected_${expH}:00,got_${gotH}:00`); }
  }

  // ---- H1 mid for ATR + origin-close validation ----
  const h1raw = await fetchCandles("H1", "M", "2022-10-01T00:00:00Z", new Date().toISOString());
  const h1 = h1raw.filter((c) => c.complete).map((c) => ({ t: new Date(Date.parse(c.time)).toISOString(), o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c }));
  const h1idx = new Map(h1.map((c, i) => [c.t, i]));
  const atr = atr14(h1);

  // ---- per-trade executable replay ----
  const replay: any[] = []; let closeValidationFails = 0; const atrImpliedDiffs: number[] = [];
  for (const t of cohort) {
    const originISO = t.originUtc.toISOString();
    const oi = h1idx.get(originISO);
    const originClose = oi != null ? h1[oi]!.c : null;
    if (originClose != null && Math.abs(originClose - t.tvEntry) > 0.0006) closeValidationFails++;
    const frozenAtr = oi != null ? atr[oi] : null;
    // CSV-implied ATR from TP/SL winners/losers for validation
    if (t.exitReason === "TP_OR_SL" && frozenAtr != null) atrImpliedDiffs.push(Math.abs(t.tvExit - t.tvEntry) - frozenAtr);

    const fillMs = t.originUtc.getTime() + 3_600_000; // origin close
    const m1 = await fetchCandles("M1", "BA", new Date(fillMs).toISOString(), new Date(fillMs + 6 * 3_600_000).toISOString());
    const complete = m1.filter((c) => c.complete);
    const first = complete[0];
    const entryAsk = first ? +first.ask.o : null;
    const entryBid = first ? +first.bid.o : null;
    const spreadPips = entryAsk != null && entryBid != null ? (entryAsk - entryBid) / PIP : null;

    let A: any = null, B: any = null;
    if (frozenAtr != null && entryAsk != null && complete.length) {
      const rA = resolveM1(complete, t.tvEntry + frozenAtr, t.tvEntry - frozenAtr);
      const rB = resolveM1(complete, entryAsk + frozenAtr, entryAsk - frozenAtr);
      A = { ...rA, R: (rA.exitPrice - entryAsk) / frozenAtr };
      B = { ...rB, R: (rB.exitPrice - entryAsk) / frozenAtr };
    }
    // frozen TV outcome in R (1:1): TP win=+1, SL loss=-1, time = (tvExit-tvEntry)/ATR
    const frozenR = frozenAtr == null ? null : t.exitReason === "TP_OR_SL" ? (t.netPnl > 0 ? 1 : t.netPnl < 0 ? -1 : 0) : (t.tvExit - t.tvEntry) / frozenAtr;
    replay.push({ num: t.num, setup: t.setup, year: t.originUtc.getUTCFullYear(), originUtc: originISO, nyEntry: t.nyEntry, tvEntry: t.tvEntry, originClose, frozenAtr, entryAsk, entryBid, spreadPips, tvExitReason: t.exitReason, tvExit: t.tvExit, frozenR, mA: A, mB: B });
    if (replay.length % 25 === 0) console.log(`  replayed ${replay.length}/${cohort.length}`);
  }

  // ---- aggregation ----
  const medDiff = atrImpliedDiffs.slice().sort((a, b) => a - b)[Math.floor(atrImpliedDiffs.length / 2)] ?? 0;
  function agg(rows: any[], pick: (r: any) => any) {
    const rs = rows.map(pick).filter((x) => x && Number.isFinite(x.R));
    const R = rs.map((x) => x.R); const n = R.length; const wins = R.filter((r) => r > 0).length; const losses = R.filter((r) => r < 0).length;
    const gw = R.filter((r) => r > 0).reduce((s, r) => s + r, 0); const gl = R.filter((r) => r < 0).reduce((s, r) => s + Math.abs(r), 0);
    const total = R.reduce((s, r) => s + r, 0);
    const times = rs.filter((x) => x.reason === "TIME").length; const amb = rs.filter((x) => x.ambiguous).length;
    // max drawdown on chronological equity
    let eq = 0, peak = 0, mdd = 0; for (const r of R) { eq += r; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak); }
    return { n, wins, losses, wr: n ? wins / n * 100 : 0, pf: gl ? gw / gl : Infinity, total, exp: n ? total / n : 0, times, amb, mdd };
  }
  const spreadArr = replay.map((r) => r.spreadPips).filter((x) => x != null);
  const avgSpread = spreadArr.reduce((s, x) => s + x, 0) / spreadArr.length;
  const avgSpreadCostR = replay.filter((r) => r.frozenAtr && r.spreadPips != null).reduce((s, r) => s + (r.spreadPips * PIP) / r.frozenAtr, 0) / replay.filter((r) => r.frozenAtr && r.spreadPips != null).length;

  const methods = { A: (r: any) => r.mA, B: (r: any) => r.mB };
  const summary: any = { cohort: { tvTrades: cohort.length, setupCounts, timestampMismatches: tsMismatch, duplicates: dupes, closeValidationFails, atrImpliedMedianDiff: medDiff }, avgSpreadPips: avgSpread, avgSpreadCostR };
  for (const [name, pick] of Object.entries(methods)) {
    const overall = agg(replay, pick);
    const dragArr = replay.map((r) => { const m = pick(r); return m && Number.isFinite(m.R) && r.frozenR != null ? r.frozenR - m.R : null; }).filter((x) => x != null) as number[];
    const drag = dragArr.reduce((s, x) => s + x, 0) / dragArr.length;
    const bySetup: any = {}; for (const s of Object.keys(SETUP_HOUR)) bySetup[s] = agg(replay.filter((r) => r.setup === s), pick);
    const byYear: any = {}; for (const y of [2023, 2024, 2025, 2026]) byYear[y] = agg(replay.filter((r) => r.year === y), pick);
    // transitions vs frozen
    let winToLoss = 0, lossToWin = 0, tpMiss = 0, spreadStop = 0;
    for (const r of replay) { const m = pick(r); if (!m || !Number.isFinite(m.R) || r.frozenR == null) continue; const fWin = r.frozenR > 0, eWin = m.R > 0; if (fWin && !eWin) winToLoss++; if (!fWin && eWin) lossToWin++; if (r.tvExitReason === "TP_OR_SL" && r.frozenR > 0 && m.reason !== "TP") tpMiss++; if (r.frozenR > 0 && m.reason === "SL") spreadStop++; }
    summary[name] = { overall, avgDragR: drag, bySetup, byYear, transitions: { winToLoss, lossToWin, tpMissedByBid: tpMiss, stopHitOnFrozenWinner: spreadStop } };
  }

  // ---- write artifacts ----
  writeFileSync(resolve(DIR, "RESULTS.json"), JSON.stringify(summary, null, 2));
  const tr = ["num,setup,year,originUtc,nyEntry,tvEntry,originClose,frozenAtr,entryAsk,entryBid,spreadPips,tvExitReason,tvExit,frozenR,A_reason,A_exit,A_R,B_reason,B_exit,B_R"];
  for (const r of replay) tr.push([r.num, r.setup, r.year, r.originUtc, r.nyEntry, r.tvEntry, r.originClose, r.frozenAtr?.toFixed(6), r.entryAsk, r.entryBid, r.spreadPips?.toFixed(2), r.tvExitReason, r.tvExit, r.frozenR?.toFixed(4), r.mA?.reason, r.mA?.exitPrice?.toFixed(5), r.mA?.R?.toFixed(4), r.mB?.reason, r.mB?.exitPrice?.toFixed(5), r.mB?.R?.toFixed(4)].join(","));
  writeFileSync(resolve(DIR, "trade_replay.csv"), tr.join("\n"));
  const cm = ["num,setup,nyEntry,originUtc,expectedHour,gotHour,match"];
  for (const t of cohort) { const exp = SETUP_HOUR[t.setup]; const got = t.originUtc.getUTCHours(); cm.push(`${t.num},${t.setup},${t.nyEntry},${t.originUtc.toISOString()},${exp},${got},${exp === got && t.originUtc.getUTCMinutes() === 0 ? "OK" : "MISMATCH"}`); }
  writeFileSync(resolve(DIR, "cohort_match.csv"), cm.join("\n"));
  const sa = ["num,setup,originUtc,spreadPips,frozenAtr,spreadCostR,entryAsk,entryBid"];
  for (const r of replay) sa.push(`${r.num},${r.setup},${r.originUtc},${r.spreadPips?.toFixed(2)},${r.frozenAtr?.toFixed(6)},${r.frozenAtr && r.spreadPips != null ? ((r.spreadPips * PIP) / r.frozenAtr).toFixed(4) : ""},${r.entryAsk},${r.entryBid}`);
  writeFileSync(resolve(DIR, "spread_analysis.csv"), sa.join("\n"));

  console.log("\n===== SUMMARY =====");
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(resolve(DIR, "_summary_console.json"), JSON.stringify(summary, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
