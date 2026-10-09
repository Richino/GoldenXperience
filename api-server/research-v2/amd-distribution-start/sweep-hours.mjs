// When does the first push past the Asian range (00–07 UTC) happen, and how
// often is it manipulation — closed back inside within 2h, then reached the
// other side of the range by 21 UTC before breaking the push extreme?
import fs from 'fs';
import path from 'path';
const DATA_DIR = process.env.PB_DATA_DIR;
const H = 3600e3;
const PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'USD_CHF', 'NZD_USD', 'EUR_JPY', 'GBP_JPY', 'AUD_JPY'];
const files = { '2023': '_2023', '2024': '_2024', '2025': '_2025', '2026': '' };
const buckets = new Map();
let days = 0; let never = 0;
for (const [year, suffix] of Object.entries(files)) {
  const from = Date.parse(`${year}-01-01`); const to = Date.parse(`${+year + 1}-01-01`);
  for (const pair of PAIRS) {
    const pip = pair.includes('JPY') ? 0.01 : 0.0001;
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${pair}_M15${suffix}.json`), 'utf8'));
    const byDay = new Map();
    for (const [t, bo, bh, bl, bc, ao, ah, al, ac] of raw) {
      if (t < from || t >= to) continue;
      const d = t - (t % (24 * H));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push({ ms: t, h: (bh + ah) / 2, l: (bl + al) / 2, c: (bc + ac) / 2 });
    }
    for (const [day, bars] of byDay) {
      const asia = bars.filter((b) => b.ms < day + 7 * H);
      const rest = bars.filter((b) => b.ms >= day + 7 * H && b.ms < day + 21 * H);
      if (asia.length < 20 || rest.length < 20) continue;
      days += 1;
      const hi = Math.max(...asia.map((b) => b.h)); const lo = Math.min(...asia.map((b) => b.l));
      const poke = Math.max(2 * pip, 0.1 * (hi - lo));
      const s = rest.findIndex((b) => b.h >= hi + poke || b.l <= lo - poke);
      if (s < 0) { never += 1; continue; }
      const up = rest[s].h >= hi + poke;
      if (up && rest[s].l <= lo - poke) continue;
      let extreme = up ? rest[s].h : rest[s].l;
      let reclaimed = false;
      for (let i = s; i < Math.min(rest.length, s + 8); i += 1) {
        extreme = up ? Math.max(extreme, rest[i].h) : Math.min(extreme, rest[i].l);
        if (up ? rest[i].c < hi : rest[i].c > lo) { reclaimed = i; break; }
      }
      let result = 'breakout';
      if (reclaimed !== false) {
        result = 'failed';
        for (let i = reclaimed + 1; i < rest.length; i += 1) {
          if (up ? rest[i].h > extreme : rest[i].l < extreme) break;
          if (up ? rest[i].l < lo : rest[i].h > hi) { result = 'manipulation'; break; }
        }
      }
      const hour = new Date(rest[s].ms).getUTCHours();
      const key = hour < 10 ? '07–10 London open' : hour < 12 ? '10–12 London mid' : hour < 15 ? '12–15 NY open / overlap' : '15–21 NY afternoon';
      if (!buckets.has(key)) buckets.set(key, { n: 0, manipulation: 0, failed: 0, breakout: 0 });
      const b = buckets.get(key); b.n += 1; b[result] += 1;
    }
  }
}
const allManip = [...buckets.values()].reduce((a, b) => a + b.manipulation, 0);
console.log(`pair-days ${days}; Asian range never broken ${Math.round(100 * never / days)}%`);
console.log('first push past Asia'.padEnd(26), 'share of days', ' real manipulation', ' sweep then ran on', ' clean breakout', ' share of all manipulation');
for (const k of ['07–10 London open', '10–12 London mid', '12–15 NY open / overlap', '15–21 NY afternoon']) {
  const b = buckets.get(k);
  console.log(k.padEnd(26), `${Math.round(100 * b.n / days)}%`.padStart(13), `${Math.round(100 * b.manipulation / b.n)}%`.padStart(18), `${Math.round(100 * b.failed / b.n)}%`.padStart(18), `${Math.round(100 * b.breakout / b.n)}%`.padStart(15), `${Math.round(100 * b.manipulation / allManip)}%`.padStart(26));
}
