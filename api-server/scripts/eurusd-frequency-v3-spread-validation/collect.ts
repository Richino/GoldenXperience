// Collect OANDA practice bid/ask history for the EURUSD Frequency V3 cohort.
// H1 MBA: continuous, for frozen ATR14 + signal-bar entry prices.
// M1 MBA: union of per-trade replay windows, for minute-by-minute execution.
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { parseCohort, AUTHORITATIVE_LEG_COUNTS, type Candle } from './lib.js';

for (const f of ['.env', '.env.local']) config({ path: path.resolve(f), override: false, quiet: true });
if ((process.env.OANDA_ENVIRONMENT ?? '').toLowerCase() === 'live')
  throw new Error('This validation is practice-only.');

const HOST = 'https://api-fxpractice.oanda.com';
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? '')
  .trim()
  .replace(/^["']|["']$/g, '');
if (!token) throw new Error('Missing OANDA_API_KEY');

const DIR = path.resolve('research-v2/eurusd-frequency-v3-spread-validation/data');
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
      `${HOST}/v3/instruments/EUR_USD/candles?price=MBA&granularity=${granularity}` +
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
// Sanity: leg counts must equal the authoritative cohort.
const legCounts: Record<string, number> = {};
for (const t of trades) legCounts[t.leg] = (legCounts[t.leg] ?? 0) + 1;
for (const [leg, n] of Object.entries(AUTHORITATIVE_LEG_COUNTS)) {
  if (legCounts[leg] !== n) throw new Error(`Leg ${leg}: parsed ${legCounts[leg]} != authoritative ${n}`);
}
console.log('Leg counts match authoritative cohort.', JSON.stringify(legCounts));

// Persist parsed cohort for the replay stage.
fs.writeFileSync(
  path.resolve('research-v2/eurusd-frequency-v3-spread-validation/parsed-cohort.json'),
  JSON.stringify(trades, null, 2),
);

const firstEntry = Math.min(...trades.map((t) => t.resolvedEntryUtcMs));
const lastEntry = Math.max(...trades.map((t) => t.resolvedEntryUtcMs));

// --- H1: continuous, with warmup before the first signal for Wilder ATR14. ---
const h1File = `${DIR}/EUR_USD-H1-MBA.json`;
if (!fs.existsSync(h1File)) {
  const from = firstEntry - 10 * 86400000; // ~10 days warmup (>=14 H1 trading bars)
  const until = lastEntry + 5 * 86400000;
  console.log(`Fetching H1 ${new Date(from).toISOString()} -> ${new Date(until).toISOString()}`);
  const candles = dedupSort(await fetchRange('H1', from, until));
  fs.writeFileSync(h1File, JSON.stringify({ instrument: 'EUR_USD', granularity: 'H1', candles }));
  console.log(`H1 candles: ${candles.length}`);
} else {
  console.log('H1 cache present.');
}

// --- M1: union of per-trade windows. Each window covers signal bar through a
// generous horizon so the executable side can resolve even if it lags TV. ---
const m1File = `${DIR}/EUR_USD-M1-MBA.json`;
if (!fs.existsSync(m1File)) {
  const BUFFER_MS = 5 * 86400000; // 5 calendar days past the TV exit (max TV duration is 20 H1 bars)
  const intervals = trades
    .map((t) => [t.resolvedEntryUtcMs, Math.max(t.resolvedExitUtcMs, t.resolvedEntryUtcMs) + BUFFER_MS] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  // Merge overlapping intervals to minimize requests.
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
    console.log(`  window ${i}/${merged.length} ${new Date(from).toISOString().slice(0, 10)} -> ${new Date(until).toISOString().slice(0, 10)}: ${part.length}`);
  }
  const candles = dedupSort(all);
  fs.writeFileSync(m1File, JSON.stringify({ instrument: 'EUR_USD', granularity: 'M1', candles }));
  console.log(`M1 candles: ${candles.length}`);
} else {
  console.log('M1 cache present.');
}

console.log('Collection complete. No database writes, no broker orders.');
