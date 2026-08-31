/**
 * binary-double-bollinger-1m-v1 — ISOLATED research engine.
 *
 * Extension -> rejection -> momentum confirmation -> 1-minute reversal test on
 * M1 FX candles for 12 pairs. Reads cached OANDA M1 mids only. Imports nothing
 * from src/, touches no DB, changes no production state.
 *
 * Frozen parameters (NOT swept): BB(20,2), BB(20,3), Stoch(6,3,3), CCI(21),
 * ADX interpretation of "periods 1 and 5" = 1-bar directional movement with
 * 5-period Wilder smoothing of ATR/DM and a 5-period Wilder smoothing of DX.
 *
 * Usage: node run.mjs <candles.json> <outDir>
 */
import fs from "node:fs";
import path from "node:path";

const [, , CANDLES_PATH, OUT_DIR] = process.argv;
if (!CANDLES_PATH || !OUT_DIR) { console.error("usage: node run.mjs <candles.json> <outDir>"); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });

const raw = JSON.parse(fs.readFileSync(CANDLES_PATH, "utf8"));
const PAIRS = raw.pairs;
const MIN = 60_000;

// ------------------------------------------------------------------ indicators
// Bollinger with POPULATION sd (matches the project's computeBollinger).
function bollinger(close, period, k) {
  const n = close.length;
  const up = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN), mid = new Float64Array(n).fill(NaN);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = close[i]; sum += x; sumSq += x * x;
    if (i >= period) { const old = close[i - period]; sum -= old; sumSq -= old * old; }
    if (i >= period - 1) {
      const m = sum / period; const v = Math.max(0, sumSq / period - m * m); const sd = Math.sqrt(v);
      mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
    }
  }
  return { mid, up, lo };
}

// Heikin-Ashi from market OHLC. Returns HA open/close plus bull flag per index.
function heikinAshi(o, h, l, c) {
  const n = o.length;
  const hc = new Float64Array(n), ho = new Float64Array(n), bull = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    hc[i] = (o[i] + h[i] + l[i] + c[i]) / 4;
    ho[i] = i === 0 ? (o[i] + c[i]) / 2 : (ho[i - 1] + hc[i - 1]) / 2;
    bull[i] = hc[i] >= ho[i] ? 1 : 0;
  }
  return { ho, hc, bull };
}

// Stochastic(6,3,3): fast %K over 6, slow %K = SMA(fastK,3), %D = SMA(slowK,3).
function stochastic(h, l, c, kPeriod = 6, kSmooth = 3, dPeriod = 3) {
  const n = c.length;
  const fastK = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i < kPeriod - 1) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; }
    fastK[i] = hi === lo ? 50 : (100 * (c[i] - lo)) / (hi - lo);
  }
  const slowK = sma(fastK, kSmooth);
  const d = sma(slowK, dPeriod);
  return { slowK, d };
}
function sma(arr, p) {
  const n = arr.length; const out = new Float64Array(n).fill(NaN);
  let sum = 0, cnt = 0; const buf = [];
  for (let i = 0; i < n; i++) {
    const x = arr[i];
    if (Number.isNaN(x)) { buf.length = 0; sum = 0; cnt = 0; continue; }
    buf.push(x); sum += x; cnt++;
    if (buf.length > p) { sum -= buf.shift(); cnt--; }
    if (cnt === p) out[i] = sum / p;
  }
  return out;
}

// CCI(21) with typical price and mean absolute deviation.
function cci(h, l, c, period = 21) {
  const n = c.length; const out = new Float64Array(n).fill(NaN);
  const tp = new Float64Array(n);
  for (let i = 0; i < n; i++) tp[i] = (h[i] + l[i] + c[i]) / 3;
  for (let i = period - 1; i < n; i++) {
    let m = 0; for (let j = i - period + 1; j <= i; j++) m += tp[j]; m /= period;
    let md = 0; for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - m); md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - m) / (0.015 * md);
  }
  return out;
}

// ADX / DMI with 1-bar directional movement and P-period Wilder smoothing.
// "periods 1 and 5" => 1-bar DM, 5-period smoothing of TR/DM and of DX.
function adxDmi(o, h, l, c, P = 5) {
  const n = c.length;
  const adx = new Float64Array(n).fill(NaN), pDI = new Float64Array(n).fill(NaN), mDI = new Float64Array(n).fill(NaN);
  if (n < 2 * P + 1) return { adx, pDI, mDI };
  const tr = new Float64Array(n), pDM = new Float64Array(n), mDM = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pDM[i] = up > dn && up > 0 ? up : 0;
    mDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  let atr = 0, sp = 0, sm = 0;
  for (let i = 1; i <= P; i++) { atr += tr[i]; sp += pDM[i]; sm += mDM[i]; }
  const dxArr = [];
  for (let i = P; i < n; i++) {
    if (i > P) { atr = atr - atr / P + tr[i]; sp = sp - sp / P + pDM[i]; sm = sm - sm / P + mDM[i]; }
    const plus = atr > 0 ? (100 * sp) / atr : 0;
    const minus = atr > 0 ? (100 * sm) / atr : 0;
    pDI[i] = plus; mDI[i] = minus;
    const denom = plus + minus;
    const dx = denom > 0 ? (100 * Math.abs(plus - minus)) / denom : 0;
    dxArr.push(dx);
    if (dxArr.length === P) adx[i] = dxArr.reduce((a, b) => a + b, 0) / P;
    else if (dxArr.length > P) adx[i] = (adx[i - 1] * (P - 1) + dx) / P;
  }
  return { adx, pDI, mDI };
}

// ADX convergence->divergence, deterministic. CONV/L frozen, documented.
const ADX_CONV = 6;   // DI lines "touch" when |+DI - -DI| <= 6
const ADX_LOOK = 3;   // convergence must have occurred within last 3 bars
function adxRule(dir, i, pDI, mDI, adx) {
  if (i < 1) return false;
  const p = pDI[i], m = mDI[i], p1 = pDI[i - 1], m1 = mDI[i - 1], a = adx[i], a1 = adx[i - 1];
  if (![p, m, p1, m1, a, a1].every(Number.isFinite)) return false;
  let converged = false;
  for (let j = Math.max(1, i - ADX_LOOK); j <= i - 1; j++) {
    if (Number.isFinite(pDI[j]) && Number.isFinite(mDI[j]) && Math.abs(pDI[j] - mDI[j]) <= ADX_CONV) { converged = true; break; }
  }
  if (!converged) return false;
  if (a <= a1) return false; // ADX must be rising (strengthening)
  if (dir === "DOWN") return m > p && (m - p) > (m1 - p1); // -DI overtakes and widens
  return p > m && (p - m) > (p1 - m1);                     // +DI overtakes and widens
}

// ------------------------------------------------------------------ stats
function wilson(w, n) {
  if (n === 0) return [0, 0];
  const z = 1.959963984540054, phat = w / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return [(centre - margin) / denom, (centre + margin) / denom];
}
const PAYOUTS = [0.70, 0.75, 0.80, 0.85, 0.90];
const breakEven = (p) => 1 / (1 + p);

function sessionOf(hourUtc) {
  if (hourUtc >= 7 && hourUtc < 12) return "London";
  if (hourUtc >= 12 && hourUtc < 16) return "London/NY overlap";
  if (hourUtc >= 16 && hourUtc < 21) return "New York";
  return "Asia"; // 21-23 and 0-6
}

// ------------------------------------------------------------------ variants
const VARIANTS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
const VARIANT_DESC = {
  A: "BB2 rejection only",
  B: "BB3 rejection only",
  C: "BB rejection + Heikin Ashi",
  D: "BB rejection + Stochastic",
  E: "BB rejection + CCI",
  F: "BB rejection + ADX",
  G: "BB + HA + Stochastic",
  H: "BB + HA + Stochastic + CCI",
  I: "FULL: BB + HA + Stochastic + CCI + ADX",
};

// ------------------------------------------------------------------ main loop
const trades = [];          // every fired signal across all variants
const perPairCandle = {};   // for gap/coverage reporting

// Determine the 12 complete trading days (UTC dates) from data coverage.
const dateCount = new Map();
for (const p of PAIRS) {
  for (const c of raw.data[p]) {
    const d = c.t.slice(0, 10);
    dateCount.set(d, Math.max(dateCount.get(d) ?? 0, 1) + 0);
  }
}
// per-date max candle count across pairs
const dateMax = new Map();
for (const p of PAIRS) {
  const byDate = new Map();
  for (const c of raw.data[p]) { const d = c.t.slice(0, 10); byDate.set(d, (byDate.get(d) ?? 0) + 1); }
  for (const [d, n] of byDate) dateMax.set(d, Math.max(dateMax.get(d) ?? 0, n));
}
const completeDates = [...dateMax.entries()].filter(([, n]) => n >= 1000).map(([d]) => d).sort();
const SELECTED = completeDates.slice(-12);
const SELECTED_SET = new Set(SELECTED);
console.error("selected trading days:", SELECTED.join(", "));

const coverage = {};
for (const pair of PAIRS) {
  const rows = raw.data[pair].filter((c) => SELECTED_SET.has(c.t.slice(0, 10)));
  // build arrays
  const t = rows.map((r) => Date.parse(r.t));
  const o = Float64Array.from(rows, (r) => r.o);
  const h = Float64Array.from(rows, (r) => r.h);
  const l = Float64Array.from(rows, (r) => r.l);
  const c = Float64Array.from(rows, (r) => r.c);
  const n = rows.length;

  // coverage / gap report
  let gaps = 0, maxGapMin = 0;
  const byDay = new Map();
  for (let i = 0; i < n; i++) {
    const d = rows[i].t.slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + 1);
    if (i > 0) { const dt = (t[i] - t[i - 1]) / MIN; if (dt > 1) { gaps++; if (dt > maxGapMin) maxGapMin = dt; } }
  }
  coverage[pair] = { candles: n, start: rows[0]?.t, end: rows[n - 1]?.t, gaps, maxGapMin, perDay: Object.fromEntries(byDay) };

  const bb2 = bollinger(c, 20, 2);
  const bb3 = bollinger(c, 20, 3);
  const ha = heikinAshi(o, h, l, c);
  const st = stochastic(h, l, c);
  const cc = cci(h, l, c, 21);
  const dm = adxDmi(o, h, l, c, 5);

  // iterate signal candles i (completed), enter at i+1 open, expire at i+1 close
  for (let i = 21; i < n - 1; i++) {
    // require contiguous next minute for a clean 60s binary settlement
    if (t[i + 1] - t[i] !== MIN) continue;
    const U2 = bb2.up[i], L2 = bb2.lo[i], U3 = bb3.up[i], L3 = bb3.lo[i];
    if (!Number.isFinite(U2) || !Number.isFinite(U3)) continue;

    for (const dir of ["DOWN", "UP"]) {
      const isDown = dir === "DOWN";
      // --- BB rejection events (use ACTUAL candle high/low vs BB) ---
      const bb2rej = isDown ? (h[i] >= U2 && c[i] < U2) : (l[i] <= L2 && c[i] > L2);
      const bb3rej = isDown ? (h[i] >= U3 && c[i] < U3) : (l[i] <= L3 && c[i] > L3);
      const bb2touch = isDown ? (h[i] >= U2) : (l[i] <= L2);
      const bb3touch = isDown ? (h[i] >= U3) : (l[i] <= L3);
      const bbBase = bb2rej; // generic "BB rejection" base for C..I

      // --- confirmations ---
      const haConf = isDown ? (ha.bull[i - 1] === 1 && ha.bull[i] === 0) : (ha.bull[i - 1] === 0 && ha.bull[i] === 1);
      const kNow = st.slowK[i], kPrev = st.slowK[i - 1], dNow = st.d[i], dPrev = st.d[i - 1];
      const stochOk = [kNow, kPrev, dNow, dPrev].every(Number.isFinite);
      const stochConf = stochOk && (isDown ? (kPrev >= dPrev && kNow < dNow) : (kPrev <= dPrev && kNow > dNow));
      const cciNow = cc[i], cciPrev = cc[i - 1];
      const cciConf = Number.isFinite(cciNow) && Number.isFinite(cciPrev) && (isDown ? cciNow < cciPrev : cciNow > cciPrev);
      const adxConf = adxRule(dir, i, dm.pDI, dm.mDI, dm.adx);

      // --- variant membership ---
      const fired = {
        A: bb2rej,
        B: bb3rej,
        C: bbBase && haConf,
        D: bbBase && stochConf,
        E: bbBase && cciConf,
        F: bbBase && adxConf,
        G: bbBase && haConf && stochConf,
        H: bbBase && haConf && stochConf && cciConf,
        I: bbBase && haConf && stochConf && cciConf && adxConf,
      };
      const firedVariants = VARIANTS.filter((v) => fired[v]);
      if (firedVariants.length === 0) continue;

      // extension bucket (mutually exclusive by max extension reached at candle i)
      let extBucket;
      if (bb3touch) extBucket = bb3rej ? "BB3 penetration + rejection" : "BB3 touch";
      else if (bb2touch) extBucket = "Between BB2-BB3";
      else extBucket = "none";

      // settlement using ACTUAL market mid price
      const entry = o[i + 1];
      const expiry = c[i + 1];
      let result;
      if (expiry === entry) result = "TIE";
      else if (isDown) result = expiry < entry ? "WIN" : "LOSS";
      else result = expiry > entry ? "WIN" : "LOSS";

      const entryTime = new Date(t[i + 1]).toISOString();
      const hourUtc = new Date(t[i + 1]).getUTCHours();
      const rec = {
        entryTime,
        symbol: pair,
        direction: dir,
        entry: +entry.toFixed(6),
        expiryTime: new Date(t[i + 1] + MIN).toISOString(),
        expiry: +expiry.toFixed(6),
        result,
        bbEvent: bb3rej ? "BB3_REJECTION" : bb3touch ? "BB3_TOUCH" : bb2rej ? "BB2_REJECTION" : bb2touch ? "BB2_TOUCH" : "NONE",
        extBucket,
        u2: +U2.toFixed(6), l2: +L2.toFixed(6), u3: +U3.toFixed(6), l3: +L3.toFixed(6),
        haDir: ha.bull[i] ? "bull" : "bear",
        stochK: Number.isFinite(kNow) ? +kNow.toFixed(2) : null,
        stochD: Number.isFinite(dNow) ? +dNow.toFixed(2) : null,
        stochCross: stochConf ? (isDown ? "K<D" : "K>D") : "none",
        cci: Number.isFinite(cciNow) ? +cciNow.toFixed(1) : null,
        cciSlope: Number.isFinite(cciNow) && Number.isFinite(cciPrev) ? +(cciNow - cciPrev).toFixed(1) : null,
        adx: Number.isFinite(dm.adx[i]) ? +dm.adx[i].toFixed(2) : null,
        plusDI: Number.isFinite(dm.pDI[i]) ? +dm.pDI[i].toFixed(2) : null,
        minusDI: Number.isFinite(dm.mDI[i]) ? +dm.mDI[i].toFixed(2) : null,
        session: sessionOf(hourUtc),
        hourUtc,
        day: entryTime.slice(0, 10),
        variants: firedVariants,        // list of variants that fired this signal
        // sub-flags for interpretation tests
        _kPrev: Number.isFinite(kPrev) ? +kPrev.toFixed(2) : null,
        _stochConf: stochConf, _cciConf: cciConf,
      };
      trades.push(rec);
    }
  }
}

// ------------------------------------------------------------------ aggregation
function tally(list) {
  let w = 0, ls = 0, ti = 0;
  for (const r of list) { if (r.result === "WIN") w++; else if (r.result === "LOSS") ls++; else ti++; }
  const denom = w + ls;
  const wr = denom ? w / denom : 0;
  const [lo, hi] = wilson(w, denom);
  return { n: list.length, decided: denom, wins: w, losses: ls, ties: ti, wr, ciLo: lo, ciHi: hi };
}
function evLine(wr) {
  const out = {};
  for (const p of PAYOUTS) out[p] = +(wr * p - (1 - wr)).toFixed(4);
  return out;
}
// De-duplicate trades per variant: a variant's trade list is signals where that
// variant is in `variants`. (A single candle/direction may belong to several.)
function variantTrades(v) { return trades.filter((r) => r.variants.includes(v)); }

const results = { experiment: "binary-double-bollinger-1m-v1" };

// full method = variant I
const fullList = variantTrades("I");
results.full = tally(fullList);

// per variant
results.variants = {};
for (const v of VARIANTS) {
  const list = variantTrades(v);
  const tt = tally(list);
  results.variants[v] = { desc: VARIANT_DESC[v], ...tt, ev: evLine(tt.wr) };
}

// per pair (full method) and per pair (best broad variant A for coverage)
function perPair(list) {
  const out = {};
  for (const pair of PAIRS) {
    const L = list.filter((r) => r.symbol === pair);
    const up = L.filter((r) => r.direction === "UP");
    const dn = L.filter((r) => r.direction === "DOWN");
    out[pair] = { all: tally(L), up: tally(up), down: tally(dn) };
  }
  return out;
}
results.perPairFull = perPair(fullList);
results.perPairA = perPair(variantTrades("A"));

// direction (full)
results.directionFull = { up: tally(fullList.filter((r) => r.direction === "UP")), down: tally(fullList.filter((r) => r.direction === "DOWN")) };

// BB extension analysis (across ALL BB rejection signals = variant A union B, use bbEvent buckets)
// Use the broad candidate set: any signal that had a BB touch (variant A covers BB2 rej;
// but extension analysis should span all extension levels, so use union of A and B plus touches).
const extAll = trades.filter((r) => r.variants.includes("A") || r.variants.includes("B"));
results.extension = {};
for (const b of ["Between BB2-BB3", "BB3 touch", "BB3 penetration + rejection"]) {
  results.extension[b] = tally(extAll.filter((r) => r.extBucket === b));
}
// BB2 vs BB3 rejection head-to-head
results.bb2vsbb3 = { BB2_rejection: tally(variantTrades("A")), BB3_rejection: tally(variantTrades("B")) };

// sessions and hours (full method); also for variant A (larger sample)
function bySession(list) {
  const out = {};
  for (const s of ["Asia", "London", "London/NY overlap", "New York"]) out[s] = tally(list.filter((r) => r.session === s));
  return out;
}
function byHour(list) {
  const out = {};
  for (let hUtc = 0; hUtc < 24; hUtc++) { const L = list.filter((r) => r.hourUtc === hUtc); if (L.length) out[hUtc] = tally(L); }
  return out;
}
function byDay(list) {
  const out = {};
  for (const d of SELECTED) out[d] = tally(list.filter((r) => r.day === d));
  return out;
}
results.sessionFull = bySession(fullList);
results.sessionA = bySession(variantTrades("A"));
results.hourA = byHour(variantTrades("A"));
results.dayFull = byDay(fullList);
results.dayA = byDay(variantTrades("A"));

// interpretation tests: stochastic neutral zones on variant D base
const dList = variantTrades("D");
function stochZone(list, dir, lowB, hiB) {
  // require crossing to originate from extreme: DOWN kPrev>=hiB ; UP kPrev<=lowB
  return list.filter((r) => r.direction === dir ? (dir === "DOWN" ? r._kPrev >= hiB : r._kPrev <= lowB) : false);
}
results.stochZones = {
  unrestricted: tally(dList),
  z20_80: tally(dList.filter((r) => r.direction === "DOWN" ? r._kPrev >= 80 : r._kPrev <= 20)),
  z30_70: tally(dList.filter((r) => r.direction === "DOWN" ? r._kPrev >= 70 : r._kPrev <= 30)),
};
// CCI neutral zones on variant E base
const eList = variantTrades("E");
results.cciZones = {
  unrestricted: tally(eList),
  outside100: tally(eList.filter((r) => r.direction === "DOWN" ? (r.cci ?? 0) > 100 : (r.cci ?? 0) < -100)),
  outside200: tally(eList.filter((r) => r.direction === "DOWN" ? (r.cci ?? 0) > 200 : (r.cci ?? 0) < -200)),
};

// meta
results.meta = {
  fetchedAt: raw.fetchedAt, host: raw.host, pairs: PAIRS,
  selectedTradingDays: SELECTED,
  windowStart: coverage[PAIRS[0]].start, windowEnd: coverage[PAIRS[0]].end,
  coverage,
  payouts: PAYOUTS, breakEven: Object.fromEntries(PAYOUTS.map((p) => [p, +breakEven(p).toFixed(4)])),
  adxInterpretation: `1-bar directional movement, ${5}-period Wilder smoothing (TR/DM and DX). Convergence: |+DI - -DI| <= ${ADX_CONV} within last ${ADX_LOOK} bars; divergence: reversal-side DI overtakes and gap widens with ADX rising.`,
  totalSignals: trades.length,
};

fs.writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify(results, null, 2));

// ------------------------------------------------------------------ CSVs
function csv(rows, headers) {
  return [headers.join(","), ...rows.map((r) => headers.map((hh) => {
    const v = r[hh]; return v === null || v === undefined ? "" : String(v).includes(",") ? `"${v}"` : v;
  }).join(","))].join("\n");
}
// TRADES.csv (one row per fired signal, variants joined by |)
const tradeHeaders = ["entryTime", "symbol", "direction", "entry", "expiryTime", "expiry", "result", "bbEvent",
  "extBucket", "u2", "l2", "u3", "l3", "haDir", "stochK", "stochD", "stochCross", "cci", "cciSlope",
  "adx", "plusDI", "minusDI", "session", "hourUtc", "day", "variants"];
const tradeRows = trades.map((r) => ({ ...r, variants: r.variants.join("|") }));
fs.writeFileSync(path.join(OUT_DIR, "TRADES.csv"), csv(tradeRows, tradeHeaders));

// PAIR_RESULTS.csv (full method)
const pairRows = PAIRS.map((p) => {
  const x = results.perPairFull[p];
  return {
    pair: p, signals: x.all.n, wins: x.all.wins, losses: x.all.losses, ties: x.all.ties,
    wr: (x.all.wr * 100).toFixed(1), upTrades: x.up.decided, upWins: x.up.wins, upWR: (x.up.wr * 100).toFixed(1),
    downTrades: x.down.decided, downWins: x.down.wins, downWR: (x.down.wr * 100).toFixed(1),
  };
});
fs.writeFileSync(path.join(OUT_DIR, "PAIR_RESULTS.csv"),
  csv(pairRows, ["pair", "signals", "wins", "losses", "ties", "wr", "upTrades", "upWins", "upWR", "downTrades", "downWins", "downWR"]));

// VARIANT_RESULTS.csv
const varRows = VARIANTS.map((v) => {
  const x = results.variants[v];
  return { variant: v, desc: x.desc, trades: x.n, wins: x.wins, losses: x.losses, ties: x.ties,
    wr: (x.wr * 100).toFixed(1), ci: `${(x.ciLo * 100).toFixed(1)}-${(x.ciHi * 100).toFixed(1)}`, ev80: x.ev[0.8] };
});
fs.writeFileSync(path.join(OUT_DIR, "VARIANT_RESULTS.csv"),
  csv(varRows, ["variant", "desc", "trades", "wins", "losses", "ties", "wr", "ci", "ev80"]));

// DAILY_RESULTS.csv (full + variant A)
const dailyRows = SELECTED.map((d) => {
  const f = results.dayFull[d], a = results.dayA[d];
  return { day: d, fullTrades: f.decided, fullWins: f.wins, fullWR: (f.wr * 100).toFixed(1),
    aTrades: a.decided, aWins: a.wins, aWR: (a.wr * 100).toFixed(1) };
});
fs.writeFileSync(path.join(OUT_DIR, "DAILY_RESULTS.csv"),
  csv(dailyRows, ["day", "fullTrades", "fullWins", "fullWR", "aTrades", "aWins", "aWR"]));

console.error(`total signals: ${trades.length}`);
console.error(`full(I): n=${results.full.n} wr=${(results.full.wr * 100).toFixed(1)}% (${results.full.wins}/${results.full.losses}/${results.full.ties})`);
for (const v of VARIANTS) { const x = results.variants[v]; console.error(`  ${v} ${VARIANT_DESC[v]}: n=${x.n} decided=${x.decided} wr=${(x.wr * 100).toFixed(1)}%`); }
console.error("wrote RESULTS.json, TRADES.csv, PAIR_RESULTS.csv, VARIANT_RESULTS.csv, DAILY_RESULTS.csv");
