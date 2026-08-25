/**
 * Historical backtest of the batch-1 legacy EMA-pullback strategy.
 * RESEARCH ONLY. No DB writes. Uses live labelOutcome resolver for exits
 * (16:45 ET forced close, 48h horizon, conservative ambiguity).
 *
 * Recipe (from batch-1 recorded `conditions` field):
 *   1) EMA21/50/200 stack aligned (long: 21>50>200; short: reversed)
 *   2) H1 agrees with 15m direction (EMA21 vs EMA50 on H1)
 *   3) H4 does NOT oppose (matches or is neutral)
 *   4) Pullback: close inside the [min(EMA21,EMA50)-0.35*ATR, max+0.35*ATR] zone
 *      with EMA200 not lost (close on trend side of EMA200)
 *   5) Market-structure break: close beyond recent 5-bar high/low (in signal dir)
 *   6) Confirmation candle: last bar body engulfs prior bar body & closes in dir
 *   7) RSI14 in trend-supporting range (long 45..70, short 30..55)
 *   8) ATR14 sufficient (>= 5 pips)
 *   9) Session = London (03-08 ET) or London/NY overlap (08-12 ET)
 *  10) Spread cap: askClose-bidClose <= 3 pips (majors) at signal bar
 * Stop = 10-bar structural swing; Target = entry ± 2.0 * risk.
 * Entry fill: ask (long) / bid (short) at signal bar close.
 * One open trade per instrument at a time (release at actual exit).
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
const OUT_DIR = path.join(serviceRoot, "..", "backtest-legacy-batch1-2R");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const OUT = process.env.OUT ?? path.join(OUT_DIR, "trades.json");
const CACHE_DIR = path.join(serviceRoot, "..", "backtest-legacy-batch1", "candles");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const PAIRS = ["USD_JPY", "AUD_USD", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF"];
const TARGET_TRADES = 2000;
const YEARS_BACK = 4; // go back this far; stop early once we hit TARGET_TRADES

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
  const cache = path.join(CACHE_DIR, `${inst}_${gran}.json`);
  if (existsSync(cache)) {
    const cached = JSON.parse(readFileSync(cache, "utf8")) as { from: string; to: string; bars: Q[] };
    if (cached.from === fromIso && cached.to === toIso) { console.log(`  ${inst} ${gran}: ${cached.bars.length} bars (cached)`); return cached.bars; }
  }
  const out: Q[] = [];
  let cursor = fromIso;
  const toMs = Date.parse(toIso);
  for (let page = 0; page < 60; page++) {
    const batch = await fetchPage(inst, gran, cursor);
    if (batch.length === 0) break;
    out.push(...batch);
    const lastMs = Date.parse(batch[batch.length - 1]!.closeTime);
    if (lastMs >= toMs || batch.length < 5000) break;
    cursor = new Date(lastMs + 60_000).toISOString();
  }
  writeFileSync(cache, JSON.stringify({ from: fromIso, to: toIso, bars: out }));
  console.log(`  ${inst} ${gran}: ${out.length} bars fetched`);
  return out;
}

// ---- indicators (all incremental / windowed) ----
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
  // Wilder's smoothing
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i]!;
  if (trs.length >= period) {
    let a = sum / period;
    out[period - 1] = a;
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

function pipSize(inst: string): number { return inst.endsWith("JPY") ? 0.01 : 0.0001; }

function etHour(iso: string): number {
  // Convert UTC to America/New_York (handles DST via Intl)
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(h) % 24;
}
function inSession(iso: string): boolean {
  const h = etHour(iso);
  return h >= 3 && h < 12; // London (3-8) + London/NY overlap (8-12)
}

function htfBias(closeTime: string, bars: Q[], f21: number[], f50: number[]): -1 | 0 | 1 {
  // most-recent complete HTF bar with closeTime <= this M15 closeTime
  const t = Date.parse(closeTime);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return 0;
  const a = f21[k]; const b = f50[k];
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const spread = Math.abs(a - b) / (bars[k]!.close || 1);
  if (spread < 1e-5) return 0; // effectively neutral
  return a > b ? 1 : -1;
}

// ---- run per pair ----
const now = new Date();
const fromIso = new Date(now.getTime() - YEARS_BACK * 365 * 86400e3).toISOString();
const toIso = now.toISOString();
console.log(`fetching ${YEARS_BACK}y M15/H1/H4 for ${PAIRS.length} pairs (${fromIso} → ${toIso})`);

type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  entry: number; stop: number; target: number; stopPips: number; targetPips: number; spreadPips: number;
  atrPips: number; rsi: number; sessionHourEt: number;
  outcome: string; resultR: number | null; resolvedAt: string | null; horizonEndsAt: string;
};

const trades: Trade[] = [];

for (const pair of PAIRS) {
  console.log(`\n--- ${pair} ---`);
  const m15 = await fetchAll(pair, "M15", fromIso, toIso);
  const h1 = await fetchAll(pair, "H1", fromIso, toIso);
  const h4 = await fetchAll(pair, "H4", fromIso, toIso);
  if (m15.length < 300) { console.log(`  too few M15 bars, skip`); continue; }

  const closes15 = m15.map((b) => b.close);
  const e21 = ema(closes15, 21); const e50 = ema(closes15, 50); const e200 = ema(closes15, 200);
  const a14 = atr(m15, 14);
  const r14 = rsi(closes15, 14);
  const h1_e21 = ema(h1.map((b) => b.close), 21); const h1_e50 = ema(h1.map((b) => b.close), 50);
  const h4_e21 = ema(h4.map((b) => b.close), 21); const h4_e50 = ema(h4.map((b) => b.close), 50);
  const pip = pipSize(pair);

  let openUntilMs = 0;
  let sigCount = 0, tookCount = 0;

  for (let i = 210; i < m15.length - 1; i++) {
    const bar = m15[i]!;
    const t = Date.parse(bar.closeTime);
    if (t < openUntilMs) continue;
    if (!inSession(bar.closeTime)) continue;

    const f21 = e21[i]!, f50 = e50[i]!, f200 = e200[i]!;
    const bullish = f21 > f50 && f50 > f200;
    const bearish = f21 < f50 && f50 < f200;
    const dir: "long" | "short" | null = bullish ? "long" : bearish ? "short" : null;
    if (!dir) continue;

    // HTF gates
    const h1b = htfBias(bar.closeTime, h1, h1_e21, h1_e50);
    const h4b = htfBias(bar.closeTime, h4, h4_e21, h4_e50);
    const need = dir === "long" ? 1 : -1;
    if (h1b !== need) continue;                     // H1 must agree
    if (h4b === -need) continue;                    // H4 must not oppose

    // Pullback into EMA21/50 zone, EMA200 intact
    const atrV = a14[i]!;
    if (!Number.isFinite(atrV) || atrV <= 0) continue;
    const zoneLo = Math.min(f21, f50) - 0.35 * atrV;
    const zoneHi = Math.max(f21, f50) + 0.35 * atrV;
    const inZone = bar.low <= zoneHi && bar.high >= zoneLo;
    const structIntact = dir === "long" ? bar.low > f200 : bar.high < f200;
    if (!inZone || !structIntact) continue;

    // Market-structure break of last 5 bars
    const winStart = Math.max(0, i - 5);
    const prevHi = Math.max(...m15.slice(winStart, i).map((b) => b.high));
    const prevLo = Math.min(...m15.slice(winStart, i).map((b) => b.low));
    const structBreak = dir === "long" ? bar.close > prevHi : bar.close < prevLo;
    if (!structBreak) continue;

    // Confirmation candle: body engulfs prior body & closes in direction
    const prev = m15[i - 1]!;
    const bodyNow = Math.abs(bar.close - bar.open);
    const bodyPrev = Math.abs(prev.close - prev.open);
    const closedDir = dir === "long" ? bar.close > bar.open : bar.close < bar.open;
    const engulfs = bodyNow >= bodyPrev && Math.min(bar.open, bar.close) <= Math.min(prev.open, prev.close) && Math.max(bar.open, bar.close) >= Math.max(prev.open, prev.close);
    if (!closedDir || !engulfs) continue;

    // RSI in trend-supporting band, not extended
    const rv = r14[i];
    if (rv === undefined || !Number.isFinite(rv)) continue;
    if (dir === "long" && !(rv >= 45 && rv <= 70)) continue;
    if (dir === "short" && !(rv >= 30 && rv <= 55)) continue;

    // Volatility floor
    const atrPips = atrV / pip;
    if (atrPips < 5) continue;

    // Spread cap
    const spreadPips = (bar.askClose - bar.bidClose) / pip;
    if (!Number.isFinite(spreadPips) || spreadPips > 3) continue;

    sigCount++;

    // Stop = 10-bar structural swing; target = entry ± 1.5*risk
    const swWin = m15.slice(Math.max(0, i - 10), i + 1);
    const rawStop = dir === "long" ? Math.min(...swWin.map((b) => b.low)) : Math.max(...swWin.map((b) => b.high));
    const entry = dir === "long" ? bar.askClose : bar.bidClose;
    const risk = Math.abs(entry - rawStop);
    if (risk <= 0 || risk / entry < 1e-6) continue;
    const target = dir === "long" ? entry + 2.0 * risk : entry - 2.0 * risk;

    // Resolve with production labelOutcome using forward M15 quotes
    const forward = m15.slice(i + 1);
    const res = labelOutcome(dir, entry, rawStop, target, bar.closeTime, forward as never);
    const resolvedMs = res.resolvedAt ? Date.parse(res.resolvedAt) : (t + 48 * 3600e3);

    trades.push({
      pair, direction: dir, decisionTime: bar.closeTime,
      entry, stop: rawStop, target,
      stopPips: risk / pip, targetPips: (2.0 * risk) / pip, spreadPips,
      atrPips, rsi: rv, sessionHourEt: etHour(bar.closeTime),
      outcome: res.outcome, resultR: res.resultR, resolvedAt: res.resolvedAt, horizonEndsAt: res.horizonEndsAt,
    });
    tookCount++;
    openUntilMs = resolvedMs;
    if (trades.length >= TARGET_TRADES) break;
  }
  console.log(`  ${pair}: ${tookCount} trades taken (signals matched all gates: ${sigCount})`);
  if (trades.length >= TARGET_TRADES) break;
}

writeFileSync(OUT, JSON.stringify({
  scope: { engine: "batch-1 legacy EMA-pullback", pairs: PAIRS, yearsBack: YEARS_BACK, targetTrades: TARGET_TRADES },
  trades,
}, null, 1));

// ---- summarize ----
type Agg = { n: number; w: number; l: number; totalR: number; grossW: number; grossL: number; sumAbsR: number };
const empty = (): Agg => ({ n: 0, w: 0, l: 0, totalR: 0, grossW: 0, grossL: 0, sumAbsR: 0 });
const push = (a: Agg, r: number) => { a.n++; a.totalR += r; a.sumAbsR += Math.abs(r); if (r > 0) { a.w++; a.grossW += r; } else if (r < 0) { a.l++; a.grossL += r; } };
const fmt = (a: Agg) => {
  const wr = a.n ? 100 * a.w / a.n : 0;
  const exp = a.n ? a.totalR / a.n : 0;
  const pf = a.grossL < 0 ? a.grossW / Math.abs(a.grossL) : Infinity;
  const avgAbs = a.n ? a.sumAbsR / a.n : 0;
  return `n=${a.n} W/L=${a.w}/${a.l} winrate=${wr.toFixed(1)}% exp=${exp.toFixed(3)}R avg|R|=${avgAbs.toFixed(3)} totalR=${a.totalR >= 0 ? "+" : ""}${a.totalR.toFixed(2)} PF=${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`;
};

const overall = empty();
const byPair = new Map<string, Agg>();
const byDir = new Map<string, Agg>();
const byOutcome = new Map<string, number>();
const bySession = new Map<string, Agg>();

for (const t of trades) {
  const r = t.resultR ?? 0;
  if (t.outcome === "ambiguous" || t.resultR === null) { byOutcome.set(t.outcome, (byOutcome.get(t.outcome) ?? 0) + 1); continue; }
  push(overall, r);
  const bp = byPair.get(t.pair) ?? empty(); push(bp, r); byPair.set(t.pair, bp);
  const bd = byDir.get(t.direction) ?? empty(); push(bd, r); byDir.set(t.direction, bd);
  byOutcome.set(t.outcome, (byOutcome.get(t.outcome) ?? 0) + 1);
  const sessKey = t.sessionHourEt < 8 ? "London" : "London/NY overlap";
  const bs = bySession.get(sessKey) ?? empty(); push(bs, r); bySession.set(sessKey, bs);
}

console.log(`\n=== OVERALL ===`);
console.log(`  ${fmt(overall)}`);
console.log(`\n=== BY PAIR ===`);
for (const [p, ag] of byPair) console.log(`  ${p}: ${fmt(ag)}`);
console.log(`\n=== BY DIRECTION ===`);
for (const [d, ag] of byDir) console.log(`  ${d}: ${fmt(ag)}`);
console.log(`\n=== BY SESSION ===`);
for (const [s, ag] of bySession) console.log(`  ${s}: ${fmt(ag)}`);
console.log(`\n=== OUTCOME DISTRIBUTION ===`);
for (const [o, n] of byOutcome) console.log(`  ${o}: ${n} (${(100 * n / trades.length).toFixed(1)}%)`);
console.log(`\nwrote ${path.resolve(OUT)}`);

process.exit(0);
