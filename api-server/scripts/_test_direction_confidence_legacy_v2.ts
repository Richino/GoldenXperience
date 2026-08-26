/**
 * Direction-confidence v2 — orthogonal features.
 *
 * v1 lesson: features that mirror the setup filter (h1Slope, h4Slope, emaDist)
 * collapse into "always invert or always agree." v2 uses features that vary
 * INDEPENDENTLY of the EMA-stack direction so the model has real signal to work
 * with.
 *
 * Feature set (7 features):
 *   Regime (direction-independent, magnitude only):
 *     f1 atrPct        — 500-bar percentile rank of ATR14 (0..1)
 *     f2 atrRatio      — ATR14 / ATR50 (vol expansion/contraction)
 *     f3 hourEt        — hour of day, ET (0..23) — one-hot-ish via cosine? just raw
 *     f4 dayOfWeek     — 0..4 (Mon..Fri)
 *   Orthogonal direction features (carry direction info not encoded by setup):
 *     f5 rsiVelocity   — (rsi[i] - rsi[i-3]) / 3
 *     f6 rangePos      — (close - low_20) / (high_20 - low_20), 0..1
 *     f7 mom3          — (close_t - close_t-3) / close_t
 *
 * Loads dataset via DATASET env (default backtest-legacy-expanded).
 * Same 70/30 chronological IS/OOS split as v1.
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
const DATASET = process.env.DATASET ?? "backtest-legacy-expanded";
const TRADES_JSON = process.env.TRADES_JSON ?? path.join(REPO_ROOT, DATASET, "trades.json");
const CACHE_DIR = process.env.CACHE_DIR ?? path.join(REPO_ROOT, DATASET, "candles");
const OUT_DIR = process.env.OUT_DIR ?? path.join(serviceRoot, "research-v2", `legacy-direction-confidence-v2-${DATASET}`);
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
  for (let page = 0; page < 80; page++) {
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

function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}

function etDay(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
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

type Feat = {
  pair: string; decisionTime: string; ts: number;
  direction: "long" | "short"; resultR: number;
  atrPct: number; atrRatio: number; hourEt: number; dayOfWeek: number;
  rsiVelocity: number; rangePos: number; mom3: number;
};
const feats: Feat[] = [];

const rankPercentile = (arr: number[], value: number): number => {
  // fraction of arr <= value (arr assumed non-empty, may contain NaN — caller filters)
  let count = 0;
  for (const v of arr) if (v <= value) count++;
  return count / arr.length;
};

for (const pair of PAIRS) {
  console.log(`\n--- ${pair} ---`);
  const m15 = await fetchAll(pair, "M15", fromIso, toIso);
  // no H1/H4 needed for v2 features, but ensure trades match the M15 series

  const closes = m15.map((b) => b.close);
  const a14 = atr(m15, 14);
  const a50 = atr(m15, 50);
  const r14 = rsi(closes, 14);

  const pairTrades = trades.filter((t) => t.pair === pair);
  let matched = 0, missed = 0;
  for (const t of pairTrades) {
    const i = idxAtOrBefore(m15, t.decisionTime);
    if (i < 500) { missed++; continue; }

    const atr14V = a14[i]!;
    const atr50V = a50[i]!;
    const closeV = closes[i]!;
    const rsiV = r14[i]!;
    const rsiPrev = r14[i - 3];
    const closePrev3 = closes[i - 3];
    if (![atr14V, atr50V, closeV, rsiV, rsiPrev, closePrev3].every((x) => Number.isFinite(x as number))) { missed++; continue; }

    // atr percentile over trailing 500 bars
    const atrHist = a14.slice(Math.max(0, i - 500), i).filter((v) => Number.isFinite(v));
    if (atrHist.length < 100) { missed++; continue; }
    const atrPct = rankPercentile(atrHist, atr14V);

    const atrRatio = atr14V / atr50V;

    // 20-bar range position
    const rangeWin = m15.slice(Math.max(0, i - 20), i);
    const rangeHi = Math.max(...rangeWin.map((b) => b.high));
    const rangeLo = Math.min(...rangeWin.map((b) => b.low));
    const rangePos = rangeHi > rangeLo ? (closeV - rangeLo) / (rangeHi - rangeLo) : 0.5;

    const rsiVelocity = (rsiV - (rsiPrev as number)) / 3;
    const mom3 = (closeV - (closePrev3 as number)) / closeV;

    feats.push({
      pair, decisionTime: t.decisionTime, ts: Date.parse(t.decisionTime),
      direction: t.direction, resultR: t.resultR!,
      atrPct, atrRatio,
      hourEt: etHour(t.decisionTime),
      dayOfWeek: etDay(t.decisionTime),
      rsiVelocity, rangePos, mom3,
    });
    matched++;
  }
  console.log(`  matched ${matched}, missed ${missed}`);
}

feats.sort((a, b) => a.ts - b.ts);
console.log(`\ntotal feature rows: ${feats.length}`);

function longWon(f: Feat): 1 | 0 {
  const longRes = f.direction === "long" ? f.resultR : -f.resultR;
  return longRes > 0 ? 1 : 0;
}

const FEATURE_NAMES = ["atrPct", "atrRatio", "hourEt", "dayOfWeek", "rsiVelocity", "rangePos", "mom3"] as const;
const getVec = (f: Feat): number[] => [f.atrPct, f.atrRatio, f.hourEt, f.dayOfWeek, f.rsiVelocity, f.rangePos, f.mom3];

const splitIdx = Math.floor(feats.length * 0.7);
const IS = feats.slice(0, splitIdx);
const OOS = feats.slice(splitIdx);
console.log(`IS: ${IS.length}   OOS: ${OOS.length}`);

const K = FEATURE_NAMES.length;
const mean = new Array(K).fill(0).map((_, k) => IS.reduce((s, f) => s + getVec(f)[k]!, 0) / IS.length);
const std = new Array(K).fill(0).map((_, k) => {
  const m = mean[k]!;
  const v = IS.reduce((s, f) => s + (getVec(f)[k]! - m) ** 2, 0) / IS.length;
  return Math.sqrt(v) || 1;
});
const scale = (f: Feat): number[] => getVec(f).map((v, k) => (v - mean[k]!) / std[k]!);

// Long-baseline rate on IS — if labels are severely imbalanced, model just predicts majority
const isLongWonRate = IS.filter((f) => longWon(f) === 1).length / IS.length;
console.log(`IS baseline P(long wins): ${(100 * isLongWonRate).toFixed(1)}%`);

const w = new Array(K).fill(0);
let b = 0;
const lr = 0.05;
const epochs = 600;
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

type Scored = { f: Feat; pLong: number; picked: "long" | "short"; matchedTrade: boolean; impliedR: number };
const scored: Scored[] = OOS.map((f) => {
  const x = scale(f);
  const pLong = sigmoid(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
  const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
  const matched = picked === f.direction;
  const impliedR = matched ? f.resultR : -f.resultR;
  return { f, pLong, picked, matchedTrade: matched, impliedR };
});

const baselineTotalR = OOS.reduce((s, f) => s + f.resultR, 0);
const baselineWinrate = 100 * OOS.filter((f) => f.resultR > 0).length / OOS.length;
const modelTotalR = scored.reduce((s, x) => s + x.impliedR, 0);
const modelWinrate = 100 * scored.filter((x) => x.impliedR > 0).length / scored.length;
const disagree = 100 * scored.filter((x) => !x.matchedTrade).length / scored.length;

console.log(`\n=== OOS OVERALL (n=${OOS.length}) ===`);
console.log(`  baseline (EMA-stack pick): winrate=${baselineWinrate.toFixed(1)}%  totalR=${baselineTotalR.toFixed(2)}  expR=${(baselineTotalR / OOS.length).toFixed(3)}`);
console.log(`  model (P>=0.5 pick):       winrate=${modelWinrate.toFixed(1)}%  totalR=${modelTotalR.toFixed(2)}  expR=${(modelTotalR / OOS.length).toFixed(3)}`);
console.log(`  disagreement rate: ${disagree.toFixed(1)}%`);

console.log(`\n=== OOS CALIBRATION ===`);
const buckets = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.001]];
for (const [lo, hi] of buckets) {
  const rows = scored.filter((x) => x.pLong >= lo && x.pLong < hi);
  if (!rows.length) continue;
  const actualLongWon = rows.filter((x) => longWon(x.f) === 1).length / rows.length;
  const avgP = rows.reduce((s, x) => s + x.pLong, 0) / rows.length;
  console.log(`  P in [${lo.toFixed(2)},${hi.toFixed(2)})  n=${String(rows.length).padStart(3)}  avgP=${avgP.toFixed(3)}  actualLongWonPct=${(100 * actualLongWon).toFixed(1)}%`);
}

console.log(`\n=== OOS EXPECTED R BY CONFIDENCE THRESHOLD ===`);
console.log(`  threshold  taken  winrate  totalR    expR/trade`);
for (const t of [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40]) {
  const rows = scored.filter((x) => Math.abs(x.pLong - 0.5) >= t);
  if (!rows.length) { console.log(`  ${t.toFixed(2)}       0`); continue; }
  const wins = rows.filter((x) => x.impliedR > 0).length;
  const total = rows.reduce((s, x) => s + x.impliedR, 0);
  console.log(`  ${t.toFixed(2)}       ${String(rows.length).padStart(4)}   ${(100 * wins / rows.length).toFixed(1).padStart(5)}%  ${total >= 0 ? "+" : ""}${total.toFixed(2).padStart(7)}  ${(total / rows.length).toFixed(3).padStart(7)}`);
}

const summary = {
  generated: new Date().toISOString(),
  featureNames: [...FEATURE_NAMES],
  mean, std, weights: w, bias: b,
  is: { n: IS.length, from: IS[0]?.decisionTime, to: IS[IS.length - 1]?.decisionTime },
  oos: { n: OOS.length, from: OOS[0]?.decisionTime, to: OOS[OOS.length - 1]?.decisionTime },
  overall: {
    baselineTotalR, baselineWinrate, modelTotalR, modelWinrate, disagreementPct: disagree,
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
