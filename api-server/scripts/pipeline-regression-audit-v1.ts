/**
 * PIPELINE REGRESSION AUDIT V1
 *
 * Blind rediscovery audit. The phase rules in this file are a direct executable
 * transcription of the audit brief; historical control answers are deliberately
 * absent until the comparison section generated after all measurements finish.
 * Research only: reads OANDA candles, writes local artifacts, never places orders.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";

config({ path: path.resolve(".env"), quiet: true });
config({ path: path.resolve(".env.local"), override: false, quiet: true });

type Side = "LONG" | "SHORT";
type Candle = { t: number; o: number; h: number; l: number; c: number };
type Row = { i: number; hour: number; atr: number; ema20: number; ema50: number; close3: number; dominant: Side; move: { displacement: number; mfe: number; ge1: boolean; range: number; body: number } };
type Signal = { name: string; side: Side | null };
const HOUR = 3_600_000;
const OUT = path.resolve("research-v2/pipeline-regression-audit-v1");
const FROM = Date.parse("2023-01-01T00:00:00.000Z");
const WARMUP = Date.parse("2022-09-01T00:00:00.000Z");
const UNTIL = Date.now() - HOUR; // completed bars only
const PAIRS = ["USD_CHF", "USD_CAD", "EUR_JPY"] as const;

const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^['"]|['"]$/g, "");
if (!token) throw new Error("Missing OANDA_API_KEY/OANDA_API_TOKEN; audit cannot substitute another data source.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").toLowerCase() === "live") throw new Error("This audit is practice-data only.");
const host = "https://api-fxpractice.oanda.com";

function ema(values: number[], length: number) {
  const out = Array<number>(values.length).fill(NaN); let v = 0, sum = 0; const a = 2 / (length + 1);
  for (let i = 0; i < values.length; i++) { sum += values[i]!; if (i < length - 1) continue; if (i === length - 1) v = sum / length; else v = a * values[i]! + (1 - a) * v; out[i] = v; }
  return out;
}
function atr(rows: Candle[]) {
  const out = Array<number>(rows.length).fill(NaN); let total = 0, value = 0;
  for (let i = 1; i < rows.length; i++) { const tr = Math.max(rows[i]!.h - rows[i]!.l, Math.abs(rows[i]!.h - rows[i - 1]!.c), Math.abs(rows[i]!.l - rows[i - 1]!.c)); if (i <= 14) total += tr; if (i === 14) value = total / 14; else if (i > 14) value = (value * 13 + tr) / 14; if (i >= 14) out[i] = value; }
  return out;
}
async function fetchJson(url: string): Promise<any> {
  for (let n = 0; n < 5; n++) { const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) }); if (r.ok) return r.json(); if (![429, 500, 502, 503, 504].includes(r.status)) throw new Error(`OANDA HTTP ${r.status}`); await new Promise((x) => setTimeout(x, 500 * (n + 1))); }
  throw new Error("OANDA retries exhausted");
}
async function candles(pair: string): Promise<Candle[]> {
  const file = path.join(OUT, "data", `${pair}-H1-mid.json`); fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) { const cached = JSON.parse(fs.readFileSync(file, "utf8")); if (cached.from === WARMUP && cached.until >= UNTIL - 2 * HOUR) return cached.candles; }
  const all = new Map<number, Candle>(); let cursor = UNTIL + HOUR;
  while (cursor > WARMUP) {
    const url = `${host}/v3/instruments/${pair}/candles?price=M&granularity=H1&count=5000&to=${encodeURIComponent(new Date(cursor).toISOString())}`;
    const body = await fetchJson(url); const batch = (body.candles ?? []).filter((x: any) => x.complete && x.mid).map((x: any) => ({ t: Date.parse(x.time), o: +x.mid.o, h: +x.mid.h, l: +x.mid.l, c: +x.mid.c })).filter((x: Candle) => Number.isFinite(x.c));
    if (!batch.length) throw new Error(`${pair}: empty completed H1 page`);
    for (const c of batch) if (c.t >= WARMUP && c.t < UNTIL) all.set(c.t, c);
    const next = Math.min(...batch.map((x: Candle) => x.t)); if (next >= cursor) throw new Error(`${pair}: pagination stalled`); cursor = next;
  }
  const result = [...all.values()].sort((a, b) => a.t - b.t); fs.writeFileSync(file, JSON.stringify({ from: WARMUP, until: UNTIL, candles: result })); return result;
}
function contiguous(a: Candle, b: Candle) { return b.t - a.t === HOUR; }
function signals(r: Row, closes: number[], ema20: number[]): Signal[] {
  const trend: Side = r.ema20 > r.ema50 ? "LONG" : "SHORT";
  const price: Side = closes[r.i]! > r.ema20 ? "LONG" : "SHORT";
  const slope: Side = r.ema20 > ema20[r.i - 3]! ? "LONG" : "SHORT";
  return [{ name: "EMA20_vs_EMA50", side: trend }, { name: "close_vs_EMA20", side: price }, { name: "EMA20_slope_3", side: slope }, { name: "3bar_momentum", side: closes[r.i]! > closes[r.i - 3]! ? "LONG" : "SHORT" }, { name: "EMA_price_agreement", side: trend === price ? trend : null }];
}
function metrics(values: number[]) { const wins = values.filter((x) => x > 0), losses = values.filter((x) => x < 0); return { N: values.length, WR: values.length ? wins.length / values.length : null, PF: losses.length ? wins.reduce((s, x) => s + x, 0) / -losses.reduce((s, x) => s + x, 0) : null, totalR: values.reduce((s, x) => s + x, 0), expectancyR: values.length ? values.reduce((s, x) => s + x, 0) / values.length : null }; }
function tradeResult(side: Side, origin: Candle, future: Candle[], risk: number) {
  const stop = side === "LONG" ? origin.c - risk : origin.c + risk, target = side === "LONG" ? origin.c + 2 * risk : origin.c - 2 * risk;
  for (const bar of future) { const stopHit = side === "LONG" ? bar.l <= stop : bar.h >= stop; const targetHit = side === "LONG" ? bar.h >= target : bar.l <= target; if (stopHit) return { r: -1, exit: "SL" }; if (targetHit) return { r: 2, exit: "TP" }; }
  return { r: (side === "LONG" ? future[2]!.c - origin.c : origin.c - future[2]!.c) / risk, exit: "TIME" };
}
function fmt(n: number | null, d = 3) { return n == null || !Number.isFinite(n) ? "—" : n.toFixed(d); }

async function run(pair: string) {
  const c = await candles(pair), closes = c.map((x) => x.c), a = atr(c), e20 = ema(closes, 20), e50 = ema(closes, 50);
  const rows: Row[] = [];
  for (let i = 50; i + 3 < c.length; i++) {
    if (c[i]!.t < FROM || ![1, 2, 3].every((k) => contiguous(c[i + k - 1]!, c[i + k]!)) || !Number.isFinite(a[i]!)) continue;
    const hi = Math.max(...c.slice(i + 1, i + 4).map((x) => x.h)), lo = Math.min(...c.slice(i + 1, i + 4).map((x) => x.l)); const up = hi - c[i]!.c, down = c[i]!.c - lo;
    rows.push({ i, hour: new Date(c[i]!.t).getUTCHours(), atr: a[i]!, ema20: e20[i]!, ema50: e50[i]!, close3: c[i + 3]!.c, dominant: up >= down ? "LONG" : "SHORT", move: { displacement: Math.abs(c[i + 3]!.c - c[i]!.c) / a[i]!, mfe: Math.max(up, down) / a[i]!, ge1: Math.max(up, down) / a[i]! >= 1, range: (c[i]!.h - c[i]!.l) / a[i]!, body: Math.abs(c[i]!.c - c[i]!.o) / a[i]! } });
  }
  const clusters = Array.from({ length: 24 }, (_, hour) => { const x = rows.filter((r) => r.hour === hour); const mean = (f: (r: Row) => number) => x.reduce((s, r) => s + f(r), 0) / Math.max(1, x.length); return { hour, N: x.length, displacement: mean((r) => r.move.displacement), mfe: mean((r) => r.move.mfe), reach1: mean((r) => +r.move.ge1), range: mean((r) => r.move.range), body: mean((r) => r.move.body) }; }).sort((x, y) => y.reach1 - x.reach1 || y.mfe - x.mfe || y.displacement - x.displacement);
  const selectedHour = clusters[0]!.hour, phaseRows = rows.filter((r) => r.hour === selectedHour);
  const models = ["EMA20_vs_EMA50", "close_vs_EMA20", "EMA20_slope_3", "3bar_momentum", "EMA_price_agreement", "4vote_consensus"];
  const modelRows = models.map((name) => {
    const calls = phaseRows.map((r) => { const base = signals(r, closes, e20); const votes = base.slice(0, 4).map((x) => x.side!); const long = votes.filter((x) => x === "LONG").length, short = 4 - long; const s = name === "4vote_consensus" ? (long >= 3 ? "LONG" : short >= 3 ? "SHORT" : null) : base.find((x) => x.name === name)?.side ?? null; return { r, s }; }).filter((x): x is { r: Row; s: Side } => x.s !== null);
    const one = (side: Side) => { const x = calls.filter((z) => z.s === side); const net = x.filter((z) => (z.r.close3 > c[z.r.i]!.c ? "LONG" : "SHORT") === side).length / Math.max(1, x.length); const dom = x.filter((z) => z.r.dominant === side).length / Math.max(1, x.length); return { N: x.length, accuracy: net, dominantAccuracy: dom, reach1: x.filter((z) => z.r.move.ge1).length / Math.max(1, x.length) }; };
    const long = one("LONG"), short = one("SHORT"), all = calls.filter((z) => (z.r.close3 > c[z.r.i]!.c ? "LONG" : "SHORT") === z.s).length / Math.max(1, calls.length);
    return { name, N: calls.length, overallAccuracy: all, LONG: long, SHORT: short, asymmetry: Math.abs(long.dominantAccuracy - short.dominantAccuracy) };
  });
  const eligible = modelRows.filter((m) => Math.max(m.LONG.N, m.SHORT.N) >= 30).sort((x, y) => y.asymmetry - x.asymmetry || Math.max(y.LONG.N, y.SHORT.N) - Math.max(x.LONG.N, x.SHORT.N));
  const selectedModel = eligible[0] ?? modelRows[0]!; const selectedSide: Side = selectedModel.LONG.dominantAccuracy >= selectedModel.SHORT.dominantAccuracy ? "LONG" : "SHORT";
  const isGate = (r: Row) => { const base = signals(r, closes, e20); if (selectedModel.name === "4vote_consensus") { const v = base.slice(0, 4).map((x) => x.side!); return v.filter((x) => x === selectedSide).length >= 3; } return base.find((x) => x.name === selectedModel.name)?.side === selectedSide; };
  const entered = phaseRows.filter(isGate);
  const filters: Record<string, (r: Row) => boolean> = {
    direction_gate_only: () => true,
    bullish_bearish_structure: (r) => selectedSide === "LONG" ? c[r.i]!.h > c[r.i - 1]!.h && c[r.i]!.l > c[r.i - 1]!.l : c[r.i]!.h < c[r.i - 1]!.h && c[r.i]!.l < c[r.i - 1]!.l,
    EMA20_reclaim: (r) => selectedSide === "LONG" ? c[r.i]!.l <= r.ema20 && c[r.i]!.c > r.ema20 : c[r.i]!.h >= r.ema20 && c[r.i]!.c < r.ema20,
    previous_high_low_break: (r) => selectedSide === "LONG" ? c[r.i]!.c > c[r.i - 1]!.h : c[r.i]!.c < c[r.i - 1]!.l,
    body_outer_25: (r) => { const bar = c[r.i]!, pos = (bar.c - bar.l) / Math.max(Number.EPSILON, bar.h - bar.l); return Math.abs(bar.c - bar.o) >= .5 * r.atr && (selectedSide === "LONG" ? pos >= .75 : pos <= .25); },
  };
  filters.structure_plus_reclaim = (r) => filters.bullish_bearish_structure(r) && filters.EMA20_reclaim(r);
  filters.break_plus_extreme = (r) => filters.previous_high_low_break(r) && filters.body_outer_25(r);
  const phase3 = Object.entries(filters).map(([name, gate]) => { const trades = entered.filter(gate).map((r) => tradeResult(selectedSide, c[r.i]!, c.slice(r.i + 1, r.i + 4), r.atr)); const m = metrics(trades.map((x) => x.r)); return { filter: name, ...m, TP: trades.filter((x) => x.exit === "TP").length, SL: trades.filter((x) => x.exit === "SL").length, TIME: trades.filter((x) => x.exit === "TIME").length, robust: m.N >= 30 }; });
  return { pair, data: { from: new Date(FROM).toISOString(), until: new Date(UNTIL).toISOString(), candles: c.filter((x) => x.t >= FROM).length, source: "OANDA Practice H1 midpoint, completed candles" }, phase1: { primary: clusters[0], secondary: clusters[1], allClusters: clusters }, phase2: { selectedModel: selectedModel.name, selectedSide, models: modelRows }, phase3, safeguards: { atr: "Wilder ATR14 frozen at origin", entry: "origin completed H1 close", future: "next three completed contiguous H1 bars", sameBar: "stop first", maxHold: "third future H1 close", timezone: "UTC" } };
}
const results = [];
for (const pair of PAIRS) { console.log(`AUDIT ${pair}: collecting and running frozen phases`); results.push(await run(pair)); }
const artifact = { generatedAt: new Date().toISOString(), purpose: "PIPELINE_REGRESSION_AUDIT", controls: results, note: "Historical answers were not present in selection code; comparison is a separate human/post-run step." };
fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify(artifact, null, 2));
