/**
 * Apply legacy-confidence-v2 to the actual live paper trades.
 * RESEARCH ONLY — no DB writes.
 *
 * For each closed+resolved live paper trade, compute the model's features at
 * decision_time using our OANDA candle cache, run the model, and apply the
 * combined rule. Report what the model would have done vs what actually
 * happened.
 *
 * Note: model was trained on legacy EMA-pullback FX setups. Applying it to
 * other families (ema/breakout/momentum/meanrev) is off-distribution — the
 * user said "doesn't have to be exact." Numbers broken out by family so we
 * can see where it helped vs hurt.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const REPO_ROOT = path.resolve(serviceRoot, "..");
const CACHE_DIR = path.join(REPO_ROOT, "backtest-legacy-expanded", "candles");

import type { LegacyConfidenceFeatures } from "../src/legacy-confidence-v2.js";
const { query } = await import("../src/database.js");
const { decideDirection, loadLegacyConfidenceArtifact, artifactAgeDays } = await import("../src/legacy-confidence-v2.js");

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

const cacheCache = new Map<string, Q[]>();
function loadCandles(pair: string, gran: string): Q[] | null {
  const key = `${pair}_${gran}`;
  if (cacheCache.has(key)) return cacheCache.get(key)!;
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!existsSync(file)) return null;
  const bars = (JSON.parse(readFileSync(file, "utf8")) as { bars: Q[] }).bars;
  cacheCache.set(key, bars);
  return bars;
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

const rankPercentile = (arr: number[], value: number): number => {
  let count = 0;
  for (const v of arr) if (v <= value) count++;
  return count / arr.length;
};

function computeFeatures(pair: string, decisionTime: string): LegacyConfidenceFeatures | null {
  const m15 = loadCandles(pair, "M15");
  if (!m15) return null;
  const i = idxAtOrBefore(m15, decisionTime);
  if (i < 500) return null;
  const closes = m15.map((b) => b.close);
  const a14 = atr(m15, 14);
  const a50 = atr(m15, 50);
  const r14 = rsi(closes, 14);
  const atr14V = a14[i]!; const atr50V = a50[i]!; const closeV = closes[i]!;
  const rsiV = r14[i]!; const rsiPrev = r14[i - 3]; const closePrev3 = closes[i - 3];
  if (![atr14V, atr50V, closeV, rsiV, rsiPrev, closePrev3].every((x) => Number.isFinite(x as number))) return null;
  const atrHist = a14.slice(Math.max(0, i - 500), i).filter((v) => Number.isFinite(v));
  if (atrHist.length < 100) return null;
  const atrPct = rankPercentile(atrHist, atr14V);
  const atrRatio = atr14V / atr50V;
  const rangeWin = m15.slice(Math.max(0, i - 20), i);
  const rangeHi = Math.max(...rangeWin.map((b) => b.high));
  const rangeLo = Math.min(...rangeWin.map((b) => b.low));
  const rangePos = rangeHi > rangeLo ? (closeV - rangeLo) / (rangeHi - rangeLo) : 0.5;
  const rsiVelocity = (rsiV - (rsiPrev as number)) / 3;
  const mom3 = (closeV - (closePrev3 as number)) / closeV;
  return {
    atrPct, atrRatio, hourEt: etHour(decisionTime), dayOfWeek: etDay(decisionTime),
    rsiVelocity, rangePos, mom3,
  };
}

// ---- load live trades ----
const trades = (await query<{
  instrument: string; direction: "long" | "short"; decision_time: string;
  result_r: string; paper_pl: string | null; strategy_family: string | null;
}>(
  `SELECT instrument, direction, decision_time, result_r::text, paper_pl::text, strategy_family
     FROM paper_strategy_trades
    WHERE result_r IS NOT NULL
    ORDER BY decision_time`
)).rows;

const artifact = loadLegacyConfidenceArtifact();
console.log(`live resolved trades: ${trades.length}`);
console.log(`model artifact: ${artifact.modelName} v${artifact.version}, trained ${artifact.metadata.trainedAt} (${artifactAgeDays(artifact).toFixed(1)}d old)`);
console.log(`training window: ${artifact.metadata.trainWindowStart} → ${artifact.metadata.trainWindowEnd}`);
console.log(`(NOTE: model overlaps with live-trade dates — treat this as a demo, not clean OOS)\n`);

type Row = {
  fam: string; pair: string; direction: "long" | "short"; decisionTime: string;
  actualR: number; actualPL: number;
  hasFeatures: boolean;
  pLong: number | null; action: string; reason: string;
  wouldTake: "same_direction" | "flip" | "baseline_xau" | "skip"; impliedR: number;
};
const rows: Row[] = [];

for (const t of trades) {
  const fam = t.strategy_family ?? "legacy";
  const feats = computeFeatures(t.instrument, t.decision_time);
  const actualR = Number(t.result_r);
  const actualPL = t.paper_pl ? Number(t.paper_pl) : 0;
  if (!feats) {
    rows.push({
      fam, pair: t.instrument, direction: t.direction, decisionTime: t.decision_time,
      actualR, actualPL, hasFeatures: false,
      pLong: null, action: "no_features", reason: "no_cache_or_pre_history",
      wouldTake: "skip", impliedR: 0,
    });
    continue;
  }
  const dec = decideDirection({ pair: t.instrument, legacyDirection: t.direction, features: feats });
  let wouldTake: Row["wouldTake"] = "skip";
  let impliedR = 0;
  if (dec.decision.action === "take_baseline") { wouldTake = "baseline_xau"; impliedR = actualR; }
  else if (dec.decision.action === "take_model_pick") {
    wouldTake = dec.decision.direction === t.direction ? "same_direction" : "flip";
    impliedR = wouldTake === "same_direction" ? actualR : -actualR;
  }
  rows.push({
    fam, pair: t.instrument, direction: t.direction, decisionTime: t.decision_time,
    actualR, actualPL, hasFeatures: true,
    pLong: dec.pLong, action: dec.decision.action, reason: dec.decision.reason,
    wouldTake, impliedR,
  });
}

// summary
const sum = (arr: Row[], sel: (r: Row) => number) => arr.reduce((s, r) => s + sel(r), 0);

console.log(`=== ACTUAL (what the live engines did) ===`);
console.log(`  n=${trades.length}  totalR=${sum(rows, (r) => r.actualR).toFixed(2)}  totalPL=$${sum(rows, (r) => r.actualPL).toFixed(0)}`);
console.log(`  winners: ${rows.filter((r) => r.actualR > 0).length}   losers: ${rows.filter((r) => r.actualR < 0).length}`);

console.log(`\n=== IF WE HAD USED legacy-confidence-v2 (combined rule) ===`);
const takes = rows.filter((r) => r.wouldTake !== "skip");
const skips = rows.filter((r) => r.wouldTake === "skip");
const wins = takes.filter((r) => r.impliedR > 0).length;
console.log(`  taken: ${takes.length}   skipped: ${skips.length}   no_features: ${rows.filter((r) => !r.hasFeatures).length}`);
console.log(`  taken totalR=${sum(takes, (r) => r.impliedR).toFixed(2)}   winners: ${wins}   winrate: ${takes.length ? (100 * wins / takes.length).toFixed(1) : "n/a"}%`);
console.log(`  breakdown by action: ${takes.filter((r) => r.wouldTake === "baseline_xau").length} XAU baseline, ${takes.filter((r) => r.wouldTake === "flip").length} FX flip, ${takes.filter((r) => r.wouldTake === "same_direction").length} agree`);

console.log(`\n=== BY FAMILY (actual vs model-directed) ===`);
const fams = [...new Set(rows.map((r) => r.fam))];
console.log(`  fam                n   actualR   modelTakeN  modelR   modelWr  action-mix`);
for (const fam of fams) {
  const famRows = rows.filter((r) => r.fam === fam);
  const famTakes = famRows.filter((r) => r.wouldTake !== "skip");
  const famWins = famTakes.filter((r) => r.impliedR > 0).length;
  const aR = sum(famRows, (r) => r.actualR);
  const mR = sum(famTakes, (r) => r.impliedR);
  const mix = `${famTakes.filter((r) => r.wouldTake === "baseline_xau").length}xau/${famTakes.filter((r) => r.wouldTake === "flip").length}flip`;
  console.log(`  ${fam.padEnd(18)}${String(famRows.length).padStart(3)}   ${(aR >= 0 ? "+" : "") + aR.toFixed(2).padStart(6)}    ${String(famTakes.length).padStart(4)}     ${(mR >= 0 ? "+" : "") + mR.toFixed(2).padStart(6)}    ${famTakes.length ? (100 * famWins / famTakes.length).toFixed(1) + "%" : "  n/a"}   ${mix}`);
}

console.log(`\n=== TRADE-BY-TRADE (first 30) ===`);
console.log(`  fam          pair    dir   actualR   pLong  action                reason                       wouldTake       impliedR`);
for (const r of rows.slice(0, 30)) {
  const p = r.pLong === null ? "  —  " : r.pLong.toFixed(3);
  console.log(`  ${r.fam.padEnd(12)} ${r.pair.padEnd(7)} ${r.direction.padEnd(5)} ${(r.actualR >= 0 ? "+" : "") + r.actualR.toFixed(2).padStart(6)}   ${p}  ${r.action.padEnd(20)} ${r.reason.padEnd(28)} ${r.wouldTake.padEnd(15)} ${(r.impliedR >= 0 ? "+" : "") + r.impliedR.toFixed(2)}`);
}
if (rows.length > 30) console.log(`  ... (${rows.length - 30} more)`);

process.exit(0);
