// Wider stops on 2026, 1:2 kept; then what target the same entries need for 50%.
import { run } from './replay.mjs';
const sum = (a) => a.reduce((x, y) => x + y, 0);
const s = (ts) => { const w = ts.filter((t) => t.resultR > 0); const gl = -sum(ts.filter((t) => t.resultR <= 0).map((t) => t.resultR)); return `n=${String(ts.length).padStart(3)} WR ${String(Math.round(100 * w.length / (ts.length || 1))).padStart(2)}% avg ${(sum(ts.map((t) => t.resultR)) / (ts.length || 1)).toFixed(2).padStart(5)}R net ${sum(ts.map((t) => t.resultR)).toFixed(1).padStart(6)}R PF ${gl ? (sum(w.map((t) => t.resultR)) / gl).toFixed(2) : '-'} | spread ${(sum(ts.map((t) => t.spreadR)) / (ts.length || 1)).toFixed(3)}R | time-exits ${ts.filter((t) => t.how === 'time' || t.how === 'friday').length} | stop ~${[...ts.map((t) => t.stopPips)].sort((a, b) => a - b)[Math.floor(ts.length / 2)]?.toFixed(0)}p`; };
for (const confirm of ['candle', 'structure']) {
  console.log(`\n== entry confirmation: ${confirm}, target 2R`);
  console.log('pullback stop (original)'.padEnd(26), s(run({ confirm }).trades));
  for (const k of [1, 1.5, 2, 3, 4, 6]) console.log(`stop ${k} x H1 ATR`.padEnd(26), s(run({ confirm, stopAtr: k, maxHoldH: 120 }).trades));
}
console.log('\n== what reward the same entries need for 50% (structure confirm, stop 2 x H1 ATR)');
for (const r of [2, 1.5, 1.2, 1, 0.8]) console.log(`target ${r}R`.padEnd(26), s(run({ confirm: 'structure', stopAtr: 2, targetR: r, maxHoldH: 120 }).trades));
