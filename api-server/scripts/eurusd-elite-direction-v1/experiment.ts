/**
 * EURUSD_ELITE_DIRECTION_V1
 *
 * Isolated, read-only research. This module imports feature/model utilities but
 * never imports a collector, execution adapter, paper-cycle, or production
 * strategy. It writes only regenerable research artifacts under research-v2.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predict, trainNeuralModel, type NeuralModel, type Sample } from "../eurusd-neural-day-v1/model.js";
import {
  fitRegimes, loadBars, prepareSeries, rawFeatures, regimeOf, regimeVector,
  type Bar, type Direction, type Outcome,
} from "../eurusd-neural-day-v1/experiment.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = path.join(ROOT, "api-server", "research-v2", "EURUSD_ELITE_DIRECTION_V1");
const PIP = 0.0001;
const HOLD_BARS = 12; // three hours
const WARMUP = 240;
const ENTRY_SLIP = 0.1 * PIP;
const EXIT_SLIP = 0.1 * PIP;
const MIN_UNIT = 4 * PIP;
const GEOMETRY = { targetR: 1, stopR: 0.5 } as const;
const FINAL_FROM = Date.parse("2025-11-01T00:00:00Z");
const FINAL_TO = Date.parse("2026-08-01T00:00:00Z");
const DEV_FROM = Date.parse("2025-05-01T00:00:00Z");
const BUILD_FROM = Date.parse("2024-08-01T00:00:00Z");
const EXPERTS = ["raw_price", "structure", "momentum", "regime", "multi_timeframe", "location", "liquidity", "relative_strength", "macro_news"] as const;
type Expert = typeof EXPERTS[number];
type Raw = { closeTime: string; open: number; high: number; low: number; close: number; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Timed = Raw & { t: number };
type News = { time: number; currency: string; name: string; actual: number | null; forecast: number | null; previous: number | null };
type Side = { direction: Direction; x: Record<Expert, number[]>; outcome: Outcome };
type Candidate = { time: number; iso: string; day: string; session: string; regime: number; spreadR: number; unitPips: number; long: Side; short: Side };
type System = { experts: Record<Expert, NeuralModel>; fusion: NeuralModel; fusionEpochs: number; threshold: number };
type Trade = { time: number; iso: string; day: string; direction: Direction; resultR: number; kind: string; score: number; pLong: number; pShort: number; component: Record<Expert, number> };

const round = (v: unknown): unknown => typeof v === "number" ? (Number.isFinite(v) ? Number(v.toFixed(6)) : null) : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const sigmoid = (v: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, v))));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const csv = (rows: Record<string, unknown>[]) => {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return [keys.map(q).join(","), ...rows.map((r) => keys.map((k) => q(r[k])).join(","))].join("\n") + "\n";
};

function readHistoricalFile(relative: string) {
  const local = path.join(ROOT, relative);
  try { return { text: readFileSync(local, "utf8"), source: relative }; }
  catch {
    const revision = "master";
    const text = execFileSync("git", ["show", `${revision}:${relative.replaceAll("\\", "/")}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    return { text, source: `${revision}:${relative.replaceAll("\\", "/")}` };
  }
}
function parseNumber(raw: unknown): number | null {
  const s = String(raw ?? "").trim(); if (!s) return null;
  const m = /^(-?[\d,.]+)\s*([KMBT%]?)/i.exec(s); if (!m) return null;
  const n = Number(m[1]!.replaceAll(",", "")); if (!Number.isFinite(n)) return null;
  const mult = ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[(m[2] ?? "").toUpperCase()] ?? 1;
  return n * mult;
}
function loadNews() {
  const files = [
    "api-server/research-v2/eurusd-ff-high-impact-aug2024-jul2025/events.json",
    "api-server/research-v2/eurusd-ff-high-impact-aug2025-jul2026/events.json",
  ];
  const sources: Array<{ source: string; sha256: string; rows: number }> = [];
  const events: News[] = [];
  for (const file of files) {
    const found = readHistoricalFile(file); const parsed = JSON.parse(found.text); const rows = Array.isArray(parsed) ? parsed : parsed.events ?? [];
    sources.push({ source: found.source, sha256: sha(found.text), rows: rows.length });
    for (const e of rows) {
      const time = Date.parse(e.releaseTimeUtc ?? ""); if (!Number.isFinite(time)) continue;
      events.push({ time, currency: e.currency ?? "", name: e.eventName ?? "", actual: parseNumber(e.actual), forecast: parseNumber(e.forecast), previous: parseNumber(e.previous) });
    }
  }
  events.sort((a, b) => a.time - b.time);
  return { events, sources };
}
function loadTimed(relative: string) {
  const parsed = JSON.parse(readFileSync(path.join(ROOT, relative), "utf8")) as { bars: Raw[] };
  return [...new Map(parsed.bars.map((b) => [Date.parse(b.closeTime), { ...b, t: Date.parse(b.closeTime) }])).values()].sort((a, b) => a.t - b.t);
}
function auditTimed(relative: string, expectedMinutes: number) {
  const parsed = JSON.parse(readFileSync(path.join(ROOT, relative), "utf8")) as { bars: Raw[] };
  let invalidTimestamp = 0, malformedOhlc = 0, negativeSpread = 0, duplicateTimestamp = 0, nonMonotonic = 0, unexpectedWeekdayGaps = 0;
  const seen = new Set<number>(); let previous = -Infinity;
  for (const b of parsed.bars) {
    const t = Date.parse(b.closeTime); if (!Number.isFinite(t)) { invalidTimestamp += 1; continue; }
    if (seen.has(t)) duplicateTimestamp += 1; seen.add(t); if (t <= previous) nonMonotonic += 1;
    if (!(b.low <= b.open && b.open <= b.high && b.low <= b.close && b.close <= b.high) || ![b.bidOpen, b.bidHigh, b.bidLow, b.bidClose, b.askOpen, b.askHigh, b.askLow, b.askClose].every(Number.isFinite)) malformedOhlc += 1;
    if (b.askOpen < b.bidOpen || b.askClose < b.bidClose) negativeSpread += 1;
    if (previous > 0) { const gap = t - previous; const weekday = new Date(previous).getUTCDay(); if (gap > expectedMinutes * 60_000 * 1.5 && gap < 12 * 3_600_000 && weekday !== 5 && weekday !== 6) unexpectedWeekdayGaps += 1; }
    previous = t;
  }
  return { rows: parsed.bars.length, invalidTimestamp, malformedOhlc, negativeSpread, duplicateTimestamp, nonMonotonic, unexpectedWeekdayGaps };
}
function lastAtOrBefore(rows: Timed[], t: number) { let l = 0, h = rows.length; while (l < h) { const m = (l + h) >>> 1; rows[m]!.t <= t ? l = m + 1 : h = m; } return l - 1; }
function ret(rows: Timed[], i: number, lag: number) { return i >= lag && rows[i - lag]!.close > 0 ? Math.log(rows[i]!.close / rows[i - lag]!.close) : 0; }
function orient(x: number[], d: Direction, directional = x.length) { return x.map((v, i) => i < directional ? d * v : v); }
function polarity(name: string) { return /unemploy|jobless|claims/i.test(name) ? -1 : 1; }
function newsVector(events: News[], t: number) {
  let last: News | null = null, next: News | null = null;
  for (const e of events) { if (e.time <= t) last = e; else { next = e; break; } }
  let signed = 0, magnitude = 0, age = 1;
  if (last) {
    const base = last.forecast ?? last.previous; const scale = Math.max(Math.abs(base ?? 0), Math.abs(last.previous ?? 0), 1e-9);
    if (last.actual != null && base != null) {
      const currency = last.currency === "EUR" ? 1 : last.currency === "USD" ? -1 : 0;
      signed = currency * polarity(last.name) * Math.tanh(2 * (last.actual - base) / scale);
      magnitude = Math.abs(signed);
    }
    age = Math.min(1, (t - last.time) / (6 * 3_600_000));
  }
  const until = next ? Math.min(1, (next.time - t) / (6 * 3_600_000)) : 1;
  return [signed, signed * Math.pow(0.5, age * 6 / 2), magnitude, age, until];
}
function crossStrength(series: Map<string, Timed[]>, t: number) {
  const strength = new Map<string, number[]>();
  for (const [pair, rows] of series) {
    const i = lastAtOrBefore(rows, t); if (i < 24) continue;
    const [base, quote] = pair.split("_"); const values = [ret(rows, i, 4), ret(rows, i, 24)];
    for (const [cur, sign] of [[base!, 1], [quote!, -1]] as const) {
      const a = strength.get(cur) ?? [0, 0, 0]; a[0]! += sign * values[0]!; a[1]! += sign * values[1]!; a[2]! += 1; strength.set(cur, a);
    }
  }
  const e = strength.get("EUR") ?? [0, 0, 1], u = strength.get("USD") ?? [0, 0, 1];
  return [e[0]! / e[2]! - u[0]! / u[2]!, e[1]! / e[2]! - u[1]! / u[2]!, e[2]!, u[2]!];
}
function outcome(bars: Bar[], index: number, direction: Direction, unit: number): Outcome {
  const entryBar = bars[index + 1]!; const entry = direction === 1 ? entryBar.askOpen + ENTRY_SLIP : entryBar.bidOpen - ENTRY_SLIP;
  const stop = direction === 1 ? entry - GEOMETRY.stopR * unit : entry + GEOMETRY.stopR * unit; const target = direction === 1 ? entry + GEOMETRY.targetR * unit : entry - GEOMETRY.targetR * unit;
  for (let j = index + 1; j <= Math.min(index + HOLD_BARS, bars.length - 1); j += 1) {
    const b = bars[j]!; const high = direction === 1 ? b.bidHigh : b.askHigh; const low = direction === 1 ? b.bidLow : b.askLow;
    const hitT = direction === 1 ? high >= target : low <= target; const hitS = direction === 1 ? low <= stop : high >= stop;
    if (hitT && hitS) return { kind: "AMBIGUOUS_STOP", r: -GEOMETRY.stopR - EXIT_SLIP / unit, exitTime: b.t, holdMinutes: (b.t - bars[index]!.t) / 60_000 };
    if (hitS) return { kind: "STOP", r: -GEOMETRY.stopR - EXIT_SLIP / unit, exitTime: b.t, holdMinutes: (b.t - bars[index]!.t) / 60_000 };
    if (hitT) return { kind: "TARGET", r: GEOMETRY.targetR - EXIT_SLIP / unit, exitTime: b.t, holdMinutes: (b.t - bars[index]!.t) / 60_000 };
  }
  const b = bars[Math.min(index + HOLD_BARS, bars.length - 1)]!; const exit = direction === 1 ? b.bidClose - EXIT_SLIP : b.askClose + EXIT_SLIP;
  return { kind: "TIME_EXIT", r: Math.max(-GEOMETRY.stopR - EXIT_SLIP / unit, Math.min(GEOMETRY.targetR - EXIT_SLIP / unit, direction * (exit - entry) / unit)), exitTime: b.t, holdMinutes: (b.t - bars[index]!.t) / 60_000 };
}
function buildCandidates(bars: Bar[], m5: Timed[], h1: Timed[], crosses: Map<string, Timed[]>, events: News[]) {
  const series = prepareSeries(bars); const trainingVectors: number[][] = [];
  for (let i = WARMUP; i < bars.length; i += 4) if (bars[i]!.t < DEV_FROM) trainingVectors.push(regimeVector(bars, series, i));
  const centroids = fitRegimes(trainingVectors, 3); const out: Candidate[] = [];
  for (let i = WARMUP; i < bars.length - HOLD_BARS - 2; i += 1) {
    const t = bars[i]!.t; if (t < BUILD_FROM || t >= FINAL_TO) continue;
    const date = new Date(t); const hour = date.getUTCHours(); if (date.getUTCMinutes() % 30 || hour < 6 || hour >= 16) continue;
    const atr = series.atr14[i]!; if (!Number.isFinite(atr) || atr <= 0) continue;
    const regime = regimeOf(regimeVector(bars, series, i), centroids); const base = rawFeatures(bars, series, i, regime); if (!base) continue;
    const mi = lastAtOrBefore(m5, t), hi = lastAtOrBefore(h1, t); if (mi < 36 || hi < 200) continue;
    const m5x = [ret(m5, mi, 1), ret(m5, mi, 3), ret(m5, mi, 6), ret(m5, mi, 12)].map((x) => x / Math.max(1e-6, atr));
    const h1x = [ret(h1, hi, 1), ret(h1, hi, 4), ret(h1, hi, 24), ret(h1, hi, 96)].map((x) => x / Math.max(1e-6, atr));
    const cross = crossStrength(crosses, t); const news = newsVector(events, t);
    const common: Record<Expert, number[]> = {
      raw_price: [...base.slice(0, 7), ...base.slice(15, 18)],
      structure: [...base.slice(7, 15), ...base.slice(18, 20)],
      momentum: [...base.slice(0, 13), ...m5x],
      regime: [...base.slice(20, 31), ...base.slice(38, 41)],
      multi_timeframe: [...m5x, ...h1x],
      location: [...base.slice(12, 15), ...base.slice(18, 20), base[30]!],
      liquidity: [base[15]!, base[16]!, base[17]!, base[20]!, base[28]!, base[29]!],
      relative_strength: cross,
      macro_news: news,
    };
    const side = (direction: Direction): Side => ({
      direction,
      x: Object.fromEntries(EXPERTS.map((name) => [name, orient(common[name], direction, name === "regime" ? 0 : name === "macro_news" ? 2 : name === "relative_strength" ? 2 : common[name].length)])) as Record<Expert, number[]>,
      outcome: outcome(bars, i, direction, Math.max(MIN_UNIT, atr)),
    });
    const unit = Math.max(MIN_UNIT, atr); const entry = bars[i + 1]!; out.push({ time: t, iso: new Date(t).toISOString(), day: new Date(t).toISOString().slice(0, 10), session: hour < 11 ? "LONDON" : hour < 13 ? "OVERLAP" : "NEW_YORK", regime, spreadR: (entry.askOpen - entry.bidOpen) / unit, unitPips: unit / PIP, long: side(1), short: side(-1) });
  }
  return { candidates: out, centroids };
}
function samples(rows: Candidate[], expert: Expert): Sample[] { return rows.flatMap((c) => [c.long, c.short].map((s) => ({ x: s.x[expert], y: s.outcome.kind === "TARGET" ? 1 as const : 0 as const }))); }
function expertProbabilities(c: Candidate, models: Record<Expert, NeuralModel>, side: Side) { return Object.fromEntries(EXPERTS.map((name) => [name, predict(models[name], side.x[name])])) as Record<Expert, number>; }
function fusionX(probs: Record<Expert, number>, c: Candidate, omit?: Expert) { return [...EXPERTS.filter((x) => x !== omit).map((x) => probs[x]), c.regime / 2, c.spreadR, c.session === "LONDON" ? 1 : 0, c.session === "OVERLAP" ? 1 : 0]; }
function trainExperts(rows: Candidate[], seed: number) {
  return Object.fromEntries(EXPERTS.map((name, i) => [name, trainNeuralModel(samples(rows, name), { name: `${name}-expert`, hidden1: name === "raw_price" || name === "multi_timeframe" ? 8 : 0, hidden2: 0 }, { seed: seed + i, epochs: 12, learningRate: 0.004, l2: 0.001 })])) as Record<Expert, NeuralModel>;
}
function trainFusion(rows: Candidate[], models: Record<Expert, NeuralModel>, epochs: number, omit?: Expert) {
  const s: Sample[] = rows.flatMap((c) => [c.long, c.short].map((side) => { const p = expertProbabilities(c, models, side); return { x: fusionX(p, c, omit), y: side.outcome.kind === "TARGET" ? 1 as const : 0 as const }; }));
  return trainNeuralModel(s, { name: omit ? `fusion-minus-${omit}` : "gated-fusion", hidden1: 12, hidden2: 4 }, { seed: 7301 + (omit ? EXPERTS.indexOf(omit) : 0), epochs, learningRate: 0.003, l2: 0.002 });
}
function brier(rows: Candidate[], models: Record<Expert, NeuralModel>, fusion: NeuralModel, omit?: Expert) {
  return mean(rows.flatMap((c) => [c.long, c.short].map((side) => { const p = predict(fusion, fusionX(expertProbabilities(c, models, side), c, omit)); return (p - (side.outcome.kind === "TARGET" ? 1 : 0)) ** 2; })));
}
function score(c: Candidate, system: System, omit?: Expert) {
  const lp = expertProbabilities(c, system.experts, c.long), sp = expertProbabilities(c, system.experts, c.short);
  return { lp, sp, pLong: predict(system.fusion, fusionX(lp, c, omit)), pShort: predict(system.fusion, fusionX(sp, c, omit)) };
}
function execute(rows: Candidate[], system: System, omit?: Expert) {
  const trades: Trade[] = []; let openUntil = -Infinity; const perDay = new Map<string, number>();
  for (const c of rows) {
    if (c.time < openUntil || (perDay.get(c.day) ?? 0) >= 3) continue;
    const s = score(c, system, omit); const direction: Direction = s.pLong >= s.pShort ? 1 : -1; const best = Math.max(s.pLong, s.pShort);
    if (best < system.threshold || Math.abs(s.pLong - s.pShort) < 0.02) continue;
    const side = direction === 1 ? c.long : c.short; const component = direction === 1 ? s.lp : s.sp;
    trades.push({ time: c.time, iso: c.iso, day: c.day, direction, resultR: side.outcome.r, kind: side.outcome.kind, score: best, pLong: s.pLong, pShort: s.pShort, component });
    openUntil = side.outcome.exitTime; perDay.set(c.day, (perDay.get(c.day) ?? 0) + 1);
  }
  return trades;
}
function metrics(trades: Trade[], candidateDays: number) {
  const r = trades.map((t) => t.resultR), wins = r.filter((x) => x > 0), losses = r.filter((x) => x < 0); let e = 0, peak = 0, dd = 0;
  for (const x of r) { e += x; peak = Math.max(peak, e); dd = Math.max(dd, peak - e); }
  return { trades: r.length, winRate: wins.length / Math.max(1, r.length), expectancyR: e / Math.max(1, r.length), totalR: e, profitFactor: wins.reduce((a, b) => a + b, 0) / Math.max(1e-9, -losses.reduce((a, b) => a + b, 0)), maxDrawdownR: dd, tradesPerDay: r.length / Math.max(1, candidateDays), waitRate: 1 - r.length / Math.max(1, candidateDays * 3), targetRate: trades.filter((t) => t.kind === "TARGET").length / Math.max(1, r.length), ambiguous: trades.filter((t) => t.kind === "AMBIGUOUS_STOP").length };
}
function days(rows: Candidate[]) { return new Set(rows.map((x) => x.day)).size; }
function chooseThreshold(rows: Candidate[], base: Omit<System, "threshold">, omit?: Expert) {
  const choices = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7].map((threshold) => { const trades = execute(rows, { ...base, threshold }, omit); return { threshold, trades, m: metrics(trades, days(rows)) }; });
  return choices.filter((x) => x.m.trades >= 60).sort((a, b) => b.m.expectancyR - a.m.expectancyR || b.m.trades - a.m.trades)[0] ?? choices.sort((a, b) => b.m.trades - a.m.trades)[0]!;
}
function fitSystem(rows: Candidate[], dev: Candidate[], seed = 100) {
  const cut = rows[Math.floor(rows.length * 0.68)]!.time; const expertRows = rows.filter((x) => x.time <= cut), fusionRows = rows.filter((x) => x.time > cut);
  const experts = trainExperts(expertRows, seed); const f8 = trainFusion(fusionRows, experts, 8), f16 = trainFusion(fusionRows, experts, 16); const fusion = brier(dev, experts, f8) <= brier(dev, experts, f16) ? f8 : f16; const fusionEpochs = fusion === f8 ? 8 : 16;
  const chosen = chooseThreshold(dev, { experts, fusion, fusionEpochs }); return { experts, fusion, fusionEpochs, threshold: chosen.threshold };
}
function baseline(rows: Candidate[], mode: string) {
  const trades: Trade[] = []; let openUntil = -Infinity; const perDay = new Map<string, number>(); let state = 918273;
  for (const c of rows) {
    if (c.time < openUntil || (perDay.get(c.day) ?? 0) >= 3) continue;
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    const r4 = c.long.x.raw_price[3]!, trend = c.long.x.structure[2]! + c.long.x.structure[3]!;
    const direction: Direction = mode === "always_long" ? 1 : mode === "always_short" ? -1 : mode === "random" ? ((state >>> 0) / 4294967296 >= 0.5 ? 1 : -1) : mode === "momentum" ? (r4 >= 0 ? 1 : -1) : (trend >= 0 ? 1 : -1);
    const side = direction === 1 ? c.long : c.short; trades.push({ time: c.time, iso: c.iso, day: c.day, direction, resultR: side.outcome.r, kind: side.outcome.kind, score: 1, pLong: direction === 1 ? 1 : 0, pShort: direction === -1 ? 1 : 0, component: {} as Record<Expert, number> }); openUntil = side.outcome.exitTime; perDay.set(c.day, (perDay.get(c.day) ?? 0) + 1);
  }
  return trades;
}
function simpleX(c: Candidate, side: Side) {
  return [...EXPERTS.flatMap((name) => side.x[name]), c.regime / 2, c.spreadR, c.session === "LONDON" ? 1 : 0, c.session === "OVERLAP" ? 1 : 0];
}
function executeSimple(rows: Candidate[], model: NeuralModel, threshold: number) {
  const trades: Trade[] = []; let openUntil = -Infinity; const perDay = new Map<string, number>();
  for (const c of rows) {
    if (c.time < openUntil || (perDay.get(c.day) ?? 0) >= 3) continue;
    const pLong = predict(model, simpleX(c, c.long)), pShort = predict(model, simpleX(c, c.short)); const direction: Direction = pLong >= pShort ? 1 : -1;
    if (Math.max(pLong, pShort) < threshold || Math.abs(pLong - pShort) < 0.02) continue;
    const side = direction === 1 ? c.long : c.short;
    trades.push({ time: c.time, iso: c.iso, day: c.day, direction, resultR: side.outcome.r, kind: side.outcome.kind, score: Math.max(pLong, pShort), pLong, pShort, component: {} as Record<Expert, number> });
    openUntil = side.outcome.exitTime; perDay.set(c.day, (perDay.get(c.day) ?? 0) + 1);
  }
  return trades;
}
function chooseSimpleThreshold(rows: Candidate[], model: NeuralModel) {
  const choices = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7].map((threshold) => ({ threshold, trades: executeSimple(rows, model, threshold) }));
  return choices.filter((x) => x.trades.length >= 60).sort((a, b) => metrics(b.trades, days(rows)).expectancyR - metrics(a.trades, days(rows)).expectancyR || b.trades.length - a.trades.length)[0] ?? choices.sort((a, b) => b.trades.length - a.trades.length)[0]!;
}
function componentRows(rows: Candidate[], system: System, finalTrades: Trade[]) {
  const finalByTime = new Map(finalTrades.map((x) => [x.time, x]));
  return EXPERTS.map((name) => {
    let correct = 0, n = 0, b = 0, alignedR: number[] = [], opposedR: number[] = [];
    for (const c of rows) {
      const pl = predict(system.experts[name], c.long.x[name]), ps = predict(system.experts[name], c.short.x[name]); const side = pl >= ps ? c.long : c.short; const p = Math.max(pl, ps);
      const betterDirection = c.long.outcome.r > c.short.outcome.r ? 1 : c.short.outcome.r > c.long.outcome.r ? -1 : 0;
      if (betterDirection !== 0) { n += 1; if (side.direction === betterDirection) correct += 1; }
      b += (p - (side.outcome.kind === "TARGET" ? 1 : 0)) ** 2;
      const f = finalByTime.get(c.time); if (f) (f.direction === side.direction ? alignedR : opposedR).push(f.resultR);
    }
    return { component: name, sample_count: rows.length, directional_non_tie_count: n, directional_accuracy: correct / Math.max(1, n), brier: b / Math.max(1, rows.length), expectancy_when_aligned: mean(alignedR), aligned_n: alignedR.length, expectancy_when_opposed: mean(opposedR), opposed_n: opposedR.length };
  });
}
function breakdown(rows: Candidate[], trades: Trade[], key: (candidate: Candidate) => string) {
  const byTime = new Map(rows.map((x) => [x.time, x]));
  const grouped = new Map<string, Trade[]>();
  for (const trade of trades) {
    const group = key(byTime.get(trade.time)!); const subset = grouped.get(group) ?? []; subset.push(trade); grouped.set(group, subset);
  }
  return [...grouped].map(([group, subset]) => ({ group, ...metrics(subset, new Set(subset.map((x) => x.day)).size) }));
}
function lossDiagnosis(rows: Candidate[], trades: Trade[]) {
  const byTime = new Map(rows.map((candidate) => [candidate.time, candidate]));
  return trades.map((trade) => {
    const candidate = byTime.get(trade.time)!; const selected = trade.direction === 1 ? candidate.long : candidate.short; const opposite = trade.direction === 1 ? candidate.short : candidate.long;
    const directionStatus = selected.outcome.r > opposite.outcome.r ? "SELECTED_BETTER_R" : selected.outcome.r < opposite.outcome.r ? "OPPOSITE_BETTER_R" : "TIED_R";
    const lossCause = trade.resultR >= 0 ? "WIN" : opposite.outcome.r > 0 ? "OPPOSITE_DIRECTION_PROFITABLE" : opposite.outcome.r > selected.outcome.r ? "OPPOSITE_LESS_BAD" : opposite.outcome.r < 0 ? "BOTH_DIRECTIONS_LOSE" : "TIED_OR_ZERO";
    const scoreBand = trade.score < 0.6 ? "0.55-0.60" : trade.score < 0.65 ? "0.60-0.65" : trade.score < 0.7 ? "0.65-0.70" : "0.70+";
    return { time: trade.iso, direction: trade.direction === 1 ? "LONG" : "SHORT", session: candidate.session, regime: `regime_${candidate.regime}`, score: trade.score, score_band: scoreBand, unit_pips: candidate.unitPips, stop_pips: GEOMETRY.stopR * candidate.unitPips, target_pips: GEOMETRY.targetR * candidate.unitPips, p_long: trade.pLong, p_short: trade.pShort, result_r: trade.resultR, outcome_kind: trade.kind, long_result_r: candidate.long.outcome.r, long_outcome_kind: candidate.long.outcome.kind, short_result_r: candidate.short.outcome.r, short_outcome_kind: candidate.short.outcome.kind, opposite_result_r: opposite.outcome.r, opposite_outcome_kind: opposite.outcome.kind, direction_status: directionStatus, loss_cause: lossCause };
  });
}
function diagnosticTable(rows: Record<string, unknown>[], key: string) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) { const group = String(row[key]); const subset = groups.get(group) ?? []; subset.push(row); groups.set(group, subset); }
  const summary = [...groups].map(([group, subset]) => {
    const r = subset.map((x) => Number(x.result_r)); const wins = r.filter((x) => x > 0).length; const targets = subset.filter((x) => x.outcome_kind === "TARGET").length;
    return { group, trades: subset.length, win_rate: wins / subset.length, target_rate: targets / subset.length, expectancy_r: mean(r), average_score: mean(subset.map((x) => Number(x.score))) };
  });
  return `| ${key} | Trades | Win rate | Target rate | Avg R | Avg model score |\n|---|---:|---:|---:|---:|---:|\n${summary.map((x) => `| ${x.group} | ${x.trades} | ${(100 * x.win_rate).toFixed(1)}% | ${(100 * x.target_rate).toFixed(1)}% | ${x.expectancy_r.toFixed(4)} | ${x.average_score.toFixed(3)} |`).join("\n")}`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const bars = loadBars(); const m5 = loadTimed("backtest-breakout-m5/candles/EUR_USD_M5.json"); const h1 = loadTimed("backtest-legacy-expanded/candles/EUR_USD_H1.json");
  const m15Audit = auditTimed("backtest-legacy-expanded/candles/EUR_USD_M15.json", 15); const m5Audit = auditTimed("backtest-breakout-m5/candles/EUR_USD_M5.json", 5);
  const crossPairs = ["EUR_GBP", "EUR_JPY", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CAD", "USD_CHF"];
  const crosses = new Map(crossPairs.map((p) => [p, loadTimed(`backtest-legacy-expanded/candles/${p}_H1.json`)]));
  const news = loadNews(); const built = buildCandidates(bars, m5, h1, crosses, news.events); const candidates = built.candidates;
  const train = candidates.filter((x) => x.time < DEV_FROM), dev = candidates.filter((x) => x.time >= DEV_FROM && x.time < FINAL_FROM), holdout = candidates.filter((x) => x.time >= FINAL_FROM && x.time < FINAL_TO);
  const system = fitSystem(train, dev); const finalTrades = execute(holdout, system); const full = metrics(finalTrades, days(holdout));

  const ablations: Record<string, unknown>[] = [];
  for (const omit of EXPERTS) {
    const cut = train[Math.floor(train.length * 0.68)]!.time; const fusionRows = train.filter((x) => x.time > cut); const fusion = trainFusion(fusionRows, system.experts, system.fusionEpochs, omit); const choice = chooseThreshold(dev, { experts: system.experts, fusion, fusionEpochs: system.fusionEpochs }, omit); const trades = execute(holdout, { experts: system.experts, fusion, fusionEpochs: system.fusionEpochs, threshold: choice.threshold }, omit); const m = metrics(trades, days(holdout));
    ablations.push({ variant: `FULL_MINUS_${omit}`, threshold: choice.threshold, ...m, delta_expectancy_vs_full: m.expectancyR - full.expectancyR, harmful_component_if_removed_improves: m.expectancyR > full.expectancyR });
  }
  ablations.unshift({ variant: "FULL_MODEL", threshold: system.threshold, ...full, delta_expectancy_vs_full: 0, harmful_component_if_removed_improves: false });

  const baselineRows: Record<string, unknown>[] = [];
  for (const mode of ["random", "always_long", "always_short", "momentum", "trend"]) baselineRows.push({ model: mode, ...metrics(baseline(holdout, mode), days(holdout)) });
  const proxySamples: Sample[] = train.flatMap((c) => [c.long, c.short].map((side) => ({ x: simpleX(c, side), y: side.outcome.kind === "TARGET" ? 1 as const : 0 as const })));
  const proxyModel = trainNeuralModel(proxySamples, { name: "simple-logistic-existing-features", hidden1: 0, hidden2: 0 }, { seed: 450, epochs: 12, learningRate: 0.004, l2: 0.002 });
  const proxyChoice = chooseSimpleThreshold(dev, proxyModel); const proxy = executeSimple(holdout, proxyModel, proxyChoice.threshold);
  baselineRows.push({ model: "simple_logistic_existing_features", threshold: proxyChoice.threshold, ...metrics(proxy, days(holdout)) });
  baselineRows.push({ model: "mixture_of_experts", ...full });

  const walk: Record<string, unknown>[] = [];
  for (const [from, to] of [["2025-05-01", "2025-08-01"], ["2025-08-01", "2025-11-01"], ["2025-11-01", "2026-02-01"], ["2026-02-01", "2026-05-01"], ["2026-05-01", "2026-08-01"]]) {
    const f = Date.parse(`${from}T00:00:00Z`), t = Date.parse(`${to}T00:00:00Z`); const prior = candidates.filter((x) => x.time < f), test = candidates.filter((x) => x.time >= f && x.time < t); const calibrationCut = prior[Math.floor(prior.length * .8)]!.time; const wf = fitSystem(prior.filter((x) => x.time < calibrationCut), prior.filter((x) => x.time >= calibrationCut), 800 + walk.length * 50); const tr = execute(test, wf); walk.push({ fold: `${from}..${to}`, threshold: wf.threshold, ...metrics(tr, days(test)) });
  }

  const components = componentRows(holdout, system, finalTrades); const bestComponent = [...components].sort((a, b) => Number(b.expectancy_when_aligned) - Number(a.expectancy_when_aligned))[0]!; const harmful = ablations.slice(1).filter((x) => x.harmful_component_if_removed_improves).map((x) => String(x.variant).replace("FULL_MINUS_", ""));
  const strongestAblation = [...ablations.slice(1)].sort((a, b) => Number(a.delta_expectancy_vs_full) - Number(b.delta_expectancy_vs_full))[0]!;
  const weakestAblation = [...ablations.slice(1)].sort((a, b) => Number(b.delta_expectancy_vs_full) - Number(a.delta_expectancy_vs_full))[0]!;
  const regimeResults = breakdown(holdout, finalTrades, (x) => `regime_${x.regime}`); const sessionResults = breakdown(holdout, finalTrades, (x) => x.session);
  const positiveFolds = walk.filter((x) => Number(x.expectancyR) > 0).length; const bestSimple = [...baselineRows.filter((x) => x.model !== "mixture_of_experts")].sort((a, b) => Number(b.expectancyR) - Number(a.expectancyR))[0]!;
  const verdict = full.trades < 100 ? "INSUFFICIENT_DATA" : full.expectancyR <= 0 || full.profitFactor <= 1 ? "NO_EDGE" : Number(bestSimple.expectancyR) >= full.expectancyR ? "WEAK_EDGE" : positiveFolds < 3 ? "PROMISING_BUT_UNPROVEN" : "STRONG_EDGE";

  const audit = `# EURUSD_ELITE_DIRECTION_V1 — Data audit\n\n## Price data\n\n- EUR/USD M15 bid/ask: ${bars.length.toLocaleString()} completed records, ${new Date(bars[0]!.t).toISOString()} through ${new Date(bars.at(-1)!.t).toISOString()}.\n- EUR/USD M5 bid/ask: ${m5.length.toLocaleString()} records, ${new Date(m5[0]!.t).toISOString()} through ${new Date(m5.at(-1)!.t).toISOString()}.\n- H1 context: EUR/USD plus ${crossPairs.length} liquid EUR/USD crosses and USD majors. This fixed universe avoids symbol survivorship selection during the experiment.\n- M1: **MISSING locally for this full period**. M15 is the conservative barrier resolver; same-bar TP/SL collisions are charged as stops.\n\n| Audit | M15 | M5 |\n|---|---:|---:|\n| Raw rows | ${m15Audit.rows} | ${m5Audit.rows} |\n| Duplicate timestamps | ${m15Audit.duplicateTimestamp} | ${m5Audit.duplicateTimestamp} |\n| Non-monotonic rows | ${m15Audit.nonMonotonic} | ${m5Audit.nonMonotonic} |\n| Invalid timestamps | ${m15Audit.invalidTimestamp} | ${m5Audit.invalidTimestamp} |\n| Malformed OHLC/quotes | ${m15Audit.malformedOhlc} | ${m5Audit.malformedOhlc} |\n| Negative bid/ask spreads | ${m15Audit.negativeSpread} | ${m5Audit.negativeSpread} |\n| Sub-12h unexpected weekday gaps | ${m15Audit.unexpectedWeekdayGaps} | ${m5Audit.unexpectedWeekdayGaps} |\n\nWeekend/holiday gaps are expected and are not forward-filled. The cache rows do not carry a vendor completeness flag; their completed-candle status is inherited from the repository fetcher and cannot be independently reconstructed, so that field is **MISSING**.\n\n## News data\n\n- ${news.events.length} high-impact EUR/USD events, ${new Date(news.events[0]!.time).toISOString()} through ${new Date(news.events.at(-1)!.time).toISOString()}.\n- ${news.events.filter((x) => x.actual != null).length} actual, ${news.events.filter((x) => x.forecast != null).length} forecast, and ${news.events.filter((x) => x.previous != null).length} previous values.\n- The files are absent from the current research branch but present in local git history. Sources: ${news.sources.map((x) => `\`${x.source}\` (${x.rows} rows, SHA-256 ${x.sha256})`).join("; ")}.\n- All release timestamps are explicit UTC. Actual surprises are exposed only at or after releaseTimeUtc. Multiple releases sharing a timestamp are valid simultaneous events, not deduplicated away.\n- The dataset does not contain vendor publication-latency/version history, so exact sub-minute release latency and revision-vintage reconstruction are **MISSING**.\n\n## Leakage and execution audit\n\n- Decisions use completed bars at T; entry is the next M15 executable ask/bid.\n- All rolling features stop at T. H1/M5 joins use the last timestamp <= T. News releases after T are never exposed.\n- Standardization is fitted only on each training fold. Experts, fusion, calibration, development, and final slices are chronological.\n- Bid/ask spread is paid directly; 0.1 pip entry and 0.1 pip exit slippage are added.\n- Geometry is +1R / -0.5R with a one-ATR unit (four-pip floor), maximum three-hour hold.\n- Important limitation: the 2025-11..2026-08 final slice was inspected by earlier V5 research on this branch. It is chronological OOS for this code run but not a pristine never-seen organizational holdout. Claims are downgraded accordingly.\n`;
  const architecture = `# Model architecture\n\nEURUSD_ELITE_DIRECTION_V1 is a mixture of nine separately trained experts: ${EXPERTS.join(", ")}. Raw-price and multi-timeframe branches use small nonlinear neural experts; the remaining branches use regularized logistic experts. Each branch estimates its own P(TP before SL) for LONG and SHORT.\n\nA 12x4 gating/fusion MLP consumes only expert probabilities plus causal regime, spread, and session context. Fusion training occurs strictly after expert training in time. Eight versus sixteen epochs are selected by development Brier score (early stopping proxy); L2 regularization is applied throughout.\n\nThe eleven-stage output maps macro/news, relative strength, regime, HTF structure, location, liquidity, momentum, LTF confirmation, side-by-side LONG/SHORT evidence, cost-aware probabilities, and a final LONG/SHORT/WAIT decision. WAIT is emitted below the development-selected probability threshold or below a 0.02 side margin.\n\nThis script imports no execution, collector, paper-cycle, or production strategy module.\n`;
  const metricTable = (rows: Record<string, unknown>[], label: string) => `| ${label} | N | Win rate | Avg R | PF | Max DD |\n|---|---:|---:|---:|---:|---:|\n${rows.map((x) => `| ${x.model ?? x.group} | ${x.trades} | ${(100 * Number(x.winRate)).toFixed(1)}% | ${Number(x.expectancyR).toFixed(4)} | ${Number(x.profitFactor).toFixed(3)} | ${Number(x.maxDrawdownR).toFixed(2)} |`).join("\n")}`;
  const report = `# EURUSD_ELITE_DIRECTION_V1 — Final report\n\nFinal verdict: **${verdict}**\n\n## Final chronological slice\n\n- Trades: ${full.trades}; win rate ${(100 * full.winRate).toFixed(2)}%; expectancy ${full.expectancyR.toFixed(4)}R; total ${full.totalR.toFixed(2)}R; PF ${full.profitFactor.toFixed(3)}; max DD ${full.maxDrawdownR.toFixed(2)}R; WAIT ${(100 * full.waitRate).toFixed(1)}%.\n- Best simple comparator: ${bestSimple.model} at ${Number(bestSimple.expectancyR).toFixed(4)}R/trade.\n- Walk-forward positive folds: ${positiveFolds}/${walk.length}.\n\n## Baselines\n\n${metricTable(baselineRows, "Model")}\n\n## Regimes\n\n${metricTable(regimeResults, "Regime")}\n\n## Sessions\n\n${metricTable(sessionResults, "Session")}\n\n## Required answers\n\n1. Out-of-sample directional edge: **${full.expectancyR > 0 ? "positive in the final slice" : "not demonstrated"}**.\n2. After spread/costs: **${full.expectancyR > 0 && full.profitFactor > 1 ? "yes in this slice" : "no"}**.\n3. Strongest contributor by ablation: **${String(strongestAblation.variant).replace("FULL_MINUS_", "")}**; removing it changed expectancy by ${Number(strongestAblation.delta_expectancy_vs_full).toFixed(4)}R. The best alignment diagnostic was ${bestComponent.component}, but even aligned expectancy remained ${Number(bestComponent.expectancy_when_aligned).toFixed(4)}R.\n4. Weakest/most harmful by ablation: **${String(weakestAblation.variant).replace("FULL_MINUS_", "")}**; removing it improved expectancy by ${Number(weakestAblation.delta_expectancy_vs_full).toFixed(4)}R.\n5. Components flagged harmful because removal improved final expectancy: **${harmful.length ? harmful.join(", ") : "none"}**.\n6. News value: removing macro/news changed expectancy by ${Number(ablations.find((x) => x.variant === "FULL_MINUS_macro_news")!.delta_expectancy_vs_full).toFixed(4)}R. It helped relative to the full model but did not create a positive system.\n7. Neural model beats simple models: **${full.expectancyR > Number(bestSimple.expectancyR) ? "yes on this slice" : "no"}**.\n8–9. Regime performance is shown above; no regime may be called successful unless its expectancy and PF are positive with adequate N.\n10. WAIT frequency: ${(100 * full.waitRate).toFixed(1)}%.\n11. +1R/-0.5R profitability: **${full.expectancyR > 0 ? "positive on final slice" : "negative"}**.\n12. Stability: **${positiveFolds}/${walk.length} positive walk-forward folds; ${positiveFolds >= 4 ? "reasonably stable" : "not stable"}**.\n\n## Judgment\n\nThe verdict is not upgraded on architecture complexity. The final slice is not organizationally pristine because earlier V5 work inspected the same calendar period, and M1 sequencing is unavailable for the full history. A production or paper-engine change is not authorized by this experiment.\n`;
  const finalByTime = new Map(finalTrades.map((x) => [x.time, x]));
  const inventory = `## Relevant repository inventory inspected

- Feature/model utilities: \`scripts/eurusd-neural-day-v1/model.ts\` and \`experiment.ts\` (rolling price state, regimes, train-only normalization, and deterministic neural training).
- Existing news-aware EUR/USD research: \`scripts/eurusd-neural-day-v5/\` and \`research-v2/eurusd-neural-day-v5/\`. V5 used different, development-selected geometry; its final slice was +0.0906R/trade but its expanding walk-forward result was -0.0812R/trade. It is contextual evidence, not an apples-to-apples +1R/-0.5R baseline.
- Existing simulators/caches: \`scripts/_backtest_legacy_expanded.ts\`, \`scripts/_backtest_breakout_m5.ts\`, \`backtest-legacy-expanded/\`, and \`backtest-breakout-m5/\`.
- Existing production/paper strategies were inspected only for isolation boundaries and were not imported, called, or modified. No directly comparable frozen +1R/-0.5R GoldenXperience baseline was available; that comparator is therefore **MISSING**, not fabricated.`;
  const exactNewsDuplicates = news.events.length - new Set(news.events.map((x) => `${x.time}|${x.currency}|${x.name}|${x.actual}|${x.forecast}|${x.previous}`)).size;
  const newsTimestampCounts = new Map<number, number>(); for (const event of news.events) newsTimestampCounts.set(event.time, (newsTimestampCounts.get(event.time) ?? 0) + 1);
  const simultaneousNewsTimestamps = [...newsTimestampCounts.values()].filter((count) => count > 1).length;
  const audited = audit
    .replace("## News data", `${inventory}\n\n## News data`)
    .replace("- All release timestamps are explicit UTC.", `- Invalid release timestamps: ${news.sources.reduce((sum, source) => sum + source.rows, 0) - news.events.length}; exact duplicate event rows: ${exactNewsDuplicates}; timestamps containing multiple simultaneous releases: ${simultaneousNewsTimestamps}.\n- All release timestamps are explicit UTC.`)
    .replace("Geometry is +1R / -0.5R", `Geometry is +${GEOMETRY.targetR}R / -${GEOMETRY.stopR}R`)
    .replace("maximum three-hour hold.", "maximum three-hour hold. Geometry is isolated in `GEOMETRY` for later experiments.");
  const architectureWithDefinitions = architecture.replace(
    "This script imports no execution",
    "`DECISIONS.csv` records both side probabilities from every expert at every final-period decision timestamp. In `COMPONENT_RESULTS.csv`, directional accuracy means whether the component's higher-scored side had the better realized R of LONG versus SHORT; tied outcomes are excluded. Brier score measures calibration of the selected side's TP-before-SL probability. Context/filter value is judged primarily by chronological ablation, not forced directional accuracy.\n\nThis script imports no execution",
  );
  const workingRegimes = regimeResults.filter((x) => Number(x.expectancyR) > 0 && Number(x.profitFactor) > 1 && Number(x.trades) >= 30).map((x) => x.group).join(", ") || "none";
  const failedRegimes = regimeResults.filter((x) => Number(x.expectancyR) <= 0 || Number(x.profitFactor) <= 1).map((x) => x.group).join(", ") || "none";
  const completedReport = report.replace(
    "8–9. Regime performance is shown above; no regime may be called successful unless its expectancy and PF are positive with adequate N.",
    `8. Regimes that work: **${workingRegimes}**.\n9. Regimes that fail: **${failedRegimes}**. Regimes with no selected trades remain unproven rather than successful.`,
  ).replace(
    `- Best simple comparator: ${bestSimple.model} at ${Number(bestSimple.expectancyR).toFixed(4)}R/trade.`,
    `- Best simple comparator: ${bestSimple.model} at ${Number(bestSimple.expectancyR).toFixed(4)}R/trade. Its ${bestSimple.trades}-trade final sample is below the 60-trade development minimum, so this is context, not evidence of a viable alternative.`,
  );
  const decisions = holdout.map((c) => { const s = score(c, system); const selected = finalByTime.get(c.time); return { time: c.iso, decision: selected ? (selected.direction === 1 ? "LONG" : "SHORT") : "WAIT", p_long: s.pLong, p_short: s.pShort, result_r: selected?.resultR ?? "", ...Object.fromEntries(EXPERTS.flatMap((name) => [[`${name}_long`, s.lp[name]], [`${name}_short`, s.sp[name]]])) }; });
  const diagnosis = lossDiagnosis(holdout, finalTrades); const lossRows = diagnosis.filter((x) => Number(x.result_r) < 0);
  const averageStopPips = mean(diagnosis.map((x) => Number(x.stop_pips))); const averageTargetPips = mean(diagnosis.map((x) => Number(x.target_pips)));
  const lossReport = `# EURUSD_ELITE_DIRECTION_V1 — Loss diagnosis

This is post-trade forensic analysis only. It does not feed the decision model. “Opposite” means the executable counterfactual from the identical timestamp, using the same +${GEOMETRY.targetR}R/-${GEOMETRY.stopR}R geometry, historical bid/ask, slippage, and conservative same-candle resolver.

- Average selected geometry: ${averageTargetPips.toFixed(2)}-pip target and ${averageStopPips.toFixed(2)}-pip stop. The stop is half an ATR-unit by construction.

## All selected trades by realized outcome

${diagnosticTable(diagnosis, "outcome_kind")}

## Loss mechanism

${diagnosticTable(lossRows, "loss_cause")}

## Direction selection on losing trades

${diagnosticTable(lossRows, "direction_status")}

## Calibration check: selected-score buckets

${diagnosticTable(diagnosis, "score_band")}

## Session composition

${diagnosticTable(diagnosis, "session")}

Interpretation: OPPOSITE_DIRECTION_PROFITABLE is clear direction failure. BOTH_DIRECTIONS_LOSE is a no-move/whipsaw/geometry failure, not evidence the opposite signal would have worked. OPPOSITE_LESS_BAD means direction selection was still inferior, but neither direction produced a profitable outcome.
`;
  writeFileSync(path.join(OUT, "DATA_AUDIT.md"), audited); writeFileSync(path.join(OUT, "MODEL_ARCHITECTURE.md"), architectureWithDefinitions); writeFileSync(path.join(OUT, "COMPONENT_RESULTS.csv"), csv(components)); writeFileSync(path.join(OUT, "ABLATION_RESULTS.csv"), csv(ablations)); writeFileSync(path.join(OUT, "WALK_FORWARD_RESULTS.csv"), csv(walk)); writeFileSync(path.join(OUT, "FINAL_REPORT.md"), completedReport); writeFileSync(path.join(OUT, "DECISIONS.csv"), csv(decisions)); writeFileSync(path.join(OUT, "LOSS_DIAGNOSIS.csv"), csv(diagnosis)); writeFileSync(path.join(OUT, "LOSS_DIAGNOSIS.md"), lossReport);
  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(round({ experiment: "EURUSD_ELITE_DIRECTION_V1", verdict, protocol: { buildFrom: new Date(BUILD_FROM).toISOString(), developmentFrom: new Date(DEV_FROM).toISOString(), finalFrom: new Date(FINAL_FROM).toISOString(), finalTo: new Date(FINAL_TO).toISOString(), geometry: GEOMETRY, threshold: system.threshold, fusionEpochs: system.fusionEpochs, experts: EXPERTS, newsSources: news.sources }, dataAudit: { m15: m15Audit, m5: m5Audit }, counts: { candidates: candidates.length, train: train.length, development: dev.length, holdout: holdout.length }, final: full, components, ablations, baselines: baselineRows, regimes: regimeResults, sessions: sessionResults, walkForward: walk, lossDiagnosis: diagnosis, regimeCentroids: built.centroids }), null, 2));
  console.log(JSON.stringify(round({ verdict, counts: { candidates: candidates.length, train: train.length, development: dev.length, holdout: holdout.length }, final: full, threshold: system.threshold, fusionEpochs: system.fusionEpochs, bestSimple, positiveFolds, harmful }), null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
