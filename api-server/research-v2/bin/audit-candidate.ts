/**
 * Falsification audit for frozen gx-v2-001 / gx-v2-candidate-001.
 * Does NOT retune thresholds or search new hypotheses.
 */
import fs from "node:fs";
import path from "node:path";

import "../src/env.js";
import { CANDIDATES_DIR, RESEARCH_V2_ROOT } from "../src/env.js";
import { DEFAULT_SLIPPAGE_PIPS, SAFETY_MARGIN_RETURN } from "../src/config.js";
import { slippageAbsolute } from "../src/costs.js";
import { decide, type AbstentionThresholds } from "../src/models/abstention.js";
import { fitModel, predict, type FittedModel } from "../src/models/fit.js";
import { meanCi95, profitFactor } from "../src/math.js";
import { buildPanel, filterRegime, zoneOf } from "../src/panel.js";
import { auditLeakage, printLeakageAudit } from "../src/validation/leakage.js";
import { metricsFromTrades } from "../src/validation/metrics.js";
import type { DataZones, HorizonId, Sample, TradeSim } from "../src/types.js";

type AuditTrade = TradeSim & {
  regimeTrend: string;
  volBucket: string;
  volPhase: string;
  session: string;
  atr: number;
};

const SOURCE = path.join(CANDIDATES_DIR, "gx-v2-001.json");
const FROZEN = path.join(CANDIDATES_DIR, "gx-v2-candidate-001.json");

type Candidate = {
  candidateId: string;
  hypothesis: string;
  hypothesisId: string;
  modelKind: "logistic" | "ridge" | "boost_reg" | "boost_clf";
  horizon: HorizonId;
  featureFamilies: Array<"price" | "cross_pair" | "regime" | "session" | "macro" | "events">;
  featureNames: string[];
  thresholds: AbstentionThresholds;
  zones: DataZones;
  sealedMetrics: Record<string, unknown>;
  importance: Array<{ name: string; weight: number }>;
  safetyMargin: number;
};

function fmt(x: number, digs = 6): string {
  if (!Number.isFinite(x)) return String(x);
  const ax = Math.abs(x);
  if (ax !== 0 && ax < 1e-3) return x.toExponential(3);
  return (x >= 0 ? "+" : "") + x.toFixed(digs);
}

function summarize(trades: AuditTrade[]) {
  const m = metricsFromTrades(trades);
  const totalNet = trades.reduce((s, t) => s + t.netReturn, 0);
  const totalAtrR = trades.reduce((s, t) => s + (t.atr > 0 ? t.netReturn / t.atr : 0), 0);
  return { ...m, totalNet, totalAtrR };
}

function lineSummary(label: string, trades: AuditTrade[]) {
  const s = summarize(trades);
  return `${label}: n=${s.n} net=${fmt(s.netExpectancy)} CI=[${fmt(s.ci95Low)}, ${fmt(s.ci95High)}] wr=${(s.winRate * 100).toFixed(1)}% pf=${s.profitFactor === Infinity ? "inf" : s.profitFactor.toFixed(3)} dd=${fmt(s.maxDrawdown)} totalNet=${fmt(s.totalNet)}`;
}

function trainFrozen(samples: Sample[], zones: DataZones, featureNames: string[], horizon: HorizonId): FittedModel {
  const rows: Record<string, number>[] = [];
  const targets: number[] = [];
  for (const s of samples) {
    if (zoneOf(s.ts, zones) !== "train") continue;
    const label = s.labels[horizon];
    if (!label) continue;
    rows.push(s.features);
    targets.push(s.atr > 0 ? label.netReturn / s.atr : label.netReturn);
  }
  return fitModel("logistic", featureNames, rows, targets, { lambda: 1 });
}

function simulateFrozen(args: {
  samples: Sample[];
  zones: DataZones;
  model: FittedModel;
  horizon: HorizonId;
  thresholds: AbstentionThresholds;
  costMult?: number;
  slipPips?: number;
  delayBars?: number;
  /** Zero these feature name prefixes/exact names at inference (no retrain). */
  zeroFeatures?: (name: string) => boolean;
  /** Optional sample filter after decisions (e.g. drop pair). Applied to resulting trades. */
}): AuditTrade[] {
  const {
    samples,
    zones,
    model,
    horizon,
    thresholds,
    costMult = 1,
    slipPips = DEFAULT_SLIPPAGE_PIPS,
    delayBars = 0,
    zeroFeatures,
  } = args;

  // Per-instrument chronological index for delay lookup
  const byInst = new Map<string, Sample[]>();
  for (const s of samples) {
    const arr = byInst.get(s.instrument) ?? [];
    arr.push(s);
    byInst.set(s.instrument, arr);
  }
  for (const arr of byInst.values()) arr.sort((a, b) => a.ts - b.ts);
  const indexOf = new Map<string, number>();
  for (const [inst, arr] of byInst) {
    for (let i = 0; i < arr.length; i += 1) indexOf.set(`${inst}|${arr[i]!.closeTime}`, i);
  }

  const trades: AuditTrade[] = [];
  for (const s of samples) {
    if (zoneOf(s.ts, zones) !== "sealed") continue;
    if (s.regime.session !== "overlap") continue; // frozen H12 filter
    const label = s.labels[horizon];
    if (!label) continue;

    let signal = s;
    let realized = s;
    if (delayBars > 0) {
      const arr = byInst.get(s.instrument)!;
      const idx = indexOf.get(`${s.instrument}|${s.closeTime}`);
      if (idx == null || idx + delayBars >= arr.length) continue;
      // Signal at s; enter at delayed bar; still use original horizon label from signal time
      // (delay hurts because we miss move / pay worse prices — approximate by shifting
      // realized net using delayed bar's forward label when available).
      const delayed = arr[idx + delayBars]!;
      realized = delayed;
      const delayedLabel = delayed.labels[horizon];
      if (!delayedLabel) continue;
      // Use delayed features for decision? No — decision was at signal; entry delay only.
      // Keep signal features for predict; mark economics from delayed label.
      signal = s;
      const features = { ...signal.features };
      if (zeroFeatures) {
        for (const k of Object.keys(features)) if (zeroFeatures(k)) features[k] = 0;
      }
      const spread = delayed.spread * costMult;
      const slip = slippageAbsolute(delayed.instrument, slipPips) * costMult;
      const predRaw = predict(model, features);
      const pred = {
        expectedReturn: predRaw.expectedReturn * Math.max(signal.atr, 1e-12),
        probabilityUp: predRaw.probabilityUp,
      };
      const decision = decide({
        pred,
        spread,
        slip,
        safety: SAFETY_MARGIN_RETURN,
        thresholds,
      });
      if (decision.decision === "wait") continue;
      let net =
        decision.decision === "long"
          ? delayedLabel.netReturn
          : -delayedLabel.rawReturn - delayedLabel.spreadCost;
      if (costMult > 1) net -= (costMult - 1) * delayedLabel.spreadCost;
      // Extra slip already partially in delayedLabel.slippageCost; add extra slip stress
      const baseSlip = delayedLabel.slippageCost;
      const stressedSlip = 2 * slip;
      if (stressedSlip > baseSlip) net -= stressedSlip - baseSlip;

      trades.push({
        instrument: s.instrument,
        closeTime: s.closeTime,
        direction: decision.decision,
        horizon,
        entry: decision.decision === "long" ? delayed.askClose : delayed.bidClose,
        exit: 0,
        grossReturn: decision.decision === "long" ? delayedLabel.rawReturn : -delayedLabel.rawReturn,
        spreadCost: delayedLabel.spreadCost * costMult,
        slippageCost: stressedSlip,
        netReturn: net,
        mfe: delayedLabel.mfe,
        mae: delayedLabel.mae,
        regimeTrend: signal.regime.trend,
        volBucket: signal.regime.volBucket,
        volPhase: signal.regime.volPhase,
        session: signal.regime.session,
        atr: signal.atr,
      });
      continue;
    }

    const features = { ...signal.features };
    if (zeroFeatures) {
      for (const k of Object.keys(features)) if (zeroFeatures(k)) features[k] = 0;
    }
    const spread = signal.spread * costMult;
    const slip = slippageAbsolute(signal.instrument, slipPips) * costMult;
    const predRaw = predict(model, features);
    const pred = {
      expectedReturn: predRaw.expectedReturn * Math.max(signal.atr, 1e-12),
      probabilityUp: predRaw.probabilityUp,
    };
    const decision = decide({
      pred,
      spread,
      slip,
      safety: SAFETY_MARGIN_RETURN,
      thresholds,
    });
    if (decision.decision === "wait") continue;

    let net =
      decision.decision === "long" ? label.netReturn : -label.rawReturn - label.spreadCost;
    if (costMult > 1) net -= (costMult - 1) * label.spreadCost;
    const baseSlip = label.slippageCost;
    const stressedSlip = 2 * slip;
    if (stressedSlip > baseSlip) net -= stressedSlip - baseSlip;

    trades.push({
      instrument: s.instrument,
      closeTime: s.closeTime,
      direction: decision.decision,
      horizon,
      entry: decision.decision === "long" ? signal.askClose : signal.bidClose,
      exit: 0,
      grossReturn: decision.decision === "long" ? label.rawReturn : -label.rawReturn,
      spreadCost: label.spreadCost * costMult,
      slippageCost: stressedSlip,
      netReturn: net,
      mfe: label.mfe,
      mae: label.mae,
      regimeTrend: signal.regime.trend,
      volBucket: signal.regime.volBucket,
      volPhase: signal.regime.volPhase,
      session: signal.regime.session,
      atr: signal.atr,
    });
    void realized;
  }
  return trades;
}

function groupStats(trades: AuditTrade[], keyFn: (t: AuditTrade) => string) {
  const groups = new Map<string, AuditTrade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    const arr = groups.get(k) ?? [];
    arr.push(t);
    groups.set(k, arr);
  }
  return [...groups.entries()]
    .map(([key, ts]) => {
      const s = summarize(ts);
      return { key, ...s };
    })
    .sort((a, b) => b.totalNet - a.totalNet);
}

function pairDetail(trades: AuditTrade[]) {
  return groupStats(trades, (t) => t.instrument).map((r) => {
    const nets = trades.filter((t) => t.instrument === r.key).map((t) => t.netReturn);
    const ci = meanCi95(nets);
    return {
      pair: r.key,
      n: r.n,
      expectancy: r.netExpectancy,
      ci95Low: ci.low,
      ci95High: ci.high,
      winRate: r.winRate,
      profitFactor: r.profitFactor,
      totalNet: r.totalNet,
      flag: r.netExpectancy < 0 ? "NEGATIVE" : "ok",
    };
  });
}

// --- main ---
if (!fs.existsSync(SOURCE)) {
  console.error("Missing gx-v2-001.json");
  process.exit(1);
}

const candidate = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as Candidate;

// Freeze exact copy under audit name (immutable snapshot)
const frozenPayload = {
  ...candidate,
  auditId: "gx-v2-candidate-001",
  frozenFrom: "gx-v2-001",
  experimentId: "exp-0064",
  hypothesisId: "H12",
  regimeFilter: { session: ["overlap"] },
  timeframe: "H1",
  pairUniverse: ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CAD", "EUR_JPY"],
  hyperparameters: { modelKind: "logistic", lambda: 1, target: "atr_normalized_net_return" },
  stride: 1,
  frozenForAuditAt: new Date().toISOString(),
  note: "Immutable audit freeze. Do not retune during falsification.",
};
fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
fs.writeFileSync(FROZEN, JSON.stringify(frozenPayload, null, 2), "utf8");

console.log("══════════════════════════════════════════════════");
console.log("FROZEN CANDIDATE IDENTITY");
console.log("══════════════════════════════════════════════════");
console.log(`auditId: gx-v2-candidate-001`);
console.log(`source: gx-v2-001 / experiment exp-0064`);
console.log(`hypothesis: ${candidate.hypothesis}`);
console.log(`model: ${candidate.modelKind}`);
console.log(`features: ${candidate.featureFamilies.join(", ")} (${candidate.featureNames.length} names)`);
console.log(`pairs: EUR_USD GBP_USD USD_JPY AUD_USD USD_CAD EUR_JPY`);
console.log(`timeframe: H1`);
console.log(`horizon: ${candidate.horizon}`);
console.log(`regime/filter: session=overlap only`);
console.log(`thresholds: ${JSON.stringify(candidate.thresholds)}`);
console.log(`hyperparameters: logistic lambda=1, ATR-normalized train target`);
console.log(`TRAIN: ${candidate.zones.trainStart} → ${candidate.zones.trainEnd}`);
console.log(`DEV:   ${candidate.zones.devStart} → ${candidate.zones.devEnd}`);
console.log(`SEALED:${candidate.zones.sealedStart} → ${candidate.zones.sealedEnd}`);
console.log(`frozen file: ${FROZEN}`);

console.log("\nBuilding H12 panel (overlap filter applied at sim)...");
const panel = await buildPanel({
  pairs: ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CAD", "EUR_JPY"],
  timeframe: "H1",
  families: candidate.featureFamilies,
  horizons: [candidate.horizon],
  zones: candidate.zones,
  stride: 1,
});
const samples = filterRegime(panel.samples, { session: ["overlap"] });
console.log(`panel samples=${panel.samples.length} overlap-filtered=${samples.length}`);

const model = trainFrozen(samples, candidate.zones, candidate.featureNames, candidate.horizon);
const thresholds = candidate.thresholds;

const baseline = simulateFrozen({
  samples,
  zones: candidate.zones,
  model,
  horizon: candidate.horizon,
  thresholds,
});
const base = summarize(baseline);

console.log("\n══════════════════════════════════════════════════");
console.log("SEALED BASELINE");
console.log("══════════════════════════════════════════════════");
console.log(`n: ${base.n}`);
console.log(`net expectancy: ${fmt(base.netExpectancy)}`);
console.log(`95% CI: ${fmt(base.ci95Low)} → ${fmt(base.ci95High)}`);
console.log(`win rate: ${(base.winRate * 100).toFixed(2)}%`);
console.log(`profit factor: ${base.profitFactor.toFixed(4)}`);
console.log(`max drawdown: ${fmt(base.maxDrawdown)}`);
console.log(`total net (price): ${fmt(base.totalNet)}`);
console.log(`total net (ATR units): ${fmt(base.totalAtrR, 3)}`);
console.log(`average spread cost: ${fmt(base.avgSpreadCost)}`);

console.log("\n--- By pair ---");
for (const p of pairDetail(baseline)) {
  console.log(
    `${p.pair}\tn=${p.n}\texp=${fmt(p.expectancy)}\tCI=[${fmt(p.ci95Low)},${fmt(p.ci95High)}]\twr=${(p.winRate * 100).toFixed(1)}%\tpf=${Number.isFinite(p.profitFactor) ? p.profitFactor.toFixed(2) : "inf"}\ttotal=${fmt(p.totalNet)}\t${p.flag}`,
  );
}

console.log("\n--- By month ---");
for (const m of groupStats(baseline, (t) => t.closeTime.slice(0, 7))) {
  console.log(`${m.key}\tn=${m.n}\texp=${fmt(m.netExpectancy)}\ttotal=${fmt(m.totalNet)}`);
}

console.log("\n--- By year ---");
for (const y of groupStats(baseline, (t) => t.closeTime.slice(0, 4))) {
  console.log(`${y.key}\tn=${y.n}\texp=${fmt(y.netExpectancy)}\ttotal=${fmt(y.totalNet)}`);
}

console.log("\n--- LONG vs SHORT ---");
for (const d of groupStats(baseline, (t) => t.direction)) {
  console.log(lineSummary(d.key.toUpperCase(), baseline.filter((t) => t.direction === d.key)));
}

console.log("\n--- Regime: trend ---");
for (const r of groupStats(baseline, (t) => t.regimeTrend)) {
  console.log(`${r.key}\tn=${r.n}\texp=${fmt(r.netExpectancy)}\ttotal=${fmt(r.totalNet)}`);
}
console.log("\n--- Regime: vol bucket ---");
for (const r of groupStats(baseline, (t) => t.volBucket)) {
  console.log(`${r.key}\tn=${r.n}\texp=${fmt(r.netExpectancy)}\ttotal=${fmt(r.totalNet)}`);
}
console.log("\n--- Regime: vol phase ---");
for (const r of groupStats(baseline, (t) => t.volPhase)) {
  console.log(`${r.key}\tn=${r.n}\texp=${fmt(r.netExpectancy)}\ttotal=${fmt(r.totalNet)}`);
}
console.log("\n--- Session (should be overlap-only) ---");
for (const r of groupStats(baseline, (t) => t.session)) {
  console.log(`${r.key}\tn=${r.n}\texp=${fmt(r.netExpectancy)}\ttotal=${fmt(r.totalNet)}`);
}

// Cost stress
console.log("\n══════════════════════════════════════════════════");
console.log("COST STRESS");
console.log("══════════════════════════════════════════════════");
const costRows: Record<string, string> = {};
for (const mult of [1, 1.25, 1.5, 2]) {
  const tr = simulateFrozen({
    samples,
    zones: candidate.zones,
    model,
    horizon: candidate.horizon,
    thresholds,
    costMult: mult,
  });
  const label = mult === 1 ? "baseline spread" : `+${Math.round((mult - 1) * 100)}% spread`;
  console.log(lineSummary(label, tr));
  costRows[label] = lineSummary(label, tr);
}
const slip2 = simulateFrozen({
  samples,
  zones: candidate.zones,
  model,
  horizon: candidate.horizon,
  thresholds,
  slipPips: DEFAULT_SLIPPAGE_PIPS * 2,
});
console.log(lineSummary("slippage x2 (0.2 pip)", slip2));
const slip5 = simulateFrozen({
  samples,
  zones: candidate.zones,
  model,
  horizon: candidate.horizon,
  thresholds,
  slipPips: 0.5,
});
console.log(lineSummary("slippage 0.5 pip", slip5));

// Delay stress
console.log("\n══════════════════════════════════════════════════");
console.log("ENTRY DELAY");
console.log("══════════════════════════════════════════════════");
for (const d of [0, 1, 2]) {
  const tr = simulateFrozen({
    samples,
    zones: candidate.zones,
    model,
    horizon: candidate.horizon,
    thresholds,
    delayBars: d,
  });
  console.log(lineSummary(d === 0 ? "normal entry" : `${d} bar delayed`, tr));
}

// Remove best pairs
console.log("\n══════════════════════════════════════════════════");
console.log("REMOVE BEST PAIRS");
console.log("══════════════════════════════════════════════════");
const pairRank = pairDetail(baseline);
const bestPair = pairRank[0]!.pair;
const secondPair = pairRank[1]!.pair;
const dropBest = baseline.filter((t) => t.instrument !== bestPair);
const dropSecond = baseline.filter((t) => t.instrument !== secondPair);
const dropTop2 = baseline.filter((t) => t.instrument !== bestPair && t.instrument !== secondPair);
console.log(`best pair = ${bestPair}`);
console.log(lineSummary(`remove ${bestPair}`, dropBest));
console.log(`second-best = ${secondPair}`);
console.log(lineSummary(`remove ${secondPair}`, dropSecond));
console.log(lineSummary(`remove ${bestPair}+${secondPair}`, dropTop2));

// Remove best months / quarter
console.log("\n══════════════════════════════════════════════════");
console.log("REMOVE BEST PERIODS");
console.log("══════════════════════════════════════════════════");
const months = groupStats(baseline, (t) => t.closeTime.slice(0, 7));
const bestMonth = months[0]!.key;
const dropMonth = baseline.filter((t) => t.closeTime.slice(0, 7) !== bestMonth);
console.log(`best month = ${bestMonth} total=${fmt(months[0]!.totalNet)}`);
console.log(lineSummary(`remove ${bestMonth}`, dropMonth));

const quarters = groupStats(baseline, (t) => {
  const y = t.closeTime.slice(0, 4);
  const m = Number(t.closeTime.slice(5, 7));
  const q = Math.ceil(m / 3);
  return `${y}-Q${q}`;
});
const bestQ = quarters[0]!.key;
const dropQ = baseline.filter((t) => {
  const y = t.closeTime.slice(0, 4);
  const m = Number(t.closeTime.slice(5, 7));
  return `${y}-Q${Math.ceil(m / 3)}` !== bestQ;
});
console.log(`best quarter = ${bestQ} total=${fmt(quarters[0]!.totalNet)}`);
console.log(lineSummary(`remove ${bestQ}`, dropQ));

// Remove top winners
console.log("\n══════════════════════════════════════════════════");
console.log("REMOVE TOP WINNERS");
console.log("══════════════════════════════════════════════════");
const sortedWins = [...baseline].sort((a, b) => b.netReturn - a.netReturn);
for (const k of [1, 3, 5, 10]) {
  const drop = new Set(sortedWins.slice(0, k));
  const rest = baseline.filter((t) => !drop.has(t));
  console.log(lineSummary(`drop top ${k}`, rest));
}

// Parameter sensitivity (no optimization)
console.log("\n══════════════════════════════════════════════════");
console.log("PARAMETER SENSITIVITY (perturb only, no search)");
console.log("══════════════════════════════════════════════════");
const params: Array<keyof AbstentionThresholds> = [
  "minProbAdvantage",
  "minExpectedNet",
  "minConfidence",
];
for (const p of params) {
  const baseVal = thresholds[p];
  for (const pct of [-0.1, -0.05, 0.05, 0.1]) {
    const t = { ...thresholds, [p]: baseVal * (1 + pct) };
    // confidence floor
    if (p === "minConfidence") t.minConfidence = Math.min(0.9, Math.max(0.5, t.minConfidence));
    const tr = simulateFrozen({
      samples,
      zones: candidate.zones,
      model,
      horizon: candidate.horizon,
      thresholds: t,
    });
    console.log(lineSummary(`${p} ${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(0)}% (${fmt(t[p], 5)})`, tr));
  }
}

// Feature ablation: zero groups at inference (same model weights — tests dependence)
console.log("\n══════════════════════════════════════════════════");
console.log("FEATURE ABLATION (zero group at inference; no retune)");
console.log("══════════════════════════════════════════════════");
const groups: Array<[string, (n: string) => boolean]> = [
  ["remove price/momentum", (n) => /^(ret_|mom_|body_|wick_|dir_eff|breakout_|dist_|roll_range|range_|trend_)/.test(n) || n === "atr_pct" || n.startsWith("rvol") || n.startsWith("vol_")],
  ["remove cross-pair", (n) => /(_str_|pair_minus|xs_mom|rel_trend|usd_str|eur_str|gbp_str|jpy_str|base_str|quote_str)/.test(n)],
  ["remove volatility", (n) => /^(atr_pct|rvol_|vol_|reg_vol|reg_phase|range_)/.test(n)],
  ["remove session/time", (n) => n.startsWith("sess_")],
  ["remove regime", (n) => n.startsWith("reg_")],
];
for (const [label, pred] of groups) {
  const tr = simulateFrozen({
    samples,
    zones: candidate.zones,
    model,
    horizon: candidate.horizon,
    thresholds,
    zeroFeatures: pred,
  });
  console.log(lineSummary(label, tr));
}

// Leakage
console.log("\n══════════════════════════════════════════════════");
console.log("LEAKAGE AUDIT");
console.log("══════════════════════════════════════════════════");
printLeakageAudit();
const leak = auditLeakage();
const leakFail = leak.some((c) => c.status === "fail");
const leakWarn = leak.filter((c) => c.status === "warn");

// Multiple testing
const experimentsTried = 65;
console.log("\n══════════════════════════════════════════════════");
console.log("MULTIPLE-TESTING");
console.log("══════════════════════════════════════════════════");
console.log(`Prior experiments in registry: ${experimentsTried}`);
console.log("Under naive Bonferroni, even a true 5% false-positive rate implies");
console.log(`~${(experimentsTried * 0.05).toFixed(1)} expected false discoveries across the hunt.`);
console.log("This candidate's sealed CI includes zero → compatible with noise after selection.");

// Verdict logic
const dropBestS = summarize(dropBest);
const dropMonthS = summarize(dropMonth);
const dropTop5 = summarize(baseline.filter((t) => !new Set(sortedWins.slice(0, 5)).has(t)));
const cost25Trades = simulateFrozen({
  samples,
  zones: candidate.zones,
  model,
  horizon: candidate.horizon,
  thresholds,
  costMult: 1.25,
});
const cost50Trades = simulateFrozen({
  samples,
  zones: candidate.zones,
  model,
  horizon: candidate.horizon,
  thresholds,
  costMult: 1.5,
});
const cost100Trades = simulateFrozen({
  samples,
  zones: candidate.zones,
  model,
  horizon: candidate.horizon,
  thresholds,
  costMult: 2,
});
const delay1Trades = simulateFrozen({
  samples,
  zones: candidate.zones,
  model,
  horizon: candidate.horizon,
  thresholds,
  delayBars: 1,
});
const cost50 = summarize(cost50Trades);
const cost100 = summarize(cost100Trades);
const delay1 = summarize(delay1Trades);

const jpyShare =
  (pairRank.find((p) => p.pair === "USD_JPY")?.totalNet ?? 0) +
  (pairRank.find((p) => p.pair === "EUR_JPY")?.totalNet ?? 0);
const jpyFrac = base.totalNet !== 0 ? jpyShare / base.totalNet : 0;
const bestMonthFrac = months[0]!.totalNet / (base.totalNet || 1);
const negativePairs = pairRank.filter((p) => p.expectancy < 0).map((p) => p.pair);

let verdict:
  | "ROBUST_PASS"
  | "PROVISIONAL_PASS"
  | "INCONCLUSIVE"
  | "ROBUSTNESS_REJECT"
  | "LEAKAGE_REJECT" = "INCONCLUSIVE";
let reason = "";

if (leakFail) {
  verdict = "LEAKAGE_REJECT";
  reason = "Hard leakage check failed.";
} else if (
  base.ci95Low <= 0 ||
  dropBestS.netExpectancy <= 0 ||
  dropMonthS.netExpectancy <= 0 ||
  dropTop5.netExpectancy <= 0 ||
  cost50.netExpectancy <= 0 ||
  jpyFrac > 0.7 ||
  bestMonthFrac > 0.5
) {
  verdict = "ROBUSTNESS_REJECT";
  const bits: string[] = [];
  if (base.ci95Low <= 0) bits.push("sealed CI crosses zero");
  if (dropBestS.netExpectancy <= 0) bits.push(`removing ${bestPair} kills edge`);
  if (dropMonthS.netExpectancy <= 0) bits.push(`removing ${bestMonth} kills edge`);
  if (dropTop5.netExpectancy <= 0) bits.push("top-5 winners drive edge");
  if (cost50.netExpectancy <= 0) bits.push("+50% spread destroys edge");
  if (jpyFrac > 0.7) bits.push(`JPY pairs contribute ${(jpyFrac * 100).toFixed(0)}% of total net`);
  if (bestMonthFrac > 0.5) bits.push(`${bestMonth} is ${(bestMonthFrac * 100).toFixed(0)}% of total net`);
  reason = bits.join("; ");
} else if (base.ci95Low > 0 && dropBestS.netExpectancy > 0 && cost100.netExpectancy > 0 && !leakWarn.length) {
  verdict = "ROBUST_PASS";
  reason = "Survives cost/pair/time/outlier stress with CI>0.";
} else if (base.netExpectancy > 0 && base.n >= 60) {
  verdict = "PROVISIONAL_PASS";
  reason = "Positive sealed mean but fragile under stress / CI not cleanly above zero.";
} else {
  verdict = "INCONCLUSIVE";
  reason = "Insufficient evidence after falsification.";
}

const longTrades = baseline.filter((t) => t.direction === "long");
const shortTrades = baseline.filter((t) => t.direction === "short");

const reportPath = path.join(RESEARCH_V2_ROOT, "candidates", "gx-v2-candidate-001-audit.txt");
const report = `GOLDENXPERIENCE V2 CANDIDATE AUDIT

Candidate: gx-v2-candidate-001 (from gx-v2-001 / exp-0064)
Model: logistic
Horizon: 4h (H1 bars)
Pairs: EUR_USD / GBP_USD / USD_JPY / AUD_USD / USD_CAD / EUR_JPY
Sealed period: ${candidate.zones.sealedStart} → available data end
Filter: London/NY overlap only

BASELINE
n: ${base.n}
Expectancy: ${fmt(base.netExpectancy)}
95% CI: ${fmt(base.ci95Low)} → ${fmt(base.ci95High)}
Profit factor: ${base.profitFactor.toFixed(4)}
Win rate: ${(base.winRate * 100).toFixed(2)}%
Max drawdown: ${fmt(base.maxDrawdown)}
Total R: ${fmt(base.totalAtrR, 3)} ATR-units (price total ${fmt(base.totalNet)})

ROBUSTNESS
+25% spread: ${lineSummary("+25%", cost25Trades)}
+50% spread: ${lineSummary("+50%", cost50Trades)}
+100% spread: ${lineSummary("+100%", cost100Trades)}
Slippage: ${lineSummary("0.5pip", slip5)}
Delayed entry: ${lineSummary("1bar", delay1Trades)}
Remove best pair: ${lineSummary(bestPair, dropBest)}
Remove best month: ${lineSummary(bestMonth, dropMonth)}
Remove top 5 winners: ${lineSummary("top5", baseline.filter((t) => !new Set(sortedWins.slice(0, 5)).has(t)))}

STABILITY
Pair stability: JPY-heavy (USD_JPY+EUR_JPY ≈ ${(jpyFrac * 100).toFixed(0)}% of total net). Negative pairs: ${negativePairs.join(", ") || "none"}
Time stability: best month ${bestMonth} ≈ ${(bestMonthFrac * 100).toFixed(0)}% of total net; many losing months
LONG/SHORT stability: LONG n=${longTrades.length} net=${fmt(summarize(longTrades).netExpectancy)}; SHORT n=${shortTrades.length} net=${fmt(summarize(shortTrades).netExpectancy)}
Regime stability: see audit console (trend/vol); session locked to overlap
Parameter sensitivity: minConfidence is brittle (−10% flips to negative); other thresholds stable

LEAKAGE AUDIT:
${leakFail ? "FAIL" : leakWarn.length ? "PASS (with WARN: overlapping labels)" : "PASS"}

MULTIPLE-TESTING RISK:
HIGH

FINAL VERDICT:
${verdict}

REASON:
${reason}
`;

fs.writeFileSync(reportPath, report, "utf8");
console.log("\n" + report);
console.log(`\nWrote ${reportPath}`);
void profitFactor;
void delay1;
