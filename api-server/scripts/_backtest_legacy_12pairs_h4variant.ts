/**
 * Two-variant backtest for the legacy-v2 daemon:
 *   (A) Baseline: same 10 gates as the daemon, on the 12 pairs it runs
 *   (B) H4 removed: identical to (A) but skips the H4 "does not oppose" gate
 *
 * Reports for each variant: fire rate (trades/day, gap distribution), quality
 * (winrate, expectancy, PF), and side-by-side comparison so the volume/edge
 * tradeoff is explicit before touching production gates.
 *
 * Reuses cached candles from backtest-legacy-batch1/candles/ for the 6
 * overlapping pairs; fetches the other 6 into its own cache dir.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { labelOutcome } = await import("../src/research.js");

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";

const OUT_DIR = path.join(serviceRoot, "..", "backtest-legacy-12pairs");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const CACHE_DIR = path.join(OUT_DIR, "candles");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
const SHARED_CACHE_DIR = path.join(serviceRoot, "..", "backtest-legacy-batch1", "candles");

const PAIRS = ["USD_JPY", "AUD_USD", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP", "NZD_USD", "XAU_USD"];
const YEARS_BACK = 4;

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};
const GRAN_MIN: Record<string, number> = { M15: 15, H1: 60, H4: 240 };

async function fetchPage(inst: string, gran: string, fromIso: string): Promise<Q[]> {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=${gran}&count=5000&from=${encodeURIComponent(fromIso)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`  FETCH FAIL ${inst} ${gran} ${r.status}`); return []; }
  const j = await r.json() as { candles?: Array<Record<string, never>> };
  const step = GRAN_MIN[gran]! * 60_000;
  return (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
    const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    const mid = (b: number, a: number) => (b + a) / 2;
    return {
      closeTime: new Date(Date.parse(x.time) + step).toISOString(),
      open: mid(+x.bid.o, +x.ask.o), high: mid(+x.bid.h, +x.ask.h), low: mid(+x.bid.l, +x.ask.l), close: mid(+x.bid.c, +x.ask.c),
      bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
      askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
    };
  });
}
async function fetchAll(inst: string, gran: string, fromIso: string, toIso: string): Promise<Q[]> {
  const localCache = path.join(CACHE_DIR, `${inst}_${gran}.json`);
  if (existsSync(localCache)) {
    const c = JSON.parse(readFileSync(localCache, "utf8")) as { from: string; to: string; bars: Q[] };
    if (c.from === fromIso && c.to === toIso) { console.log(`  ${inst} ${gran}: ${c.bars.length} (cached-local)`); return c.bars; }
  }
  const shared = path.join(SHARED_CACHE_DIR, `${inst}_${gran}.json`);
  if (existsSync(shared)) {
    const c = JSON.parse(readFileSync(shared, "utf8")) as { from: string; to: string; bars: Q[] };
    if (c.from === fromIso && c.to === toIso) { console.log(`  ${inst} ${gran}: ${c.bars.length} (cached-shared)`); return c.bars; }
  }
  const out: Q[] = [];
  let cursor = fromIso;
  const toMs = Date.parse(toIso);
  for (let page = 0; page < 60; page++) {
    const b = await fetchPage(inst, gran, cursor);
    if (b.length === 0) break;
    out.push(...b);
    const lastMs = Date.parse(b[b.length - 1]!.closeTime);
    if (lastMs >= toMs || b.length < 5000) break;
    cursor = new Date(lastMs + 60_000).toISOString();
  }
  writeFileSync(localCache, JSON.stringify({ from: fromIso, to: toIso, bars: out }));
  console.log(`  ${inst} ${gran}: ${out.length} fetched`);
  return out;
}

function ema(values: number[], period: number): number[] {
  const out: number[] = []; if (!values.length) return out;
  const k = 2 / (period + 1);
  let e = values[0]!; out.push(e);
  for (let i = 1; i < values.length; i++) { e = values[i]! * k + e * (1 - k); out.push(e); }
  return out;
}
function atr(bars: Q[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  const trs: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) { trs[i] = b.high - b.low; continue; }
    const p = bars[i - 1]!;
    trs[i] = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i]!;
  if (trs.length >= period) {
    let a = sum / period; out[period - 1] = a;
    for (let i = period; i < trs.length; i++) { a = (a * (period - 1) + trs[i]!) / period; out[i] = a; }
  }
  return out;
}
function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const up = d > 0 ? d : 0; const dn = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + up) / period;
    loss = (loss * (period - 1) + dn) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function pipSize(inst: string): number {
  if (inst === "XAU_USD") return 0.1;
  return inst.endsWith("JPY") ? 0.01 : 0.0001;
}
function spreadCap(inst: string): number {
  if (inst === "XAU_USD") return 30;
  if (inst.includes("JPY") && !inst.startsWith("USD_JPY")) return 4;
  return 3;
}
function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function inSession(iso: string): boolean { const h = etHour(iso); return h >= 3 && h < 12; }
function htfBias(closeTime: string, bars: Q[], e21: number[], e50: number[]): -1 | 0 | 1 {
  const t = Date.parse(closeTime);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return 0;
  const a = e21[k]; const b = e50[k];
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const spread = Math.abs(a - b) / (bars[k]!.close || 1);
  if (spread < 1e-5) return 0;
  return a > b ? 1 : -1;
}

type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  entry: number; stop: number; target: number; stopPips: number; targetPips: number;
  spreadPips: number; atrPips: number; rsi: number; sessionHourEt: number;
  outcome: string; resultR: number | null; resolvedAt: string | null; horizonEndsAt: string;
};

function runOnce(useH4Gate: boolean): Trade[] {
  const trades: Trade[] = [];
  for (const pair of PAIRS) {
    const m15 = ALL_M15[pair]!;
    const h1 = ALL_H1[pair]!;
    const h4 = ALL_H4[pair]!;
    if (!m15 || m15.length < 300) continue;
    const closes = m15.map((b) => b.close);
    const e21 = ema(closes, 21); const e50 = ema(closes, 50); const e200 = ema(closes, 200);
    const a14 = atr(m15, 14); const r14 = rsi(closes, 14);
    const h1e21 = ema(h1.map((b) => b.close), 21); const h1e50 = ema(h1.map((b) => b.close), 50);
    const h4e21 = ema(h4.map((b) => b.close), 21); const h4e50 = ema(h4.map((b) => b.close), 50);
    const pip = pipSize(pair); const sc = spreadCap(pair);
    let openUntil = 0;
    for (let i = 210; i < m15.length - 1; i++) {
      const bar = m15[i]!;
      const t = Date.parse(bar.closeTime);
      if (t < openUntil) continue;
      if (!inSession(bar.closeTime)) continue;
      const f21 = e21[i]!, f50 = e50[i]!, f200 = e200[i]!;
      const bullish = f21 > f50 && f50 > f200;
      const bearish = f21 < f50 && f50 < f200;
      const dir = bullish ? ("long" as const) : bearish ? ("short" as const) : null;
      if (!dir) continue;
      const need = dir === "long" ? 1 : -1;
      const h1b = htfBias(bar.closeTime, h1, h1e21, h1e50);
      if (h1b !== need) continue;
      if (useH4Gate) {
        const h4b = htfBias(bar.closeTime, h4, h4e21, h4e50);
        if (h4b === -need) continue;
      }
      const atrV = a14[i]!;
      if (!Number.isFinite(atrV) || atrV <= 0) continue;
      const zoneLo = Math.min(f21, f50) - 0.35 * atrV;
      const zoneHi = Math.max(f21, f50) + 0.35 * atrV;
      if (!(bar.low <= zoneHi && bar.high >= zoneLo)) continue;
      if (dir === "long" ? bar.low <= f200 : bar.high >= f200) continue;
      const win = m15.slice(Math.max(0, i - 5), i);
      const prevHi = Math.max(...win.map((b) => b.high));
      const prevLo = Math.min(...win.map((b) => b.low));
      if (dir === "long" ? bar.close <= prevHi : bar.close >= prevLo) continue;
      const prev = m15[i - 1]!;
      const bodyNow = Math.abs(bar.close - bar.open);
      const bodyPrev = Math.abs(prev.close - prev.open);
      const closedDir = dir === "long" ? bar.close > bar.open : bar.close < bar.open;
      const engulfs = bodyNow >= bodyPrev
        && Math.min(bar.open, bar.close) <= Math.min(prev.open, prev.close)
        && Math.max(bar.open, bar.close) >= Math.max(prev.open, prev.close);
      if (!closedDir || !engulfs) continue;
      const rv = r14[i];
      if (rv === undefined || !Number.isFinite(rv)) continue;
      if (dir === "long" && !(rv >= 45 && rv <= 70)) continue;
      if (dir === "short" && !(rv >= 30 && rv <= 55)) continue;
      const atrPips = atrV / pip;
      if (atrPips < 5) continue;
      const spreadPips = (bar.askClose - bar.bidClose) / pip;
      if (!Number.isFinite(spreadPips) || spreadPips > sc) continue;

      const swWin = m15.slice(Math.max(0, i - 10), i + 1);
      const rawStop = dir === "long" ? Math.min(...swWin.map((b) => b.low)) : Math.max(...swWin.map((b) => b.high));
      const entry = dir === "long" ? bar.askClose : bar.bidClose;
      const risk = Math.abs(entry - rawStop);
      if (risk <= 0 || risk / entry < 1e-6) continue;
      const target = dir === "long" ? entry + 1.5 * risk : entry - 1.5 * risk;

      const forward = m15.slice(i + 1);
      const res = labelOutcome(dir, entry, rawStop, target, bar.closeTime, forward as never);
      const resolvedMs = res.resolvedAt ? Date.parse(res.resolvedAt) : (t + 48 * 3600e3);
      trades.push({
        pair, direction: dir, decisionTime: bar.closeTime,
        entry, stop: rawStop, target, stopPips: risk / pip, targetPips: (1.5 * risk) / pip, spreadPips,
        atrPips, rsi: rv, sessionHourEt: etHour(bar.closeTime),
        outcome: res.outcome, resultR: res.resultR, resolvedAt: res.resolvedAt, horizonEndsAt: res.horizonEndsAt,
      });
      openUntil = resolvedMs;
    }
  }
  return trades;
}

// --- fetch data ---
const now = new Date();
const fromIso = new Date(now.getTime() - YEARS_BACK * 365 * 86400e3).toISOString();
const toIso = now.toISOString();
console.log(`fetching ${YEARS_BACK}y M15/H1/H4 for ${PAIRS.length} pairs`);
const ALL_M15: Record<string, Q[]> = {};
const ALL_H1: Record<string, Q[]> = {};
const ALL_H4: Record<string, Q[]> = {};
for (const p of PAIRS) {
  console.log(`--- ${p} ---`);
  ALL_M15[p] = await fetchAll(p, "M15", fromIso, toIso);
  ALL_H1[p] = await fetchAll(p, "H1", fromIso, toIso);
  ALL_H4[p] = await fetchAll(p, "H4", fromIso, toIso);
}

// --- run both variants ---
console.log(`\nrunning variant A (12 pairs, strict H4 gate)…`);
const tradesA = runOnce(true);
console.log(`  → ${tradesA.length} trades`);
console.log(`\nrunning variant B (12 pairs, H4 gate REMOVED)…`);
const tradesB = runOnce(false);
console.log(`  → ${tradesB.length} trades`);

writeFileSync(path.join(OUT_DIR, "variantA_strict.json"), JSON.stringify({ scope: { variant: "A", h4Gate: true, pairs: PAIRS }, trades: tradesA }, null, 1));
writeFileSync(path.join(OUT_DIR, "variantB_no_h4.json"), JSON.stringify({ scope: { variant: "B", h4Gate: false, pairs: PAIRS }, trades: tradesB }, null, 1));

// --- summarize ---
type Agg = { n: number; w: number; l: number; totalR: number; grossW: number; grossL: number; sumAbsR: number };
const empty = (): Agg => ({ n: 0, w: 0, l: 0, totalR: 0, grossW: 0, grossL: 0, sumAbsR: 0 });
const push = (a: Agg, r: number) => { a.n++; a.totalR += r; a.sumAbsR += Math.abs(r); if (r > 0) { a.w++; a.grossW += r; } else if (r < 0) { a.l++; a.grossL += r; } };

function stats(label: string, trades: Trade[]) {
  const days = new Set(trades.map((t) => t.decisionTime.slice(0, 10)));
  const tradingDaysSpan = YEARS_BACK * 260;
  const a = empty();
  for (const t of trades) { const r = t.resultR ?? 0; if (t.outcome === "ambiguous" || t.resultR === null) continue; push(a, r); }
  const wr = a.n ? 100 * a.w / a.n : 0;
  const exp = a.n ? a.totalR / a.n : 0;
  const pf = a.grossL < 0 ? a.grossW / Math.abs(a.grossL) : Infinity;
  trades.sort((x, y) => Date.parse(x.decisionTime) - Date.parse(y.decisionTime));
  const gaps: number[] = [];
  for (let i = 1; i < trades.length; i++) gaps.push((Date.parse(trades[i]!.decisionTime) - Date.parse(trades[i - 1]!.decisionTime)) / 3600e3);
  gaps.sort((x, y) => x - y);
  const q = (p: number) => gaps.length ? gaps[Math.floor(p * gaps.length)]! : 0;
  console.log(`\n=== ${label} ===`);
  console.log(`  trades:               ${trades.length}`);
  console.log(`  trades/day (avg):     ${(trades.length / tradingDaysSpan).toFixed(2)}`);
  console.log(`  trades/week (avg):    ${(trades.length / (YEARS_BACK * 52)).toFixed(1)}`);
  console.log(`  days with any trade:  ${days.size} (${(100 * days.size / tradingDaysSpan).toFixed(0)}% of trading days)`);
  console.log(`  gap median: ${q(0.5).toFixed(1)}h   p75: ${q(0.75).toFixed(1)}h   p90: ${q(0.9).toFixed(1)}h   max: ${gaps.length ? gaps[gaps.length - 1]!.toFixed(1) : "n/a"}h`);
  console.log(`  QUALITY: winrate ${wr.toFixed(1)}%  exp=${(exp >= 0 ? "+" : "") + exp.toFixed(4)}R/trade  totalR ${(a.totalR >= 0 ? "+" : "") + a.totalR.toFixed(2)}  PF ${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`);
  const byPair: Record<string, number> = {};
  for (const t of trades) byPair[t.pair] = (byPair[t.pair] ?? 0) + 1;
  console.log(`  by pair (trades over 4y):`);
  for (const p of PAIRS) console.log(`    ${p.padEnd(8)} ${String(byPair[p] ?? 0).padStart(4)}  (~${(((byPair[p] ?? 0)) / (YEARS_BACK * 52)).toFixed(2)}/week)`);
}
stats("VARIANT A — 12 pairs, strict recipe (matches current daemon)", tradesA);
stats("VARIANT B — 12 pairs, H4 gate REMOVED (candidate loosening)", tradesB);

// per-pair edge — how does each pair perform under each variant
function perPairEdge(label: string, trades: Trade[]) {
  console.log(`\n${label} — per-pair edge:`);
  const bp: Record<string, Agg> = {};
  for (const t of trades) {
    if (t.outcome === "ambiguous" || t.resultR === null) continue;
    if (!bp[t.pair]) bp[t.pair] = empty();
    push(bp[t.pair]!, t.resultR);
  }
  for (const p of PAIRS) {
    const a = bp[p];
    if (!a || a.n === 0) { console.log(`  ${p.padEnd(8)}  n=0`); continue; }
    const pf = a.grossL < 0 ? a.grossW / Math.abs(a.grossL) : Infinity;
    console.log(`  ${p.padEnd(8)}  n=${String(a.n).padStart(4)}  wr=${(100 * a.w / a.n).toFixed(1).padStart(4)}%  exp=${(a.totalR / a.n >= 0 ? "+" : "") + (a.totalR / a.n).toFixed(4)}R  totalR=${(a.totalR >= 0 ? "+" : "") + a.totalR.toFixed(2).padStart(6)}  PF=${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`);
  }
}
perPairEdge("A", tradesA);
perPairEdge("B", tradesB);

console.log(`\nwrote variantA_strict.json / variantB_no_h4.json under ${OUT_DIR}`);
process.exit(0);
