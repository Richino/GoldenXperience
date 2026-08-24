/**
 * Full falsification audit for any frozen V2 candidate JSON.
 * Usage: CANDIDATE=gx-v2-003 npx tsx research-v2/bin/audit-frozen.ts
 * Does NOT retune.
 */
import fs from "node:fs";
import path from "node:path";

import "../src/env.js";
import { CANDIDATES_DIR, RESEARCH_V2_ROOT } from "../src/env.js";
import { DEFAULT_SLIPPAGE_PIPS, SAFETY_MARGIN_RETURN } from "../src/config.js";
import { slippageAbsolute } from "../src/costs.js";
import { decide, type AbstentionThresholds } from "../src/models/abstention.js";
import { fitModel, predict, type FittedModel } from "../src/models/fit.js";
import { buildPanel, filterRegime, zoneOf } from "../src/panel.js";
import { printLeakageAudit } from "../src/validation/leakage.js";
import { metricsFromTrades } from "../src/validation/metrics.js";
import type { DataZones, HorizonId, Sample, TradeSim } from "../src/types.js";

type Cand = {
  candidateId: string;
  hypothesis: string;
  hypothesisId: string;
  modelKind: "logistic" | "ridge" | "boost_reg" | "boost_clf";
  horizon: HorizonId;
  directionMode?: "both" | "long_only" | "short_only";
  featureFamilies: Array<"price" | "cross_pair" | "regime" | "session" | "macro" | "events">;
  featureNames: string[];
  thresholds: AbstentionThresholds;
  zones: DataZones;
  pairUniverse?: string[];
};

type AuditTrade = TradeSim & { atr: number; session: string; trend: string; vol: string };

const id = process.env.CANDIDATE ?? "gx-v2-003";
const src = path.join(CANDIDATES_DIR, `${id}.json`);
if (!fs.existsSync(src)) {
  console.error("missing", src);
  process.exit(1);
}
const candidate = JSON.parse(fs.readFileSync(src, "utf8")) as Cand;
const pairs = candidate.pairUniverse ?? ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY"];
const directionMode = candidate.directionMode ?? "both";

function fmt(x: number) {
  if (!Number.isFinite(x)) return String(x);
  return (x >= 0 ? "+" : "") + x.toFixed(4);
}

function train(samples: Sample[], zones: DataZones, names: string[], horizon: HorizonId): FittedModel {
  const rows: Record<string, number>[] = [];
  const targets: number[] = [];
  for (const s of samples) {
    if (zoneOf(s.ts, zones) !== "train") continue;
    const label = s.labels[horizon];
    if (!label) continue;
    rows.push(s.features);
    targets.push(s.atr > 0 ? label.netReturn / s.atr : label.netReturn);
  }
  return fitModel("logistic", names, rows, targets, { lambda: 1 });
}

function sim(args: {
  samples: Sample[];
  model: FittedModel;
  costMult?: number;
  slipPips?: number;
  delayBars?: number;
}): AuditTrade[] {
  const { samples, model } = args;
  const costMult = args.costMult ?? 1;
  const slipPips = args.slipPips ?? DEFAULT_SLIPPAGE_PIPS;
  const delayBars = args.delayBars ?? 0;
  const byInst = new Map<string, Sample[]>();
  for (const s of samples) {
    const a = byInst.get(s.instrument) ?? [];
    a.push(s);
    byInst.set(s.instrument, a);
  }
  for (const a of byInst.values()) a.sort((x, y) => x.ts - y.ts);
  const idx = new Map<string, number>();
  for (const [inst, a] of byInst) for (let i = 0; i < a.length; i++) idx.set(`${inst}|${a[i]!.closeTime}`, i);

  const out: AuditTrade[] = [];
  for (const s of samples) {
    if (zoneOf(s.ts, candidate.zones) !== "sealed") continue;
    const label0 = s.labels[candidate.horizon];
    if (!label0) continue;

    let signal = s;
    let label = label0;
    let entry = s;
    if (delayBars > 0) {
      const a = byInst.get(s.instrument)!;
      const i = idx.get(`${s.instrument}|${s.closeTime}`);
      if (i == null || i + delayBars >= a.length) continue;
      entry = a[i + delayBars]!;
      const dl = entry.labels[candidate.horizon];
      if (!dl) continue;
      label = dl;
    }

    const spread = entry.spread * costMult;
    const slip = slippageAbsolute(entry.instrument, slipPips) * costMult;
    const predRaw = predict(model, signal.features);
    const pred = {
      expectedReturn: predRaw.expectedReturn * Math.max(signal.atr, 1e-12),
      probabilityUp: predRaw.probabilityUp,
    };
    const decision = decide({
      pred,
      spread,
      slip,
      safety: SAFETY_MARGIN_RETURN,
      thresholds: candidate.thresholds,
      directionMode,
    });
    if (decision.decision === "wait") continue;

    let net = decision.decision === "long" ? label.netReturn : -label.rawReturn - label.spreadCost;
    if (costMult > 1) net -= (costMult - 1) * label.spreadCost;
    const scale = signal.atr > 0 ? 1 / signal.atr : 1;
    out.push({
      instrument: s.instrument,
      closeTime: s.closeTime,
      direction: decision.decision,
      horizon: candidate.horizon,
      entry: decision.decision === "long" ? entry.askClose : entry.bidClose,
      exit: 0,
      grossReturn: (decision.decision === "long" ? label.rawReturn : -label.rawReturn) * scale,
      spreadCost: label.spreadCost * costMult * scale,
      slippageCost: label.slippageCost * scale,
      netReturn: net * scale,
      mfe: label.mfe * scale,
      mae: label.mae * scale,
      atr: signal.atr,
      session: signal.regime.session,
      trend: signal.regime.trend,
      vol: signal.regime.volBucket,
    });
  }
  return out;
}

console.log(`\nFULL AUDIT ${id}`);
console.log(candidate.hypothesis);
printLeakageAudit();

const panel = await buildPanel({
  pairs,
  timeframe: "H1",
  families: candidate.featureFamilies,
  horizons: [candidate.horizon],
  zones: candidate.zones,
  stride: candidate.horizon === "1d" ? 2 : 2,
});
// no session filter unless overlap-only (001) — these JPY hyps are all-session
const samples = filterRegime(panel.samples, undefined);
const model = train(samples, candidate.zones, candidate.featureNames, candidate.horizon);
const baseline = sim({ samples, model });
const base = metricsFromTrades(baseline);
const total = baseline.reduce((s, t) => s + t.netReturn, 0);

console.log(`\nBASELINE n=${base.n} net=${fmt(base.netExpectancy)} CI=[${fmt(base.ci95Low)}, ${fmt(base.ci95High)}] pf=${base.profitFactor.toFixed(3)} wr=${(base.winRate * 100).toFixed(1)}% totalATR=${fmt(total)}`);

for (const mult of [1.25, 1.5, 2]) {
  const t = sim({ samples, model, costMult: mult });
  const m = metricsFromTrades(t);
  console.log(`spread +${Math.round((mult - 1) * 100)}%: n=${m.n} net=${fmt(m.netExpectancy)} CI=[${fmt(m.ci95Low)}, ${fmt(m.ci95High)}]`);
}
for (const d of [1, 2]) {
  const t = sim({ samples, model, delayBars: d });
  const m = metricsFromTrades(t);
  console.log(`delay ${d}bar: n=${m.n} net=${fmt(m.netExpectancy)} CI=[${fmt(m.ci95Low)}, ${fmt(m.ci95High)}]`);
}

const byPair = new Map<string, number>();
for (const t of baseline) byPair.set(t.instrument, (byPair.get(t.instrument) ?? 0) + t.netReturn);
const pairRank = [...byPair.entries()].sort((a, b) => b[1] - a[1]);
console.log("\nBy pair total ATR-net:");
for (const [p, v] of pairRank) {
  const ts = baseline.filter((t) => t.instrument === p);
  const m = metricsFromTrades(ts);
  console.log(`  ${p} n=${m.n} exp=${fmt(m.netExpectancy)} total=${fmt(v)} ${m.netExpectancy < 0 ? "NEG" : ""}`);
}
const bestPair = pairRank[0]![0];
const dropBest = metricsFromTrades(baseline.filter((t) => t.instrument !== bestPair));
console.log(`drop ${bestPair}: n=${dropBest.n} net=${fmt(dropBest.netExpectancy)}`);

const byMonth = new Map<string, number>();
for (const t of baseline) {
  const mo = t.closeTime.slice(0, 7);
  byMonth.set(mo, (byMonth.get(mo) ?? 0) + t.netReturn);
}
const months = [...byMonth.entries()].sort((a, b) => b[1] - a[1]);
console.log("\nTop months:");
for (const [mo, v] of months.slice(0, 5)) console.log(`  ${mo} total=${fmt(v)}`);
const bestMonth = months[0]![0];
const dropMonth = metricsFromTrades(baseline.filter((t) => t.closeTime.slice(0, 7) !== bestMonth));
console.log(`drop ${bestMonth}: n=${dropMonth.n} net=${fmt(dropMonth.netExpectancy)}`);

const sorted = [...baseline].sort((a, b) => b.netReturn - a.netReturn);
for (const k of [5, 10, 50]) {
  const m = metricsFromTrades(sorted.slice(k));
  console.log(`drop top ${k}: n=${m.n} net=${fmt(m.netExpectancy)}`);
}

const longs = metricsFromTrades(baseline.filter((t) => t.direction === "long"));
const shorts = metricsFromTrades(baseline.filter((t) => t.direction === "short"));
console.log(`LONG n=${longs.n} net=${fmt(longs.netExpectancy)} CI=[${fmt(longs.ci95Low)}, ${fmt(longs.ci95High)}]`);
console.log(`SHORT n=${shorts.n} net=${fmt(shorts.netExpectancy)} CI=[${fmt(shorts.ci95Low)}, ${fmt(shorts.ci95High)}]`);

const byYear = new Map<string, AuditTrade[]>();
for (const t of baseline) {
  const y = t.closeTime.slice(0, 4);
  const a = byYear.get(y) ?? [];
  a.push(t);
  byYear.set(y, a);
}
for (const [y, ts] of [...byYear.entries()].sort()) {
  const m = metricsFromTrades(ts);
  console.log(`year ${y}: n=${m.n} net=${fmt(m.netExpectancy)} total=${fmt(ts.reduce((s, t) => s + t.netReturn, 0))}`);
}

// Overlap / stride concern for 1d
const uniqueDays = new Set(baseline.map((t) => t.closeTime.slice(0, 10)));
console.log(`\nunique calendar days traded: ${uniqueDays.size} / n=${baseline.length} (overlap ratio=${(baseline.length / Math.max(1, uniqueDays.size)).toFixed(2)})`);

let verdict: "ROBUST_PASS" | "PROVISIONAL_PASS" | "ROBUSTNESS_REJECT" | "INCONCLUSIVE" = "INCONCLUSIVE";
const fails: string[] = [];
if (base.ci95Low <= 0) fails.push("CI crosses 0");
if (dropBest.netExpectancy <= 0) fails.push(`drop ${bestPair}`);
if (dropMonth.netExpectancy <= 0) fails.push(`drop ${bestMonth}`);
const drop10 = metricsFromTrades(sorted.slice(10));
if (drop10.netExpectancy <= 0) fails.push("drop top10");
const cost2 = metricsFromTrades(sim({ samples, model, costMult: 2 }));
if (cost2.netExpectancy <= 0) fails.push("+100% spread");
const delay2 = metricsFromTrades(sim({ samples, model, delayBars: 2 }));
if (delay2.netExpectancy <= 0) fails.push("2bar delay");
if (shorts.n > 20 && shorts.netExpectancy < 0 && longs.netExpectancy > 0 && Math.abs(shorts.netExpectancy) > 0.05)
  fails.push("SHORT side loses hard");
const years = [...byYear.entries()].map(([y, ts]) => ({ y, m: metricsFromTrades(ts) }));
if (years.some((y) => y.m.n >= 40 && y.m.netExpectancy < 0) && years.some((y) => y.m.netExpectancy > 0))
  fails.push("year sign flip");

if (fails.length >= 2 || (fails.length >= 1 && base.ci95Low <= 0)) verdict = "ROBUSTNESS_REJECT";
else if (fails.length === 0 && base.ci95Low > 0 && base.n >= 150) verdict = "ROBUST_PASS";
else if (base.netExpectancy > 0) verdict = "PROVISIONAL_PASS";

const report = `FULL_AUDIT ${id}
verdict: ${verdict}
fails: ${fails.join("; ") || "none"}
baseline: n=${base.n} net=${fmt(base.netExpectancy)} CI=[${fmt(base.ci95Low)}, ${fmt(base.ci95High)}]
`;
const outPath = path.join(RESEARCH_V2_ROOT, "candidates", `${id}-full-audit.txt`);
fs.writeFileSync(outPath, report, "utf8");
console.log(`\nFINAL VERDICT: ${verdict}`);
console.log(`REASON: ${fails.join("; ") || "survived listed stresses"}`);
console.log(`Wrote ${outPath}`);

// stamp candidate
const j = JSON.parse(fs.readFileSync(src, "utf8"));
j.auditVerdict = verdict;
j.grade = verdict === "ROBUST_PASS" ? "strong_candidate" : verdict.toLowerCase();
j.mode = verdict === "ROBUST_PASS" ? "SHADOW_ONLY" : "REJECTED_OR_HOLD";
j.fullAuditReport = `${id}-full-audit.txt`;
j.doNotRescue = verdict !== "ROBUST_PASS";
fs.writeFileSync(src, JSON.stringify(j, null, 2));
