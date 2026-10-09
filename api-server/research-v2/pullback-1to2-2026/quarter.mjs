// 1:0.25 with a wide stop, 2023–2026. Compare stop widths first.
import { run } from './replay.mjs';
const sum = (a) => a.reduce((x, y) => x + y, 0);
export const YEARS = [['2023', { suffix: '_2023', start: '2023-01-01', end: '2024-01-01' }], ['2024', { suffix: '_2024', start: '2024-01-01', end: '2025-01-01' }], ['2025', { suffix: '_2025', start: '2025-01-01', end: '2026-01-01' }], ['2026', {}]];
export const s = (ts) => { const w = ts.filter((t) => t.resultR > 0); return `n=${String(ts.length).padStart(4)} WR ${(100 * w.length / (ts.length || 1)).toFixed(1).padStart(5)}% avg ${(sum(ts.map((t) => t.resultR)) / (ts.length || 1)).toFixed(3).padStart(6)}R net ${sum(ts.map((t) => t.resultR)).toFixed(1).padStart(6)}R stopped ${ts.filter((t) => t.how === 'stop').length} time/fri ${ts.filter((t) => t.how === 'time' || t.how === 'friday').length}`; };
if (process.argv[2] === 'grid') {
  for (const k of [1, 2, 3, 4, 6]) {
    const all = [];
    for (const [, y] of YEARS) all.push(...run({ ...y, stopAtr: k, targetR: 0.25, maxHoldH: 120 }).trades);
    const med = [...all.map((t) => t.stopPips)].sort((a, b) => a - b)[Math.floor(all.length / 2)];
    console.log(`stop ${k}x H1 ATR (~${med.toFixed(0)}p, target ~${(med / 4).toFixed(0)}p)`.padEnd(40), s(all), `| spread ${(sum(all.map((t) => t.spreadR)) / all.length).toFixed(3)}R`);
  }
}
