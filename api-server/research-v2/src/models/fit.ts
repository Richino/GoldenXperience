import { logisticRidgeFit, mean, ridgeFit, sigmoid, std } from "../math.js";
import type { ModelKind } from "../types.js";

export type FittedModel = {
  kind: ModelKind;
  featureNames: string[];
  means: number[];
  stds: number[];
  intercept: number;
  coef: number[];
  /** For boost: stump list */
  stumps?: Array<{ featureIndex: number; threshold: number; leftValue: number; rightValue: number; weight: number }>;
  trainTargetMean: number;
  trainTargetStd: number;
};

export type ModelPrediction = {
  expectedReturn: number;
  probabilityUp: number;
};

function standardize(row: number[], means: number[], stds: number[]): number[] {
  return row.map((v, j) => {
    const s = stds[j]!;
    return s > 1e-12 ? (v - means[j]!) / s : 0;
  });
}

export function vectorize(features: Record<string, number>, names: string[]): number[] {
  return names.map((n) => {
    const v = features[n];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  });
}

export function fitModel(
  kind: ModelKind,
  featureNames: string[],
  rows: Record<string, number>[],
  targets: number[],
  hyper: { lambda?: number; trees?: number; depthBins?: number } = {},
): FittedModel {
  const lambda = hyper.lambda ?? 1;
  const Xraw = rows.map((r) => vectorize(r, featureNames));
  const means = featureNames.map((_, j) => mean(Xraw.map((r) => r[j]!)));
  const stds = featureNames.map((_, j) => std(Xraw.map((r) => r[j]!)) || 1);
  const X = Xraw.map((r) => standardize(r, means, stds));
  const trainTargetMean = mean(targets);
  const trainTargetStd = std(targets) || 1;

  if (kind === "ridge" || kind === "boost_reg") {
    if (kind === "ridge") {
      const fit = ridgeFit(X, targets, lambda);
      return {
        kind,
        featureNames,
        means,
        stds,
        intercept: fit.intercept,
        coef: fit.coef,
        trainTargetMean,
        trainTargetStd,
      };
    }
    return fitBoostReg(featureNames, X, targets, means, stds, hyper.trees ?? 40);
  }

  // classification on sign of target
  const y = targets.map((t) => (t > 0 ? 1 : 0));
  if (kind === "logistic") {
    const fit = logisticRidgeFit(X, y, lambda);
    return {
      kind,
      featureNames,
      means,
      stds,
      intercept: fit.intercept,
      coef: fit.coef,
      trainTargetMean,
      trainTargetStd,
    };
  }

  // boost_clf: boost on ±1 labels then map
  const signed = targets.map((t) => (t > 0 ? 1 : -1));
  const boost = fitBoostReg(featureNames, X, signed, means, stds, hyper.trees ?? 40);
  return { ...boost, kind: "boost_clf" };
}

function fitBoostReg(
  featureNames: string[],
  X: number[][],
  y: number[],
  means: number[],
  stds: number[],
  trees: number,
): FittedModel {
  const n = X.length;
  const p = featureNames.length;
  const pred = Array.from({ length: n }, () => mean(y));
  const stumps: NonNullable<FittedModel["stumps"]> = [];
  const learningRate = 0.1;

  for (let t = 0; t < trees; t += 1) {
    const resid = y.map((yi, i) => yi - pred[i]!);
    let best: NonNullable<FittedModel["stumps"]>[number] | null = null;
    let bestLoss = Number.POSITIVE_INFINITY;

    // Subsample features for speed
    const featOrder = Array.from({ length: p }, (_, j) => j);
    for (let s = featOrder.length - 1; s > 0; s -= 1) {
      const j = Math.floor(Math.random() * (s + 1));
      [featOrder[s], featOrder[j]] = [featOrder[j]!, featOrder[s]!];
    }
    const consider = featOrder.slice(0, Math.min(12, p));

    for (const j of consider) {
      const vals = X.map((r) => r[j]!);
      const sorted = [...vals].sort((a, b) => a - b);
      const qs = [0.25, 0.5, 0.75].map((q) => sorted[Math.floor(q * (sorted.length - 1))]!);
      for (const thr of qs) {
        let leftSum = 0;
        let leftN = 0;
        let rightSum = 0;
        let rightN = 0;
        for (let i = 0; i < n; i += 1) {
          if (X[i]![j]! <= thr) {
            leftSum += resid[i]!;
            leftN += 1;
          } else {
            rightSum += resid[i]!;
            rightN += 1;
          }
        }
        if (leftN < 5 || rightN < 5) continue;
        const leftValue = leftSum / leftN;
        const rightValue = rightSum / rightN;
        let loss = 0;
        for (let i = 0; i < n; i += 1) {
          const pv = X[i]![j]! <= thr ? leftValue : rightValue;
          const e = resid[i]! - pv;
          loss += e * e;
        }
        if (loss < bestLoss) {
          bestLoss = loss;
          best = { featureIndex: j, threshold: thr, leftValue, rightValue, weight: learningRate };
        }
      }
    }
    if (!best) break;
    stumps.push(best);
    for (let i = 0; i < n; i += 1) {
      const pv = X[i]![best.featureIndex]! <= best.threshold ? best.leftValue : best.rightValue;
      pred[i]! += learningRate * pv;
    }
  }

  return {
    kind: "boost_reg",
    featureNames,
    means,
    stds,
    intercept: mean(y),
    coef: [],
    stumps,
    trainTargetMean: mean(y),
    trainTargetStd: std(y) || 1,
  };
}

export function predict(model: FittedModel, features: Record<string, number>): ModelPrediction {
  const raw = vectorize(features, model.featureNames);
  const x = standardize(raw, model.means, model.stds);

  if (model.kind === "logistic" || model.kind === "boost_clf") {
    let score = model.intercept;
    if (model.stumps?.length) {
      for (const s of model.stumps) {
        const v = x[s.featureIndex]! <= s.threshold ? s.leftValue : s.rightValue;
        score += s.weight * v;
      }
      const probabilityUp = sigmoid(score);
      const expectedReturn = (probabilityUp - 0.5) * 2 * model.trainTargetStd;
      return { expectedReturn, probabilityUp };
    }
    for (let j = 0; j < model.coef.length; j += 1) score += model.coef[j]! * x[j]!;
    const probabilityUp = sigmoid(score);
    const expectedReturn = (probabilityUp - 0.5) * 2 * model.trainTargetStd;
    return { expectedReturn, probabilityUp };
  }

  let expectedReturn = model.intercept;
  if (model.stumps?.length) {
    expectedReturn = model.intercept;
    for (const s of model.stumps) {
      const v = x[s.featureIndex]! <= s.threshold ? s.leftValue : s.rightValue;
      expectedReturn += s.weight * v;
    }
  } else {
    for (let j = 0; j < model.coef.length; j += 1) expectedReturn += model.coef[j]! * x[j]!;
  }
  // Map expected return to a pseudo-probability via train scale
  const z = model.trainTargetStd > 0 ? expectedReturn / model.trainTargetStd : 0;
  const probabilityUp = sigmoid(z);
  return { expectedReturn, probabilityUp };
}

export function featureImportance(model: FittedModel): Array<{ name: string; weight: number }> {
  if (model.stumps?.length) {
    const weights = new Map<string, number>();
    for (const s of model.stumps) {
      const name = model.featureNames[s.featureIndex]!;
      weights.set(name, (weights.get(name) ?? 0) + Math.abs(s.weight * (s.leftValue - s.rightValue)));
    }
    return [...weights.entries()].map(([name, weight]) => ({ name, weight })).sort((a, b) => b.weight - a.weight);
  }
  return model.featureNames
    .map((name, j) => ({ name, weight: Math.abs(model.coef[j] ?? 0) }))
    .sort((a, b) => b.weight - a.weight);
}
