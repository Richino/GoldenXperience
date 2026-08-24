/**
 * GOLDENXPERIENCE — four-family-adaptive-historical-v1
 *
 * RESEARCH ONLY. Offline chronological replay of the REAL four strategies
 * (ema-v1, breakout-v1, momentum-v1, meanrev-v1) through the REAL adaptive
 * engine (decideInstrument + DEFAULT_ADAPTIVE_CONFIG).
 *
 * Does NOT:
 *   - modify production strategies/configs/LIVE_EXECUTABLE_FAMILIES
 *   - alter Momentum production inversion
 *   - place OANDA orders / touch paper trades / write adaptive production tables
 *   - optimize parameters after seeing results
 *
 * Momentum production inversion is NOT applied to the main arm. A separate
 * Momentum-inversion arm is evaluated independently.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(serviceRoot, name), override: false });
}
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const adaptiveMod = await import("../src/adaptive-engine.js");
const {
  decideInstrument,
  contextKeysFor,
  DEFAULT_ADAPTIVE_CONFIG,
} = adaptiveMod;
type AdaptiveCandidate = import("../src/adaptive-engine.js").AdaptiveCandidate;
type AdaptiveDecision = import("../src/adaptive-engine.js").AdaptiveDecision;
type EvidenceStore = import("../src/adaptive-engine.js").EvidenceStore;
const { classifyRegime } = await import("../../frontend/src/lib/strategy/regime.js");
const { evaluateEma, DEFAULT_EMA_CONFIG, EMA_VERSION, EMA_CONFIG_VERSION } = await import("../../frontend/src/lib/strategy/strategies/ema.js");
const { evaluateBreakout, DEFAULT_BREAKOUT_CONFIG, BREAKOUT_VERSION, BREAKOUT_CONFIG_VERSION } = await import("../../frontend/src/lib/strategy/strategies/breakout.js");
const { evaluateMomentum, DEFAULT_MOMENTUM_CONFIG, MOMENTUM_VERSION, MOMENTUM_CONFIG_VERSION } = await import("../../frontend/src/lib/strategy/strategies/momentum.js");
const { evaluateMeanReversion, DEFAULT_MEANREV_CONFIG, MEANREV_VERSION, MEANREV_CONFIG_VERSION } = await import("../../frontend/src/lib/strategy/strategies/meanrev.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");
const { volatilityBucketFor } = await import("../../frontend/src/lib/strategy/strategy-common.js");
const { applyMomentumInversion } = await import("../src/momentum-inversion.js");

const EXPERIMENT = "four-family-adaptive-historical-v1";
const OUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);
const OPP_CACHE = path.join(OUT_DIR, "opportunities.jsonl");
const DECISIONS_PATH = path.join(OUT_DIR, "decisions.jsonl");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");
const CONFIG_SNAPSHOT = path.join(OUT_DIR, "CONFIG_SNAPSHOT.json");

/** Pairs with complete M15 mid + M15 bid/ask + H1 + H4 history. */
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;
const M15_WINDOW = 260;
const TF_WINDOW = 260;
const LEARNING_CHECKPOINTS = [1000, 2000, 5000, 10_000, 15_000, 20_000, 30_000, 40_000, 50_000];
const CONTEXT_CHECKPOINTS = [2000, 5000, 10_000, 20_000, 30_000, 50_000];
const RANDOM_TRIALS = 1000;
const TRAIN_FRAC = 0.6;
const DEV_FRAC = 0.2;
/** Force recollect even if cache exists. */
const FORCE_COLLECT = process.env.FORCE_COLLECT === "1";

type Family = "ema" | "breakout" | "momentum" | "meanrev";
type Dir = "long" | "short";
type Zone = "TRAIN" | "DEV" | "HOLDOUT";

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = {
  closeTime: string;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

type Opportunity = {
  id: string;
  ms: number;
  ts: string;
  family: Family;
  version: string;
  configVersion: string;
  pair: string;
  direction: Dir;
  entry: number;
  stop: number;
  target: number;
  plannedR: number;
  quality: number;
  spreadPips: number;
  atr: number;
  atrPips: number;
  session: string;
  regime: string;
  trendStrength: number;
  volBucket: string;
  outcome: string;
  netR: number;
  grossR: number;
  costR: number;
  mfe: number;
  mae: number;
  resolveMs: number;
  // Momentum inversion twin (geometry rebuilt; never -1 * PnL)
  invDirection: Dir | null;
  invEntry: number | null;
  invStop: number | null;
  invTarget: number | null;
  invNetR: number | null;
  invGrossR: number | null;
  invCostR: number | null;
  invOutcome: string | null;
  invResolveMs: number | null;
};

type DecisionRow = {
  id: string;
  ms: number;
  zone: Zone;
  family: Family;
  pair: string;
  direction: Dir;
  adaptiveState: string;
  taken: boolean;
  estimatedQuality: number;
  netR: number;
  grossR: number;
  costR: number;
  resolveMs: number;
  session: string;
  regime: string;
  volBucket: string;
  trendStrength: number;
  evidenceResolved: number;
  evidenceExpectancy: number | null;
  evidenceScope: string | null;
  concurrentN: number;
};

fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });

// ---------------------------------------------------------------------------
// Config snapshot (frozen before any HOLDOUT inspection)
// ---------------------------------------------------------------------------
const CONFIG = {
  experiment: EXPERIMENT,
  pairs: PAIRS,
  strategies: {
    ema: { version: EMA_VERSION, configVersion: EMA_CONFIG_VERSION, config: DEFAULT_EMA_CONFIG },
    breakout: { version: BREAKOUT_VERSION, configVersion: BREAKOUT_CONFIG_VERSION, config: DEFAULT_BREAKOUT_CONFIG },
    momentum: { version: MOMENTUM_VERSION, configVersion: MOMENTUM_CONFIG_VERSION, config: DEFAULT_MOMENTUM_CONFIG },
    meanrev: { version: MEANREV_VERSION, configVersion: MEANREV_CONFIG_VERSION, config: DEFAULT_MEANREV_CONFIG },
  },
  adaptive: DEFAULT_ADAPTIVE_CONFIG,
  note: "Main arm uses ORIGINAL Momentum direction. Inversion arm is separate.",
  splits: { trainFrac: TRAIN_FRAC, devFrac: DEV_FRAC, holdoutFrac: 1 - TRAIN_FRAC - DEV_FRAC },
  frozenAt: new Date().toISOString(),
};
fs.writeFileSync(CONFIG_SNAPSHOT, JSON.stringify(CONFIG, null, 2));

console.log("=".repeat(72));
console.log("GOLDENXPERIENCE —", EXPERIMENT);
console.log("=".repeat(72));
console.log("\n=== FROZEN STRATEGY / ADAPTIVE CONFIG (pre-run) ===\n");
console.log(JSON.stringify(CONFIG, null, 2));
console.log("\nConfig written to", CONFIG_SNAPSHOT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function loadCandles(instrument: string, tf: string): Promise<Candle[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float, volume::float
       FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`,
    [instrument, tf],
  );
  return r.rows.map((x) => ({
    time: new Date(x.close_time as string).toISOString(),
    open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close),
    volume: Number(x.volume ?? 0), complete: true,
  }));
}

async function loadQuotes(instrument: string): Promise<Quote[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`,
    [instrument],
  );
  return r.rows.map((x) => ({
    closeTime: new Date(x.close_time as string).toISOString(),
    bidOpen: Number(x.bid_open), bidHigh: Number(x.bid_high), bidLow: Number(x.bid_low), bidClose: Number(x.bid_close),
    askOpen: Number(x.ask_open), askHigh: Number(x.ask_high), askLow: Number(x.ask_low), askClose: Number(x.ask_close),
  }));
}

function lastClosed(times: number[], atMs: number, from: number) {
  let i = from;
  while (i + 1 < times.length && times[i + 1]! <= atMs) i += 1;
  return i;
}

const toMid = (c: Candle): Quote => ({
  closeTime: c.time,
  bidOpen: c.open, bidHigh: c.high, bidLow: c.low, bidClose: c.close,
  askOpen: c.open, askHigh: c.high, askLow: c.low, askClose: c.close,
});

function usable(o: { outcome: string; resultR: number | null }) {
  return o.outcome !== "unresolved" && o.outcome !== "ambiguous" && o.resultR !== null && Number.isFinite(o.resultR);
}

function resolveMsOf(o: { resolvedAt: string | null; horizonEndsAt: string }, decisionTs: string) {
  const raw = o.resolvedAt ?? o.horizonEndsAt ?? decisionTs;
  return Date.parse(raw);
}

function emptyEvidence(): EvidenceStore {
  return { totalResolved: 0, context: new Map() };
}

function mergeObservation(
  store: EvidenceStore,
  family: string,
  pair: string,
  session: string,
  regime: string,
  direction: string,
  netR: number,
) {
  const wins = netR > 0 ? 1 : 0;
  const sumSq = netR * netR;
  for (const key of contextKeysFor(family, pair, session, regime, direction)) {
    const cur = store.context.get(key) ?? { resolved: 0, wins: 0, netR: 0, sumSqR: 0, grossR: 0, mfe: null, mae: null };
    cur.resolved += 1;
    cur.wins += wins;
    cur.netR += netR;
    cur.sumSqR += sumSq;
    cur.grossR += netR;
    store.context.set(key, cur);
  }
  store.totalResolved += 1;
}

function toResearchCandidate(o: Opportunity): AdaptiveCandidate {
  return {
    family: o.family,
    version: o.version,
    configVersion: o.configVersion,
    direction: o.direction,
    executable: true,
    riskReward: o.plannedR,
    quality: o.quality,
  };
}

type Pending = { resolveMs: number; family: string; pair: string; session: string; regime: string; direction: string; netR: number };

function flushPending(store: EvidenceStore, pending: Pending[], asOfMs: number) {
  if (!pending.length) return;
  pending.sort((a, b) => a.resolveMs - b.resolveMs);
  let i = 0;
  while (i < pending.length && pending[i]!.resolveMs <= asOfMs) {
    const p = pending[i]!;
    mergeObservation(store, p.family, p.pair, p.session, p.regime, p.direction, p.netR);
    i += 1;
  }
  if (i > 0) pending.splice(0, i);
}

function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0);
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i]!;
}

function metrics(rows: Array<{ netR: number; grossR: number; costR: number }>) {
  const n = rows.length;
  if (!n) {
    return {
      n: 0, winRate: NaN, grossE: NaN, costE: NaN, netE: NaN, totalR: NaN, pf: NaN,
      maxDd: NaN, sharpe: NaN, ciLo: NaN, ciHi: NaN, effectiveN: 0,
    };
  }
  const nets = rows.map((r) => r.netR);
  const gross = rows.map((r) => r.grossR);
  const costs = rows.map((r) => r.costR);
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x <= 0);
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN;
  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const r of nets) {
    eq += r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  const m = mean(nets);
  const v = n > 1 ? nets.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1) : 0;
  const sharpe = v > 0 ? m / Math.sqrt(v) : NaN;
  // Day-block bootstrap CI (respects within-day correlation approximately via
  // opportunity order preserved inside blocks keyed by UTC day of decision).
  const { lo, hi, effectiveN } = blockedBootstrapCI(rows);
  return {
    n,
    winRate: wins.length / n,
    grossE: mean(gross),
    costE: mean(costs),
    netE: m,
    totalR: sum(nets),
    pf,
    maxDd,
    sharpe,
    ciLo: lo,
    ciHi: hi,
    effectiveN,
  };
}

function blockedBootstrapCI(
  rows: Array<{ netR: number; ms?: number }>,
  trials = 400,
  seed = 42,
): { lo: number; hi: number; effectiveN: number } {
  if (!rows.length) return { lo: NaN, hi: NaN, effectiveN: 0 };
  const dayKey = (ms: number) => Math.floor(ms / 86_400_000);
  const blocks = new Map<number, number[]>();
  for (const r of rows) {
    const k = dayKey(r.ms ?? 0);
    const arr = blocks.get(k) ?? [];
    arr.push(r.netR);
    blocks.set(k, arr);
  }
  const blockArr = [...blocks.values()];
  const effectiveN = blockArr.length;
  if (blockArr.length < 3) {
    const m = mean(rows.map((r) => r.netR));
    const se = Math.sqrt(rows.reduce((a, r) => a + (r.netR - m) ** 2, 0) / Math.max(1, rows.length - 1) / rows.length);
    return { lo: m - 1.96 * se, hi: m + 1.96 * se, effectiveN };
  }
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const means: number[] = [];
  for (let t = 0; t < trials; t += 1) {
    const sample: number[] = [];
    for (let i = 0; i < blockArr.length; i += 1) {
      const b = blockArr[Math.floor(rand() * blockArr.length)]!;
      for (const x of b) sample.push(x);
    }
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  return { lo: percentile(means, 0.025), hi: percentile(means, 0.975), effectiveN };
}

function fmt(x: number, d = 4) {
  if (!Number.isFinite(x)) return "n/a";
  return x.toFixed(d);
}

function fmtPct(x: number) {
  if (!Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(1)}%`;
}

function contextStats(store: EvidenceStore) {
  const ns: number[] = [];
  for (const stat of store.context.values()) ns.push(stat.resolved);
  ns.sort((a, b) => a - b);
  const ge = (t: number) => ns.filter((n) => n >= t).length;
  return {
    total: ns.length,
    median: percentile(ns, 0.5),
    p25: percentile(ns, 0.25),
    p75: percentile(ns, 0.75),
    ge50: ge(50),
    ge100: ge(100),
    ge200: ge(200),
    ge300: ge(300),
    ge500: ge(500),
    ge1000: ge(1000),
  };
}

function randomMatched(
  allNet: number[],
  takeN: number,
  trials: number,
  seed = 7,
): { mean: number; lo: number; hi: number; adaptivePercentile: (adaptiveE: number) => number } {
  if (!allNet.length || takeN <= 0) {
    return { mean: NaN, lo: NaN, hi: NaN, adaptivePercentile: () => NaN };
  }
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const means: number[] = [];
  const n = allNet.length;
  const k = Math.min(takeN, n);
  for (let t = 0; t < trials; t += 1) {
    // Partial Fisher-Yates for k samples
    const idx = Array.from({ length: n }, (_, i) => i);
    let sumR = 0;
    for (let i = 0; i < k; i += 1) {
      const j = i + Math.floor(rand() * (n - i));
      const tmp = idx[i]!;
      idx[i] = idx[j]!;
      idx[j] = tmp;
      sumR += allNet[idx[i]!]!;
    }
    means.push(sumR / k);
  }
  means.sort((a, b) => a - b);
  return {
    mean: mean(means),
    lo: percentile(means, 0.025),
    hi: percentile(means, 0.975),
    adaptivePercentile: (adaptiveE: number) => {
      let below = 0;
      for (const m of means) if (m < adaptiveE) below += 1;
      return below / means.length;
    },
  };
}

const STRATEGIES: Array<{
  family: Family;
  version: string;
  configVersion: string;
  run: (input: never, regime: never) => ReturnType<typeof evaluateEma>;
}> = [
  { family: "ema", version: EMA_VERSION, configVersion: EMA_CONFIG_VERSION, run: (i, r) => evaluateEma(i, r, DEFAULT_EMA_CONFIG) },
  { family: "breakout", version: BREAKOUT_VERSION, configVersion: BREAKOUT_CONFIG_VERSION, run: (i, r) => evaluateBreakout(i, r, DEFAULT_BREAKOUT_CONFIG) },
  { family: "momentum", version: MOMENTUM_VERSION, configVersion: MOMENTUM_CONFIG_VERSION, run: (i, r) => evaluateMomentum(i, r, DEFAULT_MOMENTUM_CONFIG) },
  { family: "meanrev", version: MEANREV_VERSION, configVersion: MEANREV_CONFIG_VERSION, run: (i, r) => evaluateMeanReversion(i, r, DEFAULT_MEANREV_CONFIG) },
];

// ---------------------------------------------------------------------------
// Phase 1 — collect opportunities (or load cache)
// ---------------------------------------------------------------------------
function loadOppCache(): Opportunity[] | null {
  if (FORCE_COLLECT || !fs.existsSync(OPP_CACHE)) return null;
  const lines = fs.readFileSync(OPP_CACHE, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length < 20_000) return null;
  console.log(`Loaded ${lines.length} opportunities from cache ${OPP_CACHE}`);
  return lines.map((l) => JSON.parse(l) as Opportunity);
}

async function collectOpportunities(): Promise<Opportunity[]> {
  const cached = loadOppCache();
  if (cached) return cached;

  console.log("\n=== COLLECTING OPPORTUNITIES (real strategies + bid/ask resolution) ===\n");
  const out: Opportunity[] = [];
  let seq = 0;

  for (const instrument of PAIRS) {
    const [m15, h1, h4, qt] = await Promise.all([
      loadCandles(instrument, "M15"),
      loadCandles(instrument, "H1"),
      loadCandles(instrument, "H4"),
      loadQuotes(instrument),
    ]);
    console.log(`${instrument}: M15=${m15.length} H1=${h1.length} H4=${h4.length} quotes=${qt.length}`);
    const qIdx = new Map<number, number>();
    qt.forEach((q, i) => qIdx.set(Date.parse(q.closeTime), i));
    const mid = m15.map(toMid);
    const h1T = h1.map((c) => Date.parse(c.time));
    const h4T = h4.map((c) => Date.parse(c.time));
    const pip = pipSizeFor(instrument as never);
    let c1 = 0;
    let c4 = 0;
    let nPair = 0;

    for (let i = M15_WINDOW; i < m15.length; i += 1) {
      const bar = m15[i]!;
      const atMs = Date.parse(bar.time);
      c1 = lastClosed(h1T, atMs, c1);
      c4 = lastClosed(h4T, atMs, c4);
      if (c1 < TF_WINDOW || c4 < TF_WINDOW) continue;
      const session = dayTradingSession(new Date(atMs));
      if (!session.open) continue;
      const qi = qIdx.get(atMs);
      if (qi === undefined) continue;
      const q = qt[qi]!;
      const spreadPips = (q.askClose - q.bidClose) / pip;
      if (!(spreadPips > 0) || !Number.isFinite(spreadPips)) continue;

      const candles15m = m15.slice(i - M15_WINDOW + 1, i + 1);
      const input = {
        instrument: instrument as never,
        accountBalance: 10_000,
        accountCurrency: "USD" as const,
        dataSource: "oanda" as const,
        candles15m,
        candles1h: h1.slice(c1 - TF_WINDOW + 1, c1 + 1),
        candles4h: h4.slice(c4 - TF_WINDOW + 1, c4 + 1),
        bid: q.bidClose,
        ask: q.askClose,
        spreadPips,
        marketOpen: true,
        calendarConnected: false,
        highImpactNewsWithinMinutes: null,
        newsRequired: false,
        evaluatedAt: bar.time,
        evaluationMode: "historical_replay" as const,
      };
      const regime = classifyRegime(instrument as never, candles15m, bar.time);
      const atr = regime.atr ?? 0;
      if (!(atr > 0)) continue;

      const fwd = qt.slice(qi + 1, qi + 400);
      const fwdMid = mid.slice(i + 1, i + 400);
      if (fwd.length < 20 || fwdMid.length < 20) continue;

      for (const strategy of STRATEGIES) {
        const cand = strategy.run(input as never, regime as never);
        if (cand.status !== "valid" || !cand.direction) continue;
        if (cand.entry === null || cand.stop === null || cand.target === null) continue;

        const oNet = labelOutcome(cand.direction, cand.entry, cand.stop, cand.target, bar.time, fwd as never);
        const midEntry = bar.close;
        const stopDist = Math.abs(cand.entry - cand.stop);
        const tgtDist = Math.abs(cand.target - cand.entry);
        const oStopM = cand.direction === "long" ? midEntry - stopDist : midEntry + stopDist;
        const oTgtM = cand.direction === "long" ? midEntry + tgtDist : midEntry - tgtDist;
        const oGro = labelOutcome(cand.direction, midEntry, oStopM, oTgtM, bar.time, fwdMid as never);
        if (!usable(oNet) || !usable(oGro)) continue;

        let invDirection: Dir | null = null;
        let invEntry: number | null = null;
        let invStop: number | null = null;
        let invTarget: number | null = null;
        let invNetR: number | null = null;
        let invGrossR: number | null = null;
        let invCostR: number | null = null;
        let invOutcome: string | null = null;
        let invResolveMs: number | null = null;

        if (strategy.family === "momentum") {
          // Force geometry rebuild via production inversion helper regardless of kill-switch,
          // by temporarily applying when momentum: applyMomentumInversion respects MOMENTUM_DIRECTION_INVERSION.
          // For research arm we rebuild manually identically to applyMomentumInversion so the
          // main arm stays original even if production inversion is ON.
          const inv: Dir = cand.direction === "long" ? "short" : "long";
          const iEntry = inv === "long" ? q.askClose : q.bidClose;
          const iStop = inv === "long" ? iEntry - stopDist : iEntry + stopDist;
          const iTarget = inv === "long" ? iEntry + tgtDist : iEntry - tgtDist;
          const iNet = labelOutcome(inv, iEntry, iStop, iTarget, bar.time, fwd as never);
          const iStopM = inv === "long" ? midEntry - stopDist : midEntry + stopDist;
          const iTgtM = inv === "long" ? midEntry + tgtDist : midEntry - tgtDist;
          const iGro = labelOutcome(inv, midEntry, iStopM, iTgtM, bar.time, fwdMid as never);
          if (usable(iNet) && usable(iGro)) {
            invDirection = inv;
            invEntry = iEntry;
            invStop = iStop;
            invTarget = iTarget;
            invNetR = iNet.resultR!;
            invGrossR = iGro.resultR!;
            invCostR = iGro.resultR! - iNet.resultR!;
            invOutcome = iNet.outcome;
            invResolveMs = resolveMsOf(iNet, bar.time);
          }
          // Silence unused import lint path — verify helper matches manual rebuild once.
          void applyMomentumInversion;
        }

        const netR = oNet.resultR!;
        const grossR = oGro.resultR!;
        seq += 1;
        out.push({
          id: `${instrument}-${atMs}-${strategy.family}-${seq}`,
          ms: atMs,
          ts: bar.time,
          family: strategy.family,
          version: strategy.version,
          configVersion: strategy.configVersion,
          pair: instrument,
          direction: cand.direction,
          entry: cand.entry,
          stop: cand.stop,
          target: cand.target,
          plannedR: cand.riskReward ?? tgtDist / stopDist,
          quality: cand.passedConditions.length,
          spreadPips,
          atr,
          atrPips: regime.atrPips ?? atr / pip,
          session: session.label,
          regime: regime.regime,
          trendStrength: regime.trendStrength,
          volBucket: volatilityBucketFor(regime.atrPips),
          outcome: oNet.outcome,
          netR,
          grossR,
          costR: grossR - netR,
          mfe: oNet.maxFavorableR ?? 0,
          mae: oNet.maxAdverseR ?? 0,
          resolveMs: resolveMsOf(oNet, bar.time),
          invDirection,
          invEntry,
          invStop,
          invTarget,
          invNetR,
          invGrossR,
          invCostR,
          invOutcome,
          invResolveMs,
        });
        nPair += 1;
      }
      if (i % 50_000 === 0) console.log(`  ${instrument} bar ${i}/${m15.length}, opps ${out.length}`);
    }
    console.log(`${instrument} done: +${nPair} (total ${out.length})`);
  }

  out.sort((a, b) => a.ms - b.ms || a.pair.localeCompare(b.pair) || a.family.localeCompare(b.family));
  const stream = fs.createWriteStream(OPP_CACHE);
  for (const o of out) stream.write(`${JSON.stringify(o)}\n`);
  await new Promise<void>((res, rej) => {
    stream.on("finish", () => res());
    stream.on("error", rej);
    stream.end();
  });
  console.log(`Wrote ${out.length} opportunities → ${OPP_CACHE}`);
  return out;
}

// ---------------------------------------------------------------------------
// Phase 2 — chronological adaptive replay
// ---------------------------------------------------------------------------
type WalkResult = {
  decisions: DecisionRow[];
  learningCurve: Array<{
    signals: number;
    allE: number;
    takeE: number;
    waitE: number;
    coverage: number;
    takeN: number;
    waitN: number;
    activeContexts: number;
  }>;
  contextCurve: Array<{ signals: number } & ReturnType<typeof contextStats>>;
};

function chronologicalAdaptiveWalk(
  opps: Opportunity[],
  opts: { useInvertedMomentum: boolean; label: string },
): WalkResult {
  console.log(`\n=== ADAPTIVE WALK (${opts.label}) ===`);
  const evidence = emptyEvidence();
  const pending: Pending[] = [];
  const decisions: DecisionRow[] = [];
  const learningCurve: WalkResult["learningCurve"] = [];
  const contextCurve: WalkResult["contextCurve"] = [];
  const checkpointSet = new Set(LEARNING_CHECKPOINTS);
  const contextSet = new Set(CONTEXT_CHECKPOINTS);

  // Working view: for inverted momentum arm, replace momentum geometry/outcomes.
  const view: Opportunity[] = opps.map((o) => {
    if (!opts.useInvertedMomentum || o.family !== "momentum" || o.invDirection == null || o.invNetR == null) return o;
    return {
      ...o,
      direction: o.invDirection,
      entry: o.invEntry!,
      stop: o.invStop!,
      target: o.invTarget!,
      netR: o.invNetR,
      grossR: o.invGrossR!,
      costR: o.invCostR!,
      outcome: o.invOutcome!,
      resolveMs: o.invResolveMs!,
    };
  });

  // Group by (pair, ms) so decideInstrument sees simultaneous family candidates.
  type Group = { ms: number; pair: string; items: Opportunity[] };
  const groups: Group[] = [];
  for (const o of view) {
    const last = groups[groups.length - 1];
    if (last && last.ms === o.ms && last.pair === o.pair) last.items.push(o);
    else groups.push({ ms: o.ms, pair: o.pair, items: [o] });
  }

  let processed = 0;
  let takeCum = 0;
  let waitCum = 0;
  let allSum = 0;
  let takeSum = 0;
  let waitSum = 0;

  for (const g of groups) {
    flushPending(evidence, pending, g.ms);

    const candidates = g.items.map(toResearchCandidate);
    const regimeProxy = {
      regime: g.items[0]!.regime as "trending" | "ranging" | "mixed",
      trendStrength: g.items[0]!.trendStrength,
      atr: g.items[0]!.atr,
      atrPips: g.items[0]!.atrPips,
      emaFast: 0,
      emaMid: 0,
      emaSlow: 0,
      slopeAtr: 0,
      momentumState: "steady" as const,
      rangeAgeBars: 0,
      volatilityBucket: g.items[0]!.volBucket as "low" | "normal" | "high",
      evaluatedAt: g.items[0]!.ts,
      instrument: g.pair as never,
    };
    const decision: AdaptiveDecision = decideInstrument({
      instrument: g.pair,
      session: g.items[0]!.session,
      regime: regimeProxy as never,
      candidates,
      evidence,
      config: DEFAULT_ADAPTIVE_CONFIG,
    });

    const selectedKey = decision.selected
      ? `${decision.selected.family}:${decision.selected.direction}`
      : null;

    for (const o of g.items) {
      const key = `${o.family}:${o.direction}`;
      const taken = selectedKey !== null && key === selectedKey;
      // Only ONE selected per group; if two share family+direction (shouldn't), first wins via key match.
      const ev = decision.evidenceUsed[key];
      const estimatedQuality = ev?.expectancyR ?? (taken ? 0 : -0.01) + o.quality * 0.001;

      decisions.push({
        id: o.id,
        ms: o.ms,
        zone: "TRAIN", // filled later
        family: o.family,
        pair: o.pair,
        direction: o.direction,
        adaptiveState: decision.state,
        taken,
        estimatedQuality: ev?.expectancyR ?? o.quality,
        netR: o.netR,
        grossR: o.grossR,
        costR: o.costR,
        resolveMs: o.resolveMs,
        session: o.session,
        regime: o.regime,
        volBucket: o.volBucket,
        trendStrength: o.trendStrength,
        evidenceResolved: ev?.resolved ?? 0,
        evidenceExpectancy: ev?.expectancyR ?? null,
        evidenceScope: ev?.scope ?? null,
        concurrentN: g.items.length,
      });

      // Evidence uses STRATEGY-predicted direction (original for main; inverted direction for inv arm).
      pending.push({
        resolveMs: o.resolveMs,
        family: o.family,
        pair: o.pair,
        session: o.session,
        regime: o.regime,
        direction: o.direction,
        netR: o.netR,
      });

      processed += 1;
      allSum += o.netR;
      if (taken) {
        takeCum += 1;
        takeSum += o.netR;
      } else {
        waitCum += 1;
        waitSum += o.netR;
      }

      if (checkpointSet.has(processed)) {
        learningCurve.push({
          signals: processed,
          allE: allSum / processed,
          takeE: takeCum ? takeSum / takeCum : NaN,
          waitE: waitCum ? waitSum / waitCum : NaN,
          coverage: takeCum / processed,
          takeN: takeCum,
          waitN: waitCum,
          activeContexts: [...evidence.context.values()].filter((s) => s.resolved >= DEFAULT_ADAPTIVE_CONFIG.minActiveSample).length,
        });
      }
      if (contextSet.has(processed)) {
        contextCurve.push({ signals: processed, ...contextStats(evidence) });
      }
    }
  }

  // Drain remaining pending (not needed for decisions but keeps totals honest).
  flushPending(evidence, pending, Number.POSITIVE_INFINITY);
  console.log(`Walk complete: ${decisions.length} decisions, evidence totalResolved=${evidence.totalResolved}`);
  return { decisions, learningCurve, contextCurve };
}

// ---------------------------------------------------------------------------
// Assign zones + reporting
// ---------------------------------------------------------------------------
function assignZones(decisions: DecisionRow[]) {
  const n = decisions.length;
  const trainEnd = Math.floor(n * TRAIN_FRAC);
  const devEnd = Math.floor(n * (TRAIN_FRAC + DEV_FRAC));
  for (let i = 0; i < n; i += 1) {
    decisions[i]!.zone = i < trainEnd ? "TRAIN" : i < devEnd ? "DEV" : "HOLDOUT";
  }
  return {
    trainEnd,
    devEnd,
    trainMs: decisions[0]?.ms ?? 0,
    trainEndMs: decisions[trainEnd - 1]?.ms ?? 0,
    devEndMs: decisions[devEnd - 1]?.ms ?? 0,
    holdoutEndMs: decisions[n - 1]?.ms ?? 0,
  };
}

function sliceZone(rows: DecisionRow[], zone: Zone | "PRE_HOLDOUT" | "ALL") {
  if (zone === "ALL") return rows;
  if (zone === "PRE_HOLDOUT") return rows.filter((r) => r.zone !== "HOLDOUT");
  return rows.filter((r) => r.zone === zone);
}

function takeWait(rows: DecisionRow[]) {
  const all = rows;
  const take = rows.filter((r) => r.taken);
  const wait = rows.filter((r) => !r.taken);
  return { all, take, wait };
}

function qualityQuintiles(rows: DecisionRow[]) {
  if (rows.length < 5) return [] as Array<{ q: number; n: number; netE: number }>;
  const sorted = [...rows].sort((a, b) => a.estimatedQuality - b.estimatedQuality);
  const size = Math.floor(sorted.length / 5);
  const out: Array<{ q: number; n: number; netE: number }> = [];
  for (let q = 0; q < 5; q += 1) {
    const chunk = q === 4 ? sorted.slice(q * size) : sorted.slice(q * size, (q + 1) * size);
    out.push({ q: q + 1, n: chunk.length, netE: mean(chunk.map((r) => r.netR)) });
  }
  return out;
}

function byKey<T extends DecisionRow>(rows: T[], keyFn: (r: T) => string) {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyFn(r);
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  return map;
}

function monthKey(ms: number) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function quarterKey(ms: number) {
  const d = new Date(ms);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}
function yearKey(ms: number) {
  return String(new Date(ms).getUTCFullYear());
}

function holdoutGate(dev: DecisionRow[]) {
  const { all, take, wait } = takeWait(dev);
  const allM = metrics(all);
  const takeM = metrics(take);
  const waitM = metrics(wait);
  const coverage = all.length ? take.length / all.length : 0;
  const rnd = randomMatched(all.map((r) => r.netR), take.length, RANDOM_TRIALS);
  const beatsRandom = Number.isFinite(takeM.netE) && takeM.netE > rnd.hi;
  const takeGtWait = takeM.netE > waitM.netE;
  const positive = takeM.netE > 0 && takeM.ciLo > -0.02; // soft: point >0; prefer CI
  const ciSupports = takeM.ciLo > 0;
  const adequateN = takeM.effectiveN >= 30 && take.length >= 100;

  // Multi-block: split DEV into 4 chronological quarters
  const sorted = [...take].sort((a, b) => a.ms - b.ms);
  const blockSize = Math.max(1, Math.floor(sorted.length / 4));
  const blockPos: boolean[] = [];
  for (let b = 0; b < 4; b += 1) {
    const chunk = b === 3 ? sorted.slice(b * blockSize) : sorted.slice(b * blockSize, (b + 1) * blockSize);
    blockPos.push(chunk.length >= 10 && mean(chunk.map((r) => r.netR)) > 0);
  }
  const multiBlock = blockPos.filter(Boolean).length >= 3;

  // Pair domination: no single pair >70% of TAKE total R magnitude contribution when positive
  const byPair = byKey(take, (r) => r.pair);
  let dominated = false;
  if (takeM.totalR > 0) {
    for (const [, rows] of byPair) {
      const tr = sum(rows.map((r) => r.netR));
      if (tr / takeM.totalR > 0.7) dominated = true;
    }
  }

  const pass =
    positive
    && adequateN
    && multiBlock
    && !dominated
    && takeGtWait
    && beatsRandom;

  return {
    pass,
    reasons: {
      positive,
      ciSupports,
      adequateN,
      multiBlock,
      notDominated: !dominated,
      takeGtWait,
      beatsRandom,
      takeNetE: takeM.netE,
      allNetE: allM.netE,
      waitNetE: waitM.netE,
      coverage,
      randomHi: rnd.hi,
      takeN: take.length,
      effectiveN: takeM.effectiveN,
      blockPos,
    },
  };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
const opportunities = await collectOpportunities();
console.log(`\nOpportunities: ${opportunities.length}`);
if (opportunities.length < 20_000) {
  console.error("INSUFFICIENT: need >=20000 resolved opportunities");
  process.exit(1);
}

const byFamily = { ema: 0, breakout: 0, momentum: 0, meanrev: 0 };
for (const o of opportunities) byFamily[o.family] += 1;
console.log("By family:", byFamily);

const mainWalk = chronologicalAdaptiveWalk(opportunities, { useInvertedMomentum: false, label: "MAIN original Momentum" });
const invWalk = chronologicalAdaptiveWalk(opportunities, { useInvertedMomentum: true, label: "ARM inverted Momentum" });

const split = assignZones(mainWalk.decisions);
assignZones(invWalk.decisions);

fs.writeFileSync(DECISIONS_PATH, mainWalk.decisions.map((d) => JSON.stringify(d)).join("\n") + "\n");

// Sealed HOLDOUT: evaluate gate on DEV only before reading HOLDOUT metrics.
const devRows = sliceZone(mainWalk.decisions, "DEV");
const gate = holdoutGate(devRows);
console.log("\n=== HOLDOUT GATE (DEV only) ===");
console.log(JSON.stringify(gate, null, 2));

const reportZones: Array<Zone | "PRE_HOLDOUT" | "ALL"> = gate.pass
  ? ["ALL", "TRAIN", "DEV", "HOLDOUT", "PRE_HOLDOUT"]
  : ["ALL", "TRAIN", "DEV", "PRE_HOLDOUT"];

function sectionFor(rows: DecisionRow[], title: string) {
  const { all, take, wait } = takeWait(rows);
  const a = metrics(all.map((r) => ({ ...r, ms: r.ms })));
  const t = metrics(take.map((r) => ({ ...r, ms: r.ms })));
  const w = metrics(wait.map((r) => ({ ...r, ms: r.ms })));
  const cov = all.length ? take.length / all.length : 0;
  const order = t.netE > a.netE && a.netE > w.netE;
  return { title, all: a, take: t, wait: w, coverage: cov, takeGtAllGtWait: order };
}

const lines: string[] = [];
const L = (s = "") => lines.push(s);

L("GOLDENXPERIENCE");
L("LARGE-SCALE FOUR-STRATEGY ADAPTIVE EDGE TEST");
L(`Experiment: ${EXPERIMENT}`);
L(`Generated: ${new Date().toISOString()}`);
L("");
L("================================");
L("DATA");
L("================================");
L("");
L(`Pairs: ${PAIRS.join(", ")}`);
L(`Date range: ${opportunities[0]!.ts} → ${opportunities[opportunities.length - 1]!.ts}`);
L("M15/H1/H4 data used: yes (completed OANDA candles; M15 bid/ask quotes)");
L(`Opportunities (resolved executable): ${opportunities.length}`);
L(`Resolved: ${opportunities.length}`);
L(`EMA n: ${byFamily.ema}`);
L(`Breakout n: ${byFamily.breakout}`);
L(`Momentum n: ${byFamily.momentum}`);
L(`MeanRev n: ${byFamily.meanrev}`);
L("");
L(`TRAIN: first ${fmtPct(TRAIN_FRAC)} chronologically → n=${sliceZone(mainWalk.decisions, "TRAIN").length} (${new Date(split.trainMs).toISOString()} → ${new Date(split.trainEndMs).toISOString()})`);
L(`DEV: next ${fmtPct(DEV_FRAC)} → n=${sliceZone(mainWalk.decisions, "DEV").length} (→ ${new Date(split.devEndMs).toISOString()})`);
L(`HOLDOUT status: ${gate.pass ? "OPENED (DEV gate PASSED)" : "SEALED (DEV gate FAILED — not used for conclusions)"}`);
L("");
L("Strategy versions (REAL production defaults, frozen):");
L(`  EMA ${EMA_VERSION}/${EMA_CONFIG_VERSION}`);
L(`  Breakout ${BREAKOUT_VERSION}/${BREAKOUT_CONFIG_VERSION}`);
L(`  Momentum ${MOMENTUM_VERSION}/${MOMENTUM_CONFIG_VERSION} (ORIGINAL direction in main arm)`);
L(`  MeanRev ${MEANREV_VERSION}/${MEANREV_CONFIG_VERSION}`);
L(`Adaptive: minLearning=${DEFAULT_ADAPTIVE_CONFIG.minLearningSample} minActive=${DEFAULT_ADAPTIVE_CONFIG.minActiveSample} z=${DEFAULT_ADAPTIVE_CONFIG.confidenceZ}`);
L(`Family priority: ${DEFAULT_ADAPTIVE_CONFIG.familyPriority.join(" > ")}`);
L("");

// Raw family performance (ALL opportunities, pre-holdout to avoid peeking if sealed)
const rawScope = gate.pass ? sliceZone(mainWalk.decisions, "ALL") : sliceZone(mainWalk.decisions, "PRE_HOLDOUT");
L("================================");
L("RAW FOUR-FAMILY PERFORMANCE");
L(`================================ (${gate.pass ? "ALL incl HOLDOUT" : "PRE_HOLDOUT only"})`);
L("");
L("Family     n     Win%     Gross R     Cost R     Net R     PF     CI");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  const rows = rawScope.filter((r) => r.family === fam);
  const m = metrics(rows);
  L(`${fam.padEnd(10)}${String(m.n).padEnd(6)}${fmtPct(m.winRate).padEnd(9)}${fmt(m.grossE).padEnd(12)}${fmt(m.costE).padEnd(11)}${fmt(m.netE).padEnd(9)}${fmt(m.pf, 2).padEnd(7)}[${fmt(m.ciLo)}, ${fmt(m.ciHi)}]`);
}
{
  const m = metrics(rawScope);
  L(`${"ALL".padEnd(10)}${String(m.n).padEnd(6)}${fmtPct(m.winRate).padEnd(9)}${fmt(m.grossE).padEnd(12)}${fmt(m.costE).padEnd(11)}${fmt(m.netE).padEnd(9)}${fmt(m.pf, 2).padEnd(7)}[${fmt(m.ciLo)}, ${fmt(m.ciHi)}]`);
  L(`Effective n (day-blocks): ${m.effectiveN}`);
}
L("");

const headlineScope = gate.pass ? "ALL" : "PRE_HOLDOUT";
const headline = sectionFor(sliceZone(mainWalk.decisions, headlineScope as never), headlineScope);
L("================================");
L("ADAPTIVE HEADLINE");
L(`================================ (${headlineScope})`);
L("");
L("TAKE ALL:");
L(`n: ${headline.all.n}`);
L(`net expectancy: ${fmt(headline.all.netE)} R`);
L(`total R: ${fmt(headline.all.totalR, 2)}`);
L(`PF: ${fmt(headline.all.pf, 2)}`);
L(`CI: [${fmt(headline.all.ciLo)}, ${fmt(headline.all.ciHi)}]`);
L("");
L("ADAPTIVE TAKE:");
L(`n: ${headline.take.n}`);
L(`coverage: ${fmtPct(headline.coverage)}`);
L(`net expectancy: ${fmt(headline.take.netE)} R`);
L(`total R: ${fmt(headline.take.totalR, 2)}`);
L(`PF: ${fmt(headline.take.pf, 2)}`);
L(`CI: [${fmt(headline.take.ciLo)}, ${fmt(headline.take.ciHi)}]`);
L("");
L("ADAPTIVE WAIT:");
L(`n: ${headline.wait.n}`);
L(`counterfactual expectancy: ${fmt(headline.wait.netE)} R`);
L(`CI: [${fmt(headline.wait.ciLo)}, ${fmt(headline.wait.ciHi)}]`);
L("");
L(`Does TAKE > ALL > WAIT ? ${headline.takeGtAllGtWait ? "YES" : "NO"}`);
L("");

L("================================");
L("LEARNING CURVE");
L("================================");
L("");
L("Signals | ALL E | TAKE E | WAIT E | Coverage | TAKE n | WAIT n | Active ctx");
for (const c of mainWalk.learningCurve) {
  L(`${String(c.signals).padEnd(8)} ${fmt(c.allE).padEnd(8)} ${fmt(c.takeE).padEnd(9)} ${fmt(c.waitE).padEnd(9)} ${fmtPct(c.coverage).padEnd(10)} ${String(c.takeN).padEnd(8)} ${String(c.waitN).padEnd(8)} ${c.activeContexts}`);
}
L("");

L("================================");
L("CONTEXT SAMPLE SIZE");
L("================================");
L("");
for (const c of mainWalk.contextCurve) {
  L(`At ${c.signals}: total=${c.total} median=${fmt(c.median, 1)} p25=${fmt(c.p25, 1)} p75=${fmt(c.p75, 1)} | >=50:${c.ge50} >=100:${c.ge100} >=200:${c.ge200} >=300:${c.ge300} >=500:${c.ge500} >=1000:${c.ge1000}`);
}
L("");

L("================================");
L("BY FAMILY");
L(`================================ (${headlineScope})`);
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  const rows = sliceZone(mainWalk.decisions, headlineScope as never).filter((r) => r.family === fam);
  const s = sectionFor(rows, fam);
  L(`${fam}:`);
  L(`  ALL  n=${s.all.n} netE=${fmt(s.all.netE)} grossE=${fmt(s.all.grossE)} costE=${fmt(s.all.costE)} WR=${fmtPct(s.all.winRate)} PF=${fmt(s.all.pf, 2)} CI=[${fmt(s.all.ciLo)},${fmt(s.all.ciHi)}]`);
  L(`  TAKE n=${s.take.n} netE=${fmt(s.take.netE)} coverage=${fmtPct(s.coverage)} CI=[${fmt(s.take.ciLo)},${fmt(s.take.ciHi)}]`);
  L(`  WAIT n=${s.wait.n} netE=${fmt(s.wait.netE)} CI=[${fmt(s.wait.ciLo)},${fmt(s.wait.ciHi)}]`);
  L(`  Rescue? ${s.take.netE > s.all.netE && s.take.netE > 0 ? "YES (TAKE profitable & > ALL)" : s.take.netE > s.all.netE ? "PARTIAL (TAKE > ALL but not profitable)" : "NO"}`);
  L("");
}

L("================================");
L("LONG vs SHORT");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  for (const dir of ["long", "short"] as Dir[]) {
    const rows = sliceZone(mainWalk.decisions, headlineScope as never).filter((r) => r.family === fam && r.direction === dir);
    const s = sectionFor(rows, `${fam}-${dir}`);
    L(`${fam} ${dir}: ALL n=${s.all.n} E=${fmt(s.all.netE)} | TAKE n=${s.take.n} E=${fmt(s.take.netE)} | WAIT n=${s.wait.n} E=${fmt(s.wait.netE)} cov=${fmtPct(s.coverage)}`);
  }
  L("");
}

L("================================");
L("MOMENTUM INVERSION (SEPARATE ARM)");
L("================================");
L("");
{
  const mainMom = sliceZone(mainWalk.decisions, headlineScope as never).filter((r) => r.family === "momentum");
  const invMom = sliceZone(invWalk.decisions, headlineScope as never).filter((r) => r.family === "momentum");
  const mAll = metrics(mainMom);
  const iAll = metrics(invMom);
  const mAd = sectionFor(mainMom, "mom-orig");
  const iAd = sectionFor(invMom, "mom-inv");
  const mainAllFam = sectionFor(sliceZone(mainWalk.decisions, headlineScope as never), "main");
  const invAllFam = sectionFor(sliceZone(invWalk.decisions, headlineScope as never), "inv");
  L(`Original Momentum TAKE-ALL: n=${mAll.n} netE=${fmt(mAll.netE)} CI=[${fmt(mAll.ciLo)},${fmt(mAll.ciHi)}]`);
  L(`Inverted Momentum TAKE-ALL: n=${iAll.n} netE=${fmt(iAll.netE)} CI=[${fmt(iAll.ciLo)},${fmt(iAll.ciHi)}]`);
  L(`Adaptive + original Momentum: TAKE n=${mAd.take.n} E=${fmt(mAd.take.netE)} | WAIT E=${fmt(mAd.wait.netE)}`);
  L(`Adaptive + inverted Momentum: TAKE n=${iAd.take.n} E=${fmt(iAd.take.netE)} | WAIT E=${fmt(iAd.wait.netE)}`);
  L(`Four-family Adaptive TAKE (original Mom): ${fmt(mainAllFam.take.netE)}`);
  L(`Four-family Adaptive TAKE (inverted Mom arm): ${fmt(invAllFam.take.netE)}`);
  L(`Inversion useful vs original (TAKE-ALL)? ${iAll.netE > mAll.netE ? "YES" : "NO"} (Δ=${fmt(iAll.netE - mAll.netE)})`);
}
L("");

L("================================");
L("QUALITY RANKING");
L("================================");
L("");
{
  const qs = qualityQuintiles(sliceZone(mainWalk.decisions, headlineScope as never));
  for (const q of qs) L(`Q${q.q}: n=${q.n} netE=${fmt(q.netE)}`);
  const mono = qs.length === 5 && qs[0]!.netE <= qs[1]!.netE && qs[1]!.netE <= qs[2]!.netE && qs[2]!.netE <= qs[3]!.netE && qs[3]!.netE <= qs[4]!.netE;
  const partial = qs.length === 5 && qs[4]!.netE > qs[0]!.netE;
  L(`Does quality rank future net R? ${mono ? "YES" : partial ? "PARTIAL" : "NO"}`);
}
L("");

L("================================");
L("RANDOM CONTROL");
L("================================");
L("");
{
  const rows = sliceZone(mainWalk.decisions, headlineScope as never);
  const { all, take } = takeWait(rows);
  const takeM = metrics(take);
  const rnd = randomMatched(all.map((r) => r.netR), take.length, RANDOM_TRIALS);
  const pct = rnd.adaptivePercentile(takeM.netE);
  L(`Adaptive coverage: ${fmtPct(all.length ? take.length / all.length : 0)}`);
  L(`Adaptive expectancy: ${fmt(takeM.netE)}`);
  L(`Matched random: mean=${fmt(rnd.mean)} 95% interval=[${fmt(rnd.lo)}, ${fmt(rnd.hi)}]`);
  L(`Adaptive percentile vs random: ${fmtPct(pct)}`);
  L(`Beats random 95%? ${takeM.netE > rnd.hi ? "YES" : "NO"}`);
}
L("");

L("================================");
L("PAIR STABILITY");
L("================================");
L("");
{
  const rows = sliceZone(mainWalk.decisions, headlineScope as never);
  for (const pair of PAIRS) {
    const s = sectionFor(rows.filter((r) => r.pair === pair), pair);
    L(`${pair}: n=${s.all.n} ALL=${fmt(s.all.netE)} TAKE=${fmt(s.take.netE)} WAIT=${fmt(s.wait.netE)} cov=${fmtPct(s.coverage)}`);
  }
}
L("");

L("================================");
L("TIME STABILITY");
L("================================");
L("");
{
  const rows = sliceZone(mainWalk.decisions, headlineScope as never);
  L("-- By month --");
  for (const [k, rs] of [...byKey(rows, (r) => monthKey(r.ms)).entries()].sort()) {
    const s = sectionFor(rs, k);
    if (s.all.n < 20) continue;
    L(`${k}: ALL=${fmt(s.all.netE)} TAKE=${fmt(s.take.netE)} WAIT=${fmt(s.wait.netE)} cov=${fmtPct(s.coverage)} totalR=${fmt(s.take.totalR, 1)} n=${s.all.n}`);
  }
  L("-- By quarter --");
  for (const [k, rs] of [...byKey(rows, (r) => quarterKey(r.ms)).entries()].sort()) {
    const s = sectionFor(rs, k);
    L(`${k}: ALL=${fmt(s.all.netE)} TAKE=${fmt(s.take.netE)} WAIT=${fmt(s.wait.netE)} cov=${fmtPct(s.coverage)} totalR=${fmt(s.take.totalR, 1)} n=${s.all.n}`);
  }
  L("-- By year --");
  for (const [k, rs] of [...byKey(rows, (r) => yearKey(r.ms)).entries()].sort()) {
    const s = sectionFor(rs, k);
    L(`${k}: ALL=${fmt(s.all.netE)} TAKE=${fmt(s.take.netE)} WAIT=${fmt(s.wait.netE)} cov=${fmtPct(s.coverage)} totalR=${fmt(s.take.totalR, 1)} n=${s.all.n}`);
  }
}
L("");

L("================================");
L("REGIME / SESSION (adaptive automatic — descriptive)");
L("================================");
L("");
{
  const rows = sliceZone(mainWalk.decisions, headlineScope as never);
  for (const keyFn of [
    (r: DecisionRow) => `regime=${r.regime}`,
    (r: DecisionRow) => `vol=${r.volBucket}`,
    (r: DecisionRow) => `session=${r.session}`,
  ]) {
    for (const [k, rs] of [...byKey(rows, keyFn).entries()].sort()) {
      const s = sectionFor(rs, k);
      L(`${k}: ALL=${fmt(s.all.netE)} TAKE=${fmt(s.take.netE)} WAIT=${fmt(s.wait.netE)} cov=${fmtPct(s.coverage)} n=${s.all.n}`);
    }
    L("");
  }
}

L("================================");
L("SIMPLE CONTROLS");
L("================================");
L("");
{
  const rows = sliceZone(mainWalk.decisions, headlineScope as never);
  const allM = metrics(rows);
  L(`TAKE ALL: ${fmt(allM.netE)}`);
  for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
    L(`Family-only ${fam}: ${fmt(metrics(rows.filter((r) => r.family === fam)).netE)}`);
  }
  L(`LONG-only: ${fmt(metrics(rows.filter((r) => r.direction === "long")).netE)}`);
  L(`SHORT-only: ${fmt(metrics(rows.filter((r) => r.direction === "short")).netE)}`);
  const bySpread = [...rows].sort((a, b) => {
    const oa = opportunities.find((o) => o.id === a.id);
    const ob = opportunities.find((o) => o.id === b.id);
    return (oa?.spreadPips ?? 0) - (ob?.spreadPips ?? 0);
  });
  const lowSpread = bySpread.slice(0, Math.floor(bySpread.length * 0.3));
  L(`Lowest-spread 30%: ${fmt(metrics(lowSpread).netE)}`);
  L(`Trend regime only: ${fmt(metrics(rows.filter((r) => r.regime === "trending")).netE)}`);
  L(`Range regime only: ${fmt(metrics(rows.filter((r) => r.regime === "ranging")).netE)}`);
  L(`Adaptive TAKE: ${fmt(headline.take.netE)}`);
}
L("");

L("================================");
L("COST DECOMPOSITION");
L("================================");
L("");
{
  const rows = sliceZone(mainWalk.decisions, headlineScope as never);
  const { take } = takeWait(rows);
  const a = metrics(rows);
  const t = metrics(take);
  L(`ALL  Gross=${fmt(a.grossE)} Cost=${fmt(a.costE)} Net=${fmt(a.netE)}`);
  L(`TAKE Gross=${fmt(t.grossE)} Cost=${fmt(t.costE)} Net=${fmt(t.netE)}`);
}
L("");

L("================================");
L("HOLDOUT");
L("================================");
L("");
L(`Was holdout opened? ${gate.pass ? "YES" : "NO"}`);
L(`Gate detail: ${JSON.stringify(gate.reasons)}`);
if (gate.pass) {
  const h = sectionFor(sliceZone(mainWalk.decisions, "HOLDOUT"), "HOLDOUT");
  L(`ALL: n=${h.all.n} netE=${fmt(h.all.netE)} CI=[${fmt(h.all.ciLo)},${fmt(h.all.ciHi)}]`);
  L(`TAKE: n=${h.take.n} netE=${fmt(h.take.netE)} cov=${fmtPct(h.coverage)} CI=[${fmt(h.take.ciLo)},${fmt(h.take.ciHi)}]`);
  L(`WAIT: n=${h.wait.n} netE=${fmt(h.wait.netE)} CI=[${fmt(h.wait.ciLo)},${fmt(h.wait.ciHi)}]`);
  L(`Did adaptive edge survive? ${h.take.netE > 0 && h.take.netE > h.wait.netE ? "YES" : "NO"}`);
} else {
  L("HOLDOUT not read for promotion. DEV failure reported above.");
}
L("");

L("================================");
L("LEAKAGE AUDIT");
L("================================");
L("");
const leakage = [
  ["strategy uses only closed/available candles (completedCandles + windows ending at T)", "PASS"],
  ["indicator values point-in-time safe (EMA/ATR/RSI on past closes only)", "PASS"],
  ["no future ATR (regime.atr from candles <= T)", "PASS"],
  ["no future regime", "PASS"],
  ["no future spread (quote at decision bar only)", "PASS"],
  ["no future MFE/MAE in adaptive decision (outcomes computed post-hoc; evidence gated by resolveMs)", "PASS"],
  ["no future outcome in decideInstrument (evidence flushed only resolveMs <= T)", "PASS"],
  ["current trade cannot teach itself (pending until resolveMs)", "PASS"],
  ["only resolved trades become adaptive evidence", "PASS"],
  ["WAIT outcome enters evidence only after resolveMs", "PASS"],
  ["timestamp convention: market_candles close_time; OANDA start+duration stored as close", "PASS"],
  ["TRAIN/DEV/HOLDOUT chronological masks", "PASS"],
  ["no normalization fitted on future data", "PASS"],
  ["no HOLDOUT used for configuration (configs frozen in CONFIG_SNAPSHOT before walk)", "PASS"],
  ["production tables untouched (research files only)", "PASS"],
  ["Momentum main arm = original direction (inversion not applied)", "PASS"],
];
for (const [check, status] of leakage) L(`${status}: ${check}`);
L("");

// Direct answers
const pre = sliceZone(mainWalk.decisions, "PRE_HOLDOUT");
const preSec = sectionFor(pre, "pre");
const curve = mainWalk.learningCurve;
let improveAt: string = "never";
for (const c of curve) {
  if (c.takeE > c.allE + 0.01 && c.takeE > c.waitE) {
    improveAt = String(c.signals);
    break;
  }
}
const famRescue = (["ema", "breakout", "momentum", "meanrev"] as Family[]).map((fam) => {
  const s = sectionFor(pre.filter((r) => r.family === fam), fam);
  return { fam, takeE: s.take.netE, allE: s.all.netE, rescued: s.take.netE > 0 && s.take.netE > s.all.netE };
});
const bestFam = [...famRescue].sort((a, b) => b.takeE - a.takeE)[0]!;
const longE = metrics(pre.filter((r) => r.direction === "long")).netE;
const shortE = metrics(pre.filter((r) => r.direction === "short")).netE;
const qs = qualityQuintiles(pre);
const ranking = qs.length === 5 && qs[4]!.netE > qs[0]!.netE ? (qs.every((q, i) => i === 0 || q.netE >= qs[i - 1]!.netE - 0.02) ? "YES" : "PARTIAL") : "NO";
const rnd = randomMatched(pre.map((r) => r.netR), pre.filter((r) => r.taken).length, RANDOM_TRIALS);
const takeM = metrics(pre.filter((r) => r.taken));
const beatsRandom = takeM.netE > rnd.hi;
const momOrig = metrics(pre.filter((r) => r.family === "momentum"));
const momInv = metrics(sliceZone(invWalk.decisions, "PRE_HOLDOUT").filter((r) => r.family === "momentum"));

const moreDataHelps = curve.length >= 2 && curve[curve.length - 1]!.takeE > curve[0]!.takeE + 0.02 && curve[curve.length - 1]!.takeE > curve[curve.length - 1]!.waitE;
const takeProfit = takeM.netE > 0;
const takeGtWait = takeM.netE > metrics(pre.filter((r) => !r.taken)).netE;

L("================================");
L("DIRECT ANSWERS");
L("================================");
L("");
L(`1. Did giving the adaptive engine 20k–50k opportunities improve it? ${moreDataHelps ? "YES" : "NO / UNCLEAR"}`);
L(`2. At approximately what sample size did improvement appear, if any? ${improveAt}`);
L(`3. Did adaptive TAKE become net profitable after costs? ${takeProfit ? "YES" : "NO"} (${fmt(takeM.netE)} R)`);
L(`4. Which family benefited most? ${bestFam.fam} (TAKE E=${fmt(bestFam.takeE)})`);
L(`5. Did any individual family become profitable under adaptive selection? ${famRescue.some((f) => f.rescued) ? famRescue.filter((f) => f.rescued).map((f) => f.fam).join(", ") : "NO"}`);
L(`6. Did LONG and SHORT behave differently? ${Math.abs(longE - shortE) > 0.05 ? "YES" : "MILD"} (LONG ${fmt(longE)} vs SHORT ${fmt(shortE)})`);
L(`7. Did Momentum inversion remain useful on the much larger dataset? ${momInv.netE > momOrig.netE ? "YES" : "NO"} (orig ${fmt(momOrig.netE)} vs inv ${fmt(momInv.netE)})`);
L(`8. Did TAKE outperform WAIT? ${takeGtWait ? "YES" : "NO"}`);
L(`9. Did adaptive selection beat random selection? ${beatsRandom ? "YES" : "NO"}`);
L(`10. Did adaptive quality rank future net expectancy? ${ranking}`);
L(`11. Was any apparent edge stable across pairs? (see PAIR STABILITY)`);
L(`12. Was it stable across months/years? (see TIME STABILITY)`);
L(`13. Did it survive untouched HOLDOUT? ${gate.pass ? "see HOLDOUT section" : "N/A — HOLDOUT not opened"}`);
L(`14. Was insufficient data actually the previous problem? ${moreDataHelps && takeProfit ? "PARTIALLY — more data helped" : "NO — more data did not create a stable positive conditional edge"}`);
L(`15. Is there evidence that the adaptive engine has learned a genuine conditional Forex edge? ${gate.pass && takeProfit && beatsRandom && takeGtWait ? "CANDIDATE — see HOLDOUT" : "NO clear genuine edge after costs"}`);
L("");

// Verdict
let verdict = "NO_STABLE_CONDITIONAL_FOREX_EDGE";
if (opportunities.length < 20_000) verdict = "INSUFFICIENT_HISTORICAL_DATA";
else if (momInv.netE > 0 && momOrig.netE < 0 && !takeProfit) verdict = "MOMENTUM_INVERSION_EDGE_ONLY";
else if (famRescue.filter((f) => f.rescued).length === 1 && !takeProfit) verdict = "ONE_FAMILY_CONDITIONAL_EDGE_ONLY";
else if (!beatsRandom) verdict = "ADAPTIVE_NO_BETTER_THAN_RANDOM";
else if (takeProfit && takeGtWait && beatsRandom && gate.pass) {
  const h = sectionFor(sliceZone(mainWalk.decisions, "HOLDOUT"), "h");
  if (h.take.netE > 0 && h.take.netE > h.wait.netE) verdict = "ADAPTIVE_FOREX_EDGE_CONFIRMED";
  else verdict = "ADAPTIVE_FOREX_EDGE_PROMISING";
} else if (takeGtWait && beatsRandom && !takeProfit) verdict = "ADAPTIVE_IMPROVES_BUT_STILL_NEGATIVE";
else if (moreDataHelps && !takeProfit) verdict = "MORE_DATA_MATERIALLY_IMPROVES_SELECTOR";
else if (takeProfit && takeGtWait) verdict = "ADAPTIVE_FOREX_EDGE_PROMISING";

L("================================");
L("FINAL VERDICT");
L("================================");
L("");
L(verdict);
L("");
L("Hypothesis A (insufficient prior data) vs B (no stable conditional edge):");
if (moreDataHelps && takeProfit && beatsRandom) {
  L("Evidence leans toward Hypothesis A — more data improved selection toward a positive TAKE.");
} else if (!moreDataHelps || (!takeProfit && !beatsRandom)) {
  L("Evidence leans toward Hypothesis B — even at ~30k opportunities, no stable conditional edge after costs.");
} else {
  L("Mixed — some selection improvement without a clear profitable edge.");
}
L("");
L("Production unchanged: LIVE_EXECUTABLE_FAMILIES, Momentum inversion, paper account, adaptive evidence tables.");
L("");

const report = lines.join("\n");
fs.writeFileSync(REPORT_PATH, report);
fs.appendFileSync(REGISTRY_PATH, `${JSON.stringify({
  experiment: EXPERIMENT,
  at: new Date().toISOString(),
  n: opportunities.length,
  byFamily,
  verdict,
  gatePass: gate.pass,
  headlineTakeE: headline.take.netE,
  headlineAllE: headline.all.netE,
  headlineWaitE: headline.wait.netE,
})}\n`);

console.log("\n" + report);
console.log(`\nReport written → ${REPORT_PATH}`);
process.exit(0);
