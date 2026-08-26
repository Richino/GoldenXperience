/**
 * Extended legacy backtest: 12 pairs × 6y M15.
 * RESEARCH ONLY. No DB writes.
 * Same recipe as _backtest_legacy_batch1.ts (10 gates, 1.5R target, 10-bar swing stop,
 * 16:45 ET forced close, 48h horizon). Only PAIRS / YEARS_BACK / output dir differ.
 *
 * Note on XAU_USD: pip = 0.10 (metal), spread cap is applied in pip units. If XAU
 * behaves oddly (huge ATR, wide spread, thin gates), we drop it in the confidence
 * retrain rather than fixing here.
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
const OUT_DIR = path.join(serviceRoot, "..", "backtest-legacy-expanded");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const OUT = process.env.OUT ?? path.join(OUT_DIR, "trades.json");
const CACHE_DIR = path.join(OUT_DIR, "candles");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const PAIRS = [
  "USD_JPY", "AUD_USD", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF",
  "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP", "NZD_USD", "XAU_USD",
];
const TARGET_TRADES = 5000;
const YEARS_BACK = 6;

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
  for (let page = 0; page < 80; page++) {
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

function pipSize(inst: string): number {
  if (inst === "XAU_USD") return 0.1;
  return inst.endsWith("JPY") ? 0.01 : 0.0001;
}

function spreadCap(inst: string): number {
  // majors 3 pips; JPY crosses 4; XAU 30 (gold spreads run 10-30 pips)
  if (inst === "XAU_USD") return 30;
  if (inst.includes("JPY") && !inst.startsWith("USD_JPY")) return 4;
  return 3;
}

function etHour(iso: string): number {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(h) % 24;
}
function inSession(iso: string): boolean {
  const h = etHour(iso);
  return h >= 3 && h < 12;
}

function htfBias(closeTime: string, bars: Q[], f21: number[], f50: number[]): -1 | 0 | 1 {
  const t = Date.parse(closeTime);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return 0;
  const a = f21[k]; const b = f50[k];
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const spread = Math.abs(a - b) / (bars[k]!.close || 1);
  if (spread < 1e-5) return 0;
  return a > b ? 1 : -1;
}

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
  const spreadMax = spreadCap(pair);

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

    const h1b = htfBias(bar.closeTime, h1, h1_e21, h1_e50);
    const h4b = htfBias(bar.closeTime, h4, h4_e21, h4_e50);
    const need = dir === "long" ? 1 : -1;
    if (h1b !== need) continue;
    if (h4b === -need) continue;

    const atrV = a14[i]!;
    if (!Number.isFinite(atrV) || atrV <= 0) continue;
    const zoneLo = Math.min(f21, f50) - 0.35 * atrV;
    const zoneHi = Math.max(f21, f50) + 0.35 * atrV;
    const inZone = bar.low <= zoneHi && bar.high >= zoneLo;
    const structIntact = dir === "long" ? bar.low > f200 : bar.high < f200;
    if (!inZone || !structIntact) continue;

    const winStart = Math.max(0, i - 5);
    const prevHi = Math.max(...m15.slice(winStart, i).map((b) => b.high));
    const prevLo = Math.min(...m15.slice(winStart, i).map((b) => b.low));
    const structBreak = dir === "long" ? bar.close > prevHi : bar.close < prevLo;
    if (!structBreak) continue;

    const prev = m15[i - 1]!;
    const bodyNow = Math.abs(bar.close - bar.open);
    const bodyPrev = Math.abs(prev.close - prev.open);
    const closedDir = dir === "long" ? bar.close > bar.open : bar.close < bar.open;
    const engulfs = bodyNow >= bodyPrev && Math.min(bar.open, bar.close) <= Math.min(prev.open, prev.close) && Math.max(bar.open, bar.close) >= Math.max(prev.open, prev.close);
    if (!closedDir || !engulfs) continue;

    const rv = r14[i];
    if (rv === undefined || !Number.isFinite(rv)) continue;
    if (dir === "long" && !(rv >= 45 && rv <= 70)) continue;
    if (dir === "short" && !(rv >= 30 && rv <= 55)) continue;

    const atrPips = atrV / pip;
    if (atrPips < 5) continue;

    const spreadPips = (bar.askClose - bar.bidClose) / pip;
    if (!Number.isFinite(spreadPips) || spreadPips > spreadMax) continue;

    sigCount++;

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
      entry, stop: rawStop, target,
      stopPips: risk / pip, targetPips: (1.5 * risk) / pip, spreadPips,
      atrPips, rsi: rv, sessionHourEt: etHour(bar.closeTime),
      outcome: res.outcome, resultR: res.resultR, resolvedAt: res.resolvedAt, horizonEndsAt: res.horizonEndsAt,
    });
    tookCount++;
    openUntilMs = resolvedMs;
    if (trades.length >= TARGET_TRADES) break;
  }
  console.log(`  ${pair}: ${tookCount} trades taken (raw signals: ${sigCount})`);
  if (trades.length >= TARGET_TRADES) break;
}

writeFileSync(OUT, JSON.stringify({
  scope: { engine: "legacy EMA-pullback expanded", pairs: PAIRS, yearsBack: YEARS_BACK, targetTrades: TARGET_TRADES },
  trades,
}, null, 1));

type Agg = { n: number; w: number; l: number; totalR: number; grossW: number; grossL: number };
const empty = (): Agg => ({ n: 0, w: 0, l: 0, totalR: 0, grossW: 0, grossL: 0 });
const push = (a: Agg, r: number) => { a.n++; a.totalR += r; if (r > 0) { a.w++; a.grossW += r; } else if (r < 0) { a.l++; a.grossL += r; } };
const fmt = (a: Agg) => {
  const wr = a.n ? 100 * a.w / a.n : 0;
  const exp = a.n ? a.totalR / a.n : 0;
  const pf = a.grossL < 0 ? a.grossW / Math.abs(a.grossL) : Infinity;
  return `n=${a.n} winrate=${wr.toFixed(1)}% expR=${exp.toFixed(3)} totalR=${a.totalR >= 0 ? "+" : ""}${a.totalR.toFixed(2)} PF=${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`;
};

const overall = empty();
const byPair = new Map<string, Agg>();
for (const t of trades) {
  if (t.outcome === "ambiguous" || t.resultR === null) continue;
  push(overall, t.resultR);
  const bp = byPair.get(t.pair) ?? empty(); push(bp, t.resultR); byPair.set(t.pair, bp);
}
console.log(`\n=== OVERALL ===  ${fmt(overall)}`);
console.log(`\n=== BY PAIR ===`);
for (const [p, ag] of byPair) console.log(`  ${p.padEnd(9)}: ${fmt(ag)}`);
console.log(`\nwrote ${path.resolve(OUT)}`);

process.exit(0);
