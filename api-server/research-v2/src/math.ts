/** Small numeric helpers for V2 research (no ML framework dependency). */

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function variance(xs: number[], mu = mean(xs)): number {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) {
    const d = x - mu;
    s += d * d;
  }
  return s / (xs.length - 1);
}

export function std(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function sigmoid(z: number): number {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

export function olsSlopeR2(values: number[]): { slope: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const meanX = (n - 1) / 2;
  const meanY = mean(values);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    const dy = values[i]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : clamp((sxy * sxy) / (sxx * syy), 0, 1);
  return { slope, r2 };
}

/** Sample mean ± 1.96 * SE for CI95 on mean. */
export function meanCi95(xs: number[]): { mean: number; low: number; high: number; se: number } {
  const m = mean(xs);
  if (xs.length < 2) return { mean: m, low: m, high: m, se: 0 };
  const se = Math.sqrt(variance(xs, m) / xs.length);
  return { mean: m, low: m - 1.96 * se, high: m + 1.96 * se, se };
}

export function maxDrawdown(returns: number[]): number {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const r of returns) {
    equity += r;
    peak = Math.max(peak, equity);
    dd = Math.min(dd, equity - peak);
  }
  return dd;
}

export function profitFactor(returns: number[]): number {
  let gains = 0;
  let losses = 0;
  for (const r of returns) {
    if (r > 0) gains += r;
    else if (r < 0) losses += -r;
  }
  if (losses <= 1e-12) return gains > 0 ? Number.POSITIVE_INFINITY : 0;
  return gains / losses;
}

export function sharpeLike(returns: number[]): number {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const s = std(returns);
  if (s <= 1e-12) return 0;
  return (m / s) * Math.sqrt(Math.min(returns.length, 252));
}

/** Solve (X'X + λI) β = X'y for ridge; X is n×p without intercept column. */
export function ridgeFit(X: number[][], y: number[], lambda: number): { intercept: number; coef: number[] } {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) return { intercept: 0, coef: [] };

  const yMean = mean(y);
  const xMeans = Array.from({ length: p }, (_, j) => mean(X.map((row) => row[j]!)));

  // Centered design
  const xtx: number[][] = Array.from({ length: p }, () => Array.from({ length: p }, () => 0));
  const xty: number[] = Array.from({ length: p }, () => 0);
  for (let i = 0; i < n; i += 1) {
    const row = X[i]!;
    const yc = y[i]! - yMean;
    for (let j = 0; j < p; j += 1) {
      const xj = row[j]! - xMeans[j]!;
      xty[j]! += xj * yc;
      for (let k = j; k < p; k += 1) {
        const xk = row[k]! - xMeans[k]!;
        xtx[j]![k]! += xj * xk;
      }
    }
  }
  for (let j = 0; j < p; j += 1) {
    for (let k = 0; k < j; k += 1) xtx[j]![k] = xtx[k]![j]!;
    xtx[j]![j]! += lambda;
  }

  const coef = solveSymmetric(xtx, xty);
  let intercept = yMean;
  for (let j = 0; j < p; j += 1) intercept -= coef[j]! * xMeans[j]!;
  return { intercept, coef };
}

/** Logistic ridge via IRLS (few iterations). y in {0,1}. */
export function logisticRidgeFit(X: number[][], y: number[], lambda: number, maxIter = 25): { intercept: number; coef: number[] } {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) return { intercept: 0, coef: [] };

  let intercept = 0;
  let coef = Array.from({ length: p }, () => 0);

  for (let iter = 0; iter < maxIter; iter += 1) {
    const z: number[] = [];
    const w: number[] = [];
    for (let i = 0; i < n; i += 1) {
      let eta = intercept;
      const row = X[i]!;
      for (let j = 0; j < p; j += 1) eta += coef[j]! * row[j]!;
      const mu = sigmoid(eta);
      const wp = Math.max(mu * (1 - mu), 1e-6);
      w.push(wp);
      z.push(eta + (y[i]! - mu) / wp);
    }
    // Weighted ridge on [1|X]
    const dim = p + 1;
    const ata: number[][] = Array.from({ length: dim }, () => Array.from({ length: dim }, () => 0));
    const atb: number[] = Array.from({ length: dim }, () => 0);
    for (let i = 0; i < n; i += 1) {
      const wi = w[i]!;
      const zi = z[i]!;
      const row = [1, ...X[i]!];
      for (let a = 0; a < dim; a += 1) {
        atb[a]! += wi * row[a]! * zi;
        for (let b = a; b < dim; b += 1) ata[a]![b]! += wi * row[a]! * row[b]!;
      }
    }
    for (let a = 0; a < dim; a += 1) {
      for (let b = 0; b < a; b += 1) ata[a]![b] = ata[b]![a]!;
      if (a > 0) ata[a]![a]! += lambda;
    }
    const sol = solveSymmetric(ata, atb);
    intercept = sol[0]!;
    coef = sol.slice(1);
  }
  return { intercept, coef };
}

function solveSymmetric(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    const diag = M[col]![col]!;
    if (Math.abs(diag) < 1e-12) continue;
    for (let c = col; c <= n; c += 1) M[col]![c]! /= diag;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r]![col]!;
      for (let c = col; c <= n; c += 1) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row) => row[n]!);
}
