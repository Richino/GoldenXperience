/**
 * spread_settle.mjs — settle the frequent BB2-base bot at EXECUTABLE prices.
 *
 * Fetches bid/ask M1 candles (price=BA) for the 12 pairs across N quarterly
 * windows, runs the same BB(20,2) rejection signal, and settles each 1-minute
 * binary at real fill prices so every trade must overcome the spread:
 *   DOWN (short): enter at BID[i+1].open, exit buy-back at ASK[i+1].close  -> win if exitAsk < entryBid
 *   UP   (long):  enter at ASK[i+1].open, exit sell at   BID[i+1].close    -> win if exitBid > entryAsk
 * This is the honest cost model, not lookahead. Reports loss rate per window.
 *
 * Usage: node spread_settle.mjs <anchorISO> [anchorISO...]
 */
const env = (k) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const host = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const PAIRS = ["EUR_USD","GBP_USD","USD_JPY","AUD_USD","NZD_USD","USD_CAD","USD_CHF","EUR_GBP","EUR_JPY","GBP_JPY","AUD_JPY","EUR_AUD"];
const MIN = 60_000, DAYS_BACK = 19;

async function fetchPair(inst, anchorMs) {
  const cutoff = anchorMs - DAYS_BACK * 86400_000;
  const byT = new Map();
  let to = new Date(anchorMs).toISOString();
  for (let pg = 0; pg < 8; pg++) {
    const q = new URLSearchParams({ price: "BA", granularity: "M1", count: "5000", to });
    const r = await fetch(`${host}/v3/instruments/${inst}/candles?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) break;
    const j = await r.json();
    const rows = (j.candles ?? []).filter((c) => c.complete);
    if (!rows.length) break;
    for (const c of rows) byT.set(c.time, c);
    const earliest = Date.parse(rows[0].time);
    if (earliest <= cutoff) break;
    to = new Date(earliest).toISOString();
    await new Promise((s) => setTimeout(s, 100));
  }
  return [...byT.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .filter((c) => Date.parse(c.time) >= cutoff)
    .map((c) => ({ t: Date.parse(c.time),
      bo: +c.bid.o, bc: +c.bid.c, ao: +c.ask.o, ac: +c.ask.c,
      mo: (+c.bid.o + +c.ask.o) / 2, mc: (+c.bid.c + +c.ask.c) / 2, mh: (+c.bid.h + +c.ask.h) / 2, ml: (+c.bid.l + +c.ask.l) / 2 }));
}

function bollinger(close, period, k) {
  const n = close.length, up = Array(n).fill(NaN), lo = Array(n).fill(NaN);
  let s = 0, sq = 0;
  for (let i = 0; i < n; i++) { const x = close[i]; s += x; sq += x * x;
    if (i >= period) { const o = close[i - period]; s -= o; sq -= o * o; }
    if (i >= period - 1) { const m = s / period, v = Math.max(0, sq / period - m * m), sd = Math.sqrt(v); up[i] = m + k * sd; lo[i] = m - k * sd; } }
  return { up, lo };
}

async function runWindow(anchorISO) {
  const anchorMs = Date.parse(anchorISO);
  let W = 0, L = 0, T = 0, pipSum = 0, pipN = 0;
  for (const pair of PAIRS) {
    const c = await fetchPair(pair, anchorMs);
    const n = c.length; if (n < 40) continue;
    const close = c.map((x) => x.mc);
    const bb = bollinger(close, 20, 2);
    const pip = pair.includes("JPY") ? 0.01 : 0.0001;
    for (let i = 21; i < n - 1; i++) {
      if (c[i + 1].t - c[i].t !== MIN) continue;
      const U = bb.up[i], Lo = bb.lo[i]; if (!Number.isFinite(U)) continue;
      for (const dir of ["DOWN", "UP"]) {
        const isD = dir === "DOWN";
        const rej = isD ? (c[i].mh >= U && c[i].mc < U) : (c[i].ml <= Lo && c[i].mc > Lo);
        if (!rej) continue;
        // executable settlement
        let res;
        if (isD) { const entryBid = c[i + 1].bo, exitAsk = c[i + 1].ac; res = exitAsk < entryBid ? "WIN" : exitAsk > entryBid ? "LOSS" : "TIE"; }
        else { const entryAsk = c[i + 1].ao, exitBid = c[i + 1].bc; res = exitBid > entryAsk ? "WIN" : exitBid < entryAsk ? "LOSS" : "TIE"; }
        if (res === "WIN") W++; else if (res === "LOSS") L++; else T++;
        pipSum += (c[i + 1].ao - c[i + 1].bo) / pip; pipN++;
      }
    }
  }
  const dec = W + L;
  return { anchorISO, W, L, T, dec, lossRate: dec ? L / dec : 0, avgSpreadPips: pipN ? pipSum / pipN : 0 };
}

for (const a of process.argv.slice(2)) {
  const r = await runWindow(a);
  console.log(`${r.anchorISO.slice(0,7)}  decided=${r.dec}  LOSS=${(r.lossRate*100).toFixed(1)}%  win=${((1-r.lossRate)*100).toFixed(1)}%  (W${r.W}/L${r.L}/T${r.T})  avgSpread=${r.avgSpreadPips.toFixed(2)}pips`);
}
