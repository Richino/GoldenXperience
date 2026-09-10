/**
 * USDCAD Structure EMA Reclaim V3 — mandatory behavior tests (A–M).
 * Proves the frozen decision logic on the CURRENT evaluator:
 *   qualified <=> 11:00 origin AND HH+HL AND close[1]<=ema20[1] AND close>ema20.
 * PEN/EXTREME are metadata (tag) only and never gate qualification.
 * Synthetic candles only; read-only.
 */
import assert from "node:assert/strict";
import { evaluateUsdcadStructureEmaReclaimV3 } from "../src/lib/strategy/strategies/usdcad-strategy.js";
import type { Candle } from "../src/types/forex.js";

const START = Date.parse("2026-01-01T00:00:00.000Z"); // idx 59 = 2026-01-03T11:00Z (origin); idx 58 = 10:00 (previous)
const ORIGIN_ISO = "2026-01-03T11:00:00.000Z";
type OHLC = { open: number; high: number; low: number; close: number };
const PREV_HIGH = 1.3502, PREV_LOW = 1.3498;

function build(cur: OHLC, prevClose = 1.3500): Candle[] {
  const rows: Candle[] = [];
  for (let i = 0; i < 60; i += 1) {
    const time = new Date(START + i * 3_600_000).toISOString();
    // Older bars carry a large (symmetric) range so ATR14 is sizeable while EMA20
    // (close-based) stays flat at 1.3500; the previous bar (idx 58) is small so
    // HH+HL is defined against it. This lets pen-false + extreme-true coexist.
    if (i < 58) rows.push({ time, open: 1.3500, high: 1.3550, low: 1.3450, close: 1.3500, volume: 1, complete: true });
    else if (i === 58) rows.push({ time, open: 1.3500, high: Math.max(prevClose, PREV_HIGH), low: Math.min(prevClose, PREV_LOW), close: prevClose, volume: 1, complete: true });
    else rows.push({ time, ...cur, volume: 1, complete: true });
  }
  return rows;
}

let passed = 0, total = 0;
function run(label: string, rows: Candle[], expect: { signal: boolean; tag?: string | null }, extra?: (ev: ReturnType<typeof evaluateUsdcadStructureEmaReclaimV3>) => void) {
  total += 1;
  const ev = evaluateUsdcadStructureEmaReclaimV3(rows);
  assert.equal(ev.originTime, ORIGIN_ISO, `${label}: origin must be ${ORIGIN_ISO}`);
  assert.equal(ev.strategySignalQualified, expect.signal, `${label}: qualified expected ${expect.signal} [HHHL=${ev.bullStructure} reclaim=${ev.longReclaim} pen=${ev.emaPenLong} extreme=${ev.extremeLong} tag=${ev.signalTag}]`);
  if (expect.tag !== undefined) assert.equal(ev.signalTag, expect.tag, `${label}: tag expected ${expect.tag}, got ${ev.signalTag}`);
  extra?.(ev);
  console.log(`  ${label}: OK (HHHL=${ev.bullStructure} reclaim=${ev.longReclaim} pen=${ev.emaPenLong} extreme=${ev.extremeLong} -> signal=${ev.strategySignalQualified} tag=${ev.signalTag})`);
  passed += 1;
}

// Raw-pass current bar variants. In all, prev(10:00) close=1.3500==ema20[prev] (reclaim `<=` side),
// and current close>ema20 (reclaim), high>1.3502 & low>1.3498 (HH+HL).
// PEN true/false controlled by (close-ema20) vs 0.25*ATR; EXTREME by close location in range.
const PEN_EXTREME: OHLC = { open: 1.3520, high: 1.3602, low: 1.3510, close: 1.3600 };       // strong pen, close near high
const PEN_ONLY: OHLC = { open: 1.3520, high: 1.3700, low: 1.3510, close: 1.3600 };            // strong pen, close NOT near high (extreme false)
const EXTREME_ONLY: OHLC = { open: 1.3500, high: 1.35055, low: 1.3499, close: 1.3505 };        // tiny pen (<0.25*ATR), close near its own high (extreme true)
const BASE_NEITHER: OHLC = { open: 1.35035, high: 1.3700, low: 1.35005, close: 1.35044 };      // tiny pen + close low in range

// ---- A: HH+HL, reclaim, PEN, EXTREME -> SIGNAL, PEN_EXTREME ----
run("A (PEN+EXTREME)", build(PEN_EXTREME), { signal: true, tag: "USDCAD_1100_LONG_PEN_EXTREME" }, (ev) => { assert.ok(ev.emaPenLong && ev.extremeLong, "A: pen & extreme true"); });

// ---- B: same raw, PEN false, EXTREME false -> SIGNAL, BASE (critical) ----
run("B (BASE, neither)", build(BASE_NEITHER), { signal: true, tag: "USDCAD_1100_LONG_BASE" }, (ev) => { assert.equal(ev.emaPenLong, false, "B: pen false"); assert.equal(ev.extremeLong, false, "B: extreme false"); });

// ---- C: PEN true, EXTREME false -> SIGNAL, BASE ----
run("C (PEN only)", build(PEN_ONLY), { signal: true, tag: "USDCAD_1100_LONG_BASE" }, (ev) => { assert.equal(ev.emaPenLong, true, "C: pen true"); assert.equal(ev.extremeLong, false, "C: extreme false"); });

// ---- D: PEN false, EXTREME true -> SIGNAL, BASE ----
run("D (EXTREME only)", build(EXTREME_ONLY), { signal: true, tag: "USDCAD_1100_LONG_BASE" }, (ev) => { assert.equal(ev.emaPenLong, false, "D: pen false"); assert.equal(ev.extremeLong, true, "D: extreme true"); });

// ---- E: high <= high[1] -> NO SIGNAL ----
run("E (no HH)", build({ open: 1.3520, high: PREV_HIGH, low: 1.3510, close: 1.3600 }), { signal: false }, (ev) => assert.equal(ev.bullStructure, false, "E: HH false"));

// ---- F: low <= low[1] -> NO SIGNAL ----
run("F (no HL)", build({ open: 1.3520, high: 1.3602, low: PREV_LOW, close: 1.3600 }), { signal: false }, (ev) => assert.equal(ev.bullStructure, false, "F: HL false"));

// ---- G: previous close > previous EMA20 -> NO SIGNAL (no reclaim) ----
run("G (prev close > prev EMA20)", build(PEN_EXTREME, 1.3520), { signal: false }, (ev) => assert.equal(ev.longReclaim, false, "G: reclaim false (prev above EMA)"));

// ---- H: current close == EMA20 -> NO SIGNAL (strict >) ----
// Flat warmup makes ema20≈1.3500; a current close == ema20 gives no reclaim. Iterate close to equal ema20.
{
  let close = 1.3500; for (let k = 0; k < 6; k += 1) { const ev = evaluateUsdcadStructureEmaReclaimV3(build({ open: 1.3499, high: 1.3560, low: 1.3499, close })); close = ev.ema20!; }
  const ev = evaluateUsdcadStructureEmaReclaimV3(build({ open: 1.3499, high: 1.3560, low: 1.3499, close }));
  run("H (close == EMA20)", build({ open: 1.3499, high: 1.3560, low: 1.3499, close: ev.ema20! }), { signal: false }, (e) => assert.equal(e.longReclaim, false, "H: reclaim false at close==EMA20"));
}

// ---- I: current close < EMA20 -> NO SIGNAL (HH+HL still pass; only reclaim fails) ----
run("I (close < EMA20)", build({ open: 1.3499, high: 1.3560, low: 1.34985, close: 1.3499 }), { signal: false }, (ev) => { assert.equal(ev.bullStructure, true, "I: HH+HL still true"); assert.equal(ev.longReclaim, false, "I: reclaim false (close below EMA)"); });

// ---- J: previous close == previous EMA20, current close > EMA20, HH+HL -> SIGNAL (reclaim uses <=) ----
// Flat warmup gives prev close 1.3500 == ema20[prev] 1.3500 exactly.
run("J (prev close == prev EMA20)", build(PEN_EXTREME, 1.3500), { signal: true }, (ev) => { assert.ok(Math.abs(ev.closePrevious! - ev.ema20Previous!) < 1e-9, `J: prev close ≈ prev EMA20 (${ev.closePrevious} vs ${ev.ema20Previous})`); assert.ok(ev.closePrevious! <= ev.ema20Previous!, "J: prev close <= prev EMA20 (inclusive reclaim side)"); assert.equal(ev.longReclaim, true, "J: reclaim true via <="); });

// ---- K: valid raw but bearish candle (close < open) -> SIGNAL (no body filter) ----
run("K (bearish candle)", build({ open: 1.3601, high: 1.3602, low: 1.3510, close: 1.3600 }), { signal: true }, (ev) => { assert.ok(1.3600 < 1.3601, "K: candle is bearish"); });

// ---- L: valid raw but close NOT upper-25% -> SIGNAL (EXTREME metadata only) ----
run("L (close not upper-25%)", build(PEN_ONLY), { signal: true }, (ev) => assert.equal(ev.extremeLong, false, "L: extreme false but still signals"));

// ---- M: valid raw but penetration < 0.25 ATR -> SIGNAL (PEN metadata only) ----
run("M (penetration < 0.25 ATR)", build(BASE_NEITHER), { signal: true }, (ev) => assert.equal(ev.emaPenLong, false, "M: pen false but still signals"));

console.log(`\nUSDCAD behavior tests: PASS (${passed}/${total}) — 11:00 origin AND HH+HL AND EMA20 reclaim; PEN/EXTREME are tag-only metadata.`);
