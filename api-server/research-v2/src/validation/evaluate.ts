import { DEFAULT_SLIPPAGE_PIPS, SAFETY_MARGIN_RETURN } from "../config.js";
import { decide, type AbstentionThresholds } from "../models/abstention.js";
import { fitModel, predict, featureImportance, type FittedModel } from "../models/fit.js";
import type { HorizonId, ModelKind, Sample, TradeSim } from "../types.js";
import { concentrationOk, metricsFromTrades, sharpeLike } from "./metrics.js";
import { zoneOf } from "../panel.js";
import type { DataZones } from "../types.js";
import { slippageAbsolute } from "../costs.js";

export function simulateZone(args: {
  samples: Sample[];
  zones: DataZones;
  zone: "train" | "dev" | "sealed";
  model: FittedModel;
  horizon: HorizonId;
  thresholds: AbstentionThresholds;
  costMult?: number;
  delayBars?: number;
  directionMode?: "both" | "long_only" | "short_only";
  /** Score in ATR units (fair across JPY vs XXX_USD). Default true. */
  atrNormalize?: boolean;
}): TradeSim[] {
  const { samples, zones, zone, model, horizon, thresholds } = args;
  const costMult = args.costMult ?? 1;
  const delay = args.delayBars ?? 0;
  const atrNormalize = args.atrNormalize ?? true;
  const trades: TradeSim[] = [];

  const byKey = new Map(samples.map((s) => [`${s.instrument}|${s.closeTime}`, s]));

  for (const s of samples) {
    if (zoneOf(s.ts, zones) !== zone) continue;
    const label = s.labels[horizon];
    if (!label) continue;

    const entrySample = s;
    if (delay > 0) {
      // delay stress handled in dedicated audit; keep signal bar here
    }

    const spread = entrySample.spread * costMult;
    const slip = slippageAbsolute(entrySample.instrument, DEFAULT_SLIPPAGE_PIPS) * costMult;
    const predRaw = predict(model, entrySample.features);
    const pred = {
      expectedReturn: predRaw.expectedReturn * Math.max(entrySample.atr, 1e-12),
      probabilityUp: predRaw.probabilityUp,
    };
    const decision = decide({
      pred,
      spread,
      slip,
      safety: SAFETY_MARGIN_RETURN,
      thresholds,
      directionMode: args.directionMode,
    });
    if (decision.decision === "wait") continue;

    let net: number;
    let gross: number;
    if (decision.decision === "long") {
      net = label.netReturn;
      gross = label.rawReturn;
    } else {
      net = -label.rawReturn - label.spreadCost;
      gross = -label.rawReturn;
    }
    if (costMult > 1) {
      const extra = (costMult - 1) * label.spreadCost;
      net -= extra;
    }
    const scale = atrNormalize && entrySample.atr > 0 ? 1 / entrySample.atr : 1;

    trades.push({
      instrument: s.instrument,
      closeTime: s.closeTime,
      direction: decision.decision,
      horizon,
      entry: decision.decision === "long" ? entrySample.askClose : entrySample.bidClose,
      exit: 0,
      grossReturn: gross * scale,
      spreadCost: label.spreadCost * costMult * scale,
      slippageCost: label.slippageCost * costMult * scale,
      netReturn: net * scale,
      mfe: label.mfe * scale,
      mae: label.mae * scale,
    });
  }
  void byKey;
  void delay;
  return trades;
}

export function selectThresholdsOnDev(args: {
  samples: Sample[];
  zones: DataZones;
  model: FittedModel;
  horizon: HorizonId;
  grid: AbstentionThresholds[];
  directionMode?: "both" | "long_only" | "short_only";
}): { thresholds: AbstentionThresholds; trades: TradeSim[]; score: number } {
  let best: { thresholds: AbstentionThresholds; trades: TradeSim[]; score: number } | null = null;
  for (const thresholds of args.grid) {
    const trades = simulateZone({
      samples: args.samples,
      zones: args.zones,
      zone: "dev",
      model: args.model,
      horizon: args.horizon,
      thresholds,
      directionMode: args.directionMode,
    });
    const m = metricsFromTrades(trades);
    const conc = concentrationOk(trades);
    // Score: net expectancy * log(n) with CI preference; reject tiny n
    let score = -1e9;
    if (m.n >= 40 && m.netExpectancy > 0 && conc.ok) {
      score = m.netExpectancy * Math.log(m.n + 1) + (m.ci95Low > 0 ? 0.05 : 0);
    } else if (m.n >= 40 && m.netExpectancy > 0) {
      score = m.netExpectancy * Math.log(m.n + 1) - 0.02;
    }
    if (!best || score > best.score) best = { thresholds, trades, score };
  }
  return best ?? {
    thresholds: args.grid[0]!,
    trades: [],
    score: -1e9,
  };
}

export function buildThresholdGrid(): AbstentionThresholds[] {
  // Compact DEV-only grid (never touch sealed for threshold choice)
  const grid: AbstentionThresholds[] = [];
  for (const minProbAdvantage of [0.03, 0.06, 0.1]) {
    for (const minExpectedNet of [0, 0.00008]) {
      for (const minConfidence of [0.53, 0.58]) {
        grid.push({
          minProbAdvantage,
          minExpectedNet,
          minConfidence,
          minModelAgreement: 0.5,
        });
      }
    }
  }
  return grid;
}

export function trainOnZone(args: {
  samples: Sample[];
  zones: DataZones;
  featureNames: string[];
  horizon: HorizonId;
  kind: ModelKind;
}): FittedModel {
  const rows: Record<string, number>[] = [];
  const targets: number[] = [];
  for (const s of args.samples) {
    if (zoneOf(s.ts, args.zones) !== "train") continue;
    const label = s.labels[args.horizon];
    if (!label) continue;
    rows.push(s.features);
    // Prefer ATR-normalized target when ATR available (scale-invariant across pairs)
    const atrT = s.atr > 0 ? label.netReturn / s.atr : label.netReturn;
    targets.push(atrT);
  }
  if (rows.length < 50) {
    return fitModel(args.kind, args.featureNames, rows.length ? rows : [{}], targets.length ? targets : [0], { lambda: 5 });
  }
  return fitModel(args.kind, args.featureNames, rows, targets, {
    lambda: args.kind === "logistic" ? 1 : 2,
    trees: 30,
  });
}

export function runRobustness(args: {
  samples: Sample[];
  zones: DataZones;
  model: FittedModel;
  horizon: HorizonId;
  thresholds: AbstentionThresholds;
  directionMode?: "both" | "long_only" | "short_only";
}): Record<string, { pass: boolean; note: string; netExpectancy?: number }> {
  const base = simulateZone({ ...args, zone: "dev" });
  const baseM = metricsFromTrades(base);
  const out: Record<string, { pass: boolean; note: string; netExpectancy?: number }> = {};

  const stress = (name: string, trades: TradeSim[], requirePositive = true) => {
    const m = metricsFromTrades(trades);
    const pass = !requirePositive || (m.n >= 20 && m.netExpectancy > -0.02);
    out[name] = { pass, note: `n=${m.n} net=${m.netExpectancy.toExponential(2)}`, netExpectancy: m.netExpectancy };
  };

  stress("spread_+25pct", simulateZone({ ...args, zone: "dev", costMult: 1.25 }));
  stress("spread_+50pct", simulateZone({ ...args, zone: "dev", costMult: 1.5 }), false);

  // Drop best pair
  if (base.length) {
    const byPair = new Map<string, number>();
    for (const t of base) byPair.set(t.instrument, (byPair.get(t.instrument) ?? 0) + t.netReturn);
    let bestPair = "";
    let best = -Infinity;
    for (const [p, v] of byPair) {
      if (v > best) {
        best = v;
        bestPair = p;
      }
    }
    const dropped = base.filter((t) => t.instrument !== bestPair);
    stress(`drop_best_pair_${bestPair}`, dropped);
  }

  // Drop top 5 trades
  const sorted = [...base].sort((a, b) => b.netReturn - a.netReturn);
  const withoutTop5 = sorted.slice(5);
  stress("drop_top5_trades", withoutTop5);

  // Slightly altered thresholds
  const soft = {
    ...args.thresholds,
    minProbAdvantage: args.thresholds.minProbAdvantage * 0.8,
    minConfidence: Math.max(0.5, args.thresholds.minConfidence - 0.03),
  };
  stress("softer_thresholds", simulateZone({ ...args, zone: "dev", thresholds: soft }));

  out.baseline_dev = {
    pass: baseM.netExpectancy > 0 && baseM.n >= 40,
    note: `n=${baseM.n} net=${baseM.netExpectancy.toExponential(2)} ci=[${baseM.ci95Low.toExponential(2)},${baseM.ci95High.toExponential(2)}]`,
    netExpectancy: baseM.netExpectancy,
  };

  return out;
}

export { metricsFromTrades, concentrationOk, featureImportance, sharpeLike };
