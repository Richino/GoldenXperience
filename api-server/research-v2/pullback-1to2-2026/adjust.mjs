// Try each loss-driven adjustment: tune on 2026, then check on unseen 2025.
import { run } from './replay.mjs';
const sum = (a) => a.reduce((x, y) => x + y, 0);
function s(ts) {
  const w = ts.filter((t) => t.resultR > 0); const gl = -sum(ts.filter((t) => t.resultR <= 0).map((t) => t.resultR));
  return `n=${String(ts.length).padStart(3)} WR ${String(Math.round(100 * w.length / (ts.length || 1))).padStart(2)}% avg ${(sum(ts.map((t) => t.resultR)) / (ts.length || 1)).toFixed(2).padStart(5)}R net ${sum(ts.map((t) => t.resultR)).toFixed(1).padStart(6)}R PF ${gl ? (sum(w.map((t) => t.resultR)) / gl).toFixed(2) : '-'}`;
}
const variants = {
  'original': {},
  'A wait for structure break': { confirm: 'structure' },
  'B more room (0.3 ATR, min 0.6)': { stopBuffer: 0.3, minRiskAtr: 0.6 },
  'C breakeven at +1R': { beAtR: 1 },
  'D skip London open (<11 UTC)': { minHour: 11 },
  'E spread under 8% of risk': { maxSpreadR: 0.08 },
  'A+B': { confirm: 'structure', stopBuffer: 0.3, minRiskAtr: 0.6 },
  'A+B+E': { confirm: 'structure', stopBuffer: 0.3, minRiskAtr: 0.6, maxSpreadR: 0.08 },
  'A+B+D+E': { confirm: 'structure', stopBuffer: 0.3, minRiskAtr: 0.6, minHour: 11, maxSpreadR: 0.08 },
  'all (A+B+C+D+E)': { confirm: 'structure', stopBuffer: 0.3, minRiskAtr: 0.6, minHour: 11, maxSpreadR: 0.08, beAtR: 1 },
};
console.log('variant'.padEnd(32), '2026 (tuned on)'.padEnd(52), '2025 (unseen)');
for (const [name, o] of Object.entries(variants)) {
  const a = run(o).trades;
  const b = run({ ...o, suffix: '_2025', start: '2025-01-01', end: '2026-01-01' }).trades;
  console.log(name.padEnd(32), s(a).padEnd(52), s(b));
}
