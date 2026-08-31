/**
 * eurusdbot3-1 — full research protocol.
 *
 * Pipeline (all chronological, no shuffling, look-ahead-safe):
 *   1. Load stored EUR/USD bid/ask candles (H1 + M15), resample H4/Daily, news.
 *   2. Build one causal candidate per H1 close (features + LONG/SHORT 1:3/72h
 *      barrier outcomes on the M15 path, NET of spread+slippage).
 *   3. Expanding-window walk-forward: train a symmetric long/short logistic on
 *      past candidates, pick a confidence threshold on a validation slice, then
 *      trade the out-of-sample test block under a one-position-at-a-time lock.
 *   4. Baselines (random / always-long / always-short / trend / momentum /
 *      existing eur-usd-engine) on the same universe and on the model's own
 *      entry timestamps (direction counterfactual).
 *   5. News ablation on the news-covered sub-period (none / avoid / features).
 *   6. Sealed test: freeze config, evaluate once on an untouched recent block.
 *   7. R:R sweep, hold-time sweep, confidence buckets, parameter robustness,
 *      $100 @ 1% account simulation.
 * Emits research/eurusdbot3-1/RESULTS.json.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  loadCandles, resampleUp, loadNews, surpriseZScoreHistory, PIP, REPO_ROOT, type Bar, type NewsEvent,
} from "./data.js";
import { buildContext, buildRawFeatures, orientForShort, FEATURE_NAMES, NEWS_FEATURE_NAMES, type Ctx } from "./features.js";
import { buildNewsFeatures, highImpactWithin } from "./news-features.js";
import { resolveOutcome, type Outcome } from "./barrier.js";
import { trainLogit, predictProb, type Sample, type LogitModel } from "./model.js";
import { summarize, confidenceBuckets, simulateAccount, wilsonLower, type Trade, type Summary } from "./metrics.js";

// ---- Config (pre-registered before any test/sealed evaluation) -------------
const HORIZON_H = 72;
const TP_R = 3;
const K_ATR = 1.0;           // 1R = 1.0 * ATR(H1,14)
const MIN_RISK_PIPS = 5;     // floor so we never manufacture a tiny stop
const SLIPPAGE_PIPS = 0.5;   // execution slippage on top of the real bid/ask spread
const WARMUP = 520;          // H1 bars before first candidate (EMA480 + swings)
const SEALED_START = Date.parse("2026-05-01T00:00:00.000Z"); // untouched during design
const NEWS_START = Date.parse("2024-08-01T00:00:00.000Z");
const H = HORIZON_H * 3_600_000;
const COVERAGES = [1.0, 0.75, 0.5, 0.3, 0.2, 0.1];

const OUT = path.join(REPO_ROOT, "api-server", "research", "eurusdbot3-1");
mkdirSync(OUT, { recursive: true });

// Deterministic RNG (mulberry32) for the random-direction baseline only.
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

type Cand = {
  i: number; t: number; iso: string;
  raw: Record<string, number>; news: Record<string, number>;
  atr: number; risk: number;
  long: Outcome; short: Outcome;      // NET primary (72h, 3R)
  longG: Outcome; shortG: Outcome;    // GROSS primary
  hiWithin60: boolean;                // high-impact event within 60 min after entry
};

function log(...a: unknown[]) { console.log(...a); }

// ---- Build candidate universe ---------------------------------------------
function riskDistance(atr: number): number {
  return Math.max(K_ATR * atr, MIN_RISK_PIPS * PIP);
}

function buildCandidates(ctx: Ctx, h4: Bar[], daily: Bar[], news: NewsEvent[], zByEvent: Map<NewsEvent, number>): Cand[] {
  const { h1, m15 } = ctx;
  const lastLabelTime = h1.at(-1)!.t - H; // need full 72h of forward path
  const cands: Cand[] = [];
  for (let i = WARMUP; i < h1.length; i++) {
    const bar = h1[i]!;
    if (bar.t > lastLabelTime) break;
    const raw = buildRawFeatures(ctx, i, h4, daily);
    const newsF = buildNewsFeatures(news, zByEvent, bar.t);
    const atr = ctx.atr[i]!;
    const risk = riskDistance(atr);
    const base = { entryH1: bar, riskDistance: risk, tpR: TP_R, horizonMs: H, m15, slippagePips: SLIPPAGE_PIPS };
    const long = resolveOutcome({ ...base, direction: "long", cost: "net" });
    const short = resolveOutcome({ ...base, direction: "short", cost: "net" });
    const longG = resolveOutcome({ ...base, direction: "long", cost: "gross" });
    const shortG = resolveOutcome({ ...base, direction: "short", cost: "gross" });
    cands.push({
      i, t: bar.t, iso: bar.iso, raw, news: newsF, atr, risk,
      long, short, longG, shortG,
      hiWithin60: news.length ? highImpactWithin(news, bar.t, 60) : false,
    });
  }
  return cands;
}

// ---- Training samples (symmetric long+short) ------------------------------
type FeatMode = "base" | "news";
function featNames(mode: FeatMode): string[] {
  return mode === "news" ? [...FEATURE_NAMES, ...NEWS_FEATURE_NAMES] : FEATURE_NAMES;
}
function longVec(c: Cand, mode: FeatMode): Record<string, number> {
  return mode === "news" ? { ...c.raw, ...c.news } : c.raw;
}
function shortVec(c: Cand, mode: FeatMode): Record<string, number> {
  const oriented = orientForShort(c.raw);
  if (mode === "news") {
    const n = { ...c.news };
    n.news_surprise_dir = -n.news_surprise_dir!; // directional news flips too
    return { ...oriented, ...n };
  }
  return oriented;
}
function toSamples(cands: Cand[], mode: FeatMode): Sample[] {
  const s: Sample[] = [];
  for (const c of cands) {
    s.push({ x: longVec(c, mode), y: c.long.cls === "win" ? 1 : 0 });
    s.push({ x: shortVec(c, mode), y: c.short.cls === "win" ? 1 : 0 });
  }
  return s;
}

// ---- Scoring / trade construction -----------------------------------------
type Scored = { c: Cand; dir: "long" | "short"; conf: number; outcome: Outcome };
function scoreCandidate(model: LogitModel, c: Cand, mode: FeatMode): Scored {
  const pL = predictProb(model, longVec(c, mode));
  const pS = predictProb(model, shortVec(c, mode));
  const dir = pL >= pS ? "long" : "short";
  const conf = Math.max(pL, pS);
  return { c, dir, conf, outcome: dir === "long" ? c.long : c.short };
}

/** One-position-at-a-time: take a signal only when flat; lock until its exit. */
function tradesFromScored(scored: Scored[], threshold: number): Trade[] {
  const out: Trade[] = [];
  let lockedUntil = -Infinity;
  for (const s of scored) {
    if (s.conf < threshold) continue;
    if (s.c.t < lockedUntil) continue;
    out.push({ time: s.c.iso, direction: s.dir, r: s.outcome.r, cls: s.outcome.cls, holdMs: s.outcome.holdMs, conf: s.conf });
    lockedUntil = s.outcome.exitTime;
  }
  return out;
}

/** Pick the absolute prob threshold on validation that maximizes net expectancy. */
function selectThreshold(model: LogitModel, valid: Cand[], mode: FeatMode): { threshold: number; grid: Array<{ t: number; n: number; exp: number }> } {
  const scored = valid.map((c) => scoreCandidate(model, c, mode)).sort((a, b) => a.c.t - b.c.t);
  const grid: Array<{ t: number; n: number; exp: number }> = [];
  let best = { threshold: 0.5, exp: -Infinity };
  for (let th = 0.30; th <= 0.66; th += 0.02) {
    const tr = tradesFromScored(scored, th);
    const s = summarize(tr);
    grid.push({ t: +th.toFixed(2), n: tr.length, exp: +s.expectancy.toFixed(4) });
    if (tr.length >= 15 && s.expectancy > best.exp) best = { threshold: +th.toFixed(2), exp: s.expectancy };
  }
  return { threshold: best.threshold, grid };
}

// ---- Walk-forward ----------------------------------------------------------
type WFWindow = { window: number; trainStart: string; testStart: string; testEnd: string; threshold: number; trainN: number; test: Summary };
function walkForward(dev: Cand[], mode: FeatMode, folds: number): { windows: WFWindow[]; oosTrades: Trade[]; oosScored: Scored[] } {
  const t0 = dev[0]!.t, tN = dev.at(-1)!.t;
  const span = tN - t0;
  const firstTestFrac = 0.35; // first 35% is pure warmup/train
  const testSpan = (span * (1 - firstTestFrac)) / folds;
  const windows: WFWindow[] = [];
  const oosTrades: Trade[] = [];
  const oosScored: Scored[] = [];
  for (let f = 0; f < folds; f++) {
    const testStart = t0 + span * firstTestFrac + f * testSpan;
    const testEnd = f === folds - 1 ? tN + 1 : testStart + testSpan;
    // train: outcome fully resolved before testStart (embargo one horizon)
    const trainAll = dev.filter((c) => c.t < testStart - H);
    if (trainAll.length < 500) continue;
    // validation = last 15% of train by time (for threshold only)
    const cut = trainAll[Math.floor(trainAll.length * 0.85)]!.t;
    const trainFit = trainAll.filter((c) => c.t < cut);
    const valid = trainAll.filter((c) => c.t >= cut);
    const model = trainLogit(toSamples(trainFit, mode), featNames(mode), { l2: 2.0, lr: 0.2, epochs: 250 });
    const { threshold } = selectThreshold(model, valid, mode);
    const test = dev.filter((c) => c.t >= testStart && c.t < testEnd);
    const scored = test.map((c) => scoreCandidate(model, c, mode)).sort((a, b) => a.c.t - b.c.t);
    const tr = tradesFromScored(scored, threshold);
    oosScored.push(...scored);
    oosTrades.push(...tr);
    windows.push({
      window: f + 1,
      trainStart: new Date(trainFit[0]!.t).toISOString().slice(0, 10),
      testStart: new Date(testStart).toISOString().slice(0, 10),
      testEnd: new Date(testEnd).toISOString().slice(0, 10),
      threshold, trainN: trainFit.length, test: summarize(tr),
    });
  }
  return { windows, oosTrades, oosScored };
}

// ---- Baselines -------------------------------------------------------------
function nonOverlap(cands: Cand[], pick: (c: Cand) => "long" | "short"): Trade[] {
  const out: Trade[] = [];
  let lockedUntil = -Infinity;
  for (const c of cands) {
    if (c.t < lockedUntil) continue;
    const dir = pick(c);
    const o = dir === "long" ? c.long : c.short;
    out.push({ time: c.iso, direction: dir, r: o.r, cls: o.cls, holdMs: o.holdMs, conf: 0.5 });
    lockedUntil = o.exitTime;
  }
  return out;
}
/** Counterfactual: reuse the model's chosen entry timestamps, swap in a baseline direction. */
function counterfactual(trades: Trade[], byTime: Map<string, Cand>, pick: (c: Cand) => "long" | "short"): Summary {
  const out: Trade[] = [];
  for (const t of trades) {
    const c = byTime.get(t.time); if (!c) continue;
    const dir = pick(c);
    const o = dir === "long" ? c.long : c.short;
    out.push({ time: c.iso, direction: dir, r: o.r, cls: o.cls, holdMs: o.holdMs, conf: t.conf });
  }
  return summarize(out);
}

// ---- Existing eur-usd-engine baseline (guarded) ---------------------------
async function existingEngineDirections(h1: Bar[], sampleTimes: number[]): Promise<Map<number, "long" | "short"> | null> {
  try {
    const mod = await import("../../src/eur-usd-engine.js");
    const run = (mod as any).runEurUsdEngine as (i: any) => any;
    const idxByT = new Map<number, number>(); h1.forEach((b, i) => idxByT.set(b.t, i));
    const dirs = new Map<number, "long" | "short">();
    for (const t of sampleTimes) {
      const i = idxByT.get(t); if (i == null || i < 300) continue;
      const window = h1.slice(i - 300, i + 1).map((b) => ({ time: b.iso, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0, complete: true }));
      const d = run({ instrument: "EUR_USD", candles: window, bid: h1[i]!.bidClose, ask: h1[i]!.askClose });
      if (d && d.direction) dirs.set(t, d.direction);
    }
    return dirs;
  } catch (e) {
    log("  [existing-engine] unavailable:", (e as Error).message);
    return null;
  }
}

// ---- Main ------------------------------------------------------------------
async function main() {
  const startedAt = Date.now();
  log("Loading candles…");
  const h1 = loadCandles("H1");
  const m15 = loadCandles("M15");
  const h4 = resampleUp(h1, 4);
  const daily = resampleUp(h1, 24);
  log(`  H1=${h1.length} M15=${m15.length} H4=${h4.length} D=${daily.length}`);
  const news = loadNews();
  const zByEvent = surpriseZScoreHistory(news);
  log(`  news events=${news.length}`);

  log("Building context + candidates…");
  const ctx = buildContext(h1, m15);
  const cands = buildCandidates(ctx, h4, daily, news, zByEvent);
  log(`  candidates=${cands.length}  (${cands[0]!.iso.slice(0, 10)} → ${cands.at(-1)!.iso.slice(0, 10)})`);

  const dev = cands.filter((c) => c.t < SEALED_START);
  const sealed = cands.filter((c) => c.t >= SEALED_START);
  log(`  dev=${dev.length}  sealed=${sealed.length}`);
  const byTime = new Map<string, Cand>(); cands.forEach((c) => byTime.set(c.iso, c));

  // Base-rate sanity: unconditional long/short win rates on dev.
  const baseLongWR = dev.filter((c) => c.long.cls === "win").length / dev.length;
  const baseShortWR = dev.filter((c) => c.short.cls === "win").length / dev.length;
  const ambiguousFrac = dev.filter((c) => c.long.cls === "ambiguous" || c.short.cls === "ambiguous").length / dev.length;
  log(`  base long WR=${(baseLongWR * 100).toFixed(1)}%  short WR=${(baseShortWR * 100).toFixed(1)}%  ambiguousFrac=${(ambiguousFrac * 100).toFixed(2)}%`);

  // ---- Walk-forward (headline model = base features) ----
  log("Walk-forward (base features)…");
  const wf = walkForward(dev, "base", 6);
  const oos = summarize(wf.oosTrades);
  log(`  OOS trades=${oos.trades} WR=${(oos.winRate * 100).toFixed(1)}% exp=${oos.expectancy.toFixed(3)}R totalR=${oos.totalR.toFixed(1)}`);

  // ---- Baselines on full dev universe (non-overlap) ----
  log("Baselines…");
  const rand = rng(12345);
  const baselinesUniverse: Record<string, Summary> = {
    random: summarize(nonOverlap(dev, () => (rand() < 0.5 ? "long" : "short"))),
    alwaysLong: summarize(nonOverlap(dev, () => "long")),
    alwaysShort: summarize(nonOverlap(dev, () => "short")),
    trend: summarize(nonOverlap(dev, (c) => (c.raw.ema_gap_h1! > 0 ? "long" : "short"))),
    momentum: summarize(nonOverlap(dev, (c) => (c.raw.mom_12! > 0 ? "long" : "short"))),
  };
  // Counterfactual on the model's OOS entry timestamps (isolates direction skill).
  const rand2 = rng(999);
  const baselinesOnOOS: Record<string, Summary> = {
    model: oos,
    random: counterfactual(wf.oosTrades, byTime, () => (rand2() < 0.5 ? "long" : "short")),
    alwaysLong: counterfactual(wf.oosTrades, byTime, () => "long"),
    alwaysShort: counterfactual(wf.oosTrades, byTime, () => "short"),
    trend: counterfactual(wf.oosTrades, byTime, (c) => (c.raw.ema_gap_h1! > 0 ? "long" : "short")),
    momentum: counterfactual(wf.oosTrades, byTime, (c) => (c.raw.mom_12! > 0 ? "long" : "short")),
  };
  // Existing engine on the model's OOS timestamps.
  const engDirs = await existingEngineDirections(h1, wf.oosTrades.map((t) => byTime.get(t.time)!.t));
  let existingEngine: Summary | null = null;
  if (engDirs) {
    existingEngine = counterfactual(wf.oosTrades, byTime, (c) => engDirs.get(c.t) ?? "long");
  }

  // ---- News ablation on the news-covered sub-period ----
  log("News ablation (covered period)…");
  const devNews = dev.filter((c) => c.t >= NEWS_START);
  let newsAblation: Record<string, Summary> = {};
  if (devNews.length > 1000) {
    const wfNone = walkForward(devNews, "base", 4);
    const wfFeat = walkForward(devNews, "news", 4);
    // avoidance: base model, drop candidates with a high-impact event within 60m
    const wfAvoidTrades = wfNone.oosTrades.filter((t) => !byTime.get(t.time)!.hiWithin60);
    newsAblation = {
      none: summarize(wfNone.oosTrades),
      avoid: summarize(wfAvoidTrades),
      features: summarize(wfFeat.oosTrades),
      highImpactOnly: summarize(wfNone.oosTrades.filter((t) => byTime.get(t.time)!.hiWithin60)),
    };
  }

  // ---- Sealed test (freeze: base features, expanding train on ALL dev) ----
  log("Sealed test…");
  const cutSealed = dev[Math.floor(dev.length * 0.85)]!.t;
  const fitSealed = dev.filter((c) => c.t < cutSealed);
  const validSealed = dev.filter((c) => c.t >= cutSealed);
  const sealedModel = trainLogit(toSamples(fitSealed, "base"), featNames("base"), { l2: 2.0, lr: 0.2, epochs: 250 });
  const sealedThreshold = selectThreshold(sealedModel, validSealed, "base").threshold;
  const sealedScored = sealed.map((c) => scoreCandidate(sealedModel, c, "base")).sort((a, b) => a.c.t - b.c.t);
  const sealedTrades = tradesFromScored(sealedScored, sealedThreshold);
  const sealedSummary = summarize(sealedTrades);
  log(`  sealed threshold=${sealedThreshold} trades=${sealedSummary.trades} WR=${(sealedSummary.winRate * 100).toFixed(1)}% exp=${sealedSummary.expectancy.toFixed(3)}R`);

  // ---- Confidence buckets (OOS) ----
  const buckets = confidenceBuckets(wf.oosTrades, COVERAGES);

  // ---- R:R sweep + hold-time sweep on frozen OOS+sealed trades ----
  log("R:R + hold-time sweeps…");
  const allFrozen = [...wf.oosTrades, ...sealedTrades];
  // map entry iso -> entry bar + risk, for re-resolving under other tp/horizons
  const wrapMap = new Map<string, { c: Bar; risk: number }>();
  cands.forEach((c) => wrapMap.set(c.iso, { c: c.i >= 0 ? h1[c.i]! : h1[0]!, risk: c.risk }));
  const rr: Record<string, Summary> = {};
  for (const tp of [1, 1.5, 2, 2.5, 3]) {
    const out: Trade[] = [];
    for (const t of allFrozen) {
      const w = wrapMap.get(t.time)!;
      const o = resolveOutcome({ direction: t.direction, entryH1: w.c, riskDistance: w.risk, tpR: tp, horizonMs: H, m15, slippagePips: SLIPPAGE_PIPS, cost: "net" });
      out.push({ time: t.time, direction: t.direction, r: o.r, cls: o.cls, holdMs: o.holdMs, conf: t.conf });
    }
    rr[`1:${tp}`] = summarize(out);
  }
  const holdSweep: Record<string, Summary> = {};
  for (const hh of [24, 48, 72, 96, 120]) {
    const out: Trade[] = [];
    for (const t of allFrozen) {
      const w = wrapMap.get(t.time)!;
      const o = resolveOutcome({ direction: t.direction, entryH1: w.c, riskDistance: w.risk, tpR: TP_R, horizonMs: hh * 3_600_000, m15, slippagePips: SLIPPAGE_PIPS, cost: "net" });
      out.push({ time: t.time, direction: t.direction, r: o.r, cls: o.cls, holdMs: o.holdMs, conf: t.conf });
    }
    holdSweep[`${hh}h`] = summarize(out);
  }

  // ---- GROSS vs NET on OOS trades ----
  const grossOOS = summarize(wf.oosTrades.map((t) => {
    const c = byTime.get(t.time)!;
    const o = t.direction === "long" ? c.longG : c.shortG;
    return { ...t, r: o.r, cls: o.cls };
  }));

  // ---- Parameter robustness ----
  // (a) stop-size k_atr: rebuild dev outcomes at each k, rerun the full walk-forward.
  // (b) threshold perturbation: shift the sealed model's selected threshold ±.
  log("Parameter robustness…");
  const robustnessKAtr: Array<{ kAtr: number; oosTrades: number; oosExp: number; oosWR: number }> = [];
  for (const kA of [0.85, 1.0, 1.15]) {
    const devK = kA === K_ATR ? dev : dev.map((c) => {
      const risk = Math.max(kA * c.atr, MIN_RISK_PIPS * PIP);
      const w = h1[c.i]!;
      const long = resolveOutcome({ direction: "long", entryH1: w, riskDistance: risk, tpR: TP_R, horizonMs: H, m15, slippagePips: SLIPPAGE_PIPS, cost: "net" });
      const short = resolveOutcome({ direction: "short", entryH1: w, riskDistance: risk, tpR: TP_R, horizonMs: H, m15, slippagePips: SLIPPAGE_PIPS, cost: "net" });
      return { ...c, risk, long, short } as Cand;
    });
    const s = summarize(walkForward(devK, "base", 4).oosTrades);
    robustnessKAtr.push({ kAtr: kA, oosTrades: s.trades, oosExp: +s.expectancy.toFixed(3), oosWR: +s.winRate.toFixed(3) });
  }
  const robustnessThreshold = [-0.04, -0.02, 0, 0.02, 0.04].map((d) => {
    const th = +(sealedThreshold + d).toFixed(2);
    const s = summarize(tradesFromScored(sealedScored, th));
    return { thresholdDelta: d, threshold: th, sealedTrades: s.trades, sealedExp: +s.expectancy.toFixed(3), sealedWR: +s.winRate.toFixed(3) };
  });

  // ---- Account simulation ($100 @ 1%) ----
  const account = {
    oos_100: simulateAccount(wf.oosTrades, 100),
    oos_1000: simulateAccount(wf.oosTrades, 1000),
    oos_10000: simulateAccount(wf.oosTrades, 10000),
    sealed_100: simulateAccount(sealedTrades, 100),
    combined_100: simulateAccount([...wf.oosTrades, ...sealedTrades].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)), 100),
  };

  const results = {
    generatedAt: new Date().toISOString(),
    runtimeSec: +((Date.now() - startedAt) / 1000).toFixed(1),
    config: { HORIZON_H, TP_R, K_ATR, MIN_RISK_PIPS, SLIPPAGE_PIPS, WARMUP, SEALED_START: new Date(SEALED_START).toISOString(), NEWS_START: new Date(NEWS_START).toISOString() },
    data: {
      instrument: "EUR_USD",
      h1Bars: h1.length, m15Bars: m15.length, h4Bars: h4.length, dailyBars: daily.length,
      range: { from: h1[0]!.iso, to: h1.at(-1)!.iso },
      candidates: cands.length, dev: dev.length, sealed: sealed.length,
      newsEvents: news.length, newsRange: news.length ? { from: new Date(news[0]!.t).toISOString(), to: new Date(news.at(-1)!.t).toISOString() } : null,
      medianSpreadNote: "~1.5 pip median (embedded in bid/ask); +0.5 pip slippage on NET",
    },
    baseRates: { baseLongWR, baseShortWR, ambiguousFrac, randomTheoretical: 1 / (1 + TP_R) },
    walkForward: { windows: wf.windows, oos: oos, oosWilsonLowerWR: wilsonLower(oos.wins, oos.trades) },
    grossVsNetOOS: { gross: grossOOS, net: oos },
    baselinesUniverse,
    baselinesOnOOS,
    existingEngine,
    newsAblation,
    sealed: { threshold: sealedThreshold, summary: sealedSummary, wilsonLowerWR: wilsonLower(sealedSummary.wins, sealedSummary.trades) },
    confidenceBuckets: buckets,
    rrSweep: rr,
    holdSweep,
    robustness: { kAtr: robustnessKAtr, threshold: robustnessThreshold },
    account,
    model: { featureNames: featNames("base"), intercept: sealedModel.intercept, coefficients: sealedModel.coef },
  };

  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(results, null, 2));
  log(`\nWrote ${path.join(OUT, "RESULTS.json")}  (${results.runtimeSec}s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
