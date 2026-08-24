/**
 * GOLDENXPERIENCE — 1-MINUTE BINARY EXPIRY AUDIT
 *
 * Research/audit only. Does NOT modify the binary strategy, predictions,
 * adaptive engine, or production behavior.
 *
 * Counterfactual: for each EXISTING prediction at T, would the same UP/DOWN
 * call be ITM at T+60s using the same M1 mid-close convention the engine uses?
 *
 * Price source: OANDA M1 via getResearchCandles (same path as resolveDueBinaryPredictions).
 * Local DB has no stored M1 — that is expected; the live resolver also fetches OANDA M1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import {
  classifyBinaryResult,
  resolutionPriceAtOrAfter,
  type BinaryCandle,
} from "../src/binary-engine.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const { query } = await import("../src/database.js");

const REPORT_PATH = path.join(root, "research-v2", "binary-1m-audit", "FINAL_REPORT.txt");
const EXAMPLES_PATH = path.join(root, "research-v2", "binary-1m-audit", "EXAMPLES.txt");

type PredRow = {
  id: string;
  prediction_sequence: string;
  instrument: string;
  direction: "up" | "down";
  start_at: string;
  entry_price: number;
  duration_seconds: number;
  intended_expiration: string;
  resolution_price: number | null;
  resolution_price_time: string | null;
  resolution_source: string | null;
  result: "won" | "lost" | "tie" | null;
  confidence: number;
  price_precision: number;
  secondary_marks: Record<string, { price: number; priceTime: string; result: "won" | "lost" | "tie" }> | null;
  model_name: string;
  model_version: string;
  is_authoritative: boolean;
  is_shadow: boolean;
  session: string | null;
};

type HorizonOutcome = {
  horizonSeconds: number;
  result: "won" | "lost" | "tie" | "missing";
  price: number | null;
  priceTime: string | null;
  source: "computed_m1" | "stored_official" | "stored_secondary" | "missing";
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function wilsonCi(wins: number, decided: number): { low: number; high: number; rate: number } {
  if (decided <= 0) return { low: 0, high: 0, rate: 0 };
  const z = 1.96;
  const p = wins / decided;
  const denom = 1 + (z * z) / decided;
  const centre = p + (z * z) / (2 * decided);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * decided)) / decided);
  return { rate: p, low: (centre - margin) / denom, high: (centre + margin) / denom };
}

function breakEven(payout: number) {
  return 1 / (1 + payout);
}

function evPerDollar(winRate: number, payout: number) {
  return winRate * payout - (1 - winRate);
}

function sessionOf(iso: string): string {
  const h = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .find((p) => p.type === "hour")?.value,
  );
  if (h >= 3 && h < 8) return "asia_london_pre";
  if (h >= 8 && h < 12) return "london";
  if (h >= 12 && h < 17) return "overlap";
  if (h >= 17 && h < 21) return "newyork";
  return "off_hours";
}

function hourEt(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .find((p) => p.type === "hour")?.value,
  );
}

function weekdayEt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(iso));
}

function toBinaryCandles(
  candles: Awaited<ReturnType<typeof getResearchCandles>>,
): BinaryCandle[] {
  return candles.map((c) => ({
    time: c.time,
    open: c.mid.open,
    high: c.mid.high,
    low: c.mid.low,
    close: c.mid.close,
    volume: c.volume,
    complete: c.complete,
  }));
}

/** Fetch M1 mid candles covering [from, to] via OANDA pagination (to= cursor). */
async function fetchM1Range(instrument: string, fromIso: string, toIso: string): Promise<BinaryCandle[]> {
  const fromMs = Date.parse(fromIso) - 5 * 60_000; // small pad before first prediction
  const toMs = Date.parse(toIso) + 20 * 60_000; // pad past 15m secondary
  const all: BinaryCandle[] = [];
  let cursor = new Date(toMs).toISOString();
  let pages = 0;
  const maxPages = 40;

  while (pages < maxPages) {
    pages += 1;
    const raw = await getResearchCandles(instrument as MajorInstrument, "M1", 5000, { to: cursor });
    const batch = toBinaryCandles(raw).filter((c) => c.complete);
    if (batch.length === 0) break;
    for (const c of batch) all.push(c);
    const earliest = batch.reduce((min, c) => (c.time < min ? c.time : min), batch[0]!.time);
    if (Date.parse(earliest) <= fromMs) break;
    cursor = earliest;
    await sleep(200); // be polite to OANDA
  }

  // Dedupe by open time, sort ascending
  const byTime = new Map<string, BinaryCandle>();
  for (const c of all) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function resolveHorizon(
  candles: BinaryCandle[],
  direction: "up" | "down",
  entry: number,
  precision: number,
  startAt: Date,
  horizonSeconds: number,
): HorizonOutcome {
  const target = new Date(startAt.getTime() + horizonSeconds * 1000);
  const mark = resolutionPriceAtOrAfter(candles, target);
  if (!mark) return { horizonSeconds, result: "missing", price: null, priceTime: null, source: "missing" };
  if (Date.parse(mark.time) <= startAt.getTime()) {
    // Should never happen with correct M1 close-time convention
    return { horizonSeconds, result: "missing", price: mark.price, priceTime: mark.time, source: "missing" };
  }
  return {
    horizonSeconds,
    result: classifyBinaryResult(direction, entry, mark.price, precision),
    price: mark.price,
    priceTime: mark.time,
    source: "computed_m1",
  };
}

type Counts = { won: number; lost: number; tie: number; missing: number };
function emptyCounts(): Counts {
  return { won: 0, lost: 0, tie: 0, missing: 0 };
}
function addResult(c: Counts, r: string) {
  if (r === "won") c.won += 1;
  else if (r === "lost") c.lost += 1;
  else if (r === "tie") c.tie += 1;
  else c.missing += 1;
}
function fmtCounts(c: Counts) {
  const decided = c.won + c.lost;
  const wr = decided ? c.won / decided : NaN;
  const ci = wilsonCi(c.won, decided);
  return {
    ...c,
    decided,
    winRate: wr,
    ciLow: ci.low,
    ciHigh: ci.high,
    label: decided
      ? `n=${decided} W=${c.won} L=${c.lost} T=${c.tie} miss=${c.missing} WR=${(wr * 100).toFixed(2)}% CI95=[${(ci.low * 100).toFixed(2)}%,${(ci.high * 100).toFixed(2)}%]`
      : `n=0 (missing=${c.missing})`,
  };
}

console.log("Loading resolved predictions...");
const predRes = await query<PredRow>(
  `SELECT id, prediction_sequence::text, instrument, direction, start_at::text, entry_price::float,
          duration_seconds, intended_expiration::text, resolution_price::float, resolution_price_time::text,
          resolution_source, result, confidence::float, price_precision,
          secondary_marks, model_name, model_version, is_authoritative, is_shadow,
          COALESCE(market_context->>'session', features->>'session') AS session
     FROM binary_predictions
    WHERE status='resolved'
    ORDER BY start_at`,
);

const all = predRes.rows;
console.log(`Loaded ${all.length} resolved predictions`);

// Authoritative = current production binary path (baseline)
const baseline = all.filter((p) => p.model_name === "binary-baseline-v1" && p.is_authoritative);
const logistic = all.filter((p) => p.model_name === "binary-logistic-v1");

console.log(`Baseline authoritative: ${baseline.length}`);
console.log(`Logistic shadow: ${logistic.length}`);

if (baseline.length === 0) {
  console.error("No authoritative baseline predictions — cannot audit.");
  process.exit(1);
}

const instruments = [...new Set(baseline.map((p) => p.instrument))].sort();
const minStart = baseline.reduce((m, p) => (p.start_at < m ? p.start_at : m), baseline[0]!.start_at);
const maxStart = baseline.reduce((m, p) => (p.start_at > m ? p.start_at : m), baseline[0]!.start_at);

console.log(`Instruments: ${instruments.join(", ")}`);
console.log(`Date range: ${minStart} → ${maxStart}`);

// Probe one M1 fetch first
console.log("\nProbing OANDA M1 availability...");
let m1Available = true;
try {
  const probe = await getResearchCandles(instruments[0]! as MajorInstrument, "M1", 10);
  if (!probe.length) {
    m1Available = false;
    console.log("ONE_MINUTE_DATA_UNAVAILABLE: OANDA returned empty M1");
  } else {
    console.log(`OANDA M1 OK for ${instruments[0]}: ${probe.length} candles, latest open=${probe.at(-1)?.time}`);
  }
} catch (e) {
  m1Available = false;
  console.log("ONE_MINUTE_DATA_UNAVAILABLE:", e instanceof Error ? e.message : e);
}

if (!m1Available) {
  const report = `GOLDENXPERIENCE
1-MINUTE BINARY EXPIRY AUDIT

DATA
================================

Strategy/version: binary-baseline-v1@1.0.0 (authoritative)
Date range: ${minStart} → ${maxStart}
Symbols: ${instruments.join(", ")}
Total predictions: ${baseline.length}
Eligible: 0
Excluded: ${baseline.length}
1-minute price source: UNAVAILABLE
Local DB M1: NONE
OANDA M1 fetch: FAILED

FINAL VERDICT:
ONE_MINUTE_DATA_UNAVAILABLE
`;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report, "utf8");
  console.log(report);
  process.exit(0);
}

// Fetch M1 per instrument
const candlesByInst = new Map<string, BinaryCandle[]>();
for (const inst of instruments) {
  console.log(`Fetching M1 for ${inst}...`);
  try {
    const candles = await fetchM1Range(inst, minStart, maxStart);
    candlesByInst.set(inst, candles);
    console.log(`  ${inst}: ${candles.length} completed M1 candles`);
  } catch (e) {
    console.warn(`  ${inst}: FETCH FAILED`, e instanceof Error ? e.message : e);
    candlesByInst.set(inst, []);
  }
}

type Resolved = {
  pred: PredRow;
  h1: HorizonOutcome;
  h5: HorizonOutcome;
  h10: HorizonOutcome;
  h15: HorizonOutcome;
  stored10: "won" | "lost" | "tie" | null;
  stored5: "won" | "lost" | "tie" | null;
  stored15: "won" | "lost" | "tie" | null;
  timestampOk: boolean;
};

const resolved: Resolved[] = [];
let excludedNoM1 = 0;
let excludedTs = 0;
const examples: string[] = [];

for (const pred of baseline) {
  const candles = candlesByInst.get(pred.instrument) ?? [];
  const startAt = new Date(pred.start_at);
  const entry = Number(pred.entry_price);
  const precision = Number(pred.price_precision);

  const h1 = resolveHorizon(candles, pred.direction, entry, precision, startAt, 60);
  const h5c = resolveHorizon(candles, pred.direction, entry, precision, startAt, 300);
  const h10c = resolveHorizon(candles, pred.direction, entry, precision, startAt, 600);
  const h15c = resolveHorizon(candles, pred.direction, entry, precision, startAt, 900);

  if (h1.result === "missing") {
    excludedNoM1 += 1;
    continue;
  }

  const tsOk = Boolean(h1.priceTime && Date.parse(h1.priceTime) > startAt.getTime());
  if (!tsOk) {
    excludedTs += 1;
    continue;
  }

  const stored5 = pred.secondary_marks?.["300s"]?.result ?? null;
  const stored15 = pred.secondary_marks?.["900s"]?.result ?? null;

  // Prefer computed M1 for fair same-cohort comparison; fall back to stored for reporting gaps
  const h5: HorizonOutcome = h5c.result !== "missing" ? h5c : stored5
    ? { horizonSeconds: 300, result: stored5, price: pred.secondary_marks!["300s"]!.price, priceTime: pred.secondary_marks!["300s"]!.priceTime, source: "stored_secondary" }
    : h5c;
  const h10: HorizonOutcome = h10c.result !== "missing"
    ? h10c
    : pred.result
      ? { horizonSeconds: 600, result: pred.result, price: pred.resolution_price, priceTime: pred.resolution_price_time, source: "stored_official" }
      : h10c;
  const h15: HorizonOutcome = h15c.result !== "missing" ? h15c : stored15
    ? { horizonSeconds: 900, result: stored15, price: pred.secondary_marks!["900s"]!.price, priceTime: pred.secondary_marks!["900s"]!.priceTime, source: "stored_secondary" }
    : h15c;

  resolved.push({
    pred,
    h1,
    h5,
    h10,
    h15,
    stored10: pred.result,
    stored5,
    stored15,
    timestampOk: tsOk,
  });

  if (examples.length < 8) {
    examples.push(
      [
        `seq=${pred.prediction_sequence} ${pred.instrument} ${pred.direction}`,
        `  prediction/start: ${pred.start_at}`,
        `  entry_price:      ${entry}`,
        `  expiration_1m:    ${h1.priceTime}  price=${h1.price}  result=${h1.result}`,
        `  expiration_ts > start_ts: ${tsOk}`,
        `  stored_10m:       ${pred.result} @ ${pred.resolution_price_time} (${pred.resolution_source})`,
        `  computed_10m:     ${h10c.result} @ ${h10c.priceTime}`,
      ].join("\n"),
    );
  }
}

console.log(`Eligible for 1m: ${resolved.length}`);
console.log(`Excluded (no M1 mark): ${excludedNoM1}`);
console.log(`Excluded (timestamp): ${excludedTs}`);

const tsAllOk = resolved.every((r) => r.timestampOk);
console.log(`Timestamp audit 100% expiration>start: ${tsAllOk}`);

// --- Aggregates ---
const c1 = emptyCounts();
const c5 = emptyCounts();
const c10 = emptyCounts();
const c15 = emptyCounts();
const c10stored = emptyCounts();

for (const r of resolved) {
  addResult(c1, r.h1.result);
  addResult(c5, r.h5.result);
  addResult(c10, r.h10.result);
  addResult(c15, r.h15.result);
  if (r.stored10) addResult(c10stored, r.stored10);
}

const f1 = fmtCounts(c1);
const f5 = fmtCounts(c5);
const f10 = fmtCounts(c10);
const f15 = fmtCounts(c15);
const f10s = fmtCounts(c10stored);

const bestExpiry = [
  { label: "1m", wr: f1.winRate, decided: f1.decided },
  { label: "5m", wr: f5.winRate, decided: f5.decided },
  { label: "10m", wr: f10.winRate, decided: f10.decided },
  { label: "15m", wr: f15.winRate, decided: f15.decided },
]
  .filter((x) => x.decided > 0 && Number.isFinite(x.wr))
  .sort((a, b) => b.wr - a.wr)[0];

// UP vs DOWN
const upC = emptyCounts();
const dnC = emptyCounts();
for (const r of resolved) {
  if (r.pred.direction === "up") addResult(upC, r.h1.result);
  else addResult(dnC, r.h1.result);
}
const fUp = fmtCounts(upC);
const fDn = fmtCounts(dnC);

// By symbol
const bySym = new Map<string, Counts>();
for (const r of resolved) {
  const c = bySym.get(r.pred.instrument) ?? emptyCounts();
  addResult(c, r.h1.result);
  bySym.set(r.pred.instrument, c);
}

// Confidence buckets
const confBuckets = [
  { label: "<50%", lo: 0, hi: 0.5 },
  { label: "50–55%", lo: 0.5, hi: 0.55 },
  { label: "55–60%", lo: 0.55, hi: 0.6 },
  { label: "60–65%", lo: 0.6, hi: 0.65 },
  { label: "65–70%", lo: 0.65, hi: 0.7 },
  { label: "70–75%", lo: 0.7, hi: 0.75 },
  { label: "75%+", lo: 0.75, hi: 1.01 },
];
const confLines: string[] = [];
const confRates: Array<{ label: string; wr: number; n: number }> = [];
for (const b of confBuckets) {
  const c = emptyCounts();
  for (const r of resolved) {
    const conf = Number(r.pred.confidence);
    if (conf >= b.lo && conf < b.hi) addResult(c, r.h1.result);
  }
  const f = fmtCounts(c);
  confLines.push(`  ${b.label}: ${f.label}${f.decided < 30 ? "  [INSUFFICIENT_SAMPLE]" : ""}`);
  if (f.decided > 0) confRates.push({ label: b.label, wr: f.winRate, n: f.decided });
}

// Percentile buckets by confidence
const sortedByConf = [...resolved].sort((a, b) => Number(b.pred.confidence) - Number(a.pred.confidence));
function topPct(pct: number) {
  const n = Math.max(1, Math.floor(sortedByConf.length * pct));
  const c = emptyCounts();
  for (const r of sortedByConf.slice(0, n)) addResult(c, r.h1.result);
  return fmtCounts(c);
}
const pctLines = [
  `  All: ${f1.label}`,
  `  Top 50%: ${topPct(0.5).label}`,
  `  Top 25%: ${topPct(0.25).label}`,
  `  Top 10%: ${topPct(0.1).label}`,
  `  Top 5%:  ${topPct(0.05).label}`,
];

// Does confidence rank? Spearmen-ish: compare WR of high vs low halves
const mid = Math.floor(sortedByConf.length / 2);
const highHalf = emptyCounts();
const lowHalf = emptyCounts();
for (const r of sortedByConf.slice(0, mid)) addResult(highHalf, r.h1.result);
for (const r of sortedByConf.slice(mid)) addResult(lowHalf, r.h1.result);
const fHigh = fmtCounts(highHalf);
const fLow = fmtCounts(lowHalf);
let confRanks: "YES" | "NO" | "UNCLEAR" = "UNCLEAR";
if (fHigh.decided >= 50 && fLow.decided >= 50) {
  confRanks = fHigh.winRate > fLow.winRate + 0.01 ? "YES" : fHigh.winRate < fLow.winRate - 0.01 ? "NO" : "UNCLEAR";
}

// Session / hour / weekday
const bySession = new Map<string, Counts>();
const byHour = new Map<number, Counts>();
const byWeekday = new Map<string, Counts>();
for (const r of resolved) {
  const sess = r.pred.session || sessionOf(r.pred.start_at);
  const sc = bySession.get(sess) ?? emptyCounts();
  addResult(sc, r.h1.result);
  bySession.set(sess, sc);

  const h = hourEt(r.pred.start_at);
  const hc = byHour.get(h) ?? emptyCounts();
  addResult(hc, r.h1.result);
  byHour.set(h, hc);

  const wd = weekdayEt(r.pred.start_at);
  const wc = byWeekday.get(wd) ?? emptyCounts();
  addResult(wc, r.h1.result);
  byWeekday.set(wd, wc);
}

// Streaks
const outcomes = resolved.map((r) => (r.h1.result === "won" ? 1 : r.h1.result === "lost" ? -1 : 0)).filter((x) => x !== 0);
let maxWinStreak = 0;
let maxLossStreak = 0;
let cur = 0;
for (const o of outcomes) {
  if (cur === 0) cur = o;
  else if (Math.sign(cur) === o) cur += o;
  else cur = o;
  if (cur > 0) maxWinStreak = Math.max(maxWinStreak, cur);
  if (cur < 0) maxLossStreak = Math.max(maxLossStreak, -cur);
}

function afterStreak(kind: "win" | "loss", nPrev: number | "3+") {
  const c = emptyCounts();
  let streak = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i]!;
    const match =
      kind === "win"
        ? nPrev === "3+"
          ? streak >= 3
          : streak === nPrev
        : nPrev === "3+"
          ? streak >= 3
          : streak === nPrev;
    if (i > 0 && match && streak > 0) {
      if (o === 1) c.won += 1;
      else c.lost += 1;
    }
    if (kind === "win") streak = o === 1 ? streak + 1 : 0;
    else streak = o === -1 ? streak + 1 : 0;
  }
  return fmtCounts(c);
}

// Payout analysis
const payouts = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const payoutLines: string[] = [];
let profitableAt: string[] = [];
for (const p of payouts) {
  const be = breakEven(p);
  const ev = evPerDollar(f1.winRate, p);
  const ok = f1.winRate > be && f1.ciLow > be;
  const soft = f1.winRate > be;
  if (ok) profitableAt.push(`${(p * 100).toFixed(0)}% (CI clears BE)`);
  else if (soft) profitableAt.push(`${(p * 100).toFixed(0)}% (point estimate only)`);
  payoutLines.push(
    `  ${(p * 100).toFixed(0)}%: BE=${(be * 100).toFixed(2)}%  actual=${(f1.winRate * 100).toFixed(2)}%  EV/$${ev.toFixed(4)}  ${ok ? "CI>BE" : soft ? "WR>BE but CI overlaps" : "below BE"}`,
  );
}

// Statistical verdict
const be80 = breakEven(0.8);
const be90 = breakEven(0.9);
const gt50 = f1.ciLow > 0.5;
const gt55 = f1.ciLow > 0.55;
const gtBe80 = f1.ciLow > be80;
const gtBe90 = f1.ciLow > be90;
const pointGt50 = f1.winRate > 0.5;

let verdict = "ONE_MINUTE_NO_EDGE";
if (f1.decided < 100) verdict = "ONE_MINUTE_PROMISING_BUT_NOT_PROVEN";
else if (gtBe80 || gtBe90) verdict = "ONE_MINUTE_PROFITABLE";
else if (gt50 && f1.winRate > be80) verdict = "ONE_MINUTE_PROMISING_BUT_NOT_PROVEN";
else if (pointGt50 && f1.winRate < be80) verdict = "ONE_MINUTE_ACCURATE_BUT_BELOW_BREAK_EVEN";
else if (f1.winRate < Math.min(f5.winRate, f10.winRate, f15.winRate) - 0.01) verdict = "ONE_MINUTE_WORSE";
else if (!pointGt50) verdict = "ONE_MINUTE_NO_EDGE";

// Logistic separate short section (same M1 if overlapping)
const logisticResolved: HorizonOutcome[] = [];
for (const pred of logistic) {
  const candles = candlesByInst.get(pred.instrument) ?? [];
  const h1 = resolveHorizon(candles, pred.direction, Number(pred.entry_price), Number(pred.price_precision), new Date(pred.start_at), 60);
  if (h1.result !== "missing" && h1.priceTime && Date.parse(h1.priceTime) > Date.parse(pred.start_at)) {
    logisticResolved.push(h1);
  }
}
const logC = emptyCounts();
for (const h of logisticResolved) addResult(logC, h.result);
const fLog = fmtCounts(logC);

const report = `GOLDENXPERIENCE
1-MINUTE BINARY EXPIRY AUDIT

DATA
================================

Strategy/version: binary-baseline-v1@1.0.0 (authoritative / production binary)
  (logistic shadow reported separately — not mixed into headline)
Date range: ${minStart} → ${maxStart}
Symbols: ${instruments.join(", ")}
Total predictions (baseline authoritative resolved): ${baseline.length}
Eligible (1m M1-resolved): ${resolved.length}
Excluded: no_M1_mark=${excludedNoM1}  timestamp_fail=${excludedTs}
1-minute price source: OANDA M1 mid close via getResearchCandles
  (same source/convention as binary-engine resolveDueBinaryPredictions)
  Local DB market_candles has NO M1 — live resolver also fetches OANDA M1
Timestamp audit: expiration_timestamp > prediction_timestamp for ${tsAllOk ? "100%" : "NOT 100%"} of eligible (${resolved.length})
Official horizon of predictions: ${baseline[0]?.duration_seconds ?? 600}s (10m)
Secondary marks already stored: 300s (5m), 900s (15m)

Manual examples (see also EXAMPLES.txt):
${examples.slice(0, 3).join("\n\n")}

OVERALL (1-MINUTE)
================================

Wins: ${f1.won}
Losses: ${f1.lost}
Ties: ${f1.tie}
Missing among eligible: ${f1.missing}
Win rate (excl. ties): ${(f1.winRate * 100).toFixed(2)}%
95% CI (Wilson): [${(f1.ciLow * 100).toFixed(2)}%, ${(f1.ciHigh * 100).toFixed(2)}%]
Sample size (decided): ${f1.decided}

CI exceeds 50%? ${gt50 ? "YES" : "NO"}
CI exceeds 55%? ${gt55 ? "YES" : "NO"}
CI exceeds 80% payout BE (${(be80 * 100).toFixed(2)}%)? ${gtBe80 ? "YES" : "NO"}
CI exceeds 90% payout BE (${(be90 * 100).toFixed(2)}%)? ${gtBe90 ? "YES" : "NO"}

EXPIRY COMPARISON (same eligible cohort; M1-computed where available)
================================

1m:  ${f1.label}
5m:  ${f5.label}
10m: ${f10.label}
15m: ${f15.label}

Stored official 10m (same rows): ${f10s.label}

BEST EXPIRY: ${bestExpiry ? `${bestExpiry.label} (WR=${(bestExpiry.wr * 100).toFixed(2)}%)` : "n/a"}

UP vs DOWN (1m)
================================

UP:   ${fUp.label}
DOWN: ${fDn.label}

BY SYMBOL (1m)
================================

${[...bySym.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([sym, c]) => {
    const f = fmtCounts(c);
    return `  ${sym}: ${f.label}${f.decided < 30 ? "  [INSUFFICIENT_SAMPLE]" : ""}`;
  })
  .join("\n")}

CONFIDENCE (1m) — existing score buckets, no retuning
================================

${confLines.join("\n")}

Percentile buckets:
${pctLines.join("\n")}

High-conf half WR=${(fHigh.winRate * 100).toFixed(2)}% vs low-conf half WR=${(fLow.winRate * 100).toFixed(2)}%
Does confidence rank win probability? ${confRanks}

SESSION / TIME (1m, descriptive only)
================================

By session:
${[...bySession.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([k, c]) => `  ${k}: ${fmtCounts(c).label}`)
  .join("\n")}

By hour ET:
${[...byHour.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([k, c]) => `  ${String(k).padStart(2, "0")}:00 ${fmtCounts(c).label}`)
  .join("\n")}

By weekday ET:
${[...byWeekday.entries()]
  .map(([k, c]) => `  ${k}: ${fmtCounts(c).label}`)
  .join("\n")}

CONSECUTIVE OUTCOMES (exploratory, not predictive claim)
================================

Max consecutive wins: ${maxWinStreak}
Max consecutive losses: ${maxLossStreak}

After 1 loss: ${afterStreak("loss", 1).label}
After 2 losses: ${afterStreak("loss", 2).label}
After 3+ losses: ${afterStreak("loss", "3+").label}
After 1 win: ${afterStreak("win", 1).label}
After 2 wins: ${afterStreak("win", 2).label}
After 3+ wins: ${afterStreak("win", "3+").label}

PAYOUT ANALYSIS (1m observed WR=${(f1.winRate * 100).toFixed(2)}%)
================================

PAYOUT    BREAK-EVEN WR    ACTUAL WR    EV/$1
${payouts
  .map((p) => {
    const be = breakEven(p);
    const ev = evPerDollar(f1.winRate, p);
    return `  ${(p * 100).toFixed(0).padStart(3)}%      ${(be * 100).toFixed(2).padStart(6)}%         ${(f1.winRate * 100).toFixed(2).padStart(6)}%     ${ev.toFixed(4)}`;
  })
  .join("\n")}

Detail:
${payoutLines.join("\n")}

At what payout is 1m profitable?
${profitableAt.length ? profitableAt.join("; ") : "NONE — observed WR does not clear break-even with CI support"}

LOGISTIC SHADOW (separate; not mixed into headline)
================================

binary-logistic-v1@1.0.0 shadow predictions overlapping M1 fetch:
${fLog.label}

STATISTICAL VERDICT
================================

Is 1-minute accuracy >50% (point)? ${pointGt50 ? "YES" : "NO"}
Is it statistically supported (CI >50%)? ${gt50 ? "YES" : "NO"}
Does it exceed binary break-even at 80% payout (CI)? ${gtBe80 ? "YES" : "NO"}
Does it exceed binary break-even at 90% payout (CI)? ${gtBe90 ? "YES" : "NO"}
Does it outperform 5m? ${f1.winRate > f5.winRate ? "YES" : "NO"} (${(f1.winRate * 100).toFixed(2)}% vs ${(f5.winRate * 100).toFixed(2)}%)
Does it outperform 10m? ${f1.winRate > f10.winRate ? "YES" : "NO"} (${(f1.winRate * 100).toFixed(2)}% vs ${(f10.winRate * 100).toFixed(2)}%)
Does it outperform 15m? ${f1.winRate > f15.winRate ? "YES" : "NO"} (${(f1.winRate * 100).toFixed(2)}% vs ${(f15.winRate * 100).toFixed(2)}%)

NO STRATEGY CHANGES WERE MADE.
NO THRESHOLDS WERE OPTIMIZED.
NO RETRAINING WAS PERFORMED.

FINAL VERDICT:
${verdict}
`;

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, report, "utf8");
fs.writeFileSync(EXAMPLES_PATH, examples.join("\n\n") + "\n", "utf8");
console.log("\n" + report);
console.log(`\nWrote ${REPORT_PATH}`);
process.exit(0);
