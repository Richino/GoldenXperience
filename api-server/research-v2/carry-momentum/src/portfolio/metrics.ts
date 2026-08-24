import { mean, std, maxDrawdown, profitFactor } from "../../../src/math.js";

export type PeriodReturn = { date: string; ret: number; gross: number; cost: number; financing: number };

export type PortfolioStats = {
  nPeriods: number;
  totalReturn: number;
  annReturn: number;
  annVol: number;
  sharpe: number;
  sortino: number;
  maxDd: number;
  calmar: number;
  profitFactor: number;
  avgPeriodReturn: number;
  bootstrapCiLow: number;
  bootstrapCiHigh: number;
  effectiveN: number;
};

function annFactor(periodsPerYear: number): number {
  return periodsPerYear;
}

export function statsFromReturns(returns: PeriodReturn[], periodsPerYear: number): PortfolioStats {
  const rets = returns.map((r) => r.ret);
  if (rets.length === 0) {
    return {
      nPeriods: 0,
      totalReturn: 0,
      annReturn: 0,
      annVol: 0,
      sharpe: 0,
      sortino: 0,
      maxDd: 0,
      calmar: 0,
      profitFactor: 0,
      avgPeriodReturn: 0,
      bootstrapCiLow: 0,
      bootstrapCiHigh: 0,
      effectiveN: 0,
    };
  }

  const totalReturn = rets.reduce((s, r) => s + r, 0);
  const avg = mean(rets);
  const vol = std(rets);
  const annReturn = avg * periodsPerYear;
  const annVol = vol * Math.sqrt(periodsPerYear);
  const sharpe = annVol > 1e-12 ? annReturn / annVol : 0;

  const downside = rets.filter((r) => r < 0);
  const downVol = downside.length > 1 ? std(downside) * Math.sqrt(periodsPerYear) : annVol;
  const sortino = downVol > 1e-12 ? annReturn / downVol : 0;

  const maxDd = maxDrawdown(rets);
  const calmar = Math.abs(maxDd) > 1e-12 ? annReturn / Math.abs(maxDd) : 0;

  const boot = blockBootstrapMean(rets, Math.max(2, Math.floor(Math.sqrt(rets.length))), 2000);

  return {
    nPeriods: rets.length,
    totalReturn,
    annReturn,
    annVol,
    sharpe,
    sortino,
    maxDd,
    calmar,
    profitFactor: profitFactor(rets),
    avgPeriodReturn: avg,
    bootstrapCiLow: boot.low,
    bootstrapCiHigh: boot.high,
    effectiveN: boot.effectiveN,
  };
}

/** Block bootstrap CI for mean period return (accounts for serial correlation). */
export function blockBootstrapMean(
  rets: number[],
  blockSize: number,
  nBoot = 2000,
): { low: number; high: number; effectiveN: number } {
  if (rets.length < 4) {
    const m = mean(rets);
    return { low: m, high: m, effectiveN: rets.length };
  }
  const bs = Math.min(blockSize, Math.max(2, Math.floor(rets.length / 4)));
  const means: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    const sample: number[] = [];
    while (sample.length < rets.length) {
      const start = Math.floor(Math.random() * Math.max(1, rets.length - bs + 1));
      for (let k = 0; k < bs && sample.length < rets.length; k++) {
        sample.push(rets[(start + k) % rets.length]!);
      }
    }
    means.push(mean(sample.slice(0, rets.length)));
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * means.length)] ?? 0;
  const hi = means[Math.floor(0.975 * means.length)] ?? 0;
  return { low: lo, high: hi, effectiveN: Math.ceil(rets.length / bs) };
}

export function rollingSum(rets: number[], window: number): number[] {
  const out: number[] = [];
  for (let i = window; i <= rets.length; i++) {
    out.push(rets.slice(i - window, i).reduce((a, b) => a + b, 0));
  }
  return out;
}
