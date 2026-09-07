// Collect OANDA practice bid/ask history for the EURGBP Bull Consensus Structure
// Break V1 cohort.
// H1 MBA: continuous with long warmup, for frozen EMA20/EMA50/ATR14 + signal-bar
//         entry prices + the TIME_EXIT close of the 3rd future bar.
// M1 MBA: union of per-trade replay windows, for minute-by-minute execution.
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { parseCohort, INSTRUMENT, ORIGIN_HOUR_UTC, AUTHORITATIVE_TRADE_COUNT, TV_SIGNAL, type Candle } from './lib.js';

for (const f of ['.env', '.env.local']) config({ path: path.resolve(f), override: false, quiet: true });
if ((process.env.OANDA_ENVIRONMENT ?? '').toLowerCase() === 'live')
  throw new Error('This validation is practice-only.');

const HOST = 'https://api-fxpractice.oanda.com';
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? '')
  .trim()
  .replace(/^["']|["']$/g, '');
if (!token) throw new Error('Missing OANDA_API_KEY');

const DIR = path.resolve('research-v2/eurgbp-bull-consensus-break-v1-spread-validation/data');
fs.mkdirSync(DIR, { recursive: true });

async function request(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return await r.json();
      if (![429, 500, 502, 503, 504].includes(r.status)) throw new Error(`HTTP ${r.status} ${url}`);
    } catch (e) {
      if (attempt === 4) throw e;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error('Retries exhausted');
}

function toCompact(c: any): Candle {
  return {
    t: Date.parse(c.time),
    bo: +c.bid.o, bh: +c.bid.h, bl: +c.bid.l, bc: +c.bid.c,
    ao: +c.ask.o, ah: +c.ask.h, al: +c.ask.l, ac: +c.ask.c,
  };
}

async function fetchRange(granularity: 'M1' | 'H1', fromMs: number, untilMs: number): Promise<Candle[]> {
  const stepMs = granularity === 'M1' ? 60000 : 3600000;
  const out: Candle[] = [];
  let at = fromMs;
  for (let page = 0; at < untilMs && page < 5000; page++) {
    const url =
      `${HOST}/v3/instruments/${INSTRUMENT}/candles?price=MBA&granularity=${granularity}` +
      `&count=5000&from=${encodeURIComponent(new Date(at).toISOString())}`;
    const body = await request(url);
    const list = (body.candles ?? []).filter((x: any) => x.complete && x.bid && x.ask && x.mid);
    if (!list.length) break;
    for (const c of list) {
      const t = Date.parse(c.time);
      if (t < untilMs) out.push(toCompact(c));
    }
    const next = Date.parse(list.at(-1).time) + stepMs;
    if (next <= at) break;
    at = next;
    if (page % 20 === 0) process.stdout.write(`  ${granularity} ${new Date(at).toISOString().slice(0, 10)}\r`);
  }
  return out;
}

function dedupSort(candles: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of candles) m.set(c.t, c);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

const trades = parseCohort();
console.log(`Parsed ${trades.length} trades.`);
if (trades.length !== AUTHORITATIVE_TRADE_COUNT)
  throw new Error(`Parsed ${trades.length} != authoritative ${AUTHORITATIVE_TRADE_COUNT}`);
// Sanity: every leg is the exact LONG signal, resolves to 06:00 UTC.
for (const t of trades) {
  if (t.tvSignal !== TV_SIGNAL) throw new Error(`Trade ${t.tradeNumber}: signal ${t.tvSignal}`);
  const h = new Date(t.resolvedEntryUtcMs).getUTCHours();
  if (h !== ORIGIN_HOUR_UTC) throw new Error(`Trade ${t.tradeNumber}: resolved UTC hour ${h} != ${ORIGIN_HOUR_UTC} (NY ${t.tvEntryWallNy})`);
}
console.log(`All ${trades.length} legs are ${TV_SIGNAL} and resolve to 0${ORIGIN_HOUR_UTC}:00 UTC.`);

const firstEntry = Math.min(...trades.map((t) => t.resolvedEntryUtcMs));
const lastEntry = Math.max(...trades.map((t) => t.resolvedEntryUtcMs));

// --- H1: continuous, long warmup before the first signal for EMA50 convergence. ---
const h1File = `${DIR}/${INSTRUMENT}-H1-MBA.json`;
if (!fs.existsSync(h1File)) {
  const from = Date.UTC(2022, 5, 1); // 2022-06-01: >200 trading days warmup for EMA20/50 + ATR14
  const until = lastEntry + 5 * 86400000; // past the last TIME_EXIT (entry + up to 4h + margin)
  console.log(`Fetching H1 ${new Date(from).toISOString()} -> ${new Date(until).toISOString()}`);
  const candles = dedupSort(await fetchRange('H1', from, until));
  fs.writeFileSync(h1File, JSON.stringify({ instrument: INSTRUMENT, granularity: 'H1', candles }));
  console.log(`H1 candles: ${candles.length}`);
} else {
  console.log('H1 cache present.');
}

// --- M1: union of per-trade windows. Each window covers the first future bar
// (entry+1h = 07:00 UTC) through a generous horizon past the 3rd future bar
// close (entry+4h = 10:00 UTC), so the executable side can resolve TP/SL. ---
const m1File = `${DIR}/${INSTRUMENT}-M1-MBA.json`;
if (!fs.existsSync(m1File)) {
  const START_OFFSET = 3600000; // entry + 1h (open of future #1)
  const END_OFFSET = 6 * 3600000; // entry + 6h (well past future #3 close at +4h)
  const intervals = trades
    .map((t) => [t.resolvedEntryUtcMs + START_OFFSET, t.resolvedEntryUtcMs + END_OFFSET] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  // Merge overlapping/adjacent intervals to minimize requests.
  const merged: [number, number][] = [];
  for (const iv of intervals) {
    const last = merged.at(-1);
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([...iv]);
  }
  console.log(`M1: ${merged.length} merged windows.`);
  let all: Candle[] = [];
  let i = 0;
  for (const [from, until] of merged) {
    i++;
    const part = await fetchRange('M1', from, until);
    all.push(...part);
    if (i % 10 === 0 || i === merged.length)
      console.log(`  window ${i}/${merged.length} ${new Date(from).toISOString().slice(0, 10)}: cumulative ${all.length}`);
  }
  const candles = dedupSort(all);
  fs.writeFileSync(m1File, JSON.stringify({ instrument: INSTRUMENT, granularity: 'M1', candles }));
  console.log(`M1 candles: ${candles.length}`);
} else {
  console.log('M1 cache present.');
}

console.log('Collection complete. No database writes, no broker orders.');
