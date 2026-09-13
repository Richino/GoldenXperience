/**
 * GX EURUSD M1 Sweep Reclaim V3 (4AM SHORT, 1:1, 0.35 ATR) — OANDA executable
 * bid/ask validation of the frozen 46-trade cohort. RESEARCH ONLY. No orders.
 *
 * SHORT execution: entry at executable BID (signal M1 close = signalMin+1),
 * cover at executable ASK, TP/SL detected on the ASK side, max hold 10 M1 bars.
 * Frozen SL/TP levels preserved (tvEntry +/- 0.35*ATR14). Intrabar TP+SL in the
 * same M1 bar => AMBIGUOUS (never resolved favorably).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const DIR = import.meta.dirname;
for (const line of (() => { try { return readFileSync(resolve(DIR, "../../.env"), "utf8").split(/\r?\n/); } catch { return []; } })()) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, ""); }
const env = (k: string) => (process.env[k] ?? "").trim().replace(/^["']|["']$/g, "");
const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const host = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const PIP = 0.0001, ATR_STOP = 0.35, MAX_HOLD = 10;

function nyOffset(y: number, mo: number, d: number, h: number) { const s = (() => { const f = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ((7 - f) % 7) + 1 + 7; })(); const n = (() => { const f = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ((7 - f) % 7) + 1; })(); const a = mo > 3 || (mo === 3 && (d > s || (d === s && h >= 2))); const b = mo < 11 || (mo === 11 && (d < n || (d === n && h < 2))); return a && b ? -4 : -5; }
function nyToUtc(local: string) { const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local.trim())!; const [, ys, mos, ds, hs, mis] = m; const y = +ys!, mo = +mos!, d = +ds!, h = +hs!, mi = +mis!; return new Date(Date.UTC(y, mo - 1, d, h - nyOffset(y, mo, d, h), mi)); }

async function fetchM1BA(fromISO: string, toISO: string) {
  const out: any[] = []; let cursor = fromISO; const toMs = Date.parse(toISO);
  for (let g = 0; g < 400; g++) {
    const url = `${host}/v3/instruments/EUR_USD/candles?price=BA&granularity=M1&from=${encodeURIComponent(cursor)}&count=5000`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error(`M1 ${r.status}`);
    const j: any = await r.json(); const b = j.candles ?? []; if (!b.length) break;
    for (const c of b) { if (Date.parse(c.time) > toMs) break; if (c.complete) out.push({ t: Date.parse(c.time), bo: +c.bid.o, bh: +c.bid.h, bl: +c.bid.l, bc: +c.bid.c, ao: +c.ask.o, ah: +c.ask.h, al: +c.ask.l, ac: +c.ask.c, mo: (+c.bid.o + +c.ask.o) / 2, mh: (+c.bid.h + +c.ask.h) / 2, ml: (+c.bid.l + +c.ask.l) / 2, mc: (+c.bid.c + +c.ask.c) / 2 }); }
    const last = b.at(-1); if (Date.parse(last.time) >= toMs || b.length < 5000) break; cursor = new Date(Date.parse(last.time) + 60_000).toISOString();
  }
  return out.sort((a, b) => a.t - b.t);
}
function atr14mid(cs: any[]) { const v: (number | null)[] = []; let prev: number | null = null; for (let i = 0; i < cs.length; i++) { const pc = cs[i - 1]?.mc ?? cs[i].mc; const tr = Math.max(cs[i].mh - cs[i].ml, Math.abs(cs[i].mh - pc), Math.abs(cs[i].ml - pc)); if (i < 13) { v.push(null); continue; } if (prev === null) { let s = 0; for (let j = i - 13; j <= i; j++) { const jpc = cs[j - 1]?.mc ?? cs[j].mc; s += Math.max(cs[j].mh - cs[j].ml, Math.abs(cs[j].mh - jpc), Math.abs(cs[j].ml - jpc)); } prev = s / 14; } else prev = (prev * 13 + tr) / 14; v.push(prev); } return v; }

interface TV { num: number; nyEntry: string; originUtc: Date; tvEntry: number; tvExit: number; netPnl: number; duration: number; }
function parseCohort(): TV[] {
  const txt = readFileSync(resolve(DIR, "tradingview-trades.csv"), "utf8").replace(/^﻿/, "");
  const rows = txt.split(/\r?\n/).filter((l) => l.trim()); const h = rows[0]!.split(",");
  const iNum = h.indexOf("Trade number"), iType = h.indexOf("Type"), iTime = h.indexOf("Date and time"), iPrice = h.findIndex((c) => c.startsWith("Price")), iPnl = h.findIndex((c) => c.startsWith("Net PnL")), iDur = h.indexOf("Duration (bars)");
  const by = new Map<number, any>();
  for (const row of rows.slice(1)) { const c = row.split(","); const num = +c[iNum]!; const t = by.get(num) ?? { num }; if (c[iType] === "Entry short") { t.nyEntry = c[iTime]; t.tvEntry = +c[iPrice]!; } else { t.tvExit = +c[iPrice]!; t.netPnl = +c[iPnl]!; t.duration = +c[iDur]!; } by.set(num, t); }
  return [...by.values()].map((t) => ({ ...t, originUtc: nyToUtc(t.nyEntry) })).sort((a, b) => a.originUtc.getTime() - b.originUtc.getTime());
}

async function main() {
  const cohort = parseCohort();
  const m1 = await fetchM1BA("2026-08-24T00:00:00Z", "2026-09-11T10:00:00Z");
  const atr = atr14mid(m1);
  const idx = new Map<number, number>(); m1.forEach((c, i) => idx.set(c.t, i));

  // ---- Phase 1 parity + Phase 2 replay ----
  let matched = 0, unmatched = 0, tsMismatch = 0, priceMismatch = 0, dupes = 0;
  const seen = new Set<number>(); const replay: any[] = []; const atrDiffs: number[] = [];
  for (const t of cohort) {
    const sigMs = t.originUtc.getTime();
    if (seen.has(sigMs)) dupes++; else seen.add(sigMs);
    // NY hour must be 04
    const nyH = +/(\d{2}):(\d{2})$/.exec(t.nyEntry)![1]!;
    if (nyH !== 4) tsMismatch++;
    const si = idx.get(sigMs);
    if (si == null) { unmatched++; replay.push({ ...t, matched: false }); continue; }
    matched++;
    const sigMid = m1[si]!.mc;
    if (Math.abs(sigMid - t.tvEntry) > 0.00006) priceMismatch++;
    const frozenAtr = atr[si]; const riskDist = frozenAtr != null ? ATR_STOP * frozenAtr : null;
    if (riskDist != null) atrDiffs.push(riskDist - Math.abs(t.tvExit - t.tvEntry));
    // entry fill at signal close = signalMin + 1
    const fi = idx.get(sigMs + 60_000);
    const entryBid = fi != null ? m1[fi]!.bo : null;
    const entryAsk = fi != null ? m1[fi]!.ao : null;
    const spreadPips = entryBid != null && entryAsk != null ? (entryAsk - entryBid) / PIP : null;
    // Method A (frozen levels): stop=tvEntry+risk, target=tvEntry-risk. SHORT covers on ASK.
    let reason = "UNRESOLVED", exitPrice: number | null = null, ambiguous = false, tpMissed = false, spreadStop = false;
    if (fi != null && riskDist != null) {
      const stop = t.tvEntry + riskDist, target = t.tvEntry - riskDist;
      for (let k = 0; k < MAX_HOLD; k++) {
        const c = m1[fi + k]; if (!c) { reason = "OPEN"; break; }
        const slHit = c.ah >= stop;       // ask rises to stop (short SL)
        const tpHit = c.al <= target;     // ask falls to target (short TP)
        if (slHit && tpHit) { reason = "AMBIGUOUS"; ambiguous = true; exitPrice = stop; spreadStop = true; break; }
        if (slHit) { reason = "SL"; exitPrice = stop; spreadStop = true; break; }
        if (tpHit) { reason = "TP"; exitPrice = target; break; }
        if (k === MAX_HOLD - 1) { reason = "TIME"; exitPrice = c.ac; }
      }
      if (t.netPnl > 0 && reason !== "TP") tpMissed = true; // frozen winner whose ask never reached TP
    }
    const execR = exitPrice != null && entryBid != null && riskDist != null ? (entryBid - exitPrice) / riskDist : null;
    const frozenR = t.netPnl > 0 ? 1 : t.netPnl < 0 ? -1 : 0;
    replay.push({ num: t.num, matched: true, originUtc: t.originUtc.toISOString(), nyEntry: t.nyEntry, tvEntry: t.tvEntry, sigMid, tvExit: t.tvExit, frozenAtr, riskDist, entryBid, entryAsk, spreadPips, reason, exitPrice, ambiguous, tpMissed, spreadStop, execR, frozenR });
    await new Promise((r) => setTimeout(r, 0));
  }

  // ---- Phase 3 stats ----
  const midR = replay.filter((r) => r.matched).map((r) => r.frozenR);
  const execAll = replay.filter((r) => r.matched && r.execR != null);
  const execResolved = execAll.filter((r) => !r.ambiguous && r.reason !== "OPEN");
  const stat = (rs: number[]) => { const n = rs.length, w = rs.filter((x) => x > 0).length, l = rs.filter((x) => x < 0).length, gw = rs.filter((x) => x > 0).reduce((s, x) => s + x, 0), gl = rs.filter((x) => x < 0).reduce((s, x) => s + Math.abs(x), 0); return { n, w, l, wr: n ? w / n * 100 : 0, pf: gl ? gw / gl : (gw > 0 ? Infinity : 0), total: rs.reduce((s, x) => s + x, 0), exp: n ? rs.reduce((s, x) => s + x, 0) / n : 0 }; };
  const mid = stat(midR);
  const exec = stat(execResolved.map((r) => r.execR));
  const spreads = replay.filter((r) => r.spreadPips != null).map((r) => r.spreadPips).sort((a, b) => a - b);
  const avgSpread = spreads.reduce((s, x) => s + x, 0) / spreads.length, medSpread = spreads[Math.floor(spreads.length / 2)];
  const avgRiskPips = execAll.reduce((s, r) => s + r.riskDist / PIP, 0) / execAll.length;
  const spreadPctOf1R = (avgSpread / avgRiskPips) * 100;
  const dragArr = execResolved.map((r) => r.frozenR - r.execR); const totalDrag = dragArr.reduce((s, x) => s + x, 0); const avgDrag = totalDrag / dragArr.length;
  const winToLoss = execResolved.filter((r) => r.frozenR > 0 && r.execR < 0).length;
  const tpMissed = execAll.filter((r) => r.tpMissed).length;
  const spreadStops = execAll.filter((r) => r.spreadStop && !r.ambiguous).length;
  const ambiguous = execAll.filter((r) => r.ambiguous).length;
  const timeExits = execAll.filter((r) => r.reason === "TIME").length;

  const summary = {
    phase1: { tvTrades: cohort.length, matched, unmatched, duplicates: dupes, timestampMismatches: tsMismatch, entryPriceMismatches: priceMismatch, atrImpliedMedianDiffPips: (atrDiffs.slice().sort((a, b) => a - b)[Math.floor(atrDiffs.length / 2)] ?? 0) / PIP },
    mid: { N: mid.n, wins: mid.w, losses: mid.l, wr: mid.wr, pf: mid.pf, exp: mid.exp },
    exec: { N_resolved: exec.n, wins: exec.w, losses: exec.l, wr: exec.wr, pf: exec.pf, exp: exec.exp, total: exec.total },
    costs: { avgSpreadPips: avgSpread, medianSpreadPips: medSpread, avgRiskPips, spreadPctOf1R, avgDragR: avgDrag, totalDragR: totalDrag, winnersToLosers: winToLoss, tpMissedAskNeverReached: tpMissed, spreadStops, ambiguous, timeExits, unresolvedOpen: execAll.filter((r) => r.reason === "OPEN").length },
  };
  writeFileSync(resolve(DIR, "RESULTS.json"), JSON.stringify(summary, null, 2));
  const tr = ["num,originUtc,nyEntry,tvEntry,sigMid,tvExit,frozenAtr,riskPips,entryBid,entryAsk,spreadPips,reason,exitPrice,frozenR,execR,ambiguous"];
  for (const r of replay.filter((x) => x.matched)) tr.push([r.num, r.originUtc, r.nyEntry, r.tvEntry, r.sigMid?.toFixed(6), r.tvExit, r.frozenAtr?.toFixed(6), (r.riskDist / PIP)?.toFixed(3), r.entryBid, r.entryAsk, r.spreadPips?.toFixed(2), r.reason, r.exitPrice?.toFixed(6), r.frozenR, r.execR?.toFixed(3), r.ambiguous].join(","));
  writeFileSync(resolve(DIR, "trade_replay.csv"), tr.join("\n"));
  const cm = ["num,nyEntry,originUtc,nyHour,dir,tvEntry,oandaMid,priceDiffPips,matched"];
  for (const r of replay.filter((x) => x.matched)) cm.push(`${r.num},${r.nyEntry},${r.originUtc},4,short,${r.tvEntry},${r.sigMid?.toFixed(6)},${((r.sigMid - r.tvEntry) / PIP).toFixed(2)},OK`);
  writeFileSync(resolve(DIR, "cohort_match.csv"), cm.join("\n"));
  const sa = ["num,originUtc,spreadPips,riskPips,spreadPctOf1R,entryBid,entryAsk,reason,execR"];
  for (const r of replay.filter((x) => x.matched && x.spreadPips != null)) sa.push(`${r.num},${r.originUtc},${r.spreadPips.toFixed(2)},${(r.riskDist / PIP).toFixed(3)},${((r.spreadPips) / (r.riskDist / PIP) * 100).toFixed(0)},${r.entryBid},${r.entryAsk},${r.reason},${r.execR?.toFixed(3)}`);
  writeFileSync(resolve(DIR, "spread_analysis.csv"), sa.join("\n"));

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
