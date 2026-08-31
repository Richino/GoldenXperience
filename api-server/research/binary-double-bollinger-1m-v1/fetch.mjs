/**
 * Isolated data fetch for binary-double-bollinger-1m-v1.
 *
 * Pulls M1 mid OHLC candles for the 12 project FX pairs from OANDA, pages
 * backward to cover a generous calendar window, and caches raw candles to the
 * scratchpad as JSON. Reads NOTHING from src/, writes NOTHING to production.
 */
const env = (k) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const host = env("OANDA_ENVIRONMENT") === "live"
  ? "https://api-fxtrade.oanda.com"
  : "https://api-fxpractice.oanda.com";

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD",
  "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD"];

// Cover ~19 calendar days back from the last complete candle so that 12
// complete UTC trading days are fully contained even across two weekends.
const DAYS_BACK = 19;
const OUT = process.argv[2];
const ANCHOR = process.argv[3]; // optional ISO end time; default = now
if (!OUT) { console.error("usage: node fetch.mjs <out.json> [anchorISO]"); process.exit(1); }
if (!token) { console.error("no OANDA credentials"); process.exit(1); }

async function fetchPage(inst, toISO) {
  const q = new URLSearchParams({ price: "M", granularity: "M1", count: "5000" });
  if (toISO) q.set("to", toISO);
  const url = `${host}/v3/instruments/${inst}/candles?${q}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${inst} ${r.status} ${await r.text()}`);
  const j = await r.json();
  return (j.candles ?? []).filter((c) => c.complete).map((c) => ({
    t: c.time,                    // candle OPEN time (ISO)
    o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c, v: c.volume,
  }));
}

async function fetchPair(inst) {
  // Page backward from the anchor (default now) using the `to` cursor.
  const nowMs = ANCHOR ? Date.parse(ANCHOR) : Date.now();
  const cutoff = nowMs - DAYS_BACK * 86400_000;
  const byTime = new Map();
  let to = ANCHOR ? new Date(nowMs).toISOString() : undefined;
  for (let page = 0; page < 8; page++) {
    const rows = await fetchPage(inst, to);
    if (rows.length === 0) break;
    for (const row of rows) byTime.set(row.t, row);
    const earliest = Date.parse(rows[0].t);
    if (earliest <= cutoff) break;
    to = new Date(earliest).toISOString(); // next page ends at current earliest
    await new Promise((res) => setTimeout(res, 120));
  }
  const all = [...byTime.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
    .filter((r) => Date.parse(r.t) >= cutoff);
  return all;
}

const data = {};
for (const p of PAIRS) {
  const rows = await fetchPair(p);
  data[p] = rows;
  console.error(`${p}: ${rows.length} candles  ${rows[0]?.t} .. ${rows[rows.length - 1]?.t}`);
}
const fs = await import("node:fs");
fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), host, pairs: PAIRS, data }));
console.error(`wrote ${OUT}`);
