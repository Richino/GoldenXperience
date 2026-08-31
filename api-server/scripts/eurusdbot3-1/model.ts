/**
 * eurusdbot3-1 — logistic regression (standardized features, L2, full-batch GD).
 *
 * No external ML dependency (the repo ships none). Same standardize→sigmoid
 * inference shape as the existing binary-logistic-v1 artifact, so it is familiar
 * and auditable. Training uses class-balanced weighting because the positive
 * (3R-before-1R) rate is intrinsically low.
 */
export type LogitModel = {
  featureNames: string[];
  mean: Record<string, number>;
  std: Record<string, number>;
  coef: Record<string, number>;
  intercept: number;
};

export type Sample = { x: Record<string, number>; y: number; w?: number };

function sigmoid(z: number): number {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

export function trainLogit(
  samples: Sample[],
  featureNames: string[],
  opts: { l2?: number; lr?: number; epochs?: number; balance?: boolean } = {},
): LogitModel {
  const l2 = opts.l2 ?? 1.0;
  const lr = opts.lr ?? 0.1;
  const epochs = opts.epochs ?? 300;
  const balance = opts.balance ?? true;

  // standardization
  const mean: Record<string, number> = {};
  const std: Record<string, number> = {};
  for (const f of featureNames) {
    let s = 0; for (const smp of samples) s += smp.x[f] ?? 0;
    const m = s / Math.max(1, samples.length);
    let v = 0; for (const smp of samples) v += ((smp.x[f] ?? 0) - m) ** 2;
    mean[f] = m;
    std[f] = Math.sqrt(v / Math.max(1, samples.length)) || 1;
  }

  // class weights
  const nPos = samples.reduce((a, s) => a + s.y, 0);
  const nNeg = samples.length - nPos;
  const wPos = balance && nPos > 0 ? samples.length / (2 * nPos) : 1;
  const wNeg = balance && nNeg > 0 ? samples.length / (2 * nNeg) : 1;

  // pre-scale feature matrix
  const X: number[][] = samples.map((smp) => featureNames.map((f) => ((smp.x[f] ?? 0) - mean[f]!) / std[f]!));
  const Y = samples.map((s) => s.y);
  const W = samples.map((s) => (s.w ?? 1) * (s.y ? wPos : wNeg));

  const d = featureNames.length;
  const coef = new Array<number>(d).fill(0);
  let intercept = 0;
  const nInv = 1 / Math.max(1, samples.length);

  for (let ep = 0; ep < epochs; ep++) {
    const grad = new Array<number>(d).fill(0);
    let gb = 0;
    for (let n = 0; n < X.length; n++) {
      const row = X[n]!;
      let z = intercept;
      for (let j = 0; j < d; j++) z += coef[j]! * row[j]!;
      const p = sigmoid(z);
      const err = (p - Y[n]!) * W[n]!;
      gb += err;
      for (let j = 0; j < d; j++) grad[j]! += err * row[j]!;
    }
    intercept -= lr * gb * nInv;
    for (let j = 0; j < d; j++) coef[j]! -= lr * (grad[j]! * nInv + l2 * coef[j]! * nInv);
  }

  const coefMap: Record<string, number> = {};
  featureNames.forEach((f, j) => (coefMap[f] = coef[j]!));
  return { featureNames, mean, std, coef: coefMap, intercept };
}

export function predictProb(model: LogitModel, raw: Record<string, number>): number {
  let z = model.intercept;
  for (const f of model.featureNames) {
    const v = ((raw[f] ?? 0) - (model.mean[f] ?? 0)) / (model.std[f] || 1);
    z += (model.coef[f] ?? 0) * v;
  }
  return sigmoid(z);
}
