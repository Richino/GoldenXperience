// When does distribution start? Four live triggers after the Asian range
// (00–07 UTC), measured from the trigger price on M15 mid candles:
//   A displacement     first M15 close >= 0.25 Asian range beyond it, body >= 60%
//   B sweep + MSS      Asian side swept (2 pips / 10% of range) and a later
//                      close past the last swing on the other side (the
//                      extreme of the 4 candles before the sweep), by 13 UTC
//   C FVG retest       after A, first price return into the first gap the
//                      move left (entry at the gap's near edge)
//   D A + related pair the related pair has also closed beyond its own Asian
//                      range in the same (or, inverse pair, opposite) way
// Outcome: which comes first after the trigger, a further half Asian range
// with it or against it (by 21 UTC); plus how much of the day's move away
// from the range was already done at the trigger. Data cached by
// ../pullback-1to2-2026/fetch.mjs (PB_DATA_DIR).
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.PB_DATA_DIR;
const H = 3600e3;
const PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'USD_CHF', 'NZD_USD', 'EUR_JPY', 'GBP_JPY', 'AUD_JPY'];
const RELATED = { EUR_USD: ['GBP_USD', false], GBP_USD: ['EUR_USD', false], AUD_USD: ['NZD_USD', false], NZD_USD: ['AUD_USD', false], USD_CHF: ['EUR_USD', true], USD_CAD: ['AUD_USD', true], USD_JPY: ['EUR_JPY', false], EUR_JPY: ['GBP_JPY', false], GBP_JPY: ['EUR_JPY', false], AUD_JPY: ['EUR_JPY', false] };
const YEARS = { '2023': '_2023', '2024': '_2024', '2025': '_2025', '2026': '' };

function loadDays(pair, suffix, year) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${pair}_M15${suffix}.json`), 'utf8'));
  const from = Date.parse(`${year}-01-01`); const to = Date.parse(`${+year + 1}-01-01`);
  const days = new Map();
  for (const [t, bo, bh, bl, bc, ao, ah, al, ac] of raw) {
    if (t < from || t >= to) continue;
    const b = { ms: t, o: (bo + ao) / 2, h: (bh + ah) / 2, l: (bl + al) / 2, c: (bc + ac) / 2, spread: ac - bc };
    const d = t - (t % (24 * H));
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(b);
  }
  const out = new Map();
  for (const [day, bars] of days) {
    const asia = bars.filter((b) => b.ms < day + 7 * H);
    const rest = bars.filter((b) => b.ms >= day + 7 * H && b.ms < day + 21 * H);
    if (asia.length < 20 || rest.length < 20) continue;
    const hi = Math.max(...asia.map((b) => b.h)); const lo = Math.min(...asia.map((b) => b.l));
    out.set(day, { day, hi, lo, R: hi - lo, rest });
  }
  return out;
}

const isDisplacement = (b, d) => Math.abs(b.c - b.o) >= 0.6 * (b.h - b.l) && (b.c >= d.hi + 0.25 * d.R || b.c <= d.lo - 0.25 * d.R);

function outcome(d, idx, entry, up) {
  const after = d.rest.slice(idx + 1);
  if (!after.length) return null;
  let first = 'neither';
  for (const b of after) {
    const w = (up ? b.h - entry : entry - b.l) / d.R; const a = (up ? entry - b.l : b.h - entry) / d.R;
    if (a >= 0.5) { first = 'against'; break; }
    if (w >= 0.5) { first = 'with'; break; }
  }
  const dayBest = up ? Math.max(...d.rest.map((b) => b.h)) - d.hi : d.lo - Math.min(...d.rest.map((b) => b.l));
  const done = up ? entry - d.hi : d.lo - entry;
  return { first, done: dayBest > 0 ? Math.max(0, done) / dayBest : 1, spreadShare: d.rest[idx].spread / (0.5 * d.R) };
}

function triggerA(d) {
  const idx = d.rest.findIndex((b) => isDisplacement(b, d));
  if (idx < 0) return null;
  const up = d.rest[idx].c > d.hi;
  return { idx, entry: d.rest[idx].c, up };
}

function triggerB(d, pip) {
  const poke = Math.max(2 * pip, 0.1 * d.R);
  const end = d.day + 13 * H;
  const s = d.rest.findIndex((b) => b.ms < end && (b.h >= d.hi + poke || b.l <= d.lo - poke));
  if (s < 0) return null;
  const sweptHigh = d.rest[s].h >= d.hi + poke;
  if (sweptHigh && d.rest[s].l <= d.lo - poke) return null;
  const before = d.rest.slice(Math.max(0, s - 4), s);
  if (!before.length) return null;
  const level = sweptHigh ? Math.min(...before.map((b) => b.l)) : Math.max(...before.map((b) => b.h));
  for (let i = s + 1; i < d.rest.length && d.rest[i].ms < end + 2 * H; i += 1) {
    const b = d.rest[i];
    // The sweep extreme breaking first voids it.
    if (sweptHigh ? b.h > Math.max(...d.rest.slice(s, i).map((x) => x.h)) && b.c > d.hi : b.l < Math.min(...d.rest.slice(s, i).map((x) => x.l)) && b.c < d.lo) return null;
    if (sweptHigh ? b.c < level : b.c > level) return { idx: i, entry: b.c, up: !sweptHigh };
  }
  return null;
}

function triggerC(d, pip) {
  const a = triggerA(d);
  if (!a) return null;
  const minGap = Math.max(pip, 0.05 * d.R);
  const start = Math.max(2, d.rest.findIndex((b) => (a.up ? b.h > d.hi : b.l < d.lo)));
  for (let k = start; k <= a.idx + 1 && k < d.rest.length; k += 1) {
    const f = d.rest[k - 2]; const t = d.rest[k];
    const top = a.up ? t.l : f.l; const bottom = a.up ? f.h : t.h;
    if (top - bottom < minGap) continue;
    for (let j = Math.max(k + 1, a.idx + 1); j < d.rest.length; j += 1) {
      const b = d.rest[j];
      if (a.up ? b.l <= top : b.h >= bottom) return { idx: j, entry: a.up ? top : bottom, up: a.up };
    }
    return null;
  }
  return null;
}

function triggerD(d, rel, inverse) {
  const a = triggerA(d);
  if (!a || !rel) return null;
  const sigMs = d.rest[a.idx].ms;
  const relUp = a.up !== inverse;
  const agreed = rel.rest.some((b) => b.ms <= sigMs && (relUp ? b.c > rel.hi : b.c < rel.lo));
  return agreed ? a : null;
}

const triggers = { 'A displacement': [], 'B sweep + structure break': [], 'C FVG retest after A': [], 'D A + related pair agrees': [] };
const byPeriod = { tuned: structuredClone(triggers), unseen: structuredClone(triggers) };
for (const [year, suffix] of Object.entries(YEARS)) {
  const period = year === '2026' ? 'tuned' : 'unseen';
  const loaded = Object.fromEntries(PAIRS.map((p) => [p, loadDays(p, suffix, year)]));
  for (const pair of PAIRS) {
    const pip = pair.includes('JPY') ? 0.01 : 0.0001;
    const [relPair, inverse] = RELATED[pair];
    for (const d of loaded[pair].values()) {
      const rel = loaded[relPair].get(d.day);
      const fires = { 'A displacement': triggerA(d), 'B sweep + structure break': triggerB(d, pip), 'C FVG retest after A': triggerC(d, pip), 'D A + related pair agrees': triggerD(d, rel, inverse) };
      for (const [name, t] of Object.entries(fires)) {
        if (!t) continue;
        const o = outcome(d, t.idx, t.entry, t.up);
        if (o) byPeriod[period][name].push(o);
      }
    }
  }
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const pct = (n, of) => `${Math.round((100 * n) / (of || 1))}%`.padStart(4);
for (const [period, label] of [['tuned', '2026'], ['unseen', '2023–2025 (unseen)']]) {
  console.log(`\n== ${label}`);
  console.log('trigger'.padEnd(28), '   n   with  against neither  already-done  spread');
  for (const [name, rows] of Object.entries(byPeriod[period])) {
    const n = rows.length;
    console.log(name.padEnd(28), String(n).padStart(5), pct(rows.filter((r) => r.first === 'with').length, n).padStart(6), pct(rows.filter((r) => r.first === 'against').length, n).padStart(8), pct(rows.filter((r) => r.first === 'neither').length, n).padStart(7), `${Math.round(100 * med(rows.map((r) => r.done)))}%`.padStart(13), `${Math.round(100 * med(rows.map((r) => r.spreadShare)))}%`.padStart(7));
  }
}
