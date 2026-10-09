// Fetch inputs for the 2026 pullback replay: OANDA M15 bid/ask candles for
// 10 pairs (from Oct 2025 for indicator warm-up) and TradingView high-impact
// calendar events for every currency involved. Cached in DATA_DIR.
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.PB_DATA_DIR;
const envText = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'USD_CHF', 'NZD_USD', 'EUR_JPY', 'GBP_JPY', 'AUD_JPY'];
const FROM = process.env.PB_FROM ?? '2025-10-01T00:00:00Z';
const TO = process.env.PB_TO ?? '2026-10-07T00:00:00Z';

async function oanda(p) {
  const res = await fetch('https://api-fxpractice.oanda.com' + p, { headers: { Authorization: `Bearer ${env.OANDA_API_KEY}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

for (const pair of PAIRS) {
  const file = path.join(DATA_DIR, `${pair}_M15${process.env.PB_SUFFIX ?? ''}.json`);
  if (fs.existsSync(file)) continue;
  const bars = [];
  let from = FROM;
  for (;;) {
    const r = await oanda(`/v3/instruments/${pair}/candles?from=${from}&count=5000&granularity=M15&price=BA`);
    const cs = r.candles.filter((c) => c.complete && c.time < TO);
    for (const c of cs) bars.push([Date.parse(c.time), +c.bid.o, +c.bid.h, +c.bid.l, +c.bid.c, +c.ask.o, +c.ask.h, +c.ask.l, +c.ask.c]);
    if (r.candles.length < 5000 || !cs.length) break;
    from = new Date(Date.parse(cs.at(-1).time) + 900000).toISOString();
  }
  fs.writeFileSync(file, JSON.stringify(bars));
  console.log(pair, bars.length, 'bars');
}

const calFile = path.join(DATA_DIR, `calendar_high${process.env.PB_SUFFIX ?? ''}.json`);
if (!fs.existsSync(calFile)) {
  const byId = new Map();
  for (let t = Date.parse(process.env.PB_CAL_FROM ?? '2026-01-01T00:00:00Z'); t < Date.parse(TO); t += 20 * 86400000) {
    const to = Math.min(t + 20 * 86400000, Date.parse(TO));
    const url = `https://economic-calendar.tradingview.com/events?from=${new Date(t).toISOString()}&to=${new Date(to).toISOString()}&countries=US,EU,DE,FR,IT,GB,JP,AU,CA,CH,NZ`;
    const r = await (await fetch(url, { headers: { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })).json();
    for (const e of r.result ?? []) if (e.importance === 1) byId.set(e.id, { time: Date.parse(e.date), currency: e.currency, title: e.title });
    await new Promise((r) => setTimeout(r, 400));
  }
  const events = [...byId.values()].sort((a, b) => a.time - b.time);
  fs.writeFileSync(calFile, JSON.stringify(events));
  const counts = {};
  for (const e of events) counts[e.currency] = (counts[e.currency] ?? 0) + 1;
  console.log('high-impact events', events.length, counts);
}
