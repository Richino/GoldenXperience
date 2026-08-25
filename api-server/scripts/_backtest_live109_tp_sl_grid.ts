/**
 * TP/SL grid on the 109 closed+resolved LIVE paper trades (batches 1-8).
 * RESEARCH ONLY. Same entries/directions the live engine took. For each of 49
 * (TP × SL) combos in R units, re-resolve every trade using cached OANDA M15
 * bid/ask candles for the trade's window. Same rules as the legacy grid:
 *   R = original structural stop distance per trade (SL from DB row).
 *   Cost = actual entry-bar spread (spread_pips / stop_pips) charged in R.
 *   Forced-close = 16:45 ET / 48h horizon.
 *   Same-bar TP+SL touch → ambiguous (excluded).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const OUT_DIR = path.join(serviceRoot, "..", "backtest-live109-tp-sl-grid");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const CACHE_DIR = path.join(OUT_DIR, "candles");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const TP_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;
const SL_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;
const FORCED_CLOSE_ET_HOUR = 16;
const FORCED_CLOSE_ET_MIN = 45;
const HORIZON_HOURS = 48;
const REACH_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

type Row = {
  id: string; batch: number; family: string | null; instrument: string; direction: "long" | "short";
  decision_time: string; entry: string; stop: string; target: string;
  outcome: string; result_r: string | null; spread_pips: string | null;
};

const rows = await query<Row>(
  `SELECT t.id, b.batch_number AS batch, t.strategy_family AS family,
          t.instrument, t.direction, t.decision_time,
          t.entry::text, t.stop::text, t.target::text, t.outcome,
          t.result_r::text, t.spread_pips::text
     FROM paper_strategy_trades t JOIN paper_strategy_batches b ON b.id = t.batch_id
    WHERE t.status = 'closed' AND t.result_r IS NOT NULL
    ORDER BY t.decision_time, t.trade_sequence`);
console.log(`loaded ${rows.rows.length} live trades`);

type Entry = {
  id: string; batch: number; family: string; pair: string; direction: "long" | "short";
  decisionTime: string; entry: number; stop: number; targetOrig: number;
  spreadPips: number; sessionHourEt: number;
};

const entries: Entry[] = rows.rows.map((r) => ({
  id: r.id, batch: r.batch, family: r.family ?? "(legacy-null)", pair: r.instrument, direction: r.direction,
  decisionTime: r.decision_time, entry: Number(r.entry), stop: Number(r.stop), targetOrig: Number(r.target),
  spreadPips: r.spread_pips ? Number(r.spread_pips) : 1.5,
  sessionHourEt: 0, // filled below
}));

function pipSize(inst: string): number { return inst.endsWith("JPY") ? 0.01 : 0.0001; }
function etHour(iso: string): number {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
for (const e of entries) e.sessionHourEt = etHour(e.decisionTime);

// ---- fetch candles ----
type Q = {
  closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};
async function fetchPage(inst: string, fromIso: string): Promise<Q[]> {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=M15&count=5000&from=${encodeURIComponent(fromIso)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`  FETCH FAIL ${inst} ${r.status}`); return []; }
  const j = await r.json() as { candles?: Array<Record<string, never>> };
  return (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
    const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    return {
      closeTime: new Date(Date.parse(x.time) + 15 * 60_000).toISOString(),
      bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
      askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
    };
  });
}
async function fetchAll(inst: string, fromIso: string, toIso: string): Promise<Q[]> {
  const cache = path.join(CACHE_DIR, `${inst}.json`);
  if (existsSync(cache)) {
    const c = JSON.parse(readFileSync(cache, "utf8")) as { from: string; to: string; bars: Q[] };
    if (c.from === fromIso && c.to === toIso) return c.bars;
  }
  const out: Q[] = [];
  let cur = fromIso;
  const toMs = Date.parse(toIso);
  for (let p = 0; p < 10; p++) {
    const b = await fetchPage(inst, cur);
    if (b.length === 0) break;
    out.push(...b);
    const lastMs = Date.parse(b[b.length - 1]!.closeTime);
    if (lastMs >= toMs || b.length < 5000) break;
    cur = new Date(lastMs + 60_000).toISOString();
  }
  writeFileSync(cache, JSON.stringify({ from: fromIso, to: toIso, bars: out }));
  return out;
}

const pairs = [...new Set(entries.map((e) => e.pair))];
const earliestMs = Math.min(...entries.map((e) => Date.parse(e.decisionTime))) - 2 * 3600e3;
const latestMs = Math.max(...entries.map((e) => Date.parse(e.decisionTime))) + 72 * 3600e3;
const fromIso = new Date(earliestMs).toISOString();
const toIso = new Date(latestMs).toISOString();
console.log(`fetching M15 bid/ask for ${pairs.length} pairs, ${fromIso} → ${toIso}`);

const seriesByPair: Record<string, Q[]> = {};
const timesByPair: Record<string, Float64Array> = {};
const forcedFlagByPair: Record<string, Uint8Array> = {};
for (const p of pairs) {
  const bars = await fetchAll(p, fromIso, toIso);
  seriesByPair[p] = bars;
  const t = new Float64Array(bars.length);
  const fc = new Uint8Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    t[i] = Date.parse(bars[i]!.closeTime);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(t[i]!));
    const h = Number(parts.find((x) => x.type === "hour")?.value ?? "0") % 24;
    const m = Number(parts.find((x) => x.type === "minute")?.value ?? "0");
    fc[i] = (h === FORCED_CLOSE_ET_HOUR && m === FORCED_CLOSE_ET_MIN) ? 1 : 0;
  }
  timesByPair[p] = t;
  forcedFlagByPair[p] = fc;
  console.log(`  ${p}: ${bars.length} bars`);
}

function binarySearchGT(arr: Float64Array, target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m]! <= target) lo = m + 1; else hi = m; }
  return lo === arr.length ? -1 : lo;
}

const preEntry = entries.map((e) => {
  const oneR = Math.abs(e.entry - e.stop);
  const decMs = Date.parse(e.decisionTime);
  const t = timesByPair[e.pair]!;
  const startIdx = binarySearchGT(t, decMs);
  const horMs = decMs + HORIZON_HOURS * 3600e3;
  const costR = oneR > 0 ? e.spreadPips * pipSize(e.pair) / oneR : 0;
  return { pair: e.pair, dir: e.direction, startIdx, decMs, horMs, entry: e.entry, oneR, costR };
});

type OutcomeKind = "target" | "stop" | "forced" | "horizon" | "ambiguous";
interface ResolveResult {
  outcome: OutcomeKind; resultR: number; ambiguous: boolean; mfeR: number; maeR: number;
  reached: Record<string, boolean>; exitAt: string;
}

function resolveFast(idx: number, tpR: number, slR: number): ResolveResult {
  const p = preEntry[idx]!;
  const dir = p.dir;
  const oneR = p.oneR;
  const stop = dir === "long" ? p.entry - slR * oneR : p.entry + slR * oneR;
  const target = dir === "long" ? p.entry + tpR * oneR : p.entry - tpR * oneR;
  const series = seriesByPair[p.pair]!;
  const times = timesByPair[p.pair]!;
  const forced = forcedFlagByPair[p.pair]!;
  const reached: Record<string, boolean> = {};
  for (const lv of REACH_LEVELS) reached[String(lv)] = false;
  if (p.startIdx < 0) return { outcome: "horizon", resultR: 0, ambiguous: false, mfeR: 0, maeR: 0, reached, exitAt: new Date(p.horMs).toISOString() };
  const end = series.length;
  const horMs = p.horMs;
  let mfe = 0, mae = 0;
  for (let i = p.startIdx; i < end; i++) {
    if (times[i]! > horMs) break;
    const b = series[i]!;
    const favHigh = dir === "long" ? b.bidHigh : b.askHigh;
    const favLow = dir === "long" ? b.bidLow : b.askLow;
    const favR = (dir === "long" ? (favHigh - p.entry) : (p.entry - favLow)) / oneR;
    const advR = (dir === "long" ? (p.entry - favLow) : (favHigh - p.entry)) / oneR;
    if (favR > mfe) mfe = favR;
    if (advR > mae) mae = advR;
    for (const lv of REACH_LEVELS) if (favR >= lv) reached[String(lv)] = true;
    const targetHit = dir === "long" ? b.bidHigh >= target : b.askLow <= target;
    const stopHit = dir === "long" ? b.bidLow <= stop : b.askHigh >= stop;
    if (targetHit && stopHit) return { outcome: "ambiguous", resultR: 0, ambiguous: true, mfeR: mfe, maeR: -mae, reached, exitAt: b.closeTime };
    if (targetHit) return { outcome: "target", resultR: tpR, ambiguous: false, mfeR: mfe, maeR: -mae, reached, exitAt: b.closeTime };
    if (stopHit) return { outcome: "stop", resultR: -slR, ambiguous: false, mfeR: mfe, maeR: -mae, reached, exitAt: b.closeTime };
    if (forced[i]) {
      const closeMid = (b.bidClose + b.askClose) / 2;
      const rClose = dir === "long" ? (closeMid - p.entry) / oneR : (p.entry - closeMid) / oneR;
      return { outcome: "forced", resultR: rClose, ambiguous: false, mfeR: mfe, maeR: -mae, reached, exitAt: b.closeTime };
    }
  }
  let last = -1;
  for (let i = p.startIdx; i < end; i++) { if (times[i]! > horMs) break; last = i; }
  const exitAt = last >= 0 ? series[last]!.closeTime : new Date(horMs).toISOString();
  const closeMid = last >= 0 ? (series[last]!.bidClose + series[last]!.askClose) / 2 : p.entry;
  const rClose = dir === "long" ? (closeMid - p.entry) / oneR : (p.entry - closeMid) / oneR;
  return { outcome: "horizon", resultR: rClose, ambiguous: false, mfeR: mfe, maeR: -mae, reached, exitAt };
}

// ---- aggregators identical to legacy grid ----
type ComboAgg = {
  tp: number; sl: number;
  n: number; wins: number; losses: number; flats: number; ambiguous: number;
  target: number; stop: number; forced: number; horizon: number;
  grossR: number; netR: number; sumWinR: number; sumLossR: number;
  sumMfe: number; sumMae: number; forcedSumR: number;
  reachedCount: Record<string, number>;
  perTrade: { pair: string; family: string; batch: number; session: string; r: number; net: number; amb: boolean; ts: string; mfe: number }[];
};

function empty(tp: number, sl: number): ComboAgg {
  return { tp, sl, n: 0, wins: 0, losses: 0, flats: 0, ambiguous: 0,
    target: 0, stop: 0, forced: 0, horizon: 0, grossR: 0, netR: 0,
    sumWinR: 0, sumLossR: 0, sumMfe: 0, sumMae: 0, forcedSumR: 0,
    reachedCount: Object.fromEntries(REACH_LEVELS.map((l) => [String(l), 0])),
    perTrade: [] };
}

function summarize(a: ComboAgg) {
  const nRes = a.n - a.ambiguous;
  const wr = nRes ? a.wins / nRes : 0;
  const avgWin = a.wins ? a.sumWinR / a.wins : 0;
  const avgLoss = a.losses ? a.sumLossR / a.losses : 0;
  const beWr = (avgWin - avgLoss) > 0 ? -avgLoss / (avgWin - avgLoss) : NaN;
  const pf = a.sumLossR < 0 ? a.sumWinR / Math.abs(a.sumLossR) : Infinity;
  const expNet = nRes ? a.netR / nRes : 0;
  const expGross = nRes ? a.grossR / nRes : 0;
  const seq = [...a.perTrade].filter((p) => !p.amb).sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  let cum = 0, peak = 0, dd = 0;
  for (const t of seq) { cum += t.net; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  return { nRes, wr, beWr, gapPp: (wr - beWr) * 100, avgWin, avgLoss, pf, expGross, expNet, dd,
    avgMfe: a.n ? a.sumMfe / a.n : 0, avgMae: a.n ? a.sumMae / a.n : 0,
    forcedAvgR: a.forced ? a.forcedSumR / a.forced : 0 };
}

function bySlice(a: ComboAgg, key: (p: ComboAgg["perTrade"][number]) => string) {
  const m = new Map<string, { n: number; sumR: number; sumNet: number; wins: number; losses: number }>();
  for (const p of a.perTrade) {
    if (p.amb) continue;
    const k = key(p);
    const c = m.get(k) ?? { n: 0, sumR: 0, sumNet: 0, wins: 0, losses: 0 };
    c.n++; c.sumR += p.r; c.sumNet += p.net;
    if (p.r > 0) c.wins++; else if (p.r < 0) c.losses++;
    m.set(k, c);
  }
  return m;
}

const allIdx = entries.map((_, i) => i);
const grid: ComboAgg[] = [];
for (const tp of TP_LEVELS) for (const sl of SL_LEVELS) {
  const a = empty(tp, sl);
  for (const idx of allIdx) {
    const e = entries[idx]!;
    a.n++;
    const res = resolveFast(idx, tp, sl);
    const cost = preEntry[idx]!.costR;
    const netR = res.resultR - cost;
    a.grossR += res.resultR; a.netR += netR;
    a.sumMfe += res.mfeR; a.sumMae += res.maeR;
    if (res.ambiguous) a.ambiguous++;
    else if (res.resultR > 0) { a.wins++; a.sumWinR += res.resultR; }
    else if (res.resultR < 0) { a.losses++; a.sumLossR += res.resultR; }
    else a.flats++;
    if (res.outcome === "target") a.target++;
    else if (res.outcome === "stop") a.stop++;
    else if (res.outcome === "forced") { a.forced++; a.forcedSumR += res.resultR; }
    else if (res.outcome === "horizon") a.horizon++;
    for (const lv of REACH_LEVELS) if (res.reached[String(lv)]) a.reachedCount[String(lv)]++;
    a.perTrade.push({ pair: e.pair, family: e.family, batch: e.batch, session: e.sessionHourEt < 8 ? "London" : "London/NY overlap", r: res.resultR, net: netR, amb: res.ambiguous, ts: e.decisionTime, mfe: res.mfeR });
  }
  grid.push(a);
}

// --- print grids ---
function printMatrix(title: string, fn: (a: ComboAgg) => string) {
  console.log(`\n=== ${title} ===`);
  console.log("            SL→   " + SL_LEVELS.map((s) => `${s.toFixed(2)}R`.padStart(9)).join(""));
  for (const tp of TP_LEVELS) {
    const row = [`TP ${tp.toFixed(2)}R  `];
    for (const sl of SL_LEVELS) row.push(fn(grid.find((g) => g.tp === tp && g.sl === sl)!).padStart(9));
    console.log(row.join(""));
  }
}
printMatrix("NET EXPECTANCY R/trade", (a) => { const s = summarize(a); return (s.expNet >= 0 ? "+" : "") + s.expNet.toFixed(4) + "R"; });
printMatrix("PROFIT FACTOR", (a) => { const s = summarize(a); return Number.isFinite(s.pf) ? s.pf.toFixed(3) : "inf"; });
printMatrix("WIN RATE %", (a) => { const s = summarize(a); return (100 * s.wr).toFixed(1); });
printMatrix("MAX DRAWDOWN R", (a) => summarize(a).dd.toFixed(2));
printMatrix("AMBIGUOUS COUNT", (a) => String(a.ambiguous));
printMatrix("TOTAL NET R", (a) => (a.netR >= 0 ? "+" : "") + a.netR.toFixed(2));

// --- top 10 ---
function rankKey(a: ComboAgg): [number, number, number, number] {
  const s = summarize(a);
  return [-s.expNet, -(Number.isFinite(s.pf) ? s.pf : 0), s.dd, -(a.n - a.ambiguous)];
}
function cmp4(a: readonly [number, number, number, number], b: readonly [number, number, number, number]) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
const ranked = [...grid].sort((x, y) => cmp4(rankKey(x), rankKey(y)));
console.log(`\n=== TOP 10 CONFIGS (netExp → PF → maxDD → sample) ===`);
console.log("  TP    SL    n    win%  BEwr%  gap    netExp   totalR  PF     maxDD  amb  targ%  stop%  forc%  hor%");
for (const a of ranked.slice(0, 10)) {
  const s = summarize(a);
  console.log(
    `  ${a.tp.toFixed(2)}  ${a.sl.toFixed(2)}  ${String(a.n).padStart(3)}  ${(100 * s.wr).toFixed(1).padStart(4)}  ${(100 * s.beWr).toFixed(1).padStart(4)}  ${(s.gapPp >= 0 ? "+" : "") + s.gapPp.toFixed(1)}  ${(s.expNet >= 0 ? "+" : "") + s.expNet.toFixed(4)}  ${(a.netR >= 0 ? "+" : "") + a.netR.toFixed(2).padStart(5)}  ${(Number.isFinite(s.pf) ? s.pf.toFixed(3) : "inf").padStart(5)}  ${s.dd.toFixed(2).padStart(5)}  ${String(a.ambiguous).padStart(3)}  ${(100 * a.target / a.n).toFixed(1).padStart(4)}  ${(100 * a.stop / a.n).toFixed(1).padStart(4)}  ${(100 * a.forced / a.n).toFixed(1).padStart(4)}  ${(100 * a.horizon / a.n).toFixed(1).padStart(4)}`,
  );
}

// --- best config: per family, per pair, per session ---
const best = ranked[0]!;
console.log(`\n=== BEST CONFIG (TP ${best.tp.toFixed(2)}R / SL ${best.sl.toFixed(2)}R) SLICES ===`);
console.log("  BY FAMILY");
const byF = bySlice(best, (p) => p.family);
for (const [k, s] of [...byF].sort((a, b) => (b[1].sumNet / b[1].n) - (a[1].sumNet / a[1].n))) {
  console.log(`    ${k.padEnd(14)} n=${String(s.n).padStart(3)}  W=${String(s.wins).padStart(2)}/L=${String(s.losses).padStart(2)}  netR=${(s.sumNet >= 0 ? "+" : "") + s.sumNet.toFixed(2).padStart(6)}  exp/trade=${(s.sumNet / s.n >= 0 ? "+" : "") + (s.sumNet / s.n).toFixed(4)}R`);
}
console.log("  BY BATCH");
const byB = bySlice(best, (p) => String(p.batch));
for (const [k, s] of [...byB].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`    batch ${k.padEnd(3)} n=${String(s.n).padStart(3)}  W=${String(s.wins).padStart(2)}/L=${String(s.losses).padStart(2)}  netR=${(s.sumNet >= 0 ? "+" : "") + s.sumNet.toFixed(2).padStart(6)}  exp/trade=${(s.sumNet / s.n >= 0 ? "+" : "") + (s.sumNet / s.n).toFixed(4)}R`);
}
console.log("  BY PAIR");
const byP = bySlice(best, (p) => p.pair);
for (const [k, s] of [...byP].sort((a, b) => (b[1].sumNet / b[1].n) - (a[1].sumNet / a[1].n))) {
  console.log(`    ${k.padEnd(8)} n=${String(s.n).padStart(3)}  W=${String(s.wins).padStart(2)}/L=${String(s.losses).padStart(2)}  netR=${(s.sumNet >= 0 ? "+" : "") + s.sumNet.toFixed(2).padStart(6)}  exp/trade=${(s.sumNet / s.n >= 0 ? "+" : "") + (s.sumNet / s.n).toFixed(4)}R`);
}
console.log("  BY SESSION");
const byS = bySlice(best, (p) => p.session);
for (const [k, s] of byS) {
  console.log(`    ${k.padEnd(20)} n=${String(s.n).padStart(3)}  W=${String(s.wins).padStart(2)}/L=${String(s.losses).padStart(2)}  netR=${(s.sumNet >= 0 ? "+" : "") + s.sumNet.toFixed(2).padStart(6)}  exp/trade=${(s.sumNet / s.n >= 0 ? "+" : "") + (s.sumNet / s.n).toFixed(4)}R`);
}

// --- MFE distribution (reached-R %) for best config ---
console.log(`\n=== MFE reach (%) — best config on all 109 trades ===`);
for (const lv of REACH_LEVELS) {
  const pct = (100 * best.reachedCount[String(lv)] / best.n);
  console.log(`  reached ≥ ${lv}R:  ${pct.toFixed(1)}%`);
}
console.log(`  avg MFE = ${(best.sumMfe / best.n).toFixed(3)}R   avg MAE = ${(best.sumMae / best.n).toFixed(3)}R`);

// --- per-family grid summary (best TP/SL per family) ---
console.log(`\n=== BEST CONFIG PER STRATEGY FAMILY ===`);
const families = [...new Set(entries.map((e) => e.family))];
for (const fam of families) {
  const idxs = allIdx.filter((i) => entries[i]!.family === fam);
  if (idxs.length < 5) { console.log(`  ${fam} (n=${idxs.length}) — too small`); continue; }
  let bestFam: { tp: number; sl: number; net: number; wr: number; n: number } | null = null;
  for (const tp of TP_LEVELS) for (const sl of SL_LEVELS) {
    let net = 0, w = 0, l = 0, amb = 0;
    for (const idx of idxs) {
      const res = resolveFast(idx, tp, sl);
      const cost = preEntry[idx]!.costR;
      if (res.ambiguous) { amb++; continue; }
      net += res.resultR - cost;
      if (res.resultR > 0) w++; else if (res.resultR < 0) l++;
    }
    const nRes = idxs.length - amb;
    const expNet = nRes ? net / nRes : 0;
    if (!bestFam || expNet > bestFam.net / bestFam.n) bestFam = { tp, sl, net, wr: nRes ? 100 * w / nRes : 0, n: nRes };
  }
  const bf = bestFam!;
  console.log(`  ${fam.padEnd(14)}  best TP=${bf.tp.toFixed(2)}R SL=${bf.sl.toFixed(2)}R  n=${bf.n}  winrate=${bf.wr.toFixed(1)}%  netR=${(bf.net >= 0 ? "+" : "") + bf.net.toFixed(2)}  exp/trade=${(bf.net / bf.n >= 0 ? "+" : "") + (bf.net / bf.n).toFixed(4)}R`);
}

writeFileSync(path.join(OUT_DIR, "grid_live109.json"), JSON.stringify(grid.map((a) => {
  const s = summarize(a);
  return {
    tp: a.tp, sl: a.sl, n: a.n, ambiguous: a.ambiguous, wins: a.wins, losses: a.losses,
    winrate_pct: +(100 * s.wr).toFixed(2), be_wr_pct: Number.isNaN(s.beWr) ? "n/a" : +(100 * s.beWr).toFixed(2),
    gap_pp: Number.isNaN(s.gapPp) ? "n/a" : +s.gapPp.toFixed(2),
    grossR: +a.grossR.toFixed(3), netR: +a.netR.toFixed(3),
    exp_gross_R: +s.expGross.toFixed(4), exp_net_R: +s.expNet.toFixed(4),
    pf: Number.isFinite(s.pf) ? +s.pf.toFixed(3) : "inf", maxDD_R: +s.dd.toFixed(3),
    avg_MFE_R: +s.avgMfe.toFixed(3), avg_MAE_R: +s.avgMae.toFixed(3),
    target_pct: +(100 * a.target / a.n).toFixed(1), stop_pct: +(100 * a.stop / a.n).toFixed(1),
    forced_pct: +(100 * a.forced / a.n).toFixed(1), horizon_pct: +(100 * a.horizon / a.n).toFixed(1),
    forced_avg_R: +s.forcedAvgR.toFixed(3),
    ...Object.fromEntries(REACH_LEVELS.map((lv) => [`reached_${lv}R_%`, +(100 * a.reachedCount[String(lv)] / a.n).toFixed(1)])),
  };
}), null, 1));
console.log(`\nwrote grid_live109.json under ${OUT_DIR}`);
process.exit(0);
