// 1:0.25, stop 4x H1 ATR, 2023–2026: give every losing trade a reason.
import fs from 'fs';
import { run } from './replay.mjs';
import { YEARS, s } from './quarter.mjs';
const all = [];
for (const [label, y] of YEARS) { const t = run({ ...y, stopAtr: 4, targetR: 0.25, maxHoldH: 120 }).trades; all.push(...t); console.log(label, s(t)); }
console.log('ALL ', s(all));
const CAL = ['_2023', '_2024', '_2025', ''].flatMap((x) => JSON.parse(fs.readFileSync(`${process.env.PB_DATA_DIR}/calendar_high${x}.json`, 'utf8')));
// A release for either currency, after entry, in the 3h before the stop.
function newsAtStop(t) {
  const [b, q] = t.pair.split('_'); const ex = Date.parse(t.exitTime);
  return CAL.filter((e) => (e.currency === b || e.currency === q) && e.time > Date.parse(t.entryTime) && e.time <= ex && e.time >= ex - 3 * 3600000);
}
function reason(t) {
  const tgtPips = t.stopPips * 0.25;
  const lostPips = Math.abs(t.resultR) * t.stopPips;
  if (t.how === 'friday') return ['Closed for the weekend while down', `Friday 20:45 close, down ${lostPips.toFixed(0)} pips (best was +${t.pipsMfe.toFixed(1)} of the ${tgtPips.toFixed(0)} needed)`];
  if (t.how === 'time') return ['5-day limit while down', `still open after 120h, down ${lostPips.toFixed(0)} pips`];
  const hit = newsAtStop(t);
  if (hit.length) return ['News hit it', `${hit.slice(0, 2).map((e) => `${e.currency} ${e.title}`).join('; ')}; stopped ${Math.round((Date.parse(t.exitTime) - hit[0].time) / 60000)} min after`];
  if (t.pipsMfe < Math.max(2, 0.2 * tgtPips)) return ['Never moved your way', `best +${t.pipsMfe.toFixed(1)} pips; the pullback kept going ${t.stopPips.toFixed(0)} pips to the stop`];
  if (t.mfe >= 0.15) return ['Almost hit target, then reversed', `got +${t.pipsMfe.toFixed(1)} of ${tgtPips.toFixed(0)} pips, then fell ${t.stopPips.toFixed(0)} pips to the stop`];
  if (t.h1Flipped) return ['Trend turned', `+${t.pipsMfe.toFixed(1)} pips, then the 1H trend flipped against you and ran to the stop`];
  return ['Stalled, then reversed', `+${t.pipsMfe.toFixed(1)} of ${tgtPips.toFixed(0)} pips, then reversed to the stop (1H trend still with you)`];
}
const L = all.filter((t) => t.resultR <= 0).map((t) => ({ ...t, why: reason(t) }));
const counts = {};
for (const t of L) { const k = t.why[0]; counts[k] ??= { n: 0, r: 0 }; counts[k].n += 1; counts[k].r += t.resultR; }
console.log(`\nlosers ${L.length} of ${all.length}`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1].n - a[1].n)) console.log(k.padEnd(36), String(v.n).padStart(4), `${v.r.toFixed(1)}R`);
const W = all.filter((t) => t.resultR > 0);
console.log('winners: total +', W.reduce((a, t) => a + t.resultR, 0).toFixed(1), 'R; losers', L.reduce((a, t) => a + t.resultR, 0).toFixed(1), 'R');

const byPair = {}; for (const t of all) { byPair[t.pair] ??= []; byPair[t.pair].push(t); }
for (const [p, ts] of Object.entries(byPair)) console.log(p.padEnd(8), s(ts));
const lines = ['# Every losing trade: 1:0.25, stop 4x H1 ATR, 2023–2026', '', `${all.length} trades, ${W.length} wins, ${L.length} losses. Times UTC.`, '', '| # | Entry | Pair | Dir | Stop (pips) | Result | Why | Detail |', '|---|---|---|---|---|---|---|---|'];
L.forEach((t, i) => lines.push(`| ${i + 1} | ${t.entryTime.slice(0, 16).replace('T', ' ')} | ${t.pair.replace('_', '/')} | ${t.dir} | ${t.stopPips.toFixed(0)} | ${t.resultR.toFixed(2)}R | ${t.why[0]} | ${t.why[1]} |`));
fs.writeFileSync(new URL('./losses-1to0.25.md', import.meta.url), lines.join('\n') + '\n');
fs.writeFileSync(new URL('./trades-1to0.25.json', import.meta.url), JSON.stringify(all, null, 1));
