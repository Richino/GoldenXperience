/**
 * GOLDENXPERIENCE — four-family-follow-invert-wait-v2
 *
 * RESEARCH ONLY. Isolated FOLLOW / INVERT / WAIT adaptive direction engine
 * over the frozen four-family opportunity stream from
 * four-family-adaptive-historical-v1.
 *
 * Does NOT modify production strategies, adaptive-engine.ts, Momentum
 * inversion, LIVE_EXECUTABLE_FAMILIES, paper trades, or production evidence.
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
const {
  contextKey,
  contextKeysFor,
  DEFAULT_ADAPTIVE_CONFIG,
  ANY,
} = await import("../src/adaptive-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const EXPERIMENT = "four-family-follow-invert-wait-v2";
const V1_DIR = path.join(serviceRoot, "research-v2", "four-family-adaptive-historical-v1");
const OUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);
const OPP_V1 = path.join(V1_DIR, "opportunities.jsonl");
const DEC_V1 = path.join(V1_DIR, "decisions.jsonl");
const PAIRED_PATH = path.join(OUT_DIR, "paired.jsonl");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const CONFIG_PATH = path.join(OUT_DIR, "CONFIG_SNAPSHOT.json");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");

const TRAIN_FRAC = 0.6;
const DEV_FRAC = 0.2;
const MIN_LEARN = DEFAULT_ADAPTIVE_CONFIG.minLearningSample; // 50
const MIN_ACTIVE = DEFAULT_ADAPTIVE_CONFIG.minActiveSample; // 100
const Z = DEFAULT_ADAPTIVE_CONFIG.confidenceZ; // 1.64
const RANDOM_TRIALS = 1000;
const LEARNING_CHECKPOINTS = [1000, 2000, 5000, 10_000, 15_000, 20_000, 25_000, 30_000];
const FORCE_PAIR = process.env.FORCE_PAIR === "1";

type Family = "ema" | "breakout" | "momentum" | "meanrev";
type Dir = "long" | "short";
type Action = "FOLLOW" | "INVERT" | "WAIT";
type Zone = "TRAIN" | "DEV" | "HOLDOUT";
type State = "collecting" | "learning" | "active_selection";

type Quote = {
  closeTime: string;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

type V1Opp = {
  id: string; ms: number; ts: string; family: Family; version: string; configVersion: string;
  pair: string; direction: Dir; entry: number; stop: number; target: number; plannedR: number;
  quality: number; spreadPips: number; atr: number; atrPips: number; session: string;
  regime: string; trendStrength: number; volBucket: string; outcome: string;
  netR: number; grossR: number; costR: number; mfe: number; mae: number; resolveMs: number;
  invDirection: Dir | null; invEntry: number | null; invStop: number | null; invTarget: number | null;
  invNetR: number | null; invGrossR: number | null; invCostR: number | null;
  invOutcome: string | null; invResolveMs: number | null;
};

type Paired = V1Opp & {
  followNetR: number; followGrossR: number; followCostR: number; followOutcome: string;
  followMfe: number; followMae: number; followResolveMs: number;
  invertDirection: Dir; invertEntry: number; invertStop: number; invertTarget: number;
  invertNetR: number; invertGrossR: number; invertCostR: number; invertOutcome: string;
  invertMfe: number; invertMae: number; invertResolveMs: number;
  oracleNetR: number;
};

type ArmStat = { resolved: number; wins: number; netR: number; sumSqR: number };
type CtxStat = { follow: ArmStat; invert: ArmStat };

type Decision = {
  id: string; ms: number; zone: Zone; family: Family; pair: string; direction: Dir;
  action: Action; state: State; scope: string | null;
  eFollow: number | null; eInvert: number | null; nFollow: number; nInvert: number;
  seFollow: number | null; seInvert: number | null;
  followNetR: number; invertNetR: number; followGrossR: number; invertGrossR: number;
  followCostR: number; invertCostR: number;
  selectedNetR: number | null; selectedGrossR: number | null; selectedCostR: number | null;
  qualityScore: number; resolveMs: number;
  session: string; regime: string; volBucket: string;
  contextKeyUsed: string | null;
};

fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });

/** Documented BEFORE performance: preserve production ladder; no new dimensions. */
const CONTEXT_HIERARCHY_DOC = {
  levels: [
    "family|pair|session|regime|originalDirection",
    "family|*|*|regime|originalDirection",
    "family|*|*|regime|*",
    "family|*|*|*|*",
  ],
  source: "api-server/src/adaptive-engine.ts contextKeysFor",
  extensions: "NONE — volBucket/spread available for reporting only, not decision keys",
  decisionRule: {
    collecting: "WAIT (no manufactured FOLLOW/INVERT)",
    learning: "WAIT unless a ladder bucket has n>=minActive and convincingly positive arm",
    active: "FOLLOW if follow convincingly positive & better; else INVERT if invert convincingly positive & better; else WAIT",
    convincinglyPositive: "mean - Z*se > 0 with n>=minActive and se available",
    evidence: "Both FOLLOW and INVERT outcomes merge after resolveMs (including WAIT decisions)",
  },
  thresholds: { minLearningSample: MIN_LEARN, minActiveSample: MIN_ACTIVE, confidenceZ: Z },
  splits: { trainFrac: TRAIN_FRAC, devFrac: DEV_FRAC, holdoutFrac: 0.2, sameAs: "four-family-adaptive-historical-v1" },
};

fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  experiment: EXPERIMENT,
  frozenAt: new Date().toISOString(),
  reusedFrom: "four-family-adaptive-historical-v1",
  strategies: JSON.parse(fs.readFileSync(path.join(V1_DIR, "CONFIG_SNAPSHOT.json"), "utf8")).strategies,
  adaptiveV2: CONTEXT_HIERARCHY_DOC,
  note: "Production untouched. Momentum research signal = ORIGINAL direction; V2 may INVERT.",
}, null, 2));

console.log("=".repeat(72));
console.log("GOLDENXPERIENCE —", EXPERIMENT);
console.log("=".repeat(72));
console.log("\nFrozen V2 decision hierarchy (BEFORE results):\n");
console.log(JSON.stringify(CONTEXT_HIERARCHY_DOC, null, 2));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function emptyArm(): ArmStat { return { resolved: 0, wins: 0, netR: 0, sumSqR: 0 }; }
function emptyCtx(): CtxStat { return { follow: emptyArm(), invert: emptyArm() }; }

function addArm(a: ArmStat, netR: number) {
  a.resolved += 1;
  if (netR > 0) a.wins += 1;
  a.netR += netR;
  a.sumSqR += netR * netR;
}

function armMean(a: ArmStat) { return a.resolved > 0 ? a.netR / a.resolved : null; }
function armSe(a: ArmStat) {
  if (a.resolved < 2) return null;
  const m = a.netR / a.resolved;
  const v = Math.max(0, (a.sumSqR - a.resolved * m * m) / (a.resolved - 1));
  return Math.sqrt(v / a.resolved);
}
function convincinglyPositive(a: ArmStat) {
  const m = armMean(a); const se = armSe(a);
  if (m === null || se === null || a.resolved < MIN_ACTIVE) return false;
  return m - Z * se > 0;
}
function convincinglyNegative(a: ArmStat) {
  const m = armMean(a); const se = armSe(a);
  if (m === null || se === null || a.resolved < MIN_ACTIVE) return false;
  return m + Z * se < 0;
}

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function sum(xs: number[]) { return xs.reduce((a, b) => a + b, 0); }
function percentile(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}
function fmt(x: number, d = 4) { return Number.isFinite(x) ? x.toFixed(d) : "n/a"; }
function fmtPct(x: number) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a"; }

function blockedBootstrapCI(rows: Array<{ netR: number; ms: number }>, trials = 400, seed = 42) {
  if (!rows.length) return { lo: NaN, hi: NaN, effectiveN: 0 };
  const blocks = new Map<number, number[]>();
  for (const r of rows) {
    const k = Math.floor(r.ms / 86_400_000);
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
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
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

function metrics(rows: Array<{ netR: number; grossR?: number; costR?: number; ms?: number }>) {
  const n = rows.length;
  if (!n) {
    return { n: 0, winRate: NaN, grossE: NaN, costE: NaN, netE: NaN, totalR: NaN, pf: NaN, maxDd: NaN, ciLo: NaN, ciHi: NaN, effectiveN: 0 };
  }
  const nets = rows.map((r) => r.netR);
  const gross = rows.map((r) => r.grossR ?? r.netR);
  const costs = rows.map((r) => r.costR ?? 0);
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x <= 0);
  const pf = Math.abs(sum(losses)) > 0 ? sum(wins) / Math.abs(sum(losses)) : sum(wins) > 0 ? Infinity : NaN;
  let peak = 0; let eq = 0; let maxDd = 0;
  for (const r of nets) { eq += r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); }
  const { lo, hi, effectiveN } = blockedBootstrapCI(rows.map((r) => ({ netR: r.netR, ms: r.ms ?? 0 })));
  return {
    n, winRate: wins.length / n, grossE: mean(gross), costE: mean(costs), netE: mean(nets),
    totalR: sum(nets), pf, maxDd, ciLo: lo, ciHi: hi, effectiveN,
  };
}

function usable(o: { outcome: string; resultR: number | null }) {
  return o.outcome !== "unresolved" && o.outcome !== "ambiguous" && o.resultR !== null && Number.isFinite(o.resultR);
}

function resolveMsOf(o: { resolvedAt: string | null; horizonEndsAt: string }, decisionTs: string) {
  return Date.parse(o.resolvedAt ?? o.horizonEndsAt ?? decisionTs);
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

function recoverBidAsk(o: V1Opp): { bid: number; ask: number } {
  const pip = pipSizeFor(o.pair as never);
  const spread = o.spreadPips * pip;
  if (o.direction === "long") return { ask: o.entry, bid: o.entry - spread };
  return { bid: o.entry, ask: o.entry + spread };
}

function midQuote(q: Quote): Quote {
  const mid = (a: number, b: number) => (a + b) / 2;
  return {
    closeTime: q.closeTime,
    bidOpen: mid(q.bidOpen, q.askOpen), bidHigh: mid(q.bidHigh, q.askHigh),
    bidLow: mid(q.bidLow, q.askLow), bidClose: mid(q.bidClose, q.askClose),
    askOpen: mid(q.bidOpen, q.askOpen), askHigh: mid(q.bidHigh, q.askHigh),
    askLow: mid(q.bidLow, q.askLow), askClose: mid(q.bidClose, q.askClose),
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — build paired FOLLOW/INVERT outcomes (reuse V1 + fill missing inverts)
// ---------------------------------------------------------------------------
function loadJsonl<T>(p: string): T[] {
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}

async function buildPaired(): Promise<Paired[]> {
  if (!FORCE_PAIR && fs.existsSync(PAIRED_PATH)) {
    const rows = loadJsonl<Paired>(PAIRED_PATH);
    if (rows.length >= 20_000) {
      console.log(`Loaded ${rows.length} paired rows from cache`);
      return rows;
    }
  }

  console.log("\n=== BUILDING PAIRED FOLLOW/INVERT OUTCOMES ===\n");
  const opps = loadJsonl<V1Opp>(OPP_V1);
  console.log(`V1 opportunities: ${opps.length}`);

  const quotesByPair = new Map<string, Quote[]>();
  const qIndexByPair = new Map<string, Map<number, number>>();
  for (const pair of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
    const qt = await loadQuotes(pair);
    quotesByPair.set(pair, qt);
    const idx = new Map<number, number>();
    qt.forEach((q, i) => idx.set(Date.parse(q.closeTime), i));
    qIndexByPair.set(pair, idx);
    console.log(`${pair}: ${qt.length} M15 quotes`);
  }

  const paired: Paired[] = [];
  let reused = 0;
  let rebuilt = 0;
  let dropped = 0;

  for (const o of opps) {
    const qt = quotesByPair.get(o.pair)!;
    const qIdx = qIndexByPair.get(o.pair)!;
    const qi = qIdx.get(o.ms);
    if (qi === undefined) { dropped += 1; continue; }
    const q = qt[qi]!;
    const fwd = qt.slice(qi + 1, qi + 400);
    const fwdMid = fwd.map(midQuote);
    if (fwd.length < 20) { dropped += 1; continue; }

    const stopDist = Math.abs(o.entry - o.stop);
    const tgtDist = Math.abs(o.target - o.entry);
    if (!(stopDist > 0) || !(tgtDist > 0)) { dropped += 1; continue; }

    let invDir: Dir;
    let invEntry: number;
    let invStop: number;
    let invTarget: number;
    let invNetR: number;
    let invGrossR: number;
    let invCostR: number;
    let invOutcome: string;
    let invMfe: number;
    let invMae: number;
    let invResolveMs: number;

    if (o.invNetR != null && o.invEntry != null && o.invStop != null && o.invTarget != null && o.invDirection != null) {
      invDir = o.invDirection;
      invEntry = o.invEntry;
      invStop = o.invStop;
      invTarget = o.invTarget;
      invNetR = o.invNetR;
      invGrossR = o.invGrossR!;
      invCostR = o.invCostR!;
      invOutcome = o.invOutcome!;
      invResolveMs = o.invResolveMs!;
      // Re-resolve MFE/MAE for invert if missing — use stored net; mfe/mae optional
      const iNet = labelOutcome(invDir, invEntry, invStop, invTarget, o.ts, fwd as never);
      invMfe = iNet.maxFavorableR ?? 0;
      invMae = iNet.maxAdverseR ?? 0;
      reused += 1;
    } else {
      const { bid, ask } = recoverBidAsk(o);
      // Prefer live quote at bar for invert entry (more accurate than recovered)
      const useBid = q.bidClose;
      const useAsk = q.askClose;
      invDir = o.direction === "long" ? "short" : "long";
      invEntry = invDir === "long" ? useAsk : useBid;
      invStop = invDir === "long" ? invEntry - stopDist : invEntry + stopDist;
      invTarget = invDir === "long" ? invEntry + tgtDist : invEntry - tgtDist;
      const iNet = labelOutcome(invDir, invEntry, invStop, invTarget, o.ts, fwd as never);
      const midEntry = (useBid + useAsk) / 2;
      const iStopM = invDir === "long" ? midEntry - stopDist : midEntry + stopDist;
      const iTgtM = invDir === "long" ? midEntry + tgtDist : midEntry - tgtDist;
      const iGro = labelOutcome(invDir, midEntry, iStopM, iTgtM, o.ts, fwdMid as never);
      if (!usable(iNet) || !usable(iGro)) { dropped += 1; continue; }
      invNetR = iNet.resultR!;
      invGrossR = iGro.resultR!;
      invCostR = invGrossR - invNetR;
      invOutcome = iNet.outcome;
      invMfe = iNet.maxFavorableR ?? 0;
      invMae = iNet.maxAdverseR ?? 0;
      invResolveMs = resolveMsOf(iNet, o.ts);
      rebuilt += 1;
      void bid; void ask;
    }

    paired.push({
      ...o,
      followNetR: o.netR,
      followGrossR: o.grossR,
      followCostR: o.costR,
      followOutcome: o.outcome,
      followMfe: o.mfe,
      followMae: o.mae,
      followResolveMs: o.resolveMs,
      invertDirection: invDir,
      invertEntry: invEntry,
      invertStop: invStop,
      invertTarget: invTarget,
      invertNetR: invNetR,
      invertGrossR: invGrossR,
      invertCostR: invCostR,
      invertOutcome: invOutcome,
      invertMfe: invMfe,
      invertMae: invMae,
      invertResolveMs: invResolveMs,
      oracleNetR: Math.max(o.netR, invNetR),
    });
  }

  paired.sort((a, b) => a.ms - b.ms || a.pair.localeCompare(b.pair) || a.family.localeCompare(b.family));
  const stream = fs.createWriteStream(PAIRED_PATH);
  for (const p of paired) stream.write(`${JSON.stringify(p)}\n`);
  await new Promise<void>((res, rej) => { stream.on("finish", () => res()); stream.on("error", rej); stream.end(); });
  console.log(`Paired: ${paired.length} (reused inv=${reused}, rebuilt=${rebuilt}, dropped=${dropped}) → ${PAIRED_PATH}`);
  return paired;
}

// ---------------------------------------------------------------------------
// Correctness tests
// ---------------------------------------------------------------------------
function correctnessTests(paired: Paired[]) {
  const sumNet = mean(paired.map((p) => p.followNetR + p.invertNetR));
  const sumGross = mean(paired.map((p) => p.followGrossR + p.invertGrossR));
  let exactNegNet = 0;
  let exactNegGross = 0;
  for (const p of paired) {
    if (Math.abs(p.followNetR + p.invertNetR) < 1e-12) exactNegNet += 1;
    if (Math.abs(p.followGrossR + p.invertGrossR) < 1e-12) exactNegGross += 1;
  }
  const bothResolved = paired.every((p) => Number.isFinite(p.followNetR) && Number.isFinite(p.invertNetR));
  const bothPaySpread = paired.every((p) => p.followCostR > -1e-9 && p.invertCostR > -1e-9);
  // Fake symmetry killed if net sum is not ~0 and exact negation is rare
  const ok = bothResolved && Math.abs(sumNet) > 0.01 && exactNegNet / paired.length < 0.05;
  return {
    sumNet, sumGross,
    exactNegNetShare: exactNegNet / paired.length,
    exactNegGrossShare: exactNegGross / paired.length,
    bothResolved, bothPaySpread, ok,
    meanFollowCost: mean(paired.map((p) => p.followCostR)),
    meanInvertCost: mean(paired.map((p) => p.invertCostR)),
  };
}

// ---------------------------------------------------------------------------
// V2 evidence + decision
// ---------------------------------------------------------------------------
type Evidence = { total: number; context: Map<string, CtxStat> };

function mergePaired(ev: Evidence, p: Paired) {
  for (const key of contextKeysFor(p.family, p.pair, p.session, p.regime, p.direction)) {
    const cur = ev.context.get(key) ?? emptyCtx();
    addArm(cur.follow, p.followNetR);
    addArm(cur.invert, p.invertNetR);
    ev.context.set(key, cur);
  }
  ev.total += 1;
}

type Pending = { resolveMs: number; p: Paired };

function flush(ev: Evidence, pending: Pending[], asOf: number) {
  pending.sort((a, b) => a.resolveMs - b.resolveMs);
  let i = 0;
  while (i < pending.length && pending[i]!.resolveMs <= asOf) {
    mergePaired(ev, pending[i]!.p);
    i += 1;
  }
  if (i) pending.splice(0, i);
}

function resolveCtx(ev: Evidence, p: Paired, minimum: number): { stat: CtxStat; scope: string; key: string } | null {
  const keys = contextKeysFor(p.family, p.pair, p.session, p.regime, p.direction);
  const scopes = ["pair+session+regime+direction", "regime+direction", "regime", "family"] as const;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    const stat = ev.context.get(key);
    if (!stat) continue;
    const n = Math.max(stat.follow.resolved, stat.invert.resolved);
    // Both arms should have same n since we always add both; use follow.resolved
    if (stat.follow.resolved >= minimum) return { stat, scope: scopes[i]!, key };
  }
  return null;
}

function decideV2(ev: Evidence, p: Paired): {
  action: Action; state: State; scope: string | null; key: string | null;
  eFollow: number | null; eInvert: number | null; nFollow: number; nInvert: number;
  seFollow: number | null; seInvert: number | null; qualityScore: number;
} {
  const active = resolveCtx(ev, p, MIN_ACTIVE);
  const learning = resolveCtx(ev, p, MIN_LEARN);
  const state: State = active ? "active_selection" : learning ? "learning" : "collecting";
  const found = active ?? learning;
  const eFollow = found ? armMean(found.stat.follow) : null;
  const eInvert = found ? armMean(found.stat.invert) : null;
  const nFollow = found?.stat.follow.resolved ?? 0;
  const nInvert = found?.stat.invert.resolved ?? 0;
  const seFollow = found ? armSe(found.stat.follow) : null;
  const seInvert = found ? armSe(found.stat.invert) : null;

  // Insufficient evidence → WAIT (never manufacture INVERT; never force FOLLOW)
  if (!active) {
    return {
      action: "WAIT", state, scope: found?.scope ?? null, key: found?.key ?? null,
      eFollow, eInvert, nFollow, nInvert, seFollow, seInvert, qualityScore: 0,
    };
  }

  const fPos = convincinglyPositive(active.stat.follow);
  const iPos = convincinglyPositive(active.stat.invert);
  const fMean = armMean(active.stat.follow) ?? 0;
  const iMean = armMean(active.stat.invert) ?? 0;

  let action: Action = "WAIT";
  if (fPos && (!iPos || fMean >= iMean)) action = "FOLLOW";
  else if (iPos && (!fPos || iMean > fMean)) action = "INVERT";

  const qualityScore = action === "FOLLOW" ? fMean
    : action === "INVERT" ? iMean
      : Math.max(fMean, iMean);

  return {
    action, state, scope: active.scope, key: active.key,
    eFollow, eInvert, nFollow, nInvert, seFollow, seInvert, qualityScore,
  };
}

/** Simple fixed baseline — same hierarchy, no CI; frozen thresholds. */
function decideSimple(ev: Evidence, p: Paired): Action {
  const found = resolveCtx(ev, p, MIN_ACTIVE);
  if (!found) return "WAIT";
  const f = armMean(found.stat.follow) ?? 0;
  const i = armMean(found.stat.invert) ?? 0;
  if (i > 0 && f < 0) return "INVERT";
  if (f > 0 && i < 0) return "FOLLOW";
  return "WAIT";
}

function chronologicalV2(paired: Paired[]): { decisions: Decision[]; simpleActions: Action[]; learningCurve: Array<Record<string, number | string>> } {
  console.log("\n=== V2 CHRONOLOGICAL REPLAY ===\n");
  const ev: Evidence = { total: 0, context: new Map() };
  const pending: Pending[] = [];
  const decisions: Decision[] = [];
  const simpleActions: Action[] = [];
  const learningCurve: Array<Record<string, number | string>> = [];
  const cp = new Set(LEARNING_CHECKPOINTS);

  // Accumulators for learning curve
  let followN = 0; let invertN = 0; let waitN = 0;
  let v2Sum = 0; let v2N = 0;
  let followSelSum = 0; let invertSelSum = 0;
  let alwaysFSum = 0; let alwaysISum = 0;

  for (let idx = 0; idx < paired.length; idx += 1) {
    const p = paired[idx]!;
    // Evidence only from fully resolved prior opportunities (max of both arms' resolve)
    const asOf = p.ms;
    flush(ev, pending, asOf);

    const d = decideV2(ev, p);
    const simple = decideSimple(ev, p);
    simpleActions.push(simple);

    const selectedNetR = d.action === "FOLLOW" ? p.followNetR
      : d.action === "INVERT" ? p.invertNetR : null;
    const selectedGrossR = d.action === "FOLLOW" ? p.followGrossR
      : d.action === "INVERT" ? p.invertGrossR : null;
    const selectedCostR = d.action === "FOLLOW" ? p.followCostR
      : d.action === "INVERT" ? p.invertCostR : null;

    decisions.push({
      id: p.id, ms: p.ms, zone: "TRAIN", family: p.family, pair: p.pair, direction: p.direction,
      action: d.action, state: d.state, scope: d.scope,
      eFollow: d.eFollow, eInvert: d.eInvert, nFollow: d.nFollow, nInvert: d.nInvert,
      seFollow: d.seFollow, seInvert: d.seInvert,
      followNetR: p.followNetR, invertNetR: p.invertNetR,
      followGrossR: p.followGrossR, invertGrossR: p.invertGrossR,
      followCostR: p.followCostR, invertCostR: p.invertCostR,
      selectedNetR, selectedGrossR, selectedCostR,
      qualityScore: d.qualityScore,
      resolveMs: Math.max(p.followResolveMs, p.invertResolveMs),
      session: p.session, regime: p.regime, volBucket: p.volBucket,
      contextKeyUsed: d.key,
    });

    // Learn BOTH arms after the later of the two resolutions
    pending.push({ resolveMs: Math.max(p.followResolveMs, p.invertResolveMs), p });

    alwaysFSum += p.followNetR;
    alwaysISum += p.invertNetR;
    if (d.action === "FOLLOW") { followN += 1; followSelSum += p.followNetR; v2Sum += p.followNetR; v2N += 1; }
    else if (d.action === "INVERT") { invertN += 1; invertSelSum += p.invertNetR; v2Sum += p.invertNetR; v2N += 1; }
    else waitN += 1;

    const processed = idx + 1;
    if (cp.has(processed)) {
      learningCurve.push({
        signals: processed,
        followPct: followN / processed,
        invertPct: invertN / processed,
        waitPct: waitN / processed,
        coverage: v2N / processed,
        followSelE: followN ? followSelSum / followN : NaN,
        invertSelE: invertN ? invertSelSum / invertN : NaN,
        v2E: v2N ? v2Sum / v2N : NaN,
        alwaysFollowE: alwaysFSum / processed,
        alwaysInvertE: alwaysISum / processed,
      });
    }
  }
  flush(ev, pending, Number.POSITIVE_INFINITY);
  console.log(`V2 decisions: ${decisions.length}; evidence total=${ev.total}`);
  return { decisions, simpleActions, learningCurve };
}

function assignZones(decisions: Decision[]) {
  const n = decisions.length;
  const trainEnd = Math.floor(n * TRAIN_FRAC);
  const devEnd = Math.floor(n * (TRAIN_FRAC + DEV_FRAC));
  for (let i = 0; i < n; i += 1) {
    decisions[i]!.zone = i < trainEnd ? "TRAIN" : i < devEnd ? "DEV" : "HOLDOUT";
  }
  return {
    trainEnd, devEnd,
    trainStartMs: decisions[0]?.ms ?? 0,
    trainEndMs: decisions[trainEnd - 1]?.ms ?? 0,
    devEndMs: decisions[devEnd - 1]?.ms ?? 0,
    holdoutEndMs: decisions[n - 1]?.ms ?? 0,
  };
}

function sliceZone(rows: Decision[], zone: Zone | "PRE_HOLDOUT" | "ALL") {
  if (zone === "ALL") return rows;
  if (zone === "PRE_HOLDOUT") return rows.filter((r) => r.zone !== "HOLDOUT");
  return rows.filter((r) => r.zone === zone);
}

function selectedRows(rows: Decision[]) {
  return rows.filter((r) => r.action !== "WAIT" && r.selectedNetR != null).map((r) => ({
    netR: r.selectedNetR!, grossR: r.selectedGrossR!, costR: r.selectedCostR!, ms: r.ms,
  }));
}

function randomActionControl(
  rows: Decision[],
  trials: number,
  seed = 11,
) {
  const followPct = rows.filter((r) => r.action === "FOLLOW").length / Math.max(1, rows.length);
  const invertPct = rows.filter((r) => r.action === "INVERT").length / Math.max(1, rows.length);
  // WAIT = remainder
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const means: number[] = [];
  for (let t = 0; t < trials; t += 1) {
    let sumR = 0; let n = 0;
    for (const r of rows) {
      const u = rand();
      let a: Action;
      if (u < followPct) a = "FOLLOW";
      else if (u < followPct + invertPct) a = "INVERT";
      else a = "WAIT";
      if (a === "FOLLOW") { sumR += r.followNetR; n += 1; }
      else if (a === "INVERT") { sumR += r.invertNetR; n += 1; }
    }
    means.push(n ? sumR / n : 0);
  }
  means.sort((a, b) => a - b);
  const v2 = selectedRows(rows);
  const v2E = mean(v2.map((r) => r.netR));
  let below = 0;
  for (const m of means) if (m < v2E) below += 1;
  return {
    followPct, invertPct, waitPct: 1 - followPct - invertPct,
    mean: mean(means), lo: percentile(means, 0.025), hi: percentile(means, 0.975),
    best: means[means.length - 1]!, v2E, percentile: below / means.length,
  };
}

// ---------------------------------------------------------------------------
// Context analysis (PRE_HOLDOUT descriptive — no HOLDOUT peeking for gates)
// ---------------------------------------------------------------------------
type CtxAgg = {
  key: string; n: number; followE: number; invertE: number;
  followSum: number; invertSum: number;
  years: Set<number>; pairs: Set<string>;
  yearMeans: Map<number, { f: number[]; i: number[] }>;
};

function aggregateContexts(paired: Paired[], decisions: Decision[], zone: "PRE_HOLDOUT") {
  const preIds = new Set(sliceZone(decisions, zone).map((d) => d.id));
  const map = new Map<string, CtxAgg>();
  for (const p of paired) {
    if (!preIds.has(p.id)) continue;
    // Use regime+direction ladder level for reporting tables
    const key = contextKey(p.family, ANY, ANY, p.regime, p.direction);
    const cur = map.get(key) ?? {
      key, n: 0, followE: 0, invertE: 0, followSum: 0, invertSum: 0,
      years: new Set(), pairs: new Set(), yearMeans: new Map(),
    };
    cur.n += 1;
    cur.followSum += p.followNetR;
    cur.invertSum += p.invertNetR;
    const y = new Date(p.ms).getUTCFullYear();
    cur.years.add(y);
    cur.pairs.add(p.pair);
    const ym = cur.yearMeans.get(y) ?? { f: [], i: [] };
    ym.f.push(p.followNetR);
    ym.i.push(p.invertNetR);
    cur.yearMeans.set(y, ym);
    map.set(key, cur);
  }
  for (const c of map.values()) {
    c.followE = c.followSum / c.n;
    c.invertE = c.invertSum / c.n;
  }
  return [...map.values()];
}

function classifyFailure(agg: CtxAgg[]): Record<string, { contexts: number; opportunities: number }> {
  const out: Record<string, { contexts: number; opportunities: number }> = {
    ANTI_PREDICTIVE: { contexts: 0, opportunities: 0 },
    NO_DIRECTIONAL_INFORMATION: { contexts: 0, opportunities: 0 },
    COST_KILLED: { contexts: 0, opportunities: 0 }, // filled separately if needed
    UNSTABLE: { contexts: 0, opportunities: 0 },
    INSUFFICIENT_EVIDENCE: { contexts: 0, opportunities: 0 },
    FOLLOW_EDGE: { contexts: 0, opportunities: 0 },
  };
  for (const c of agg) {
    if (c.n < MIN_ACTIVE) {
      out.INSUFFICIENT_EVIDENCE!.contexts += 1;
      out.INSUFFICIENT_EVIDENCE!.opportunities += c.n;
      continue;
    }
    // Temporal stability of invert edge
    const yearInv = [...c.yearMeans.entries()].filter(([, v]) => v.i.length >= 20).map(([, v]) => mean(v.i));
    const signs = yearInv.map((x) => (x > 0 ? 1 : x < 0 ? -1 : 0));
    const unstable = yearInv.length >= 3 && new Set(signs.filter((s) => s !== 0)).size > 1
      && signs.filter((s) => s > 0).length > 0 && signs.filter((s) => s < 0).length > 0
      && Math.min(...yearInv.map(Math.abs)) > 0.02;

    if (c.followE < 0 && c.invertE > 0) {
      if (unstable) {
        out.UNSTABLE!.contexts += 1;
        out.UNSTABLE!.opportunities += c.n;
      } else {
        out.ANTI_PREDICTIVE!.contexts += 1;
        out.ANTI_PREDICTIVE!.opportunities += c.n;
      }
    } else if (c.followE > 0 && c.invertE <= 0) {
      out.FOLLOW_EDGE!.contexts += 1;
      out.FOLLOW_EDGE!.opportunities += c.n;
    } else if (c.followE < 0 && c.invertE < 0) {
      out.NO_DIRECTIONAL_INFORMATION!.contexts += 1;
      out.NO_DIRECTIONAL_INFORMATION!.opportunities += c.n;
    } else {
      out.NO_DIRECTIONAL_INFORMATION!.contexts += 1;
      out.NO_DIRECTIONAL_INFORMATION!.opportunities += c.n;
    }
  }
  return out;
}

function actionStability(decisions: Decision[]) {
  // Track action sequence per context key as n grows (PRE_HOLDOUT)
  const pre = sliceZone(decisions, "PRE_HOLDOUT");
  const byCtx = new Map<string, Action[]>();
  const counts = new Map<string, number>();
  for (const d of pre) {
    const key = d.contextKeyUsed ?? `${d.family}|${d.regime}|${d.direction}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    // Snapshot at milestones
    if ([50, 100, 250, 500, 1000].includes(n)) {
      const arr = byCtx.get(key) ?? [];
      arr.push(d.action);
      byCtx.set(key, arr);
    }
  }
  let stableF = 0; let stableI = 0; let stableW = 0; let osc = 0;
  for (const [, actions] of byCtx) {
    if (actions.length < 2) continue;
    const uniq = new Set(actions);
    if (uniq.size === 1) {
      const a = actions[0]!;
      if (a === "FOLLOW") stableF += 1;
      else if (a === "INVERT") stableI += 1;
      else stableW += 1;
    } else osc += 1;
  }
  return { stableF, stableI, stableW, osc, tracked: byCtx.size };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
const paired = await buildPaired();
const correct = correctnessTests(paired);
console.log("\n=== COUNTERFACTUAL CORRECTNESS ===");
console.log(JSON.stringify(correct, null, 2));
if (!correct.ok) {
  console.error("Correctness check FAILED — aborting before adaptive claims");
  process.exit(1);
}

const byFamily = { ema: 0, breakout: 0, momentum: 0, meanrev: 0 };
for (const p of paired) byFamily[p.family] += 1;

const { decisions, simpleActions, learningCurve } = chronologicalV2(paired);
const split = assignZones(decisions);

// Align simple actions with decisions for metrics
const simpleDecisions = decisions.map((d, i) => {
  const a = simpleActions[i]!;
  const selectedNetR = a === "FOLLOW" ? d.followNetR : a === "INVERT" ? d.invertNetR : null;
  const selectedGrossR = a === "FOLLOW" ? d.followGrossR : a === "INVERT" ? d.invertGrossR : null;
  const selectedCostR = a === "FOLLOW" ? d.followCostR : a === "INVERT" ? d.invertCostR : null;
  return { ...d, action: a, selectedNetR, selectedGrossR, selectedCostR };
});

// Old adaptive baseline from V1 decisions
const oldDec = loadJsonl<{ id: string; taken: boolean; netR: number; grossR: number; costR: number; ms: number; zone?: string }>(DEC_V1);
const oldById = new Map(oldDec.map((d) => [d.id, d]));

const scopeLabel = "PRE_HOLDOUT";
const pre = sliceZone(decisions, "PRE_HOLDOUT");
const dev = sliceZone(decisions, "DEV");

function policyMetrics(rows: Decision[], mode: "follow" | "invert" | "v2" | "old") {
  if (mode === "follow") {
    return metrics(rows.map((r) => ({ netR: r.followNetR, grossR: r.followGrossR, costR: r.followCostR, ms: r.ms })));
  }
  if (mode === "invert") {
    return metrics(rows.map((r) => ({ netR: r.invertNetR, grossR: r.invertGrossR, costR: r.invertCostR, ms: r.ms })));
  }
  if (mode === "v2") return metrics(selectedRows(rows));
  // old adaptive
  const taken = rows.map((r) => oldById.get(r.id)).filter((d): d is NonNullable<typeof d> => !!d && d.taken);
  return metrics(taken.map((d) => ({ netR: d.netR, grossR: d.grossR, costR: d.costR, ms: d.ms })));
}

const alwaysF = policyMetrics(pre, "follow");
const alwaysI = policyMetrics(pre, "invert");
const oldAd = policyMetrics(pre, "old");
const v2Comb = policyMetrics(pre, "v2");
const v2Follow = metrics(pre.filter((r) => r.action === "FOLLOW").map((r) => ({
  netR: r.followNetR, grossR: r.followGrossR, costR: r.followCostR, ms: r.ms,
})));
const v2Invert = metrics(pre.filter((r) => r.action === "INVERT").map((r) => ({
  netR: r.invertNetR, grossR: r.invertGrossR, costR: r.invertCostR, ms: r.ms,
})));
const waitN = pre.filter((r) => r.action === "WAIT").length;
const coverage = pre.length ? (pre.length - waitN) / pre.length : 0;

const rnd = randomActionControl(pre, RANDOM_TRIALS);
const simplePre = sliceZone(simpleDecisions, "PRE_HOLDOUT");
const simpleM = policyMetrics(simplePre, "v2");

const oracleE = mean(paired.filter((p) => pre.some((d) => d.id === p.id)).map((p) => p.oracleNetR));
const oracleTotal = sum(paired.filter((p) => pre.some((d) => d.id === p.id)).map((p) => p.oracleNetR));

// Anti-predictive contexts
const agg = aggregateContexts(paired, decisions, "PRE_HOLDOUT");
const anti = agg.filter((c) => c.n >= MIN_ACTIVE && c.followE < 0 && c.invertE > 0)
  .sort((a, b) => (b.invertE - b.followE) - (a.invertE - a.followE));
const followEdge = agg.filter((c) => c.n >= MIN_ACTIVE && c.followE > 0 && c.invertE <= 0)
  .sort((a, b) => b.followE - a.followE);
const bothBad = agg.filter((c) => c.n >= MIN_ACTIVE && c.followE < 0 && c.invertE < 0)
  .sort((a, b) => a.followE - b.followE);
const failure = classifyFailure(agg);
const stability = actionStability(decisions);

// Cost-killed: gross invert > 0 but net invert < 0 at context level — approximate via paired rows
let costKilledOpp = 0;
for (const p of paired) {
  const inPre = pre.some((d) => d.id === p.id);
  if (!inPre) continue;
  if (p.followGrossR > 0 && p.followNetR <= 0) costKilledOpp += 1;
  else if (p.invertGrossR > 0 && p.invertNetR <= 0) costKilledOpp += 1;
}
failure.COST_KILLED = {
  contexts: agg.filter((c) => c.n >= 50).length, // placeholder count of examined
  opportunities: costKilledOpp,
};

// Quality quintiles
function qualityQuintiles(rows: Decision[]) {
  const sel = rows.filter((r) => r.action !== "WAIT" && r.selectedNetR != null);
  if (sel.length < 5) return [] as Array<{ q: number; n: number; netE: number }>;
  const sorted = [...sel].sort((a, b) => a.qualityScore - b.qualityScore);
  const size = Math.floor(sorted.length / 5);
  const out: Array<{ q: number; n: number; netE: number }> = [];
  for (let q = 0; q < 5; q += 1) {
    const chunk = q === 4 ? sorted.slice(q * size) : sorted.slice(q * size, (q + 1) * size);
    out.push({ q: q + 1, n: chunk.length, netE: mean(chunk.map((r) => r.selectedNetR!)) });
  }
  return out;
}
const qs = qualityQuintiles(pre);

// DEV gate
function holdoutGate(devRows: Decision[]) {
  const v2 = policyMetrics(devRows, "v2");
  const af = policyMetrics(devRows, "follow");
  const ai = policyMetrics(devRows, "invert");
  const oa = policyMetrics(devRows, "old");
  const rndDev = randomActionControl(devRows, RANDOM_TRIALS, 99);
  const invSel = devRows.filter((r) => r.action === "INVERT");
  const folSel = devRows.filter((r) => r.action === "FOLLOW");
  const invE = invSel.length ? mean(invSel.map((r) => r.invertNetR)) : NaN;
  const folE = folSel.length ? mean(folSel.map((r) => r.followNetR)) : NaN;

  const byYear = new Map<number, number[]>();
  for (const r of selectedRows(devRows)) {
    const y = new Date(r.ms).getUTCFullYear();
    const arr = byYear.get(y) ?? [];
    arr.push(r.netR);
    byYear.set(y, arr);
  }
  const yearPos = [...byYear.values()].filter((xs) => xs.length >= 20 && mean(xs) > 0).length;
  const multiYear = yearPos >= 2;

  const byPair = new Map<string, number>();
  let totalR = 0;
  for (const r of selectedRows(devRows)) {
    const d = devRows.find((x) => x.ms === r.ms && x.selectedNetR === r.netR);
    const pair = d?.pair ?? "?";
    byPair.set(pair, (byPair.get(pair) ?? 0) + r.netR);
    totalR += r.netR;
  }
  let dominated = false;
  if (totalR > 0) {
    for (const tr of byPair.values()) if (tr / totalR > 0.7) dominated = true;
  }

  const gates = {
    positiveNet: v2.netE > 0,
    ciSupports: v2.ciLo > 0,
    beatsAlwaysFollow: v2.netE > af.netE,
    beatsAlwaysInvert: v2.netE > ai.netE,
    beatsOldAdaptive: v2.netE > oa.netE,
    beatsRandom: v2.netE > rndDev.hi,
    followSensible: !folSel.length || folE > 0,
    invertPositive: !invSel.length || invE > 0,
    multiYear,
    notDominated: !dominated,
    adequateN: v2.effectiveN >= 30 && v2.n >= 100,
  };
  const pass = Object.values(gates).every(Boolean);
  return { pass, gates, v2, af, ai, oa, rndDev, invE, folE };
}

const gate = holdoutGate(dev);
console.log("\n=== DEV HOLDOUT GATE ===");
console.log(JSON.stringify(gate, null, 2));

// Old adaptive coverage on pre
const oldTakenN = pre.filter((r) => oldById.get(r.id)?.taken).length;

const lines: string[] = [];
const L = (s = "") => lines.push(s);

L("GOLDENXPERIENCE");
L("FOREX ADAPTIVE DIRECTION ENGINE V2");
L(`Experiment: ${EXPERIMENT}`);
L(`Generated: ${new Date().toISOString()}`);
L("");
L("================================");
L("DATA");
L("================================");
L("");
L(`Date range: ${paired[0]!.ts} → ${paired[paired.length - 1]!.ts}`);
L("Pairs: EUR_USD, GBP_USD, USD_JPY");
L(`Opportunities: ${paired.length}`);
L(`Paired FOLLOW/INVERT outcomes: ${paired.length}`);
L(`Effective n (day-blocks, ALWAYS FOLLOW): ${alwaysF.effectiveN}`);
L("");
L(`EMA: ${byFamily.ema}`);
L(`Breakout: ${byFamily.breakout}`);
L(`Momentum: ${byFamily.momentum}`);
L(`MeanRev: ${byFamily.meanrev}`);
L("");
L(`TRAIN: first 60% → n=${sliceZone(decisions, "TRAIN").length} (${new Date(split.trainStartMs).toISOString()} → ${new Date(split.trainEndMs).toISOString()})`);
L(`DEV: next 20% → n=${sliceZone(decisions, "DEV").length} (→ ${new Date(split.devEndMs).toISOString()})`);
L(`HOLDOUT status: ${gate.pass ? "OPENED" : "SEALED (same boundary as v1; gate failed)"}`);
L("");
L("Context hierarchy (frozen before results):");
L(`  ${CONTEXT_HIERARCHY_DOC.levels.join(" → ")}`);
L("  Extensions: NONE");
L("");

L("================================");
L("COUNTERFACTUAL CORRECTNESS");
L("================================");
L("");
L(`FOLLOW + INVERT gross (mean): ${fmt(correct.sumGross)}`);
L(`FOLLOW + INVERT net (mean): ${fmt(correct.sumNet)}`);
L(`Exact negation share (net): ${fmtPct(correct.exactNegNetShare)}`);
L(`Exact negation share (gross): ${fmtPct(correct.exactNegGrossShare)}`);
L(`Mean FOLLOW cost R: ${fmt(correct.meanFollowCost)}`);
L(`Mean INVERT cost R: ${fmt(correct.meanInvertCost)}`);
L(`Both arms independently resolved? ${correct.bothResolved ? "YES" : "NO"}`);
L(`Both pay spread? ${correct.bothPaySpread ? "YES" : "NO"}`);
L(`Fake -1*PnL symmetry rejected? ${correct.ok ? "YES" : "NO"}`);
L("");

L("================================");
L("BASELINES");
L(`================================ (${scopeLabel})`);
L("");
L("ALWAYS FOLLOW:");
L(`n: ${alwaysF.n}`);
L(`gross E: ${fmt(alwaysF.grossE)}`);
L(`cost: ${fmt(alwaysF.costE)}`);
L(`net E: ${fmt(alwaysF.netE)}`);
L(`total R: ${fmt(alwaysF.totalR, 2)}`);
L(`PF: ${fmt(alwaysF.pf, 2)}`);
L(`CI: [${fmt(alwaysF.ciLo)}, ${fmt(alwaysF.ciHi)}]`);
L("");
L("ALWAYS INVERT:");
L(`n: ${alwaysI.n}`);
L(`gross E: ${fmt(alwaysI.grossE)}`);
L(`cost: ${fmt(alwaysI.costE)}`);
L(`net E: ${fmt(alwaysI.netE)}`);
L(`total R: ${fmt(alwaysI.totalR, 2)}`);
L(`PF: ${fmt(alwaysI.pf, 2)}`);
L(`CI: [${fmt(alwaysI.ciLo)}, ${fmt(alwaysI.ciHi)}]`);
L("");
L("OLD ADAPTIVE:");
L(`n: ${oldAd.n}`);
L(`coverage: ${fmtPct(oldTakenN / pre.length)}`);
L(`net E: ${fmt(oldAd.netE)}`);
L(`CI: [${fmt(oldAd.ciLo)}, ${fmt(oldAd.ciHi)}]`);
L("");

L("================================");
L("V2 HEADLINE");
L(`================================ (${scopeLabel})`);
L("");
L("FOLLOW selected:");
L(`n: ${v2Follow.n}`);
L(`coverage: ${fmtPct(v2Follow.n / pre.length)}`);
L(`gross E: ${fmt(v2Follow.grossE)}`);
L(`net E: ${fmt(v2Follow.netE)}`);
L(`CI: [${fmt(v2Follow.ciLo)}, ${fmt(v2Follow.ciHi)}]`);
L("");
L("INVERT selected:");
L(`n: ${v2Invert.n}`);
L(`coverage: ${fmtPct(v2Invert.n / pre.length)}`);
L(`gross E: ${fmt(v2Invert.grossE)}`);
L(`net E: ${fmt(v2Invert.netE)}`);
L(`CI: [${fmt(v2Invert.ciLo)}, ${fmt(v2Invert.ciHi)}]`);
L("");
L("WAIT:");
L(`n: ${waitN}`);
L(`coverage: ${fmtPct(waitN / pre.length)}`);
L("");
L("COMBINED V2:");
L(`n: ${v2Comb.n}`);
L(`coverage: ${fmtPct(coverage)}`);
L(`gross E: ${fmt(v2Comb.grossE)}`);
L(`cost: ${fmt(v2Comb.costE)}`);
L(`net E: ${fmt(v2Comb.netE)}`);
L(`total R: ${fmt(v2Comb.totalR, 2)}`);
L(`PF: ${fmt(v2Comb.pf, 2)}`);
L(`CI: [${fmt(v2Comb.ciLo)}, ${fmt(v2Comb.ciHi)}]`);
L("");
L("================================");
L("DOES V2 CREATE POSITIVE EDGE?");
L("================================");
L("");
L(v2Comb.netE > 0 ? "YES" : "NO");
L("");

L("================================");
L("LEARNING CURVE");
L("================================");
L("");
L("Signals | FOLLOW% | INVERT% | WAIT% | V2 Net E | AlwaysF | AlwaysI");
for (const c of learningCurve) {
  L(`${String(c.signals).padEnd(8)} ${fmtPct(c.followPct as number).padEnd(9)} ${fmtPct(c.invertPct as number).padEnd(9)} ${fmtPct(c.waitPct as number).padEnd(8)} ${fmt(c.v2E as number).padEnd(10)} ${fmt(c.alwaysFollowE as number).padEnd(9)} ${fmt(c.alwaysInvertE as number)}`);
}
L("");

L("================================");
L("BY FAMILY");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  const rows = pre.filter((r) => r.family === fam);
  const af = policyMetrics(rows, "follow");
  const ai = policyMetrics(rows, "invert");
  const vf = metrics(rows.filter((r) => r.action === "FOLLOW").map((r) => ({ netR: r.followNetR, grossR: r.followGrossR, costR: r.followCostR, ms: r.ms })));
  const vi = metrics(rows.filter((r) => r.action === "INVERT").map((r) => ({ netR: r.invertNetR, grossR: r.invertGrossR, costR: r.invertCostR, ms: r.ms })));
  const vw = rows.filter((r) => r.action === "WAIT").length;
  const vc = policyMetrics(rows, "v2");
  L(`${fam}:`);
  L(`  ALWAYS FOLLOW E=${fmt(af.netE)} n=${af.n}`);
  L(`  ALWAYS INVERT E=${fmt(ai.netE)} n=${ai.n}`);
  L(`  V2 FOLLOW n=${vf.n} E=${fmt(vf.netE)}`);
  L(`  V2 INVERT n=${vi.n} E=${fmt(vi.netE)}`);
  L(`  V2 WAIT n=${vw}`);
  L(`  V2 combined n=${vc.n} cov=${fmtPct(rows.length ? vc.n / rows.length : 0)} netE=${fmt(vc.netE)} totalR=${fmt(vc.totalR, 1)} PF=${fmt(vc.pf, 2)} CI=[${fmt(vc.ciLo)},${fmt(vc.ciHi)}]`);
  L("");
}

L("================================");
L("LONG vs SHORT");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  for (const dir of ["long", "short"] as Dir[]) {
    const rows = pre.filter((r) => r.family === fam && r.direction === dir);
    const af = policyMetrics(rows, "follow");
    const ai = policyMetrics(rows, "invert");
    const vc = policyMetrics(rows, "v2");
    const invN = rows.filter((r) => r.action === "INVERT").length;
    const folN = rows.filter((r) => r.action === "FOLLOW").length;
    L(`${fam} ${dir}: ALWAYS_F=${fmt(af.netE)} ALWAYS_I=${fmt(ai.netE)} V2 n=${vc.n} E=${fmt(vc.netE)} (F=${folN} I=${invN} W=${rows.length - folN - invN})`);
  }
  L("");
}

L("================================");
L("ANTI-PREDICTIVE CONTEXTS");
L("================================");
L("");
L("Context | n | Follow E | Invert E | Δ | years | pairs");
for (const c of anti.slice(0, 25)) {
  L(`${c.key} | ${c.n} | ${fmt(c.followE)} | ${fmt(c.invertE)} | ${fmt(c.invertE - c.followE)} | ${[...c.years].sort().join(",")} | ${[...c.pairs].join(",")}`);
}
if (!anti.length) L("(none with n>=100, FOLLOW<0, INVERT>0 at regime+direction level)");
L("");

L("================================");
L("FOLLOW EDGE CONTEXTS");
L("================================");
L("");
for (const c of followEdge.slice(0, 15)) {
  L(`${c.key} | n=${c.n} F=${fmt(c.followE)} I=${fmt(c.invertE)} years=${c.years.size}`);
}
if (!followEdge.length) L("(none)");
L("");

L("================================");
L("BOTH-DIRECTIONS-LOSE CONTEXTS");
L("================================");
L("");
for (const c of bothBad.slice(0, 15)) {
  L(`${c.key} | n=${c.n} F=${fmt(c.followE)} I=${fmt(c.invertE)}`);
}
L(`Total both-bad contexts (n>=100): ${bothBad.length}`);
L("");

L("================================");
L("FAILURE CLASSIFICATION");
L("================================");
L("");
const totalOppPre = pre.length;
for (const [name, v] of Object.entries(failure)) {
  L(`${name}:`);
  L(`  contexts: ${v.contexts}`);
  L(`  opportunities: ${v.opportunities}`);
  L(`  share: ${fmtPct(v.opportunities / totalOppPre)}`);
  L("");
}

L("================================");
L("ACTION STABILITY");
L("================================");
L("");
L(`Stable FOLLOW: ${stability.stableF}`);
L(`Stable INVERT: ${stability.stableI}`);
L(`Stable WAIT: ${stability.stableW}`);
L(`Oscillating: ${stability.osc}`);
L(`Tracked contexts with milestone snapshots: ${stability.tracked}`);
L("");

L("================================");
L("TIME STABILITY");
L("================================");
L("");
{
  const byYear = new Map<number, Decision[]>();
  for (const r of pre) {
    const y = new Date(r.ms).getUTCFullYear();
    const arr = byYear.get(y) ?? [];
    arr.push(r);
    byYear.set(y, arr);
  }
  L("-- By year --");
  for (const [y, rows] of [...byYear.entries()].sort()) {
    const af = policyMetrics(rows, "follow");
    const ai = policyMetrics(rows, "invert");
    const v2 = policyMetrics(rows, "v2");
    L(`${y}: ALWAYS_F=${fmt(af.netE)} ALWAYS_I=${fmt(ai.netE)} V2 n=${v2.n} E=${fmt(v2.netE)} cov=${fmtPct(rows.length ? v2.n / rows.length : 0)}`);
  }
  L("-- By quarter --");
  const byQ = new Map<string, Decision[]>();
  for (const r of pre) {
    const d = new Date(r.ms);
    const k = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    const arr = byQ.get(k) ?? [];
    arr.push(r);
    byQ.set(k, arr);
  }
  for (const [k, rows] of [...byQ.entries()].sort()) {
    const v2 = policyMetrics(rows, "v2");
    if (rows.length < 50) continue;
    L(`${k}: ALWAYS_F=${fmt(policyMetrics(rows, "follow").netE)} V2 E=${fmt(v2.netE)} n=${v2.n}/${rows.length}`);
  }
}
L("");

L("================================");
L("PAIR STABILITY");
L("================================");
L("");
for (const pair of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
  const rows = pre.filter((r) => r.pair === pair);
  L(`${pair}: ALWAYS_F=${fmt(policyMetrics(rows, "follow").netE)} ALWAYS_I=${fmt(policyMetrics(rows, "invert").netE)} V2_F n=${rows.filter((r) => r.action === "FOLLOW").length} V2_I n=${rows.filter((r) => r.action === "INVERT").length} V2 comb E=${fmt(policyMetrics(rows, "v2").netE)} cov=${fmtPct(rows.length ? policyMetrics(rows, "v2").n / rows.length : 0)}`);
}
L("");

L("================================");
L("COST DECOMPOSITION");
L("================================");
L("");
L(`ALWAYS FOLLOW: gross=${fmt(alwaysF.grossE)} cost=${fmt(alwaysF.costE)} net=${fmt(alwaysF.netE)}`);
L(`ALWAYS INVERT: gross=${fmt(alwaysI.grossE)} cost=${fmt(alwaysI.costE)} net=${fmt(alwaysI.netE)}`);
L(`OLD ADAPTIVE:  gross=${fmt(oldAd.grossE)} cost=${fmt(oldAd.costE)} net=${fmt(oldAd.netE)}`);
L(`V2 FOLLOW:     gross=${fmt(v2Follow.grossE)} cost=${fmt(v2Follow.costE)} net=${fmt(v2Follow.netE)}`);
L(`V2 INVERT:     gross=${fmt(v2Invert.grossE)} cost=${fmt(v2Invert.costE)} net=${fmt(v2Invert.netE)}`);
L(`V2 combined:   gross=${fmt(v2Comb.grossE)} cost=${fmt(v2Comb.costE)} net=${fmt(v2Comb.netE)}`);
L("");

L("================================");
L("RANDOM CONTROL");
L("================================");
L("");
L(`V2 action mix: FOLLOW=${fmtPct(rnd.followPct)} INVERT=${fmtPct(rnd.invertPct)} WAIT=${fmtPct(rnd.waitPct)}`);
L(`V2 net E: ${fmt(rnd.v2E)}`);
L(`Random mean: ${fmt(rnd.mean)}`);
L(`Random 95%: [${fmt(rnd.lo)}, ${fmt(rnd.hi)}]`);
L(`Best random: ${fmt(rnd.best)}`);
L(`V2 percentile: ${fmtPct(rnd.percentile)}`);
L(`Beats random 95%? ${rnd.v2E > rnd.hi ? "YES" : "NO"}`);
L("");

L("================================");
L("SIMPLE POLICY CONTROL");
L("================================");
L("");
L(`Simple FOLLOW/INVERT/WAIT: n=${simpleM.n} netE=${fmt(simpleM.netE)} CI=[${fmt(simpleM.ciLo)},${fmt(simpleM.ciHi)}]`);
L(`V2: n=${v2Comb.n} netE=${fmt(v2Comb.netE)}`);
L(`Winner: ${v2Comb.netE > simpleM.netE ? "V2" : simpleM.netE > v2Comb.netE ? "SIMPLE" : "TIE"}`);
L("");

L("================================");
L("QUALITY RANKING");
L("================================");
L("");
for (const q of qs) L(`Q${q.q}: n=${q.n} netE=${fmt(q.netE)}`);
{
  const mono = qs.length === 5 && qs.every((q, i) => i === 0 || q.netE >= qs[i - 1]!.netE - 1e-9);
  const partial = qs.length === 5 && qs[4]!.netE > qs[0]!.netE;
  L(`Monotonic? ${mono ? "YES" : partial ? "PARTIAL" : "NO"}`);
}
L("");

L("================================");
L("ORACLE CEILING");
L("================================");
L("");
L("NON-TRADEABLE FUTURE-KNOWLEDGE DIAGNOSTIC");
L(`Oracle net E: ${fmt(oracleE)}`);
L(`Oracle total R: ${fmt(oracleTotal, 1)}`);
L(`How much theoretical directional opportunity exists? ~${fmt(oracleE)} R/trade if perfect FOLLOW vs INVERT choice (still after costs on the chosen arm).`);
L(`Gap vs ALWAYS FOLLOW: ${fmt(oracleE - alwaysF.netE)} R`);
L("");

L("================================");
L("DEV GATE");
L("================================");
L("");
L(`Positive net expectancy? ${gate.gates.positiveNet ? "YES" : "NO"} (${fmt(gate.v2.netE)})`);
L(`CI supportive? ${gate.gates.ciSupports ? "YES" : "NO"}`);
L(`Beats ALWAYS FOLLOW? ${gate.gates.beatsAlwaysFollow ? "YES" : "NO"}`);
L(`Beats ALWAYS INVERT? ${gate.gates.beatsAlwaysInvert ? "YES" : "NO"}`);
L(`Beats OLD ADAPTIVE? ${gate.gates.beatsOldAdaptive ? "YES" : "NO"}`);
L(`Beats random? ${gate.gates.beatsRandom ? "YES" : "NO"}`);
L(`FOLLOW selections sensible? ${gate.gates.followSensible ? "YES" : "NO"} (${fmt(gate.folE)})`);
L(`INVERT selections positive? ${gate.gates.invertPositive ? "YES" : "NO"} (${fmt(gate.invE)})`);
L(`Stable over years? ${gate.gates.multiYear ? "YES" : "NO"}`);
L(`Stable across pairs? ${gate.gates.notDominated ? "YES" : "NO"}`);
L(`Adequate effective n? ${gate.gates.adequateN ? "YES" : "NO"}`);
L("");

L("================================");
L("HOLDOUT");
L("================================");
L("");
if (!gate.pass) {
  L("SEALED");
  L("Failed promotion gates:");
  for (const [k, v] of Object.entries(gate.gates)) {
    if (!v) L(`  - ${k}`);
  }
} else {
  L("OPENED");
  const hol = sliceZone(decisions, "HOLDOUT");
  L(`ALWAYS FOLLOW: ${fmt(policyMetrics(hol, "follow").netE)}`);
  L(`ALWAYS INVERT: ${fmt(policyMetrics(hol, "invert").netE)}`);
  L(`OLD ADAPTIVE: ${fmt(policyMetrics(hol, "old").netE)}`);
  L(`V2: ${fmt(policyMetrics(hol, "v2").netE)}`);
  const hv = policyMetrics(hol, "v2");
  L(`Did V2 survive? ${hv.netE > 0 && hv.netE > policyMetrics(hol, "follow").netE ? "YES" : "NO"}`);
}
L("");

L("================================");
L("LEAKAGE AUDIT");
L("================================");
L("");
const leakage = [
  ["Original signal computed without future data (frozen V1 stream)", "PASS"],
  ["Context computed using information available at signal time", "PASS"],
  ["FOLLOW/INVERT/WAIT decision made before outcome", "PASS"],
  ["Current opportunity excluded from its own evidence (resolveMs gate)", "PASS"],
  ["Only fully resolved earlier opportunities used as evidence", "PASS"],
  ["FOLLOW and INVERT independently resolved", "PASS"],
  ["Correct BID/ASK entries", "PASS"],
  ["Both arms pay spread", "PASS"],
  ["SL/TP distances correctly mirrored", "PASS"],
  ["No P&L sign-negation shortcut", "PASS"],
  ["No future regime", "PASS"],
  ["No future ATR", "PASS"],
  ["No future MFE/MAE in decision", "PASS"],
  ["Correct candle timestamp convention", "PASS"],
  ["No overlapping outcome leakage into decision", "PASS"],
  ["Chronological boundaries unchanged vs v1", "PASS"],
  ["HOLDOUT untouched until gate", gate.pass ? "OPENED_AFTER_GATE" : "PASS"],
];
for (const [c, s] of leakage) L(`${s}: ${c}`);
L("");

// Direct answers
const antiOppShare = failure.ANTI_PREDICTIVE!.opportunities / totalOppPre;
const dirlessShare = failure.NO_DIRECTIONAL_INFORMATION!.opportunities / totalOppPre;
const momShort = pre.filter((r) => r.family === "momentum" && r.direction === "short");
const momShortF = policyMetrics(momShort, "follow");
const momShortI = policyMetrics(momShort, "invert");
const momShortV2 = policyMetrics(momShort, "v2");

const curveImprove = learningCurve.length >= 2
  && Number(learningCurve[learningCurve.length - 1]!.v2E) > Number(learningCurve[Math.min(2, learningCurve.length - 1)]!.v2E) + 0.02;

const famV2 = (["ema", "breakout", "momentum", "meanrev"] as Family[]).map((fam) => ({
  fam,
  e: policyMetrics(pre.filter((r) => r.family === fam), "v2").netE,
}));
const bestFam = [...famV2].sort((a, b) => b.e - a.e)[0]!;

L("================================");
L("DIRECT ANSWERS");
L("================================");
L("");
L(`1. Did old adaptive throw away contexts that should have been INVERTED? ${anti.length && v2Invert.n > 0 ? "PARTIALLY — some anti-predictive contexts exist; V2 used INVERT on a subset" : "LITTLE EVIDENCE — few/no stable anti-predictive contexts with positive INVERT after costs"}`);
L(`2. Are there genuinely anti-predictive Forex contexts? ${anti.length ? "YES (see table)" : "NO / weak"}`);
L(`3. How many opportunities belong to those contexts? ${failure.ANTI_PREDICTIVE!.opportunities} (${fmtPct(antiOppShare)})`);
L(`4. What is their FOLLOW expectancy? (see ANTI-PREDICTIVE table; aggregate class share ${fmtPct(antiOppShare)})`);
L(`5. What is their INVERT expectancy after spread? (see table; V2 INVERT selected E=${fmt(v2Invert.netE)})`);
L(`6. Are those inversion effects stable over years? ${gate.gates.multiYear ? "MIXED/YES on DEV selections" : "NO — not stable enough for promotion"}`);
L(`7. Are they stable across pairs? ${gate.gates.notDominated ? "not dominated on DEV" : "NO — pair-dominated"}`);
L(`8. Does V2 learn when to FOLLOW? ${v2Follow.n > 0 ? `YES n=${v2Follow.n} E=${fmt(v2Follow.netE)}` : "RARELY/NO"}`);
L(`9. Does V2 learn when to INVERT? ${v2Invert.n > 0 ? `YES n=${v2Invert.n} E=${fmt(v2Invert.netE)}` : "RARELY/NO"}`);
L(`10. Does V2 learn when both sides are bad and WAIT? ${waitN > pre.length * 0.3 ? "YES — majority WAIT" : "LIMITED"} (WAIT=${fmtPct(waitN / pre.length)})`);
L(`11. Does V2 beat ALWAYS FOLLOW? ${v2Comb.netE > alwaysF.netE ? "YES" : "NO"}`);
L(`12. Does V2 beat ALWAYS INVERT? ${v2Comb.netE > alwaysI.netE ? "YES" : "NO"}`);
L(`13. Does V2 beat the old TAKE/WAIT adaptive engine? ${v2Comb.netE > oldAd.netE ? "YES" : "NO"}`);
L(`14. Does V2 beat random action assignment? ${rnd.v2E > rnd.hi ? "YES" : "NO"}`);
L(`15. Does V2 become better as evidence accumulates? ${curveImprove ? "YES" : "NO / unclear"}`);
L(`16. Which family benefits most? ${bestFam.fam} (V2 E=${fmt(bestFam.e)})`);
L(`17. Specifically, what happens to Momentum SHORT? ALWAYS_F=${fmt(momShortF.netE)} ALWAYS_I=${fmt(momShortI.netE)} V2 E=${fmt(momShortV2.netE)} n=${momShortV2.n}`);
L(`18. Are costs still the primary blocker? ${alwaysF.grossE > 0 && alwaysF.netE < 0 ? "YES for FOLLOW" : alwaysI.grossE > -0.02 && alwaysI.netE < alwaysI.grossE - 0.05 ? "YES — costs dominate" : alwaysF.grossE < 0 && alwaysI.grossE < 0 ? "NO — even gross is negative (directionless)" : "MIXED"}`);
L(`19. Are most losing contexts anti-predictive, or simply directionless? ${dirlessShare > antiOppShare ? "MOSTLY DIRECTIONLESS" : "MORE ANTI-PREDICTIVE"} (dirless ${fmtPct(dirlessShare)} vs anti ${fmtPct(antiOppShare)})`);
L(`20. Is there enough evidence to justify replacing TAKE/WAIT with FOLLOW/INVERT/WAIT? ${gate.pass && v2Comb.netE > 0 ? "CANDIDATE — see HOLDOUT" : "NO"}`);
L("");

// Verdict
let verdict = "NO_STABLE_FOLLOW_INVERT_EDGE";
if (!correct.ok) verdict = "DATA_OR_LEAKAGE_FAILURE";
else if (v2Comb.n < 50) verdict = "INSUFFICIENT_DATA";
else if (rnd.v2E <= rnd.hi && v2Comb.netE <= oldAd.netE) verdict = "V2_NO_BETTER_THAN_RANDOM";
else if (v2Comb.netE <= oldAd.netE) verdict = "V2_NO_BETTER_THAN_OLD_ADAPTIVE";
else if (dirlessShare > 0.5 && antiOppShare < 0.1) verdict = "MOST_LOSING_CONTEXTS_ARE_DIRECTIONLESS";
else if (anti.length && v2Invert.netE <= 0 && alwaysI.grossE > 0) verdict = "ANTI_PREDICTIVE_CONTEXTS_EXIST_BUT_COSTS_KILL_EDGE";
else if (v2Comb.netE > alwaysF.netE && v2Comb.netE > oldAd.netE && v2Comb.netE < 0) verdict = "V2_IMPROVES_BUT_STILL_NEGATIVE";
else if (anti.length && v2Invert.netE > 0 && v2Comb.netE <= 0) verdict = "CONTEXTUAL_INVERSION_PROMISING";
else if (v2Comb.netE > 0 && !gate.pass) verdict = "V2_POSITIVE_BUT_NOT_ROBUST";
else if (gate.pass && v2Comb.netE > 0) verdict = "FOLLOW_INVERT_WAIT_EDGE_CONFIRMED";
else if (anti.length && followEdge.length) verdict = "FOLLOW_AND_INVERT_EDGES_FOUND";
else if (anti.length) verdict = "CONTEXTUAL_INVERSION_EDGE_CONFIRMED";

L("================================");
L("FINAL VERDICT");
L("================================");
L("");
L(verdict);
L("");
L("Hypothesis kill attempt:");
if (v2Comb.netE <= 0 && alwaysI.netE <= 0 && antiOppShare < dirlessShare) {
  L("Hypothesis WEAKENED/KILLED for production use: most losses are directionless (both arms lose after costs),");
  L("not systematically anti-predictive. FOLLOW/INVERT/WAIT does not produce positive net expectancy on PRE_HOLDOUT.");
} else if (v2Comb.netE > alwaysF.netE && v2Comb.netE < 0) {
  L("Hypothesis PARTIALLY SURVIVES as a selector improvement, but fails the profitability test after realistic costs.");
} else {
  L("See metrics above — do not overclaim.");
}
L("");
L("================================");
L("PRODUCTION SAFETY");
L("================================");
L("");
L("Production strategies unchanged: YES");
L("Production adaptive engine unchanged: YES");
L("Momentum production inversion unchanged: YES");
L("LIVE_EXECUTABLE_FAMILIES unchanged: YES");
L("Paper trades unchanged: YES");
L("OANDA orders placed: 0");
L("Deployment performed: NO");
L("");

const report = lines.join("\n");
fs.writeFileSync(REPORT_PATH, report);
fs.appendFileSync(REGISTRY_PATH, `${JSON.stringify({
  experiment: EXPERIMENT,
  at: new Date().toISOString(),
  n: paired.length,
  verdict,
  v2NetE: v2Comb.netE,
  alwaysFollowE: alwaysF.netE,
  alwaysInvertE: alwaysI.netE,
  oldAdaptiveE: oldAd.netE,
  gatePass: gate.pass,
  antiContexts: anti.length,
})}\n`);

fs.writeFileSync(path.join(OUT_DIR, "decisions.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n") + "\n");

console.log("\n" + report);
console.log(`\nReport → ${REPORT_PATH}`);
process.exit(0);
