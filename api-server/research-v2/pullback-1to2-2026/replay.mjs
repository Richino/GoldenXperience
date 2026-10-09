// 2026 trend-pullback replay, 1:2, news-avoiding.
//
// 1. Tradable check (re-run every hour, London+NY 07–17 UTC): H4 trend
//    (EMA50 vs EMA200, price on the trend side of EMA50, EMA50 sloping that
//    way), H1 agrees (EMA21 vs EMA50), the pair is moving (H1 ATR at least
//    0.8x its 20-day median) and the spread is under 15% of H1 ATR.
// 2. Pullback validated on M15: an 8-hour swing extreme, then a pullback of
//    0.6–2.0 H1 ATR that reaches the H1 EMA21 area without closing through
//    EMA50, then a M15 candle that closes back in the trend direction past
//    the previous candle's high/low.
// 3. Entry at the next M15 open (ask for longs, bid for shorts).
// 4. Stop beyond the pullback extreme + 0.1 ATR (min 0.4 ATR, skip if over
//    1.2 ATR, so stops stay tight); target 2R. Same-bar stop+target = stop.
//    Time exit after 48h; everything closed Friday 20:45 UTC.
// 5. No entry from 30 min before to 2h after a high-impact release for
//    either currency.
// One trade per pair at a time, one per pair per day.
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.PB_DATA_DIR;
const OUT_DIR = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'USD_CHF', 'NZD_USD', 'EUR_JPY', 'GBP_JPY', 'AUD_JPY'];
const H = 3600000;
const M15 = 900000;


function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let e = values[0];
  for (let i = 0; i < values.length; i += 1) { e = i === 0 ? values[0] : values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

// Aggregate M15 mid bars into higher timeframe bars keyed by bucket start.
function aggregate(bars, ms) {
  const out = [];
  for (const b of bars) {
    const t = b.t - (b.t % ms);
    const last = out.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.end = b.t + M15; }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, end: b.t + M15 });
  }
  return out;
}

function atr(bars, period) {
  const out = new Array(bars.length);
  let a = bars[0].h - bars[0].l;
  for (let i = 0; i < bars.length; i += 1) {
    const tr = i === 0 ? bars[i].h - bars[i].l : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    a = i === 0 ? tr : (a * (period - 1) + tr) / period;
    out[i] = a;
  }
  return out;
}

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

// Adjustments (all off by default = the original test):
//   confirm 'structure'  resumption candle must close past the pullback's
//                        last lower high (higher low for shorts), not just
//                        the previous candle
//   minHour              earliest entry hour UTC
//   beAtR                once price reaches this R, stop moves to +0.1R
//   stopBuffer / minRiskAtr  room beyond the pullback extreme
//   maxSpreadR           skip if the spread is more than this share of risk
//   stopAtr              fixed stop of this many H1 ATRs (replaces the
//                        pullback-extreme stop and its 1.2 ATR cap)
//   targetR / maxHoldH   reward multiple and time exit
export function run({ suffix = '', start = '2026-01-01', end = '2026-10-07', confirm = 'candle', minHour = 7, beAtR = null, stopBuffer = 0.1, minRiskAtr = 0.4, maxSpreadR = null, stopAtr = null, targetR = 2, maxHoldH = 48 } = {}) {
const START = Date.parse(start + 'T00:00:00Z');
const END = Date.parse(end + 'T00:00:00Z');
const news = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `calendar_high${suffix}.json`), 'utf8'));
const trades = [];
const audit = { tradableHours: 0, sessionHours: 0, blockedByNews: 0, skippedWideStop: 0, validated: 0 };

for (const pair of PAIRS) {
  const [base, quote] = pair.split('_');
  const pip = quote === 'JPY' ? 0.01 : 0.0001;
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${pair}_M15${suffix}.json`), 'utf8'));
  const m = raw.map(([t, bo, bh, bl, bc, ao, ah, al, ac]) => ({ t, bo, bh, bl, bc, ao, ah, al, ac, o: (bo + ao) / 2, h: (bh + ah) / 2, l: (bl + al) / 2, c: (bc + ac) / 2 }));
  const h1 = aggregate(m, H);
  const h4 = aggregate(m, 4 * H);
  const h1e21 = ema(h1.map((b) => b.c), 21);
  const h1e50 = ema(h1.map((b) => b.c), 50);
  const h1atr = atr(h1, 14);
  const h4e50 = ema(h4.map((b) => b.c), 50);
  const h4e200 = ema(h4.map((b) => b.c), 200);
  const pairNews = news.filter((e) => e.currency === base || e.currency === quote).map((e) => e.time);

  // Index of the last COMPLETED higher-TF bar at time t (bar end <= t).
  let i1 = -1; let i4 = -1;
  const lastClosed = (arr, idx, t) => { while (idx + 1 < arr.length && arr[idx + 1].end <= t) idx += 1; return idx; };

  let openUntil = 0; let lastTradeDay = -1;
  let tradableNow = null; let checkedHour = -1;

  for (let i = 40; i < m.length - 1; i += 1) {
    const bar = m[i];
    const now = bar.t + M15; // decision at this M15 close
    if (now >= END) break;
    if (now < START) { i1 = lastClosed(h1, i1, now); i4 = lastClosed(h4, i4, now); continue; }
    i1 = lastClosed(h1, i1, now); i4 = lastClosed(h4, i4, now);
    if (i1 < 500 || i4 < 210) continue;
    const d = new Date(now);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();
    const inSession = hour >= minHour && hour < 17 && dow >= 1 && dow <= 5 && !(dow === 5 && hour >= 15);
    if (!inSession) { tradableNow = null; continue; }

    // Step 1: re-check tradability once per hour.
    const hourKey = Math.floor(now / H);
    if (hourKey !== checkedHour) {
      checkedHour = hourKey;
      audit.sessionHours += 1;
      const atrNow = h1atr[i1];
      const atrMed = median(h1atr.slice(i1 - 480, i1));
      const spread = bar.ac - bar.bc;
      const slope = h4e50[i4] - h4e50[i4 - 6];
      let dir = null;
      if (h4e50[i4] > h4e200[i4] && h4[i4].c > h4e50[i4] && slope > 0 && h1e21[i1] > h1e50[i1]) dir = 'long';
      if (h4e50[i4] < h4e200[i4] && h4[i4].c < h4e50[i4] && slope < 0 && h1e21[i1] < h1e50[i1]) dir = 'short';
      const moving = atrNow >= 0.8 * atrMed;
      const spreadOk = spread <= 0.15 * atrNow;
      tradableNow = dir && moving && spreadOk ? { dir, atr: atrNow, trendGapAtr: Math.abs(h4e50[i4] - h4e200[i4]) / atrNow } : null;
      if (tradableNow) audit.tradableHours += 1;
    }
    if (!tradableNow || now < openUntil) continue;
    const day = Math.floor(now / 86400000);
    if (day === lastTradeDay) continue;

    // Step 2: validate the pullback on M15.
    const { dir, atr: a } = tradableNow;
    const long = dir === 'long';
    const win = m.slice(i - 31, i + 1);
    let extIdx = 0;
    for (let k = 1; k < win.length; k += 1) if (long ? win[k].h > win[extIdx].h : win[k].l < win[extIdx].l) extIdx = k;
    if (extIdx > win.length - 3) continue; // need bars after the swing
    const after = win.slice(extIdx + 1);
    let pbIdx = 0;
    for (let k = 1; k < after.length; k += 1) if (long ? after[k].l < after[pbIdx].l : after[k].h > after[pbIdx].h) pbIdx = k;
    const swing = long ? win[extIdx].h : win[extIdx].l;
    const pbExt = long ? after[pbIdx].l : after[pbIdx].h;
    const depth = Math.abs(swing - pbExt) / a;
    if (depth < 0.6 || depth > 2.0) continue;
    const reachedZone = long ? pbExt <= h1e21[i1] + 0.2 * a : pbExt >= h1e21[i1] - 0.2 * a;
    const trendHeld = after.every((b) => (long ? b.c > h1e50[i1] - 0.3 * a : b.c < h1e50[i1] + 0.3 * a));
    if (!reachedZone || !trendHeld) continue;
    const barsSincePb = after.length - 1 - pbIdx;
    if (barsSincePb > 6) continue;
    const prev = m[i - 1];
    let level = long ? prev.h : prev.l;
    if (confirm === 'structure') {
      const since = after.slice(pbIdx, after.length - 1);
      if (since.length < 2) continue;
      level = long ? Math.max(...since.map((b) => b.h)) : Math.min(...since.map((b) => b.l));
    }
    const confirmed = long ? bar.c > bar.o && bar.c > level : bar.c < bar.o && bar.c < level;
    if (!confirmed) continue;
    audit.validated += 1;

    // Step 5: news filter.
    const entryT = m[i + 1].t;
    if (pairNews.some((t) => t >= entryT - 30 * 60000 && t <= entryT + 2 * H)) { audit.blockedByNews += 1; continue; }

    // Steps 3–4: entry, tight stop, 2R target.
    const nb = m[i + 1];
    const entry = long ? nb.ao : nb.bo;
    let stop = long ? pbExt - stopBuffer * a : pbExt + stopBuffer * a;
    let risk = Math.abs(entry - stop);
    if (stopAtr !== null) { risk = stopAtr * a; stop = long ? entry - risk : entry + risk; }
    else if (risk > 1.2 * a) { audit.skippedWideStop += 1; continue; }
    if (risk < minRiskAtr * a) { risk = minRiskAtr * a; stop = long ? entry - risk : entry + risk; }
    if (maxSpreadR !== null && (nb.ao - nb.bo) / risk > maxSpreadR) continue;
    const target = long ? entry + targetR * risk : entry - targetR * risk;

    let exit = null; let exitT = null; let how = null; let mfe = 0; let mae = 0; let hit1R = false; let hit1RBeforeHalfLoss = null;
    const deadline = entryT + maxHoldH * H;
    for (let j = i + 1; j < m.length; j += 1) {
      const b = m[j];
      const bd = new Date(b.t);
      const fav = long ? (b.bh - entry) / risk : (entry - b.al) / risk;
      const adv = long ? (entry - b.bl) / risk : (b.ah - entry) / risk;
      if (adv >= 0.5 && hit1RBeforeHalfLoss === null) hit1RBeforeHalfLoss = false;
      if (fav >= 1 && hit1RBeforeHalfLoss === null) hit1RBeforeHalfLoss = true;
      const stopHit = long ? b.bl <= stop : b.ah >= stop;
      const tgtHit = long ? b.bh >= target : b.al <= target;
      if (stopHit) { exit = stop; exitT = b.t; how = how === 'be' ? 'breakeven' : 'stop'; mae = Math.max(mae, 1); break; }
      mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
      if (fav >= 1) hit1R = true;
      if (beAtR !== null && fav >= beAtR && (long ? stop < entry : stop > entry)) { stop = long ? entry + 0.1 * risk : entry - 0.1 * risk; how = 'be'; }
      if (tgtHit) { exit = target; exitT = b.t; how = 'target'; break; }
      const fridayClose = bd.getUTCDay() === 5 && bd.getUTCHours() === 20 && bd.getUTCMinutes() === 45;
      if (b.t + M15 >= deadline || fridayClose || j === m.length - 1) { exit = long ? b.bc : b.ac; exitT = b.t + M15; how = fridayClose ? 'friday' : 'time'; break; }
    }
    const resultR = (long ? exit - entry : entry - exit) / risk;
    const spreadR = (nb.ao - nb.bo) / risk;
    const newsDuring = pairNews.filter((t) => t > entryT && t < exitT).length;
    const newsTitles = news.filter((e) => (e.currency === base || e.currency === quote) && e.time > entryT && e.time < exitT).map((e) => `${e.currency} ${e.title}`);
    const k1 = h1.findLastIndex((b) => b.end <= exitT);
    const h1Flipped = long ? h1e21[k1] < h1e50[k1] : h1e21[k1] > h1e50[k1];
    const pipsMfe = mfe * risk / pip;
    // H4 trend still intact when the trade closed?
    const k4 = h4.findLastIndex((b) => b.end <= exitT);
    const trendIntact = long ? h4e50[k4] > h4e200[k4] && h4[k4].c > h4e50[k4] : h4e50[k4] < h4e200[k4] && h4[k4].c < h4e50[k4];
    trades.push({
      pair, dir, entryTime: new Date(entryT).toISOString(), exitTime: new Date(exitT).toISOString(), hour: new Date(entryT).getUTCHours(),
      entry, stop, target, exit, how, resultR, stopPips: risk / pip, spreadR, mfe, mae, hit1R, firstMove: hit1RBeforeHalfLoss,
      depthAtr: depth, trendGapAtr: tradableNow.trendGapAtr, newsDuring, newsTitles, trendIntact, h1Flipped, pipsMfe, holdHours: (exitT - entryT) / H,
    });
    openUntil = exitT; lastTradeDay = day;
  }
}

return { trades, audit };
}

if (path.resolve(process.argv[1]) === path.resolve(OUT_DIR, 'replay.mjs')) {
  const { trades, audit } = run();
  fs.writeFileSync(path.join(OUT_DIR, 'trades.json'), JSON.stringify(trades, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'audit.json'), JSON.stringify(audit, null, 1));
  console.log(JSON.stringify(audit), 'trades', trades.length);
}
