// How far each 2026 trade went in your favour before it came back to the
// stop: run with no target (100R) and a 48h limit, read the max favourable move.
import { run } from './replay.mjs';
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const [label, o] of [['original entry', {}], ['A (structure break)', { confirm: 'structure' }]]) {
  const T = run({ ...o, targetR: 100 }).trades;
  console.log(`\n== ${label}: ${T.length} trades, stop median ${med(T.map((t) => t.stopPips)).toFixed(1)} pips`);
  console.log('median best move before reversing:', med(T.map((t) => t.mfe)).toFixed(2), 'R =', med(T.map((t) => t.mfe * t.stopPips)).toFixed(1), 'pips');
  for (const r of [0.25, 0.5, 0.75, 1, 1.5, 2, 3]) {
    const n = T.filter((t) => t.mfe >= r).length;
    console.log(`reached +${r}R`.padEnd(14), `${String(n).padStart(3)} / ${T.length}`, `${Math.round(100 * n / T.length)}%`.padStart(5));
  }
  const b = [[0, 0.25], [0.25, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 999]];
  console.log('distribution:', b.map(([lo, hi]) => `${lo}-${hi === 999 ? '+' : hi}R: ${T.filter((t) => t.mfe >= lo && t.mfe < hi).length}`).join(' | '));
  console.log('ended on stop', T.filter((t) => t.how === 'stop').length, '| still open at 48h', T.filter((t) => t.how !== 'stop').length);
}
