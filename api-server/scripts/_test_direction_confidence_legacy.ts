/**
 * Direction-confidence v1 test on the 421 legacy backtest entries.
 *
 * RESEARCH ONLY. No DB writes. No paper engine impact.
 *
 * Loads the pre-computed 421 legacy entries from backtest-legacy-batch1/trades.json
 * (each row has decisionTime + actual resultR from labelOutcome), refetches the
 * OANDA M15/H1/H4 cache the original backtest used, computes 5 direction-vote
 * features at each decision bar, trains a logistic regression on the first 70%
 * (chronological), tests on the last 30%, and reports accuracy + expected R
 * across confidence buckets.
 *
 * Ground truth: side that would have "won" this entry =
 *   actualDirection if resultR > 0 else opposite side.
 *
 * If the model's picked side matches the trade's own direction, impliedR = resultR;
 * otherwise impliedR = -resultR (rough EV proxy — assumes symmetric TP/SL flip).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
process.env.NODE_ENV = "production";

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";

const REPO_ROOT = path.resolve(serviceRoot, "..");
const DATASET = process.env.DATASET ?? "backtest-legacy-batch1";
const TRADES_JSON = process.env.TRADES_JSON ?? path.join(REPO_ROOT, DATASET, "trades.json");
const CACHE_DIR = process.env.CACHE_DIR ?? path.join(REPO_ROOT, DATASET, "candles");
const OUT_DIR = process.env.OUT_DIR ?? path.join(serviceRoot, "research-v2", `legacy-direction-confidence-${DATASET}`);
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

const GRAN_MIN: Record<string, number> = { M15: 15, H1: 60, H4: 240 };

async function fetchPage(inst: string, gran: string, fromIso: string): Promise<Q[]> {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=${gran}&count=5000&from=${encodeURIComponent(fromIso)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`  FETCH FAIL ${inst} ${gran} ${r.status}`); return []; }
  const j = await r.json() as { candles?: Array<Record<string, never>> };
  const step = GRAN_MIN[gran]! * 60_000;
  return (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
    const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    const mid = (b: number, a: number) => (b + a) / 2;
    return {
      closeTime: new Date(Date.parse(x.time) + step).toISOString(),
      open: mid(+x.bid.o, +x.ask.o), high: mid(+x.bid.h, +x.ask.h), low: mid(+x.bid.l, +x.ask.l), close: mid(+x.bid.c, +x.ask.c),
      bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
      askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
    };
  });
}

async function fetchAll(inst: string, gran: string, fromIso: string, toIso: string): Promise<Q[]> {
  const cache = path.join(CACHE_DIR, `${inst}_${gran}.json`);
  if (existsSync(cache)) {
    const cached = JSON.parse(readFileSync(cache, "utf8")) as { from: string; to: string; bars: Q[] };
    if (cached.from === fromIso && cached.to === toIso) { console.log(`  ${inst} ${gran}: ${cached.bars.length} bars (cached)`); return cached.bars; }
  }
  const out: Q[] = [];
  let cursor = fromIso;
  const toMs = Date.parse(toIso);
  for (let page = 0; page < 60; page++) {
    const batch = await fetchPage(inst, gran, cursor);
    if (batch.length === 0) break;
    out.push(...batch);
    const lastMs = Date.parse(batch[batch.length - 1]!.closeTime);
    if (lastMs >= toMs || batch.length < 5000) break;
    cursor = new Date(lastMs + 60_000).toISOString();
  }
  writeFileSync(cache, JSON.stringify({ from: fromIso, to: toIso, bars: out }));
  console.log(`  ${inst} ${gran}: ${out.length} bars fetched`);
  return out;
}

function ema(values: number[], period: number): number[] {
  const out: number[] = []; if (!values.length) return out;
  const k = 2 / (period + 1);
  let e = values[0]!; out.push(e);
  for (let i = 1; i < values.length; i++) { e = values[i]! * k + e * (1 - k); out.push(e); }
  return out;
}

function atr(bars: Q[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  const trs: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) { trs[i] = b.high - b.low; continue; }
    const p = bars[i - 1]!;
    trs[i] = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i]!;
  if (trs.length >= period) {
    let a = sum / period;
    out[period - 1] = a;
    for (let i = period; i < trs.length; i++) { a = (a * (period - 1) + trs[i]!) / period; out[i] = a; }
  }
  return out;
}

function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const up = d > 0 ? d : 0; const dn = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + up) / period;
    loss = (loss * (period - 1) + dn) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function idxAtOrBefore(bars: Q[], iso: string): number {
  const t = Date.parse(iso);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

// ---- load ground truth ----
type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  entry: number; stop: number; target: number;
  atrPips: number; rsi: number; sessionHourEt: number;
  outcome: string; resultR: number | null;
};
const raw = JSON.parse(readFileSync(TRADES_JSON, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));
console.log(`loaded ${trades.length} resolved trades from ${TRADES_JSON}`);

const PAIRS = [...new Set(trades.map((t) => t.pair))];
const fromIso = new Date(Math.min(...trades.map((t) => Date.parse(t.decisionTime))) - 400 * 86400e3).toISOString();
const toIso = new Date(Math.max(...trades.map((t) => Date.parse(t.decisionTime))) + 86400e3).toISOString();
console.log(`pairs: ${PAIRS.join(", ")}`);
console.log(`candle range: ${fromIso} → ${toIso}`);

// ---- per-pair feature extraction ----
type Feat = {
  pair: string;
  decisionTime: string;
  ts: number;
  direction: "long" | "short";
  resultR: number;
  // features
  h1Slope: number;   // (h1_e21 - h1_e50) / close
  h4Slope: number;   // (h4_e21 - h4_e50) / close
  rsiSide: number;   // (rsi - 50) / 50
  mom3: number;      // (close_t - close_t-3) / close_t
  emaDist: number;   // (close - ema200) / atr
};
const feats: Feat[] = [];

for (const pair of PAIRS) {
  console.log(`\n--- ${pair} ---`);
  const m15 = await fetchAll(pair, "M15", fromIso, toIso);
  const h1 = await fetchAll(pair, "H1", fromIso, toIso);
  const h4 = await fetchAll(pair, "H4", fromIso, toIso);

  const c15 = m15.map((b) => b.close);
  const e200 = ema(c15, 200);
  const a14 = atr(m15, 14);
  const r14 = rsi(c15, 14);

  const c1 = h1.map((b) => b.close); const h1e21 = ema(c1, 21); const h1e50 = ema(c1, 50);
  const c4 = h4.map((b) => b.close); const h4e21 = ema(c4, 21); const h4e50 = ema(c4, 50);

  const pairTrades = trades.filter((t) => t.pair === pair);
  let matched = 0, missed = 0;
  for (const t of pairTrades) {
    const i15 = idxAtOrBefore(m15, t.decisionTime);
    if (i15 < 210) { missed++; continue; }
    const i1 = idxAtOrBefore(h1, t.decisionTime);
    const i4 = idxAtOrBefore(h4, t.decisionTime);
    if (i1 < 50 || i4 < 50) { missed++; continue; }

    const close = c15[i15]!;
    const atrV = a14[i15]!;
    const e200V = e200[i15]!;
    const rsiV = r14[i15]!;
    if (![close, atrV, e200V, rsiV].every((x) => Number.isFinite(x))) { missed++; continue; }

    const closePrev3 = c15[i15 - 3];
    if (closePrev3 === undefined) { missed++; continue; }

    const h1Slope = (h1e21[i1]! - h1e50[i1]!) / close;
    const h4Slope = (h4e21[i4]! - h4e50[i4]!) / close;
    const rsiSide = (rsiV - 50) / 50;
    const mom3 = (close - closePrev3) / close;
    const emaDist = (close - e200V) / atrV;

    feats.push({
      pair, decisionTime: t.decisionTime, ts: Date.parse(t.decisionTime),
      direction: t.direction, resultR: t.resultR!,
      h1Slope, h4Slope, rsiSide, mom3, emaDist,
    });
    matched++;
  }
  console.log(`  matched ${matched}, missed ${missed}`);
}

feats.sort((a, b) => a.ts - b.ts);
console.log(`\ntotal feature rows: ${feats.length}`);

// Ground-truth label: "long won?" — 1 if actual long resultR>0 or short resultR<0
function longWon(f: Feat): 1 | 0 {
  const longRes = f.direction === "long" ? f.resultR : -f.resultR;
  return longRes > 0 ? 1 : 0;
}

const FEATURE_NAMES = ["h1Slope", "h4Slope", "rsiSide", "mom3", "emaDist"] as const;
const getVec = (f: Feat): number[] => [f.h1Slope, f.h4Slope, f.rsiSide, f.mom3, f.emaDist];

// ---- split IS/OOS chronologically 70/30 ----
const splitIdx = Math.floor(feats.length * 0.7);
const IS = feats.slice(0, splitIdx);
const OOS = feats.slice(splitIdx);
console.log(`IS: ${IS.length}   OOS: ${OOS.length}`);

// ---- standardize on IS ----
const mean = FEATURE_NAMES.map((_, k) => IS.reduce((s, f) => s + getVec(f)[k]!, 0) / IS.length);
const std = FEATURE_NAMES.map((_, k) => {
  const m = mean[k]!;
  const v = IS.reduce((s, f) => s + (getVec(f)[k]! - m) ** 2, 0) / IS.length;
  return Math.sqrt(v) || 1;
});
const scale = (f: Feat): number[] => getVec(f).map((v, k) => (v - mean[k]!) / std[k]!);

// ---- logistic regression on IS ----
const K = FEATURE_NAMES.length;
const w = new Array(K).fill(0);
let b = 0;
const lr = 0.05;
const epochs = 400;
const l2 = 0.001;

function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)); }

for (let ep = 0; ep < epochs; ep++) {
  const grads = new Array(K).fill(0);
  let gb = 0;
  for (const f of IS) {
    const x = scale(f);
    const y = longWon(f);
    const p = sigmoid(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
    const err = p - y;
    for (let k = 0; k < K; k++) grads[k] += err * x[k]!;
    gb += err;
  }
  for (let k = 0; k < K; k++) w[k] = w[k]! - lr * (grads[k]! / IS.length + l2 * w[k]!);
  b = b - lr * (gb / IS.length);
}
console.log(`\ntrained weights:`);
FEATURE_NAMES.forEach((n, k) => console.log(`  ${n}: ${w[k]!.toFixed(4)}`));
console.log(`  bias: ${b.toFixed(4)}`);

// ---- score OOS ----
type Scored = { f: Feat; pLong: number; picked: "long" | "short"; matchedTrade: boolean; impliedR: number };
const scored: Scored[] = OOS.map((f) => {
  const x = scale(f);
  const pLong = sigmoid(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
  const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
  const matched = picked === f.direction;
  const impliedR = matched ? f.resultR : -f.resultR;
  return { f, pLong, picked, matchedTrade: matched, impliedR };
});

// Baseline: keep the original EMA-stack pick (= f.direction), impliedR = resultR
const baselineTotalR = OOS.reduce((s, f) => s + f.resultR, 0);
const baselineWinrate = 100 * OOS.filter((f) => f.resultR > 0).length / OOS.length;

// Model
const modelTotalR = scored.reduce((s, x) => s + x.impliedR, 0);
const modelWinrate = 100 * scored.filter((x) => x.impliedR > 0).length / scored.length;

console.log(`\n=== OOS OVERALL (n=${OOS.length}) ===`);
console.log(`  baseline (EMA-stack pick): winrate=${baselineWinrate.toFixed(1)}%  totalR=${baselineTotalR.toFixed(2)}  expR=${(baselineTotalR / OOS.length).toFixed(3)}`);
console.log(`  model (P>=0.5 pick):       winrate=${modelWinrate.toFixed(1)}%  totalR=${modelTotalR.toFixed(2)}  expR=${(modelTotalR / OOS.length).toFixed(3)}`);
console.log(`  disagreement rate: ${(100 * scored.filter((x) => !x.matchedTrade).length / scored.length).toFixed(1)}%`);

// ---- calibration by prob bucket ----
console.log(`\n=== OOS CALIBRATION (predicted P(long wins) vs actual) ===`);
const buckets = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.001]];
for (const [lo, hi] of buckets) {
  const rows = scored.filter((x) => x.pLong >= lo && x.pLong < hi);
  if (!rows.length) continue;
  const actualLongWon = rows.filter((x) => longWon(x.f) === 1).length / rows.length;
  const avgP = rows.reduce((s, x) => s + x.pLong, 0) / rows.length;
  console.log(`  P in [${lo.toFixed(2)},${hi.toFixed(2)})  n=${String(rows.length).padStart(3)}  avgP=${avgP.toFixed(3)}  actualLongWonPct=${(100 * actualLongWon).toFixed(1)}%`);
}

// ---- expected R by confidence threshold ----
console.log(`\n=== OOS EXPECTED R BY CONFIDENCE THRESHOLD (|P-0.5| >= t) ===`);
console.log(`  threshold  taken  winrate  totalR  expR/trade`);
for (const t of [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40]) {
  const rows = scored.filter((x) => Math.abs(x.pLong - 0.5) >= t);
  if (!rows.length) { console.log(`  ${t.toFixed(2)}       0`); continue; }
  const wins = rows.filter((x) => x.impliedR > 0).length;
  const total = rows.reduce((s, x) => s + x.impliedR, 0);
  console.log(`  ${t.toFixed(2)}       ${String(rows.length).padStart(4)}   ${(100 * wins / rows.length).toFixed(1).padStart(5)}%  ${total >= 0 ? "+" : ""}${total.toFixed(2).padStart(7)}  ${(total / rows.length).toFixed(3).padStart(7)}`);
}

// ---- write full dump ----
const summary = {
  generated: new Date().toISOString(),
  featureNames: [...FEATURE_NAMES],
  mean, std, weights: w, bias: b,
  is: { n: IS.length, from: IS[0]?.decisionTime, to: IS[IS.length - 1]?.decisionTime },
  oos: { n: OOS.length, from: OOS[0]?.decisionTime, to: OOS[OOS.length - 1]?.decisionTime },
  overall: {
    baselineTotalR, baselineWinrate,
    modelTotalR, modelWinrate,
    disagreementPct: 100 * scored.filter((x) => !x.matchedTrade).length / scored.length,
  },
  oosRows: scored.map((x) => ({
    pair: x.f.pair, decisionTime: x.f.decisionTime, actualDirection: x.f.direction,
    actualResultR: x.f.resultR, pLong: x.pLong, picked: x.picked, impliedR: x.impliedR,
  })),
};
const outPath = path.join(OUT_DIR, "RESULTS.json");
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`\nwrote ${outPath}`);

process.exit(0);
