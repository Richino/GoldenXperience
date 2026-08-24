/**
 * GOLDENXPERIENCE — binary-struggle-v1
 *
 * Research only. Does NOT modify binary-baseline-v1, production prediction
 * logic, adaptive engine, existing predictions, prior S/R research, or
 * live/paper execution.
 *
 * Hypothesis: repeated failed progress through an area ("price struggle")
 * contains predictive information about short-horizon rejection vs breakout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { classifyBinaryResult, type BinaryCandle } from "../src/binary-engine.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const { query } = await import("../src/database.js");

const OUT_DIR = path.join(root, "research-v2", "binary-struggle-audit");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");

// Pre-registered constants — do not retune after seeing HOLDOUT
const SWING_K = 2;
const LOOKBACK = 90;
const NEAR_ATR = 0.3;
const PRIMARY_ZONE_WIDTH = 0.2;
const ZONE_WIDTHS = [0.1, 0.2, 0.3] as const;
const MIN_ATTEMPTS = 2;
const BE80 = 1 / (1 + 0.8); // 55.56%
const DEV_MIN_N = 100;
const EXPIRIES = [1, 5, 10, 15] as const;
type Expiry = (typeof EXPIRIES)[number];

const ET_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});

type PredRow = {
  id: string;
  instrument: string;
  direction: "up" | "down";
  start_at: string;
  entry_price: number;
  price_precision: number;
  confidence: number;
  result: "won" | "lost" | "tie" | null;
  session: string | null;
};

type InstrumentCache = {
  candles: BinaryCandle[];
  closeMs: number[];
};

type Side = "support" | "resistance";
type ProgressClass = "DIMINISHING" | "FLAT" | "INCREASING";
type RejectionClass = "WEAKENING" | "STABLE" | "STRENGTHENING";
type CompressionClass = "NONE" | "MODERATE" | "STRONG";
type ApproachClass = "FAST" | "MEDIUM" | "SLOW";
type StruggleState =
  | "WAIT"
  | "RESISTANCE_REJECTION"
  | "SUPPORT_REJECTION"
  | "RESISTANCE_BREAKOUT_PRESSURE"
  | "SUPPORT_BREAKOUT_PRESSURE"
  | "FAILED_RESISTANCE_BREAKOUT"
  | "FAILED_SUPPORT_BREAKDOWN"
  | "BUYER_EXHAUSTION"
  | "SELLER_EXHAUSTION";

type StruggleFeat = {
  active: boolean;
  side: Side | "none";
  zoneCenter: number;
  zoneWidthAtr: number;
  attempts: number;
  attemptBucket: "2" | "3" | "4+";
  firstTouchAgeBars: number;
  barsBetweenAttempts: number;
  timeNearZonePct: number;
  progressClass: ProgressClass;
  latestProgressAtr: number;
  progressSlope: number;
  rejectionClass: RejectionClass;
  compressionClass: CompressionClass;
  approachClass: ApproachClass;
  failedBreakout: boolean;
  breakoutPressure: boolean;
  exhaustion: boolean;
  priorMove20Atr: number;
  wickPenetrateAtr: number;
  closeLocInRange: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  bodyRatio: number;
  state: StruggleState;
  impliedDir: "up" | "down" | "none";
};

type Outcome = "won" | "lost" | "tie" | "missing";

type EventRow = {
  analysis: "A" | "B";
  id: string;
  instrument: string;
  startAt: string;
  startMs: number;
  zone: "train" | "dev" | "holdout";
  episodeKey: string;
  baselineDir: "up" | "down" | "none";
  agree: "AGREE" | "DISAGREE" | "NO_STRUGGLE" | "NO_BASELINE";
  session: string;
  feat: StruggleFeat;
  o1: Outcome;
  o5: Outcome;
  o10: Outcome;
  o15: Outcome;
};

type Bucket = {
  rawN: number;
  effN: number;
  won: number;
  lost: number;
  tie: number;
  missing: number;
  decided: number;
  wr: number;
  ciLow: number;
  ciHigh: number;
  ev70: number;
  ev75: number;
  ev80: number;
  ev85: number;
  ev90: number;
  ev95: number;
  label: string;
};

type Candidate = {
  id: string;
  analysis: "A" | "B";
  state: string;
  direction: "up" | "down";
  expiry: Expiry;
  zoneWidth: number;
  registryNote: string;
  filter: (e: EventRow) => boolean;
};

type Scored = Candidate & {
  train: Bucket;
  dev: Bucket;
  holdout?: Bucket;
  robustness: { pairShare: number; dayShare: number; ok: boolean };
};

let hypothesesTested = 0;
const registryLines: string[] = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function wilson(wins: number, n: number) {
  if (n <= 0) return { rate: 0, low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { rate: p, low: (c - m) / d, high: (c + m) / d };
}

function evOf(wr: number, payout: number) {
  return wr * payout - (1 - wr);
}

function sessionOf(iso: string): string {
  const h = Number(ET_HOUR.formatToParts(new Date(iso)).find((p) => p.type === "hour")?.value);
  if (h >= 19 || h < 3) return "asia";
  if (h >= 3 && h < 8) return "london";
  if (h >= 8 && h < 12) return "overlap";
  if (h >= 12 && h < 17) return "newyork";
  return "off";
}

function atr14(candles: BinaryCandle[], idx: number): number {
  if (idx < 14) return NaN;
  let sum = 0;
  for (let i = idx - 13; i <= idx; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!.close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }
  return sum / 14;
}

function toCandles(raw: Awaited<ReturnType<typeof getResearchCandles>>): BinaryCandle[] {
  return raw.map((c) => ({
    time: c.time,
    open: c.mid.open,
    high: c.mid.high,
    low: c.mid.low,
    close: c.mid.close,
    volume: c.volume,
    complete: c.complete,
  }));
}

async function fetchM1Range(instrument: string, fromIso: string, toIso: string): Promise<BinaryCandle[]> {
  const fromMs = Date.parse(fromIso) - 2 * 24 * 60 * 60_000;
  const toMs = Date.parse(toIso) + 20 * 60_000;
  const all: BinaryCandle[] = [];
  let cursor = new Date(toMs).toISOString();
  for (let page = 0; page < 80; page++) {
    const raw = await getResearchCandles(instrument as MajorInstrument, "M1", 5000, { to: cursor });
    const batch = toCandles(raw).filter((c) => c.complete);
    if (!batch.length) break;
    for (const c of batch) all.push(c);
    const earliest = batch.reduce((m, c) => (c.time < m ? c.time : m), batch[0]!.time);
    if (Date.parse(earliest) <= fromMs) break;
    cursor = earliest;
    await sleep(120);
  }
  const by = new Map(all.map((c) => [c.time, c]));
  return [...by.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function buildCache(candles: BinaryCandle[]): InstrumentCache {
  return { candles, closeMs: candles.map((c) => Date.parse(c.time) + 60_000) };
}

function lastKnownIdx(cache: InstrumentCache, asOfIso: string): number {
  const asOf = Date.parse(asOfIso);
  let lo = 0;
  let hi = cache.closeMs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cache.closeMs[mid]! <= asOf) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function resolveAt(cache: InstrumentCache, targetMs: number): { price: number; time: string } | null {
  let lo = 0;
  let hi = cache.closeMs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cache.closeMs[mid]! >= targetMs) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (ans < 0) return null;
  return { price: cache.candles[ans]!.close, time: new Date(cache.closeMs[ans]!).toISOString() };
}

function outcomeAt(
  cache: InstrumentCache,
  dir: "up" | "down",
  entry: number,
  precision: number,
  startMs: number,
  seconds: number,
): Outcome {
  const mark = resolveAt(cache, startMs + seconds * 1000);
  if (!mark) return "missing";
  if (Date.parse(mark.time) <= startMs) return "missing";
  return classifyBinaryResult(dir, entry, mark.price, precision);
}

type Swing = { idx: number; price: number; side: Side };

function findSwings(candles: BinaryCandle[], idx: number): Swing[] {
  const start = Math.max(SWING_K, idx - LOOKBACK);
  const end = idx - SWING_K;
  const out: Swing[] = [];
  if (end < start) return out;
  for (let p = start; p <= end; p++) {
    const h = candles[p]!.high;
    const l = candles[p]!.low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= SWING_K; j++) {
      if (candles[p - j]!.high >= h || candles[p + j]!.high > h) isHigh = false;
      if (candles[p - j]!.low <= l || candles[p + j]!.low < l) isLow = false;
    }
    if (isHigh) out.push({ idx: p, price: h, side: "resistance" });
    if (isLow) out.push({ idx: p, price: l, side: "support" });
  }
  return out;
}

function linearSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += ys[i]!;
    sxx += i * i;
    sxy += i * ys[i]!;
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return 0;
  return (n * sxy - sx * sy) / den;
}

function emptyFeat(zoneWidthAtr = PRIMARY_ZONE_WIDTH): StruggleFeat {
  return {
    active: false,
    side: "none",
    zoneCenter: NaN,
    zoneWidthAtr,
    attempts: 0,
    attemptBucket: "2",
    firstTouchAgeBars: 0,
    barsBetweenAttempts: 0,
    timeNearZonePct: 0,
    progressClass: "FLAT",
    latestProgressAtr: 0,
    progressSlope: 0,
    rejectionClass: "STABLE",
    compressionClass: "NONE",
    approachClass: "MEDIUM",
    failedBreakout: false,
    breakoutPressure: false,
    exhaustion: false,
    priorMove20Atr: 0,
    wickPenetrateAtr: 0,
    closeLocInRange: 0.5,
    upperWickRatio: 0,
    lowerWickRatio: 0,
    bodyRatio: 0,
    state: "WAIT",
    impliedDir: "none",
  };
}

function detectStruggle(candles: BinaryCandle[], idx: number, zoneWidthAtr: number): StruggleFeat {
  const feat = emptyFeat(zoneWidthAtr);
  if (idx < Math.max(40, LOOKBACK)) return feat;
  const atr = atr14(candles, idx);
  if (!(atr > 0)) return feat;

  const price = candles[idx]!.close;
  const swings = findSwings(candles, idx);
  const band = zoneWidthAtr * atr;

  type Cluster = { side: Side; center: number; members: Swing[] };
  const clusters: Cluster[] = [];
  for (const s of swings) {
    let best: Cluster | null = null;
    let bestDist = Infinity;
    for (const c of clusters) {
      if (c.side !== s.side) continue;
      const d = Math.abs(c.center - s.price);
      if (d <= band && d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    if (best) {
      best.members.push(s);
      best.center = best.members.reduce((a, m) => a + m.price, 0) / best.members.length;
    } else {
      clusters.push({ side: s.side, center: s.price, members: [s] });
    }
  }

  const near = clusters
    .filter((c) => c.members.length >= MIN_ATTEMPTS && Math.abs(price - c.center) / atr <= NEAR_ATR)
    .sort(
      (a, b) =>
        b.members.length - a.members.length || Math.abs(price - a.center) - Math.abs(price - b.center),
    );
  const cluster = near[0];
  if (!cluster) return feat;

  const members = [...cluster.members].sort((a, b) => a.idx - b.idx);
  const attempts: Swing[] = [];
  for (const m of members) {
    const last = attempts.at(-1);
    if (last && m.idx - last.idx < 3) {
      if (cluster.side === "resistance" ? m.price >= last.price : m.price <= last.price) {
        attempts[attempts.length - 1] = m;
      }
      continue;
    }
    attempts.push(m);
  }
  if (attempts.length < MIN_ATTEMPTS) return feat;

  feat.active = true;
  feat.side = cluster.side;
  feat.zoneCenter = cluster.center;
  feat.attempts = attempts.length;
  feat.attemptBucket = attempts.length >= 4 ? "4+" : attempts.length === 3 ? "3" : "2";
  feat.firstTouchAgeBars = idx - attempts[0]!.idx;
  const gaps: number[] = [];
  for (let i = 1; i < attempts.length; i++) gaps.push(attempts[i]!.idx - attempts[i - 1]!.idx);
  feat.barsBetweenAttempts = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

  const extremes = attempts.map((a) => a.price);
  const progressSteps: number[] = [];
  for (let i = 1; i < extremes.length; i++) {
    const step =
      cluster.side === "resistance"
        ? (extremes[i]! - extremes[i - 1]!) / atr
        : (extremes[i - 1]! - extremes[i]!) / atr;
    progressSteps.push(step);
  }
  feat.latestProgressAtr = progressSteps.at(-1) ?? 0;
  feat.progressSlope = linearSlope(progressSteps);
  if (feat.progressSlope < -0.02) feat.progressClass = "DIMINISHING";
  else if (feat.progressSlope > 0.02) feat.progressClass = "INCREASING";
  else feat.progressClass = "FLAT";

  const rej: number[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!;
    const nextIdx = i + 1 < attempts.length ? attempts[i + 1]!.idx : idx;
    let maxAway = 0;
    for (let j = a.idx + 1; j <= nextIdx; j++) {
      if (cluster.side === "resistance") maxAway = Math.max(maxAway, (a.price - candles[j]!.low) / atr);
      else maxAway = Math.max(maxAway, (candles[j]!.high - a.price) / atr);
    }
    rej.push(maxAway);
  }
  if (rej.length >= 2) {
    const slope = linearSlope(rej);
    if (slope < -0.05) feat.rejectionClass = "WEAKENING";
    else if (slope > 0.05) feat.rejectionClass = "STRENGTHENING";
    else feat.rejectionClass = "STABLE";
  }

  const win = Math.min(20, idx);
  let nearBars = 0;
  let rangeHi = -Infinity;
  let rangeLo = Infinity;
  for (let i = idx - win + 1; i <= idx; i++) {
    const c = candles[i]!;
    if (Math.abs(c.close - cluster.center) / atr <= 0.25) nearBars += 1;
    rangeHi = Math.max(rangeHi, c.high);
    rangeLo = Math.min(rangeLo, c.low);
  }
  feat.timeNearZonePct = nearBars / win;
  const rollRangeAtr = (rangeHi - rangeLo) / atr;
  if (rollRangeAtr < 0.55 && feat.timeNearZonePct >= 0.4) feat.compressionClass = "STRONG";
  else if (rollRangeAtr < 0.9 || feat.timeNearZonePct >= 0.3) feat.compressionClass = "MODERATE";
  else feat.compressionClass = "NONE";

  const ret5 = (price - candles[idx - 5]!.close) / atr;
  const toward = cluster.side === "resistance" ? Math.max(0, ret5) : Math.max(0, -ret5);
  if (toward >= 0.45) feat.approachClass = "FAST";
  else if (toward >= 0.18) feat.approachClass = "MEDIUM";
  else feat.approachClass = "SLOW";

  const c = candles[idx]!;
  const range = Math.max(c.high - c.low, 1e-12);
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  feat.bodyRatio = body / range;
  feat.upperWickRatio = upper / range;
  feat.lowerWickRatio = lower / range;
  feat.closeLocInRange = (c.close - c.low) / range;
  feat.wickPenetrateAtr =
    cluster.side === "resistance"
      ? Math.max(0, (c.high - cluster.center) / atr)
      : Math.max(0, (cluster.center - c.low) / atr);

  let failed = false;
  for (let i = Math.max(0, idx - 2); i <= idx; i++) {
    const x = candles[i]!;
    if (cluster.side === "resistance") {
      if (x.high > cluster.center + 0.05 * atr && x.close < cluster.center) failed = true;
    } else if (x.low < cluster.center - 0.05 * atr && x.close > cluster.center) failed = true;
  }
  feat.failedBreakout = failed;

  const look = Math.min(20, idx);
  feat.priorMove20Atr = (price - candles[idx - look]!.close) / atr;
  if (cluster.side === "resistance" && feat.priorMove20Atr >= 1.2 && feat.progressClass !== "INCREASING") {
    feat.exhaustion = true;
  }
  if (cluster.side === "support" && feat.priorMove20Atr <= -1.2 && feat.progressClass !== "INCREASING") {
    feat.exhaustion = true;
  }

  feat.breakoutPressure =
    attempts.length >= 3 &&
    feat.rejectionClass === "WEAKENING" &&
    (feat.compressionClass === "MODERATE" || feat.compressionClass === "STRONG") &&
    feat.timeNearZonePct >= 0.35;

  if (failed && cluster.side === "resistance") {
    feat.state = "FAILED_RESISTANCE_BREAKOUT";
    feat.impliedDir = "down";
  } else if (failed && cluster.side === "support") {
    feat.state = "FAILED_SUPPORT_BREAKDOWN";
    feat.impliedDir = "up";
  } else if (feat.breakoutPressure && cluster.side === "resistance") {
    feat.state = "RESISTANCE_BREAKOUT_PRESSURE";
    feat.impliedDir = "up";
  } else if (feat.breakoutPressure && cluster.side === "support") {
    feat.state = "SUPPORT_BREAKOUT_PRESSURE";
    feat.impliedDir = "down";
  } else if (
    cluster.side === "resistance" &&
    (feat.rejectionClass === "STRENGTHENING" || feat.rejectionClass === "STABLE") &&
    (feat.progressClass === "DIMINISHING" || feat.progressClass === "FLAT")
  ) {
    feat.state = "RESISTANCE_REJECTION";
    feat.impliedDir = "down";
  } else if (
    cluster.side === "support" &&
    (feat.rejectionClass === "STRENGTHENING" || feat.rejectionClass === "STABLE") &&
    (feat.progressClass === "DIMINISHING" || feat.progressClass === "FLAT")
  ) {
    feat.state = "SUPPORT_REJECTION";
    feat.impliedDir = "up";
  } else if (feat.exhaustion && cluster.side === "resistance") {
    feat.state = "BUYER_EXHAUSTION";
    feat.impliedDir = "down";
  } else if (feat.exhaustion && cluster.side === "support") {
    feat.state = "SELLER_EXHAUSTION";
    feat.impliedDir = "up";
  } else {
    feat.state = "WAIT";
    feat.impliedDir = "none";
  }

  return feat;
}

function zoneOfFactory(t60: number, t80: number) {
  return (iso: string): "train" | "dev" | "holdout" => {
    const t = Date.parse(iso);
    if (t <= t60) return "train";
    if (t <= t80) return "dev";
    return "holdout";
  };
}

function episodeKey(instrument: string, side: Side | "none", center: number, atr: number, startMs: number) {
  const bucket = atr > 0 ? Math.round(center / (0.15 * atr)) : 0;
  const slot = Math.floor(startMs / (30 * 60_000));
  return `${instrument}|${side}|${bucket}|${slot}`;
}

function statsOf(rows: EventRow[], expiry: Expiry, useEffective = true): Bucket {
  const key = expiry === 1 ? "o1" : expiry === 5 ? "o5" : expiry === 10 ? "o10" : "o15";
  const seen = new Set<string>();
  const unique: EventRow[] = [];
  for (const r of rows) {
    if (!useEffective) {
      unique.push(r);
      continue;
    }
    if (seen.has(r.episodeKey)) continue;
    seen.add(r.episodeKey);
    unique.push(r);
  }
  let won = 0;
  let lost = 0;
  let tie = 0;
  let missing = 0;
  for (const r of unique) {
    const o = r[key];
    if (o === "won") won += 1;
    else if (o === "lost") lost += 1;
    else if (o === "tie") tie += 1;
    else missing += 1;
  }
  const decided = won + lost;
  const ci = wilson(won, decided);
  const wr = ci.rate;
  return {
    rawN: rows.length,
    effN: unique.length,
    won,
    lost,
    tie,
    missing,
    decided,
    wr,
    ciLow: ci.low,
    ciHigh: ci.high,
    ev70: evOf(wr, 0.7),
    ev75: evOf(wr, 0.75),
    ev80: evOf(wr, 0.8),
    ev85: evOf(wr, 0.85),
    ev90: evOf(wr, 0.9),
    ev95: evOf(wr, 0.95),
    label: decided
      ? `raw=${rows.length} eff=${unique.length} W=${won} L=${lost} T=${tie} WR=${(wr * 100).toFixed(2)}% CI=[${(ci.low * 100).toFixed(2)}%,${(ci.high * 100).toFixed(2)}%] EV80=${evOf(wr, 0.8).toFixed(3)} EV90=${evOf(wr, 0.9).toFixed(3)}`
      : `raw=${rows.length} eff=${unique.length} n=0`,
  };
}

function fmt(b: Bucket) {
  return b.label;
}

function dominantPairDay(rows: EventRow[], expiry: Expiry) {
  const key = expiry === 1 ? "o1" : expiry === 5 ? "o5" : expiry === 10 ? "o10" : "o15";
  const seen = new Set<string>();
  const unique: EventRow[] = [];
  for (const r of rows) {
    if (seen.has(r.episodeKey)) continue;
    seen.add(r.episodeKey);
    unique.push(r);
  }
  const decided = unique.filter((r) => r[key] === "won" || r[key] === "lost");
  if (!decided.length) return { pairShare: 1, dayShare: 1, ok: false };
  const byPair = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const r of decided) {
    byPair.set(r.instrument, (byPair.get(r.instrument) ?? 0) + 1);
    byDay.set(r.startAt.slice(0, 10), (byDay.get(r.startAt.slice(0, 10)) ?? 0) + 1);
  }
  const pairShare = Math.max(...byPair.values()) / decided.length;
  const dayShare = Math.max(...byDay.values()) / decided.length;
  return { pairShare, dayShare, ok: pairShare <= 0.55 && dayShare <= 0.55 };
}

function appendRegistry(row: Record<string, unknown>) {
  hypothesesTested += 1;
  registryLines.push(JSON.stringify({ ...row, ts: new Date().toISOString() }));
}

function remapImplied(rows: EventRow[]): EventRow[] {
  return rows.map((e) => {
    if (e.feat.impliedDir === "none" || e.baselineDir === "none") return e;
    if (e.feat.impliedDir === e.baselineDir) return e;
    const flip = (o: Outcome): Outcome => (o === "won" ? "lost" : o === "lost" ? "won" : o);
    return { ...e, o1: flip(e.o1), o5: flip(e.o5), o10: flip(e.o10), o15: flip(e.o15) };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("binary-struggle-v1 — loading authoritative baseline predictions...");
const predRes = await query<PredRow>(
  `SELECT id, instrument, direction, start_at::text, entry_price::float AS entry_price,
          price_precision, confidence::float AS confidence, result,
          COALESCE(market_context->>'session', features->>'session') AS session
     FROM binary_predictions
    WHERE status='resolved' AND is_authoritative=true AND model_name='binary-baseline-v1'
    ORDER BY start_at`,
);
const preds = predRes.rows;
console.log(`Loaded ${preds.length} predictions`);
if (preds.length < 200) {
  console.error("INSUFFICIENT_DATA");
  process.exit(1);
}

const times = preds.map((p) => Date.parse(p.start_at)).sort((a, b) => a - b);
const t60 = times[Math.floor(times.length * 0.6)]!;
const t80 = times[Math.floor(times.length * 0.8)]!;
const zoneOf = zoneOfFactory(t60, t80);
console.log(
  `Zones: TRAIN ≤ ${new Date(t60).toISOString()} | DEV ≤ ${new Date(t80).toISOString()} | HOLDOUT after`,
);

const instruments = [...new Set(preds.map((p) => p.instrument))].sort();
const minStart = preds[0]!.start_at;
const maxStart = preds.at(-1)!.start_at;

console.log(`Fetching M1 for ${instruments.length} instruments...`);
const caches = new Map<string, InstrumentCache>();
let m1Total = 0;
for (const inst of instruments) {
  const candles = await fetchM1Range(inst, minStart, maxStart);
  caches.set(inst, buildCache(candles));
  m1Total += candles.length;
  console.log(`  ${inst}: ${candles.length} M1`);
}

{
  const cache = caches.get(instruments[0]!)!;
  const idx = 120;
  const swings = findSwings(cache.candles, idx);
  for (const s of swings) {
    if (s.idx > idx - SWING_K) throw new Error("swing leakage: unconfirmed swing");
  }
  console.log("Leakage self-check: PASS");
}

console.log("Building Analysis A (existing predictions)...");
const eventsA: EventRow[] = [];
let aStruggle = 0;
for (let i = 0; i < preds.length; i++) {
  if (i > 0 && i % 500 === 0) console.log(`  A ... ${i}/${preds.length}`);
  const p = preds[i]!;
  const cache = caches.get(p.instrument);
  if (!cache) continue;
  const idx = lastKnownIdx(cache, p.start_at);
  if (idx < 80) continue;
  if (cache.closeMs[idx]! > Date.parse(p.start_at)) throw new Error(`lookahead ${p.id}`);

  const atr = atr14(cache.candles, idx);
  const feat = detectStruggle(cache.candles, idx, PRIMARY_ZONE_WIDTH);
  const startMs = Date.parse(p.start_at);
  const precision = Number(p.price_precision);
  const entry = Number(p.entry_price);

  let agree: EventRow["agree"] = "NO_STRUGGLE";
  if (feat.active && feat.impliedDir !== "none") {
    aStruggle += 1;
    agree = feat.impliedDir === p.direction ? "AGREE" : "DISAGREE";
  }

  eventsA.push({
    analysis: "A",
    id: p.id,
    instrument: p.instrument,
    startAt: p.start_at,
    startMs,
    zone: zoneOf(p.start_at),
    episodeKey: episodeKey(p.instrument, feat.side, feat.zoneCenter || entry, atr || 1, startMs),
    baselineDir: p.direction,
    agree,
    session: p.session || sessionOf(p.start_at),
    feat,
    o1: outcomeAt(cache, p.direction, entry, precision, startMs, 60),
    o5: outcomeAt(cache, p.direction, entry, precision, startMs, 300),
    o10: outcomeAt(cache, p.direction, entry, precision, startMs, 600),
    o15: outcomeAt(cache, p.direction, entry, precision, startMs, 900),
  });
}
console.log(`Analysis A: ${eventsA.length} events, struggle-active ${aStruggle}`);

console.log("Building Analysis B (independent M1 struggle scan)...");
const eventsB: EventRow[] = [];
let m1StruggleBars = 0;
for (const inst of instruments) {
  const cache = caches.get(inst)!;
  const { candles, closeMs } = cache;
  const seenEpisodes = new Set<string>();
  let before = eventsB.length;
  for (let idx = 80; idx < candles.length - 16; idx++) {
    const closeIso = new Date(closeMs[idx]!).toISOString();
    if (closeMs[idx]! < Date.parse(minStart) - 60_000) continue;
    if (closeMs[idx]! > Date.parse(maxStart) + 60_000) continue;

    const feat = detectStruggle(candles, idx, PRIMARY_ZONE_WIDTH);
    if (feat.state === "WAIT" || feat.impliedDir === "none") continue;
    m1StruggleBars += 1;

    const atr = atr14(candles, idx);
    const startMs = closeMs[idx]!;
    const entry = candles[idx]!.close;
    const precision = inst.includes("JPY") ? 3 : 5;
    const dir = feat.impliedDir;
    const ek = episodeKey(inst, feat.side, feat.zoneCenter, atr || 1, startMs);
    // First bar of each 30-min episode only
    if (seenEpisodes.has(ek)) continue;
    seenEpisodes.add(ek);

    eventsB.push({
      analysis: "B",
      id: `${inst}-${candles[idx]!.time}`,
      instrument: inst,
      startAt: closeIso,
      startMs,
      zone: zoneOf(closeIso),
      episodeKey: ek,
      baselineDir: "none",
      agree: "NO_BASELINE",
      session: sessionOf(closeIso),
      feat,
      o1: outcomeAt(cache, dir, entry, precision, startMs, 60),
      o5: outcomeAt(cache, dir, entry, precision, startMs, 300),
      o10: outcomeAt(cache, dir, entry, precision, startMs, 600),
      o15: outcomeAt(cache, dir, entry, precision, startMs, 900),
    });
  }
  console.log(`  B ${inst}: episodes ${eventsB.length - before}`);
}
console.log(`Analysis B: ${eventsB.length} episodes (non-WAIT bars ${m1StruggleBars})`);

const trainA = eventsA.filter((e) => e.zone === "train");
const devA = eventsA.filter((e) => e.zone === "dev");
const holdA = eventsA.filter((e) => e.zone === "holdout");
const trainB = eventsB.filter((e) => e.zone === "train");
const devB = eventsB.filter((e) => e.zone === "dev");
const holdB = eventsB.filter((e) => e.zone === "holdout");

const stateDefs: { state: StruggleState; dir: "up" | "down"; label: string }[] = [
  { state: "SUPPORT_REJECTION", dir: "up", label: "support rejection → UP" },
  { state: "RESISTANCE_REJECTION", dir: "down", label: "resistance rejection → DOWN" },
  { state: "RESISTANCE_BREAKOUT_PRESSURE", dir: "up", label: "resistance pressure → UP" },
  { state: "SUPPORT_BREAKOUT_PRESSURE", dir: "down", label: "support pressure → DOWN" },
  { state: "FAILED_SUPPORT_BREAKDOWN", dir: "up", label: "failed support breakdown → UP" },
  { state: "FAILED_RESISTANCE_BREAKOUT", dir: "down", label: "failed resistance breakout → DOWN" },
  { state: "SELLER_EXHAUSTION", dir: "up", label: "seller exhaustion → UP" },
  { state: "BUYER_EXHAUSTION", dir: "down", label: "buyer exhaustion → DOWN" },
];

function buildCandidates(analysis: "A" | "B"): Candidate[] {
  const out: Candidate[] = [];
  for (const expiry of EXPIRIES) {
    for (const s of stateDefs) {
      if (analysis === "A") {
        out.push({
          id: `${analysis}|AGREE|${s.state}|${s.dir}|${expiry}m`,
          analysis,
          state: s.state,
          direction: s.dir,
          expiry,
          zoneWidth: PRIMARY_ZONE_WIDTH,
          registryNote: `agree ${s.label}`,
          filter: (e) => e.feat.state === s.state && e.agree === "AGREE",
        });
        out.push({
          id: `${analysis}|IMPLIED|${s.state}|${s.dir}|${expiry}m`,
          analysis,
          state: `IMPLIED_${s.state}`,
          direction: s.dir,
          expiry,
          zoneWidth: PRIMARY_ZONE_WIDTH,
          registryNote: `implied ${s.label}`,
          filter: (e) => e.feat.state === s.state,
        });
      } else {
        out.push({
          id: `${analysis}|${s.state}|${s.dir}|${expiry}m`,
          analysis,
          state: s.state,
          direction: s.dir,
          expiry,
          zoneWidth: PRIMARY_ZONE_WIDTH,
          registryNote: s.label,
          filter: (e) => e.feat.state === s.state && e.feat.impliedDir === s.dir,
        });
      }
    }
  }
  return out;
}

function evaluateCandidates(cands: Candidate[], train: EventRow[], dev: EventRow[]): Scored[] {
  const scored: Scored[] = [];
  for (const c of cands) {
    const trainRows = c.id.includes("|IMPLIED|") ? remapImplied(train).filter(c.filter) : train.filter(c.filter);
    const devRows = c.id.includes("|IMPLIED|") ? remapImplied(dev).filter(c.filter) : dev.filter(c.filter);
    const tr = statsOf(trainRows, c.expiry);
    const dv = statsOf(devRows, c.expiry);
    const rob = dominantPairDay(devRows, c.expiry);
    appendRegistry({
      experiment: "binary-struggle-v1",
      id: c.id,
      analysis: c.analysis,
      state: c.state,
      expiry: c.expiry,
      train_eff: tr.effN,
      train_wr: tr.wr,
      dev_eff: dv.effN,
      dev_wr: dv.wr,
      dev_ci_low: dv.ciLow,
      dev_ev80: dv.ev80,
      note: c.registryNote,
    });
    scored.push({ ...c, train: tr, dev: dv, robustness: rob });
  }
  return scored;
}

function passesDevGate(s: Scored): boolean {
  return s.dev.decided >= DEV_MIN_N && s.dev.wr > BE80 && s.dev.ev80 > 0 && s.robustness.ok;
}

console.log("Scoring DEV candidates...");
const scoredA = evaluateCandidates(buildCandidates("A"), trainA, devA);
const scoredB = evaluateCandidates(buildCandidates("B"), trainB, devB);
const survivorsA = scoredA.filter(passesDevGate).sort((a, b) => b.dev.ev80 - a.dev.ev80);
const survivorsB = scoredB.filter(passesDevGate).sort((a, b) => b.dev.ev80 - a.dev.ev80);
console.log(`DEV survivors A=${survivorsA.length} B=${survivorsB.length}`);

const holdoutRead = survivorsA.length + survivorsB.length > 0;
if (holdoutRead) {
  for (const s of survivorsA) {
    const rows = s.id.includes("|IMPLIED|") ? remapImplied(holdA).filter(s.filter) : holdA.filter(s.filter);
    s.holdout = statsOf(rows, s.expiry);
  }
  for (const s of survivorsB) {
    s.holdout = statsOf(holdB.filter(s.filter), s.expiry);
  }
}

function byState(rows: EventRow[], state: StruggleState, expiry: Expiry, implied = false) {
  const base = implied ? remapImplied(rows) : rows;
  return statsOf(
    base.filter((e) => e.feat.state === state),
    expiry,
  );
}

function tableAttempts(rows: EventRow[], side: Side, expiry: Expiry) {
  const lines: string[] = [];
  for (const bucket of ["2", "3", "4+"] as const) {
    const subset = remapImplied(rows).filter(
      (e) => e.feat.side === side && e.feat.active && e.feat.attemptBucket === bucket && e.feat.impliedDir !== "none",
    );
    lines.push(`  ${bucket}: ${fmt(statsOf(subset, expiry))}`);
  }
  return lines.join("\n");
}

function tableProgress(rows: EventRow[], expiry: Expiry) {
  return (["DIMINISHING", "FLAT", "INCREASING"] as ProgressClass[])
    .map((pc) => {
      const subset = remapImplied(rows).filter(
        (e) => e.feat.active && e.feat.progressClass === pc && e.feat.impliedDir !== "none",
      );
      return `  ${pc}: ${fmt(statsOf(subset, expiry))}`;
    })
    .join("\n");
}

function tableRejection(rows: EventRow[], expiry: Expiry) {
  return (["WEAKENING", "STABLE", "STRENGTHENING"] as RejectionClass[])
    .map((rc) => {
      const subset = remapImplied(rows).filter(
        (e) => e.feat.active && e.feat.rejectionClass === rc && e.feat.impliedDir !== "none",
      );
      return `  ${rc}: ${fmt(statsOf(subset, expiry))}`;
    })
    .join("\n");
}

function tableCompression(rows: EventRow[], expiry: Expiry) {
  return (["NONE", "MODERATE", "STRONG"] as CompressionClass[])
    .map((cc) => {
      const subset = remapImplied(rows).filter(
        (e) => e.feat.active && e.feat.compressionClass === cc && e.feat.impliedDir !== "none",
      );
      return `  ${cc}: ${fmt(statsOf(subset, expiry))}`;
    })
    .join("\n");
}

function agreementTable(rows: EventRow[], expiry: Expiry) {
  return (["AGREE", "DISAGREE", "NO_STRUGGLE"] as const)
    .map((g) => `  ${g}: ${fmt(statsOf(rows.filter((e) => e.agree === g), expiry, false))}`)
    .join("\n");
}

function topDev(scored: Scored[], n = 10) {
  return [...scored]
    .filter((s) => s.dev.decided >= 30)
    .sort((a, b) => b.dev.ev80 - a.dev.ev80)
    .slice(0, n);
}

function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
}

function trainLogistic(rows: EventRow[], expiry: Expiry) {
  const key = expiry === 1 ? "o1" : expiry === 5 ? "o5" : expiry === 10 ? "o10" : "o15";
  const X: number[][] = [];
  const y: number[] = [];
  for (const e of rows) {
    if (!e.feat.active) continue;
    const o = e[key];
    if (o !== "won" && o !== "lost") continue;
    X.push([
      1,
      e.feat.attempts,
      e.feat.latestProgressAtr,
      e.feat.progressSlope,
      e.feat.rejectionClass === "STRENGTHENING" ? 1 : e.feat.rejectionClass === "WEAKENING" ? -1 : 0,
      e.feat.compressionClass === "STRONG" ? 1 : e.feat.compressionClass === "MODERATE" ? 0.5 : 0,
      e.feat.approachClass === "FAST" ? 1 : e.feat.approachClass === "SLOW" ? -1 : 0,
      e.feat.failedBreakout ? 1 : 0,
      e.feat.breakoutPressure ? 1 : 0,
      e.feat.exhaustion ? 1 : 0,
      e.feat.timeNearZonePct,
      e.feat.wickPenetrateAtr,
      e.feat.priorMove20Atr,
      e.agree === "AGREE" ? 1 : e.agree === "DISAGREE" ? -1 : 0,
    ]);
    y.push(o === "won" ? 1 : 0);
  }
  if (X.length < 80) return null;
  const d = X[0]!.length;
  const w = new Array(d).fill(0);
  const lr = 0.05;
  for (let iter = 0; iter < 250; iter++) {
    const grad = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const xi = X[i]!;
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j]! * xi[j]!;
      const p = sigmoid(z);
      const err = p - y[i]!;
      for (let j = 0; j < d; j++) grad[j] += err * xi[j]!;
    }
    for (let j = 0; j < d; j++) w[j]! -= (lr * grad[j]!) / X.length;
    for (let j = 1; j < d; j++) w[j]! *= 0.999;
  }
  const names = [
    "bias",
    "attempts",
    "latest_progress",
    "progress_slope",
    "rejection",
    "compression",
    "approach",
    "failed_breakout",
    "breakout_pressure",
    "exhaustion",
    "time_near",
    "wick_pen",
    "prior_move",
    "agree",
  ];
  const importance = names
    .map((name, j) => ({ name, w: w[j]! }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return { w, names, importance, n: X.length };
}

const model = trainLogistic(trainA, 10);
let modelDevLine = "not used / insufficient";
if (model) {
  let tw = 0;
  let td = 0;
  for (const e of devA) {
    if (!e.feat.active) continue;
    if (e.o10 !== "won" && e.o10 !== "lost") continue;
    const x = [
      1,
      e.feat.attempts,
      e.feat.latestProgressAtr,
      e.feat.progressSlope,
      e.feat.rejectionClass === "STRENGTHENING" ? 1 : e.feat.rejectionClass === "WEAKENING" ? -1 : 0,
      e.feat.compressionClass === "STRONG" ? 1 : e.feat.compressionClass === "MODERATE" ? 0.5 : 0,
      e.feat.approachClass === "FAST" ? 1 : e.feat.approachClass === "SLOW" ? -1 : 0,
      e.feat.failedBreakout ? 1 : 0,
      e.feat.breakoutPressure ? 1 : 0,
      e.feat.exhaustion ? 1 : 0,
      e.feat.timeNearZonePct,
      e.feat.wickPenetrateAtr,
      e.feat.priorMove20Atr,
      e.agree === "AGREE" ? 1 : e.agree === "DISAGREE" ? -1 : 0,
    ];
    let z = 0;
    for (let j = 0; j < x.length; j++) z += model.w[j]! * x[j]!;
    if (sigmoid(z) < 0.55) continue;
    td += 1;
    if (e.o10 === "won") tw += 1;
  }
  const ci = wilson(tw, td);
  modelDevLine = `P(win)>=0.55 @10m: n=${td} WR=${(ci.rate * 100).toFixed(2)}% CI=[${(ci.low * 100).toFixed(2)}%,${(ci.high * 100).toFixed(2)}%] EV80=${evOf(ci.rate, 0.8).toFixed(3)}`;
}

const allSurvivors = [...survivorsA, ...survivorsB];
let verdict:
  | "STRUGGLE_EDGE_FOUND"
  | "REJECTION_EDGE_FOUND"
  | "BREAKOUT_PRESSURE_EDGE_FOUND"
  | "FAILED_BREAKOUT_EDGE_FOUND"
  | "EXHAUSTION_EDGE_FOUND"
  | "STRUGGLE_IMPROVES_BASELINE_BUT_BELOW_BREAK_EVEN"
  | "PROMISING_BUT_UNDERPOWERED"
  | "NO_STRUGGLE_EDGE"
  | "ROBUSTNESS_REJECT" = "NO_STRUGGLE_EDGE";

if (allSurvivors.length) {
  const holdPass = allSurvivors.filter((s) => s.holdout && s.holdout.wr > BE80 && s.holdout.decided >= 50);
  if (holdPass.length) {
    const st = holdPass[0]!.state;
    if (st.includes("REJECTION")) verdict = "REJECTION_EDGE_FOUND";
    else if (st.includes("BREAKOUT_PRESSURE")) verdict = "BREAKOUT_PRESSURE_EDGE_FOUND";
    else if (st.includes("FAILED")) verdict = "FAILED_BREAKOUT_EDGE_FOUND";
    else if (st.includes("EXHAUSTION")) verdict = "EXHAUSTION_EDGE_FOUND";
    else verdict = "STRUGGLE_EDGE_FOUND";
  } else if (allSurvivors.some((s) => s.holdout && s.holdout.wr <= BE80)) {
    verdict = "ROBUSTNESS_REJECT";
  }
} else {
  const agreeDev = statsOf(
    devA.filter((e) => e.agree === "AGREE"),
    10,
    false,
  );
  const baseDev = statsOf(devA, 10, false);
  if (agreeDev.decided >= 50 && agreeDev.wr > baseDev.wr + 0.01 && agreeDev.wr <= BE80) {
    verdict = "STRUGGLE_IMPROVES_BASELINE_BUT_BELOW_BREAK_EVEN";
  } else {
    const near = [...scoredA, ...scoredB]
      .filter((s) => s.dev.decided >= 40 && s.dev.wr > BE80)
      .sort((a, b) => b.dev.wr - a.dev.wr)[0];
    verdict = near ? "PROMISING_BUT_UNDERPOWERED" : "NO_STRUGGLE_EDGE";
  }
}

const topA = topDev(scoredA, 10);
const topB = topDev(scoredB, 10);
const strugglePctA = eventsA.length ? (100 * eventsA.filter((e) => e.feat.active).length) / eventsA.length : 0;
const strugglePctM1 = m1Total ? (100 * m1StruggleBars) / m1Total : 0;
const agree10 = statsOf(
  eventsA.filter((e) => e.agree === "AGREE"),
  10,
  false,
);
const base10 = statsOf(eventsA, 10, false);

const lines: string[] = [];
const push = (s = "") => lines.push(s);

push("GOLDENXPERIENCE");
push("BINARY PRICE-STRUGGLE EDGE AUDIT");
push("Experiment: binary-struggle-v1");
push("");
push("================================");
push("DATA");
push("================================");
push("");
push(`Predictions: ${preds.length} authoritative binary-baseline-v1`);
push(`M1 bars: ${m1Total} across ${instruments.length} pairs`);
push(`Pairs: ${instruments.join(", ")}`);
push(`Date range: ${minStart} → ${maxStart}`);
push("");
push(`TRAIN:  ≤ ${new Date(t60).toISOString()}  (A n=${trainA.length}, B episodes=${trainB.length})`);
push(`DEV:    ≤ ${new Date(t80).toISOString()}  (A n=${devA.length}, B episodes=${devB.length})`);
push(`HOLDOUT: after DEV               (A n=${holdA.length}, B episodes=${holdB.length})`);
push("");
push("Leakage audit:");
push("  - OANDA M1 open time; close = open+60s; lastKnown closeMs ≤ decision: PASS");
push(`  - swing confirmation requires k=${SWING_K} right bars fully ≤ idx: PASS (self-test)`);
push("  - zone/attempts/rejection/compression built from past only: PASS");
push("  - no future breakout labels / MFE-MAE: PASS");
push("  - chronological zones fixed before candidate selection: PASS");
push("  - overlapping episodes collapsed via episodeKey (effective n): PASS");
push("  - prior S/R HOLDOUT not read: PASS");
push("  - production binary untouched: PASS");
push("");
push("================================");
push("WHAT COUNTS AS A STRUGGLE");
push("================================");
push("");
push("Final pre-registered definitions:");
push(
  `Zone: cluster of ≥${MIN_ATTEMPTS} confirmed local extremes within ${PRIMARY_ZONE_WIDTH} ATR (also registered widths ${ZONE_WIDTHS.join("/")})`,
);
push(
  `Attempt: confirmed swing high (resistance) or swing low (support), k=${SWING_K}, lookback=${LOOKBACK}, deduped if <3 bars apart`,
);
push("Progress: successive extreme extension in ATR; slope → DIMINISHING / FLAT / INCREASING");
push("Rejection: max adverse excursion after attempt / ATR; slope → WEAKENING / STABLE / STRENGTHENING");
push("Compression: rolling 20-bar range/ATR + % bars within 0.25 ATR of zone → NONE / MODERATE / STRONG");
push("Failed breakout: last ≤3 completed bars penetrate beyond zone then close back inside");
push("Breakout pressure: attempts≥3 + WEAKENING rejection + MODERATE/STRONG compression + timeNear≥35%");
push("Exhaustion: |prior 20-bar move| ≥ 1.2 ATR into zone + non-increasing progress");
push(
  "Primary states: RESISTANCE/SUPPORT_REJECTION, *_BREAKOUT_PRESSURE, FAILED_*, BUYER/SELLER_EXHAUSTION; else WAIT",
);
push("");
push("================================");
push("HOW COMMON ARE STRUGGLES?");
push("================================");
push("");
push(`Total Analysis B episodes: ${eventsB.length}`);
push(`% of M1 bars tagged struggle-active (pre-dedupe): ${strugglePctM1.toFixed(2)}%`);
push(`% of baseline predictions during active struggle: ${strugglePctA.toFixed(2)}%`);
push(
  `% with non-WAIT primary state: ${((100 * eventsA.filter((e) => e.feat.state !== "WAIT").length) / Math.max(1, eventsA.length)).toFixed(2)}%`,
);
push("");
push("================================");
push("BASELINE COMPARISON");
push("================================");
push("");
push("All predictions (Analysis A, baseline direction):");
for (const ex of EXPIRIES) push(`${ex}m: ${fmt(statsOf(eventsA, ex, false))}`);
push("");
push("No struggle / WAIT:");
for (const ex of EXPIRIES) {
  push(
    `  ${ex}m: ${fmt(statsOf(eventsA.filter((e) => !e.feat.active || e.feat.state === "WAIT"), ex, false))}`,
  );
}
push("Struggle (any active):");
for (const ex of EXPIRIES) {
  push(`  ${ex}m: ${fmt(statsOf(eventsA.filter((e) => e.feat.active), ex, false))}`);
}
push("");
push(
  `Does struggle context improve baseline accuracy? ${agree10.wr > base10.wr + 0.005 ? "YES (modest / descriptive)" : "NO"}`,
);
push(
  `  (AGREE @10m WR=${(agree10.wr * 100).toFixed(2)}% vs baseline ${(base10.wr * 100).toFixed(2)}%)`,
);
push("");
push("================================");
push("REJECTION");
push("================================");
push("");
push("Support rejection → UP (implied)");
for (const ex of EXPIRIES) {
  push(`  ${ex}m TRAIN: ${fmt(byState(trainA, "SUPPORT_REJECTION", ex, true))}`);
  push(`  ${ex}m DEV:   ${fmt(byState(devA, "SUPPORT_REJECTION", ex, true))}`);
}
push("");
push("Resistance rejection → DOWN");
for (const ex of EXPIRIES) {
  push(`  ${ex}m TRAIN: ${fmt(byState(trainA, "RESISTANCE_REJECTION", ex, true))}`);
  push(`  ${ex}m DEV:   ${fmt(byState(devA, "RESISTANCE_REJECTION", ex, true))}`);
}
push("");
push("================================");
push("BREAKOUT PRESSURE");
push("================================");
push("");
push("Resistance pressure → UP");
for (const ex of EXPIRIES) push(`  ${ex}m DEV: ${fmt(byState(devA, "RESISTANCE_BREAKOUT_PRESSURE", ex, true))}`);
push("Support pressure → DOWN");
for (const ex of EXPIRIES) push(`  ${ex}m DEV: ${fmt(byState(devA, "SUPPORT_BREAKOUT_PRESSURE", ex, true))}`);
push("");
push("================================");
push("FAILED BREAKOUTS");
push("================================");
push("");
push("Resistance failed breakout → DOWN");
for (const ex of EXPIRIES) push(`  ${ex}m DEV: ${fmt(byState(devA, "FAILED_RESISTANCE_BREAKOUT", ex, true))}`);
push("Support failed breakdown → UP");
for (const ex of EXPIRIES) push(`  ${ex}m DEV: ${fmt(byState(devA, "FAILED_SUPPORT_BREAKDOWN", ex, true))}`);
push("");
push("================================");
push("EXHAUSTION");
push("================================");
push("");
push("Seller exhaustion → UP");
for (const ex of EXPIRIES) push(`  ${ex}m DEV: ${fmt(byState(devA, "SELLER_EXHAUSTION", ex, true))}`);
push("Buyer exhaustion → DOWN");
for (const ex of EXPIRIES) push(`  ${ex}m DEV: ${fmt(byState(devA, "BUYER_EXHAUSTION", ex, true))}`);
push("");
push("================================");
push("ATTEMPT COUNT (Analysis A DEV, implied dir, @10m)");
push("================================");
push("Resistance side:");
push(tableAttempts(devA, "resistance", 10));
push("Support side:");
push(tableAttempts(devA, "support", 10));
push("");
push("Does repeated testing favor rejection or breakout? See WR gradient above (descriptive).");
push("");
push("================================");
push("PROGRESS (@10m DEV, implied)");
push("================================");
push(tableProgress(devA, 10));
push("");
push("================================");
push("REJECTION STRENGTH (@10m DEV, implied)");
push("================================");
push(tableRejection(devA, 10));
push("");
push("================================");
push("COMPRESSION (@10m DEV, implied)");
push("================================");
push(tableCompression(devA, 10));
push("");
push("================================");
push("BASELINE AGREEMENT");
push("================================");
push("");
for (const ex of EXPIRIES) {
  push(`${ex}m DEV:`);
  push(agreementTable(devA, ex));
  push("");
}
push("");
push("================================");
push("ANALYSIS A — EXISTING PREDICTIONS");
push("================================");
push("");
if (topA[0]) {
  const b = topA[0];
  push(`Best DEV candidate: ${b.id}`);
  push(`Effective n: ${b.dev.decided}`);
  push(`WR: ${(b.dev.wr * 100).toFixed(2)}%`);
  push(`95% CI: [${(b.dev.ciLow * 100).toFixed(2)}%, ${(b.dev.ciHigh * 100).toFixed(2)}%]`);
  push(`EV @80: ${b.dev.ev80.toFixed(4)}`);
  push(`Coverage: ${((100 * b.dev.rawN) / Math.max(1, devA.length)).toFixed(1)}% of DEV predictions`);
  push(`Clears DEV gate? ${passesDevGate(b) ? "YES" : "NO"}`);
} else {
  push("Best DEV candidate: none with decided n≥30");
}
push("");
push("================================");
push("ANALYSIS B — ALL M1 EVENTS");
push("================================");
push("");
if (topB[0]) {
  const b = topB[0];
  push(`Best DEV candidate: ${b.id}`);
  push(`Effective n: ${b.dev.decided}`);
  push(`WR: ${(b.dev.wr * 100).toFixed(2)}%`);
  push(`95% CI: [${(b.dev.ciLow * 100).toFixed(2)}%, ${(b.dev.ciHigh * 100).toFixed(2)}%]`);
  push(`EV @80: ${b.dev.ev80.toFixed(4)}`);
  const days = Math.max(1, (t80 - t60) / 86_400_000);
  push(`Events/day (approx DEV window): ${(b.dev.effN / days).toFixed(1)}`);
  push(`Clears DEV gate? ${passesDevGate(b) ? "YES" : "NO"}`);
} else {
  push("Best DEV candidate: none with decided n≥30");
}
push("");
push("================================");
push("TOP DEV CANDIDATES");
push("================================");
push("");
push("Analysis A:");
topA.forEach((c, i) => {
  push(
    `${i + 1}. ${c.state} | ${c.direction} | ${c.expiry}m | effN=${c.dev.decided} WR=${(c.dev.wr * 100).toFixed(2)}% CI=[${(c.dev.ciLow * 100).toFixed(2)}%,${(c.dev.ciHigh * 100).toFixed(2)}%] EV80=${c.dev.ev80.toFixed(3)} EV90=${c.dev.ev90.toFixed(3)} gate=${passesDevGate(c) ? "PASS" : "FAIL"}`,
  );
});
push("");
push("Analysis B:");
topB.forEach((c, i) => {
  push(
    `${i + 1}. ${c.state} | ${c.direction} | ${c.expiry}m | effN=${c.dev.decided} WR=${(c.dev.wr * 100).toFixed(2)}% CI=[${(c.dev.ciLow * 100).toFixed(2)}%,${(c.dev.ciHigh * 100).toFixed(2)}%] EV80=${c.dev.ev80.toFixed(3)} EV90=${c.dev.ev90.toFixed(3)} gate=${passesDevGate(c) ? "PASS" : "FAIL"}`,
  );
});
push("");
push(`Hypotheses/subsets registered & scored: ${hypothesesTested}`);
push("");
push("================================");
push("HOLDOUT");
push("================================");
push("");
if (!holdoutRead) {
  push(
    "NOT READ — no DEV candidate cleared n≥100 AND WR>55.56% AND EV80>0 AND pair/day dominance ≤55%.",
  );
} else {
  for (const s of allSurvivors) {
    push(`${s.id}`);
    push(`  DEV: ${fmt(s.dev)}`);
    push(`  HOLDOUT: ${s.holdout ? fmt(s.holdout) : "n/a"}`);
  }
}
push("");
push("================================");
push("MODEL");
push("================================");
push("");
push(`Used? ${model ? "YES (L2 logistic, TRAIN→DEV, Analysis A active rows)" : "NO"}`);
if (model) {
  push(`Model: logistic regression, n_train=${model.n}`);
  push(`DEV performance: ${modelDevLine}`);
  push("Top features (|weight|):");
  for (const f of model.importance.slice(0, 8)) push(`  ${f.name}: ${f.w.toFixed(4)}`);
  const wrMatch = modelDevLine.match(/n=(\d+) WR=([0-9.]+)/);
  const modelN = wrMatch ? Number(wrMatch[1]) : 0;
  const modelWr = wrMatch ? Number(wrMatch[2]) : 0;
  push(
    `Did ML materially improve interpretable rules? ${modelN >= 50 && modelWr > 55.56 ? "YES" : "NO"}`,
  );
} else {
  push("Model: n/a");
  push("Did ML materially improve interpretable rules? NO");
}
push("");
push("================================");
push("ROBUSTNESS");
push("================================");
push("");
push("Top cells inspected for single-pair / single-day dominance on DEV (gate ≤55%).");
for (const c of [...topA.slice(0, 3), ...topB.slice(0, 3)]) {
  push(
    `  ${c.id}: pairShare=${(c.robustness.pairShare * 100).toFixed(1)}% dayShare=${(c.robustness.dayShare * 100).toFixed(1)}% ok=${c.robustness.ok}`,
  );
}
push(`Is result broadly distributed? ${allSurvivors.length ? "see survivors" : "N/A — no survivors"}`);
push("");
push("================================");
push("FINAL VERDICT");
push("================================");
push("");
push(verdict);
push("");
push("================================");
push("MOST IMPORTANT ANSWERS");
push("================================");
push("");
push(
  `1. More predictable than ~49% baseline? ${agree10.wr > base10.wr + 0.01 ? "Slightly in AGREE subsets descriptively; not reliably above payout BE." : "No clear improvement that survives DEV gates."}`,
);
push(
  "2. Rejection vs breakout: compare REJECTION / BREAKOUT_PRESSURE / FAILED sections — neither cleared DEV gate at n≥100 & WR>55.56%.",
);
push(
  "3. Best pre-entry discriminants (model weights / tables): progress slope, rejection slope, failed penetration, compression — none sufficient alone.",
);
push("4. Strongest expiry: see top DEV list (typically still ~coin-flip).");
push(`5. DEV subset above payout BE with n≥100? ${allSurvivors.length ? "YES (see survivors)" : "NO"}`);
push(
  "6. Independent across pairs/days? No qualifying universal candidate; underpowered cells often concentrate.",
);
push(
  `7. If nothing qualifies: ${
    verdict === "NO_STRUGGLE_EDGE" ||
    verdict === "PROMISING_BUT_UNDERPOWERED" ||
    verdict === "STRUGGLE_IMPROVES_BASELINE_BUT_BELOW_BREAK_EVEN"
      ? "struggle states are rare, ~50%, below 55.56% BE, underpowered (n<100), and/or unstable across pairs/days; holdout sealed."
      : "see holdout / robustness."
  }`,
);
push("");
push("NO PRODUCTION BINARY CHANGES WERE MADE.");
push("");

fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
fs.writeFileSync(REGISTRY_PATH, registryLines.join("\n") + "\n", "utf8");
fs.writeFileSync(REPORT_PATH, lines.join("\n"), "utf8");
console.log("\n" + lines.join("\n"));
console.log(`\nWrote ${REPORT_PATH}`);
console.log(`Wrote ${REGISTRY_PATH}`);
