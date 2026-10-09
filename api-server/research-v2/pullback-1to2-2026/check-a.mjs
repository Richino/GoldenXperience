// Adjustment A (structure-break confirmation) across three years, by quarter.
import { run } from './replay.mjs';
const sum = (a) => a.reduce((x, y) => x + y, 0);
const s = (ts) => `n=${String(ts.length).padStart(3)} WR ${String(Math.round(100 * ts.filter((t) => t.resultR > 0).length / (ts.length || 1))).padStart(2)}% avg ${(sum(ts.map((t) => t.resultR)) / (ts.length || 1)).toFixed(2).padStart(5)}R net ${sum(ts.map((t) => t.resultR)).toFixed(1).padStart(6)}R`;
const years = [['2024 (unseen)', { suffix: '_2024', start: '2024-01-01', end: '2025-01-01' }], ['2025 (unseen)', { suffix: '_2025', start: '2025-01-01', end: '2026-01-01' }], ['2026 (tuned)', {}]];
const all = { orig: [], A: [] };
for (const [label, y] of years) {
  const o = run(y).trades; const a = run({ ...y, confirm: 'structure' }).trades;
  all.orig.push(...o); all.A.push(...a);
  console.log(label.padEnd(14), 'original', s(o), ' |  A', s(a));
  for (const q of ['01', '04', '07', '10']) {
    const inQ = (t) => { const m = t.entryTime.slice(5, 7); return m >= q && m < String(+q + 3).padStart(2, '0'); };
    console.log('   Q' + (Math.floor((+q - 1) / 3) + 1).toString().padEnd(10), '         ', s(o.filter(inQ)), ' |   ', s(a.filter(inQ)));
  }
}
console.log('3 years'.padEnd(14), 'original', s(all.orig), ' |  A', s(all.A));
const A = all.A;
console.log('A zero-spread avg', ((sum(A.map((t) => t.resultR + t.spreadR))) / A.length).toFixed(2), 'R; spread', (sum(A.map((t) => t.spreadR)) / A.length).toFixed(2), 'R');
const L = A.filter((t) => t.resultR <= 0);
console.log('A losers: never +0.5R', L.filter((t) => t.mfe < 0.5).length, '| +1R then reversed', L.filter((t) => t.mfe >= 1).length, 'of', L.length);
for (const d of ['long', 'short']) console.log('A', d, s(A.filter((t) => t.dir === d)));
