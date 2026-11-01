import assert from "node:assert/strict";
import { analyzeFrame, buildForecast, confirmedStructure, dataWarnings, directional, expiration, metrics, reactionZones, rsiSeries, score } from "../../frontend/src/lib/technical-analyzer/engine.js";
import { copyReport, marketReport, RESEARCH_PROMPT } from "../../frontend/src/lib/technical-analyzer/report.js";
import { chronologicalValidation, expiryCandle } from "../../frontend/src/lib/technical-analyzer/validation.js";
import { marketQuality } from "../../frontend/src/lib/technical-analyzer/quality.js";
import { calculateReadings, rating, technicalSummary } from "../../frontend/src/lib/technical-analyzer/ratings.js";
import { conciseMarketReport } from "../../frontend/src/lib/technical-analyzer/report.js";
import { assessLevelRisk, levelRiskLabel, zoneGrade } from "../../frontend/src/lib/technical-analyzer/levels.js";
import { continuationRiskLabel, outlookDirection, outlookEvidence } from "../../frontend/src/lib/technical-analyzer/outlook.js";
import { buildOutlook } from "../../frontend/src/lib/technical-analyzer/outlook.js";
import fs from "node:fs";
import { calculateAtrValues, calculateEmaValues } from "../../frontend/src/lib/strategy/indicators.js";
import { intervalTraded, candleAligned, candleEnd } from "../../frontend/src/lib/strategy/candle-clock.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { Frame, FrameAnalysis, HistoryRow, Snapshot } from "../../frontend/src/lib/technical-analyzer/types.js";

let checks = 0;
function test(name: string, fn: () => void) { fn(); checks++; console.log(`PASS ${name}`); }
const closeTo = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function bars(n: number, direction = 1, frame: Frame = "H1"): Candle[] {
  let at = Date.parse(frame === "W" ? "2015-01-02T22:00:00Z" : frame === "D" || frame === "H4" ? "2024-01-01T22:00:00Z" : "2025-01-06T00:00:00Z");
  const out: Candle[] = [];
  let steps = 0;
  while (out.length < n) {
    if (++steps > 20000) throw new Error(`Fixture clock stalled: ${frame} ${new Date(at).toISOString()}`);
    if (intervalTraded(at, candleEnd(at, frame))) {
      const v = 1.2 + direction * out.length * 0.0001;
      out.push({ time: new Date(at).toISOString(), open: v, close: v + direction * 0.00005, high: v + 0.0002, low: v - 0.0002, volume: 10, complete: true });
    }
    at = candleEnd(at, frame);
  }
  return out;
}
const frame = (f: Frame, direction = 1) => analyzeFrame(bars(300, direction, f), f, 1.23, 0.0001);
const snapshot: Snapshot = { id: "fixture", modelVersion: "fixture-v1", instrument: "EUR_USD", createdAt: "2026-10-30T14:00:00Z", marketAt: "2026-10-30T14:00:00Z",
  source: "OANDA Practice", referencePrice: 1.23, spreadPips: 1.2, pip: 0.0001, precision: 5, freshness: "FRESH", eligible: true, warnings: [], baseline: "BULLISH",
  frames: { H1: frame("H1"), H4: frame("H4"), D: frame("D"), W: frame("W") }, forecasts: [] };

test("EMA SMA seed and recurrence by hand", () => assert.deepEqual(calculateEmaValues([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]));
test("Wilder RSI published reference: first RSI 70.4641", () => {
  // Wilder example closes reproduced in StockCharts RSI calculation worksheet.
  closeTo(rsiSeries([44.34,44.09,44.15,43.61,44.33,44.83,45.1,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28])[14]!, 70.464135021097, 1e-9);
});
test("flat RSI is neutral, not overbought", () => assert.equal(rsiSeries(Array(30).fill(1)).at(-1), 50));
test("Wilder ATR hand calculation", () => {
  const c = bars(4).map((b, i) => ({ ...b, open: 10 + i, close: 10 + i, high: 11 + i, low: 9 + i }));
  assert.deepEqual(calculateAtrValues(c, 3), [null, null, 2, 2]);
});
test("ADX/+DI/-DI monotonic reference and flat zero", () => {
  closeTo(directional(bars(100)).adx, 100); assert.equal(directional(bars(100)).minusDI, 0);
  const flat = bars(60).map(b => ({ ...b, high: 1, low: 1, close: 1, open: 1 }));
  assert.deepEqual(directional(flat), { adx: 0, plusDI: 0, minusDI: 0 });
});
test("MACD on linear price reaches analytical steady state", () => {
  const f = frame("H1"); closeTo(f.macd, 0.0007, 1e-10); closeTo(f.histogram, 0, 1e-10);
});
test("Friday issue skips weekend and handles autumn DST", () => {
  assert.equal(expiration(Date.parse("2026-10-30T20:00:00Z"), 1), "2026-10-30T21:00:00.000Z");
  assert.equal(expiration(Date.parse("2026-10-30T21:00:00Z"), 1), "2026-11-02T22:00:00.000Z");
  assert.equal(expiration(Date.parse("2026-10-30T21:00:00Z"), 5), "2026-11-06T22:00:00.000Z");
});
test("spring DST and Sunday issue", () => {
  assert.equal(expiration(Date.parse("2026-03-06T22:00:00Z"), 1), "2026-03-09T21:00:00.000Z");
  assert.equal(expiration(Date.parse("2026-11-01T23:00:00Z"), 1), "2026-11-02T22:00:00.000Z");
});
test("H4 NY alignment changes with DST", () => {
  assert.equal(candleAligned(Date.parse("2026-10-30T21:00:00Z"), "H4"), true);
  assert.equal(candleAligned(Date.parse("2026-11-02T22:00:00Z"), "H4"), true);
  assert.equal(candleAligned(Date.parse("2026-11-02T21:00:00Z"), "H4"), false);
});
test("weekend gaps accepted, missing session candles flagged", () => {
  const c = bars(150); const now = candleEnd(Date.parse(c.at(-1)!.time), "H1");
  assert.deepEqual(dataWarnings(c, "H1", now), []);
  assert.ok(dataWarnings(c.filter((_, i) => i !== 30), "H1", now).some(w => w.includes("missing")));
});
test("incomplete, future, malformed and duplicate candles rejected", () => {
  const c = bars(3); const now = Date.parse(c.at(-1)!.time) + 3600000;
  assert.throws(() => dataWarnings([{ ...c[0], complete: false }], "H1", now));
  assert.throws(() => dataWarnings([c[0]], "H1", Date.parse(c[0].time)));
  assert.throws(() => dataWarnings([{ ...c[0], high: 0 }], "H1", now));
  assert.throws(() => dataWarnings([c[0], c[0]], "H1", now));
});
test("insufficient history fails explicitly", () => assert.throws(() => analyzeFrame(bars(200), "H1", 1.2, 0.0001), /260/));
test("pivot confirmation waits for three right bars", () => {
  const c = bars(10).map((b, i) => ({ ...b, high: i === 4 ? 1.5 : 1.3, low: 1.1, close: 1.2, open: 1.2 }));
  assert.equal(confirmedStructure(c.slice(0, 7), .01, "H1").pivots.length, 0);
  const p = confirmedStructure(c.slice(0, 8), .01, "H1").pivots[0];
  assert.equal(p.index, 4); assert.equal(p.confirmedAt, new Date(candleEnd(Date.parse(c[7].time), "H1")).toISOString());
});
test("wick does not confirm BOS; completed close does; future bars do not change past event", () => {
  const c = bars(35).map((b, i) => ({ ...b, high: i === 17 ? 1.5 : 1.3, low: 1.1, close: 1.2, open: 1.2 }));
  c[27] = { ...c[27], high: 1.55, close: 1.4 };
  assert.equal(confirmedStructure(c.slice(0, 28), .01, "H1").events.length, 0);
  c[28] = { ...c[28], high: 1.6, close: 1.58 };
  const e = confirmedStructure(c.slice(0, 29), .01, "H1").events[0];
  assert.equal(e.kind, "BOS"); assert.ok(confirmedStructure(c, .01, "H1").events.some(x => x.at === e.at && x.level === e.level));
  assert.ok(confirmedStructure(c, .01, "H1").events.some(x => x.kind === "FAILED BREAKOUT"));
});
test("reaction zones cluster pivots and express JPY pips", () => {
  const c = bars(50); const p = [10, 20, 30].map(i => ({ kind: "low" as const, price: 150 + i / 1000, index: i, time: c[i].time, confirmedAt: c[i + 3].time }));
  const zones = reactionZones(c.map(b => ({ ...b, close: 150.5, high: 150.6, low: 150.4 })), p, "H4", .2, 150.1, .01);
  assert.equal(zones.length, 1); assert.equal(zones[0].reactions, 3); closeTo(zones[0].distancePips, 6);
});
test("opposite confirmed structure break is CHoCH", () => {
  const c = bars(35).map(b => ({ ...b, open: 1.2, close: 1.2, high: 1.3, low: 1.1 }));
  c[5].high = 1.5; c[10].low = 1;
  c[20] = { ...c[20], high: 1.7, close: 1.6 };
  c[25] = { ...c[25], low: .8, close: .9 };
  assert.ok(confirmedStructure(c, .1, "H1").events.some(e => e.kind === "CHoCH" && e.direction === "down"));
});
test("broken resistance becomes support only after close; retest is subsequent", () => {
  const c = bars(30).map((b, i) => ({ ...b, open: i < 12 ? 1.2 : 1.4, close: i < 12 ? 1.2 : 1.4, high: i < 12 ? 1.3 : 1.45, low: i < 12 ? 1.1 : 1.35 }));
  c[13].low = 1.299;
  const p = [{ kind: "high" as const, price: 1.3, index: 4, time: c[4].time, confirmedAt: c[7].time }];
  const z = reactionZones(c, p, "H1", .1, 1.4, .0001)[0];
  assert.equal(z.role, "support"); assert.ok(z.brokenAt && z.retestedAt && z.retestedAt > z.brokenAt);
});
test("major support qualifies risk without erasing bearish bias or directional agreement", () => {
  const f = { ...snapshot.frames.H4, close: snapshot.frames.H4.ema20, trend: -1 as const, structure: "lower highs / lower lows" as const, rsi: 40, histogram: -.001, adx: 30, zones: [] };
  const zone = { frame: "D" as const, low: 1.2299, high: 1.2301, role: "support" as const, distanceAtr: 0, distancePips: 0, reactions: 4, quality: .5, brokenAt: null, retestedAt: null };
  const s = { ...snapshot, frames: { ...snapshot.frames, H1: { ...f, frame: "H1" as const }, H4: f, D: { ...snapshot.frames.D, zones: [zone] } } };
  const forecast = buildForecast(s, 1); assert.equal(forecast.bias, "BEARISH"); assert.equal(forecast.evidence, "ALIGNED"); assert.equal(forecast.levelRisk?.severity, "HIGH");
  assert.ok(forecast.contradictions.some(c => c.includes("support"))); assert.ok(levelRiskLabel(forecast).includes("Major support"));
  const minor = buildForecast({ ...s, frames: { ...s.frames, D: { ...s.frames.D, zones: [{ ...zone, reactions: 1 }] } } }, 1);
  assert.equal(minor.bias, "BEARISH"); assert.equal(minor.levelRisk?.severity, "CAUTION"); assert.ok(!levelRiskLabel(minor).includes("Major"));
  const conflict = { ...s, frames: { ...s.frames, H1: { ...f, frame: "H1" as const, rsi: 60, histogram: .001 }, H4: { ...f, rsi: 60, histogram: .001 } } };
  assert.equal(buildForecast(conflict,1).bias,"NO EDGE");
  assert.equal(buildForecast({ ...s, technicalAvailable:false },1).bias,"UNAVAILABLE");
});
test("major zone requires timeframe, reaction count and rejection strength", () => {
  const z = { frame: "D" as const, low:1.23, high:1.231, role:"resistance" as const, reactions:3, quality:.25, distancePips:0, distanceAtr:0, brokenAt:null, retestedAt:null };
  assert.equal(zoneGrade(z),"MAJOR");
  assert.equal(zoneGrade({...z,reactions:1}),"MINOR");
  assert.equal(zoneGrade({...z,reactions:2}),"DEVELOPING");
  assert.equal(zoneGrade({...z,quality:.249}),"DEVELOPING");
  assert.notEqual(zoneGrade({...z,frame:"H1",reactions:10}),"MAJOR");
});
test("level risk respects direction, distance and the actual quality of zones", () => {
  const z = { frame:"D" as const, low:1.2301, high:1.2302, role:"resistance" as const, reactions:3, quality:.5, distancePips:1, distanceAtr:.1, brokenAt:null, retestedAt:null };
  assert.equal(assessLevelRisk([z],1.23,.001,1).severity,"HIGH");
  assert.equal(assessLevelRisk([z],1.23,.001,-1).severity,"NONE");
  assert.equal(assessLevelRisk([z],1.23,.001,0).severity,"NONE");
  assert.equal(assessLevelRisk([{...z,low:1.24,high:1.241}],1.23,.001,1).severity,"NONE");
  assert.equal(assessLevelRisk([{...z,low:1.22,high:1.221}],1.23,.001,1).severity,"NONE");
});
test("directional thresholds, exhaustion and data integrity remain restrictive", () => {
  const base = { ...snapshot.frames.H4, close:snapshot.frames.H4.ema20, trend:-1 as const, structure:"lower highs / lower lows" as const, rsi:40, histogram:-.001, adx:30, zones:[] };
  const make = (change:Partial<FrameAnalysis>={}) => ({ ...snapshot, frames:{ H1:{...base,...change,frame:"H1" as const},H4:{...base,...change},D:{...snapshot.frames.D,zones:[]},W:{...snapshot.frames.W,zones:[]} } });
  assert.equal(buildForecast(make(),1).bias,"BEARISH");
  for (const change of [{trend:0 as const,structure:"mixed / range" as const},{adx:10},{rsi:60,histogram:.001},{close:base.ema20+base.atr*3}]) {
    const f = buildForecast(make(change),1);
    assert.equal(f.bias,"NO EDGE"); assert.ok(f.reasons[2].startsWith("Directional evidence unresolved:"));
  }
  assert.equal(buildForecast({...make(),technicalAvailable:false},1).bias,"UNAVAILABLE");
});
const leanSnapshot = (change: Partial<FrameAnalysis> = {}): Snapshot => {
  const f: FrameAnalysis = { ...snapshot.frames.H4, close:snapshot.frames.H4.ema20, trend:0, structure:"lower highs / lower lows", rsi:40, histogram:-.001, adx:30, zones:[], events:[], divergence:null, ...change };
  return { ...snapshot, frames:{H1:{...f,frame:"H1"},H4:f,D:{...snapshot.frames.D,zones:[]},W:{...snapshot.frames.W,zones:[]}} };
};
test("bearish structure with confirming momentum can have moderate evidence while strict assessment abstains", () => {
  const f = buildForecast(leanSnapshot(),1);
  assert.equal(f.bias,"NO EDGE"); assert.equal(f.lean?.direction,"BEARISH"); assert.equal(f.lean?.evidence,"MODERATE");
  assert.ok(f.lean!.rationale.includes("incomplete confirmation"));
});
test("opposing rebound momentum is mixed evidence, not an erased directional lean", () => {
  const f = buildForecast(leanSnapshot({trend:-1,rsi:60,histogram:.001}),1);
  assert.equal(f.bias,"NO EDGE"); assert.equal(f.lean?.direction,"BEARISH"); assert.equal(f.lean?.evidence,"MIXED");
  assert.ok(f.continuationRisk!.factors.some(r=>r.includes("Momentum")));
});
test("exhaustion remains a strict veto and high continuation risk without hiding the lean", () => {
  const f = buildForecast(leanSnapshot({trend:-1,close:snapshot.frames.H4.ema20+snapshot.frames.H4.atr*3}),1);
  assert.equal(f.bias,"NO EDGE"); assert.equal(f.lean?.direction,"BEARISH"); assert.equal(f.lean?.evidence,"STRONG"); assert.equal(f.continuationRisk?.severity,"HIGH");
});
test("balanced structure stays unclear and genuinely aligned evidence remains aligned", () => {
  const s = leanSnapshot(); s.frames.H4 = {...s.frames.H4,structure:"higher highs / higher lows"};
  assert.equal(buildForecast(s,1).lean?.direction,"UNCLEAR");
  const aligned = buildForecast(leanSnapshot({trend:-1}),1);
  assert.equal(aligned.bias,"BEARISH"); assert.equal(aligned.lean?.evidence,"STRONG"); assert.equal(aligned.continuationRisk?.severity,"LOW");
});
test("strong evidence survives both major and minor opposing levels while risk changes independently", () => {
  const s=leanSnapshot({trend:-1});
  const zone={frame:"D" as const,low:1.2299,high:1.2301,role:"support" as const,reactions:4,quality:.5,distancePips:0,distanceAtr:0,brokenAt:null,retestedAt:null};
  for (const [reactions,severity] of [[4,"HIGH"],[1,"CAUTION"]] as const) {
    const f=buildForecast({...s,frames:{...s.frames,D:{...s.frames.D,zones:[{...zone,reactions}]}}},1);
    assert.equal(f.lean?.evidence,"STRONG"); assert.equal(f.continuationRisk?.severity,severity); assert.equal(f.bias,"BEARISH");
  }
});
test("strong bullish agreement also remains strong at resistance", () => {
  const s=leanSnapshot({trend:1,structure:"higher highs / higher lows",rsi:60,histogram:.001});
  s.frames.D.zones=[{frame:"D",low:1.2299,high:1.2301,role:"resistance",reactions:3,quality:.5,distancePips:0,distanceAtr:0,brokenAt:null,retestedAt:null}];
  const f=buildForecast(s,1); assert.equal(f.lean?.direction,"BULLISH"); assert.equal(f.lean?.evidence,"STRONG"); assert.equal(f.continuationRisk?.severity,"HIGH");
});
test("reversal warnings stay visible without automatically cancelling strong directional agreement", () => {
  const f=buildForecast(leanSnapshot({trend:-1,divergence:"bullish"}),1);
  assert.equal(f.lean?.evidence,"STRONG"); assert.equal(f.continuationRisk?.severity,"CAUTION");
  assert.ok(f.continuationRisk!.factors.some(r=>r.includes("divergence")));
});
test("a secondary timeframe without full alignment cannot veto strong group agreement", () => {
  const s=leanSnapshot({trend:-1}); s.frames.H1={...s.frames.H1,trend:0,structure:"mixed / range"};
  const f=buildForecast(s,2); assert.equal(f.lean?.evidence,"STRONG");
  assert.ok(f.contradictions.some(c=>c.includes("H1 EMA")));
});
test("20 percent opposing timeframe weight is not treated like 35 percent material opposition", () => {
  const s=leanSnapshot({trend:-1}), base=s.frames.H4;
  s.frames.D={...base,frame:"D"}; s.frames.W={...base,frame:"W"};
  s.frames.H4={...base,trend:1,structure:"higher highs / higher lows"};
  assert.equal(buildForecast(s,4).lean?.evidence,"STRONG");
  s.frames.W={...s.frames.W,trend:1,structure:"higher highs / higher lows"};
  const material=buildForecast(s,5); assert.equal(material.lean?.evidence,"MIXED");
  assert.ok(material.lean!.evidenceReasons!.some(r=>r.includes("35%")));
});
test("small contrary momentum is moderate, material contrary momentum is mixed", () => {
  const input={trend:-.8,momentum:.05,strength:30,available:true,exhausted:false,levelRisk:{severity:"NONE" as const,zone:null,distanceAtr:null,explanation:"none"},reversalRisk:false,materialOppositionWeight:0};
  assert.equal(buildOutlook(input).lean.evidence,"MODERATE");
  assert.equal(buildOutlook({...input,momentum:.12}).lean.evidence,"MIXED");
  assert.equal(buildOutlook({...input,momentum:-.12}).lean.evidence,"STRONG");
});
test("missing strength prevents strong evidence even with directional agreement", () => {
  const f=buildForecast(leanSnapshot({trend:-1,adx:10}),1);
  assert.equal(f.lean?.evidence,"MODERATE"); assert.equal(f.continuationRisk?.severity,"CAUTION"); assert.equal(f.bias,"NO EDGE");
});
test("unavailable data cannot produce a lean or an available risk assessment", () => {
  const f = buildForecast({...leanSnapshot(),technicalAvailable:false},1);
  assert.equal(f.lean?.direction,"UNAVAILABLE"); assert.equal(f.lean?.evidence,"UNAVAILABLE"); assert.equal(f.continuationRisk?.severity,"UNAVAILABLE");
});
test("lean outcome sample is separate from strict calls, pending rows and ineligible records", () => {
  const s=leanSnapshot(), f=buildForecast(s,1), outcome=score(s.referencePrice,f,1.22,f.expiresAt);
  assert.equal(outcome.correct,null); assert.equal(outcome.leanCorrect,true);
  const row:HistoryRow={id:"lean",snapshot:s,forecast:f,outcome};
  const m=metrics([row,{...row,id:"pending",outcome:null},{...row,id:"excluded",snapshot:{...s,eligible:false}}]).find(m=>m.label==="1D")!;
  assert.equal(m.directional,0); assert.equal(m.accuracy,null); assert.equal(m.leanCalls,1); assert.equal(m.leanAccuracy,1);
  assert.equal(score(s.referencePrice,f,s.referencePrice,f.expiresAt).leanCorrect,false);
});
test("legacy forecasts keep their original displayed assessment and are not assigned invented leans", () => {
  const {lean,continuationRisk,...legacy}=buildForecast(leanSnapshot(),1);
  assert.equal(outlookDirection(legacy),"NO EDGE"); assert.equal(outlookEvidence(legacy),legacy.evidence); assert.equal(continuationRiskLabel(legacy),"Legacy risk assessment");
  assert.equal(score(1.23,legacy,1.22,legacy.expiresAt).leanCorrect,null);
});
test("concise export names the directional lean, strict assessment and continuation risk separately", () => {
  const s=leanSnapshot(); s.forecasts=([1,2,3,4,5] as const).map(h=>buildForecast(s,h));
  const text=conciseMarketReport(s,"H4");
  assert.ok(text.includes("1D BEARISH lean | MODERATE evidence")); assert.ok(text.includes("Strict assessment: NO EDGE")); assert.ok(text.includes("continuation risk"));
});
test("1D and 5D can disagree without copying", () => {
  const bull = (f: FrameAnalysis): FrameAnalysis => ({ ...f, trend: 1, structure: "higher highs / higher lows", rsi: 60, histogram: .001, adx: 30, zones: [], close: f.ema20, divergence: null });
  const bear = (f: FrameAnalysis): FrameAnalysis => ({ ...bull(f), trend: -1, structure: "lower highs / lower lows", rsi: 40, histogram: -.001 });
  const s = { ...snapshot, frames: { H1: bull(snapshot.frames.H1), H4: bull(snapshot.frames.H4), D: bear(snapshot.frames.D), W: bear(snapshot.frames.W) } };
  assert.equal(buildForecast(s, 1).bias, "BULLISH"); assert.equal(buildForecast(s, 5).bias, "BEARISH");
  assert.equal(buildForecast({ ...s, eligible: false, technicalAvailable: true }, 1).bias, "BULLISH");
  assert.equal(buildForecast({ ...s, eligible: false, technicalAvailable: false }, 1).bias, "UNAVAILABLE");
});
test("NO EDGE abstains and flat directional outcomes miss", () => {
  const f = buildForecast(snapshot, 1); assert.equal(score(1.2, { ...f, bias: "NO EDGE" }, 1.3, f.expiresAt).correct, null);
  assert.equal(score(1.2, { ...f, bias: "BULLISH" }, 1.2, f.expiresAt).correct, false);
  assert.equal(score(1.2, { ...f, bias: "UNAVAILABLE" }, 1.3, f.expiresAt).correct, null);
});
test("statistics exclude pending/ineligible and label overlaps", () => {
  const f = { ...buildForecast(snapshot, 1), bias: "BULLISH" as const };
  const row: HistoryRow = { id: "a", snapshot, forecast: f, outcome: { ...score(1.23, f, 1.24, f.expiresAt), baselineCorrect: true } };
  const rows = [row, { ...row, id: "b" }, { ...row, id: "c", outcome: null }, { ...row, id: "d", snapshot: { ...snapshot, eligible: false } }];
  const m = metrics(rows).find(m => m.label === "1D")!;
  assert.equal(m.directional, 2); assert.equal(m.completed, 2); assert.equal(m.independent, 1); assert.equal(m.accuracy, 1); assert.equal(m.bearishAccuracy, null);
});
snapshot.forecasts = ([1,2,3,4,5] as const).map(h => buildForecast(snapshot, h));
test("October 30 EUR/USD daily readings match observed reference without hardcoding", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("fixtures/technical-eurusd-daily-20261030.json", import.meta.url), "utf8")) as { candles: Candle[] };
  const f = analyzeFrame(fixture.candles, "D", fixture.candles.at(-1)!.close, .0001);
  closeTo(f.rsi, 37.50, .01); closeTo(f.adx, 47.44, .01); closeTo(f.ema20, 1.12199, .00001);
  assert.equal(f.lastCloseAt, "2026-10-30T21:00:00.000Z");
});
test("Friday after close preserves valid technical snapshot while excluding scoring", () => {
  const q = marketQuality(Date.parse("2026-10-30T22:00:00Z"), "2026-10-30T20:59:30Z", false, []);
  assert.equal(q.marketOpen, false); assert.equal(q.technicalAvailable, true); assert.equal(q.eligible, false);
  assert.ok(!q.scoringReasons.some(r => r.includes("unexpectedly")));
});
test("unexpected stale live quote is separate from completed-candle availability", () => {
  const q = marketQuality(Date.parse("2026-10-30T15:00:00Z"), "2026-10-30T14:00:00Z", true, []);
  assert.equal(q.marketOpen, true); assert.equal(q.quoteFresh, false); assert.equal(q.technicalAvailable, true); assert.equal(q.eligible, false);
  assert.equal(marketQuality(Date.parse("2026-10-30T15:00:00Z"), "2026-10-30T15:00:00Z", true, ["Recent gap H1"]).technicalAvailable, false);
});
test("published Christmas FX closure is distinct from unexpected gaps", () => {
  const c = ["2025-12-23T22:00:00Z","2025-12-25T22:00:00Z"].map(t => ({ ...bars(1)[0], time:t }));
  const w = dataWarnings(c, "D", Date.parse("2025-12-26T22:00:00Z"));
  assert.ok(w.some(w => w.startsWith("Expected holiday closure")));
  assert.ok(!w.some(w => w.startsWith("Recent gap")));
});
test("all timeframes calculate actual oscillator/MA rows and balanced summary counts", () => {
  for (const f of Object.values(snapshot.frames)) {
    const r = f.readings!;
    assert.equal(r.oscillators.length, 8); assert.equal(r.averages.length, 12);
    const summary = technicalSummary(r);
    assert.equal(summary.overall.sell+summary.overall.neutral+summary.overall.buy, r.oscillators.length+r.averages.length);
    closeTo(summary.overall.score, (summary.oscillators.score+summary.averages.score)/2);
    assert.ok(r.averages.every(a => a.action === "Buy"));
    assert.ok(r.oscillators.every(a => Number.isFinite(a.value)));
  }
});
test("new oscillator formulas agree with linear-series hand calculations", () => {
  const c = bars(300), f = snapshot.frames.H1;
  const r = calculateReadings(c,f,99).oscillators;
  closeTo(r.find(r=>r.name === "Momentum (10)")!.value, .001);
  closeTo(r.find(r=>r.name.startsWith("Awesome"))!.value, .00145);
  closeTo(r.find(r=>r.name.startsWith("CCI"))!.value, 126.6666666667, 1e-7);
  closeTo(r.find(r=>r.name.startsWith("Williams"))!.value, -100*.00015/.0017, 1e-7);
  assert.equal(rating([]).label, "Neutral");
});
test("concise export includes selected timeframe, five forecasts, major levels and exact research prompt", () => {
  const concise = conciseMarketReport(snapshot,"H4");
  for (const token of ["Selected indicator timeframe: H4", "1D ", "5D ", "Invalidation:", RESEARCH_PROMPT]) assert.ok(concise.includes(token));
  assert.ok(!concise.includes("Recent confirmed swings:"));
  assert.ok(concise.length < marketReport(snapshot).length);
});
test("copy report contains all horizons, explicit levels, indicators, warnings and exact prompt", () => {
  const report = marketReport(snapshot);
  for (const token of ["1D |", "2D |", "3D |", "4D |", "5D |", "1.23000", "OANDA Practice", "EMA200", "MACD", "ADX14", "Invalidation", "Contradictions", "Warnings", "17:00 America/New_York", RESEARCH_PROMPT]) assert.ok(report.includes(token), token);
  assert.ok(!/confidence.*\d+%/i.test(report));
  assert.ok(marketReport(snapshot, "2026-10-31T14:00:00Z").includes("WARNING: quote is over two minutes old at export"));
});
test("settlement rejects early, incomplete, shifted and missing holiday candles", () => {
  const b = bars(1, 1, "D")[0];
  const end = new Date(candleEnd(Date.parse(b.time), "D")).toISOString();
  assert.equal(expiryCandle([b], end, Date.parse(end) - 1), null);
  assert.equal(expiryCandle([{ ...b, complete: false }], end, Date.parse(end)), null);
  assert.equal(expiryCandle([{ ...b, time: new Date(Date.parse(b.time) + 3600000).toISOString() }], end, Date.parse(end)), null);
  assert.equal(expiryCandle([], end, Date.parse(end)), null);
  assert.equal(expiryCandle([b], end, Date.parse(end)), b);
});
test("chronological validation purges crossing outcomes, deduplicates and rejects future frames", () => {
  const f = { ...snapshot.forecasts[0], bias: "BULLISH" as const };
  const record: HistoryRow = { id: "development", snapshot, forecast: { ...f, expiresAt: "2026-10-31T21:00:00Z" }, outcome: score(1.23, f, 1.24, f.expiresAt) };
  const cross = { ...record, id: "cross", forecast: { ...f, expiresAt: "2026-11-03T22:00:00Z" } };
  const holdout = { ...record, id: "holdout", snapshot: { ...snapshot, createdAt: "2026-11-02T23:00:00Z" }, forecast: { ...f, expiresAt: "2026-11-03T22:00:00Z" } };
  const result = chronologicalValidation([record, record, cross, holdout], "2026-11-02T00:00:00Z");
  assert.equal(result.purged, 1); assert.equal(result.observations, 3);
  assert.equal(result.development[0].directional, 1); assert.equal(result.holdout[0].directional, 1);
  assert.throws(() => chronologicalValidation([{ ...record, snapshot: { ...snapshot, createdAt: "2010-01-01T00:00:00Z" } }], "2026-11-02T00:00:00Z"), /future/);
});
// Exercise clipboard success and both fallback paths without a browser dependency.
const originals = new Map(["navigator", "window", "document"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
let copied = "", fallback = true, selected = false;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (t: string) => { copied = t; } } } });
Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: true } });
Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null, body: { append() {} }, createElement: () => ({ style: {}, focus() {}, select() { selected = true; }, setSelectionRange() {}, remove() {} }), execCommand: () => fallback } });
try {
  assert.equal(await copyReport("complete report"), true); assert.equal(copied, "complete report");
  (navigator.clipboard.writeText as unknown as (s: string) => Promise<void>) = async () => { throw new Error("clipboard blocked"); };
  assert.equal(await copyReport("fallback report"), true); assert.equal(selected, true);
  fallback = false; assert.equal(await copyReport("manual report"), false);
  checks++; console.log("PASS clipboard success, denied clipboard selection fallback, manual-copy fallback");
} finally {
  for (const [key, original] of originals) { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); }
}
console.log(`${checks} technical analyzer checks passed.`);
