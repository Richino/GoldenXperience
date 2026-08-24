import { mean, meanCi95, profitFactor, std } from "../../src/math.js";
import type { MetricRow, Trade } from "./types.js";

/** Greedy non-overlapping subsample per instrument (stride = horizon via exit time). */
export function purgeTrades(trades: Trade[]): Trade[] {
  const byInst = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = byInst.get(t.instrument) ?? [];
    arr.push(t);
    byInst.set(t.instrument, arr);
  }
  const kept: Trade[] = [];
  for (const arr of byInst.values()) {
    arr.sort((a, b) => a.entryTime.localeCompare(b.entryTime));
    let lastExit = 0;
    for (const t of arr) {
      const ent = Date.parse(t.entryTime);
      if (ent < lastExit) continue;
      kept.push(t);
      lastExit = Date.parse(t.exitTime);
    }
  }
  return kept;
}

export function metricsOf(trades: Trade[]): MetricRow {
  const purged = purgeTrades(trades);
  const nets = trades.map((t) => t.netAtr);
  const gross = trades.map((t) => t.grossAtr);
  const sd = std(nets);
  const nEff = Math.max(1, purged.length);
  const m = mean(nets);
  const se = nEff > 1 ? sd / Math.sqrt(nEff) : 0;
  return {
    n: trades.length,
    effectiveN: purged.length,
    gross: mean(gross),
    net: m,
    ci95Low: m - 1.96 * se,
    ci95High: m + 1.96 * se,
    profitFactor: profitFactor(nets),
    avgSpreadAtr: mean(trades.map((t) => t.spreadCostAtr)),
    avgSlipAtr: mean(trades.map((t) => t.slippageCostAtr)),
  };
}

export function metricsPurgedOnly(trades: Trade[]): MetricRow {
  const purged = purgeTrades(trades);
  const ci = meanCi95(purged.map((t) => t.netAtr));
  return {
    n: trades.length,
    effectiveN: purged.length,
    gross: mean(purged.map((t) => t.grossAtr)),
    net: ci.mean,
    ci95Low: ci.low,
    ci95High: ci.high,
    profitFactor: profitFactor(purged.map((t) => t.netAtr)),
    avgSpreadAtr: mean(purged.map((t) => t.spreadCostAtr)),
    avgSlipAtr: mean(purged.map((t) => t.slippageCostAtr)),
  };
}

export function concentration(trades: Trade[]): { ok: boolean; reason: string } {
  if (trades.length === 0) return { ok: false, reason: "empty" };
  const pos = trades.reduce((s, t) => s + Math.max(0, t.netAtr), 0);
  if (pos <= 0) return { ok: true, reason: "no_positive_mass" };
  const top5 = [...trades].sort((a, b) => b.netAtr - a.netAtr).slice(0, 5).reduce((s, t) => s + Math.max(0, t.netAtr), 0);
  if (top5 / pos > 0.65) return { ok: false, reason: "top5_dominate" };

  const byPair = new Map<string, number>();
  for (const t of trades) byPair.set(t.instrument, (byPair.get(t.instrument) ?? 0) + t.netAtr);
  const profits = [...byPair.values()].filter((v) => v > 0);
  const psum = profits.reduce((a, b) => a + b, 0) || 1;
  if (byPair.size > 1 && Math.max(0, ...profits) / psum > 0.85) return { ok: false, reason: "single_pair_dominates" };

  const byMonth = new Map<string, number>();
  for (const t of trades) {
    const m = t.entryTime.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + t.netAtr);
  }
  const mProf = [...byMonth.values()].filter((v) => v > 0);
  const mSum = mProf.reduce((a, b) => a + b, 0) || 1;
  if (byMonth.size > 1 && Math.max(0, ...mProf) / mSum > 0.9) return { ok: false, reason: "single_month_dominates" };
  return { ok: true, reason: "ok" };
}

export function bucketExt(ext: number): string {
  if (ext < 0.25) return "<0.25";
  if (ext < 0.5) return "0.25-0.50";
  if (ext < 0.75) return "0.50-0.75";
  if (ext < 1) return "0.75-1.00";
  if (ext < 1.5) return "1.00-1.50";
  if (ext < 2) return "1.50-2.00";
  return ">2.00";
}

export const EXT_BUCKETS = ["<0.25", "0.25-0.50", "0.50-0.75", "0.75-1.00", "1.00-1.50", "1.50-2.00", ">2.00"] as const;

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k) ?? [];
    arr.push(x);
    m.set(k, arr);
  }
  return m;
}

export function fmt(m: MetricRow): string {
  return `n=${m.n} neff=${m.effectiveN} gross=${m.gross.toFixed(4)} net=${m.net.toFixed(4)} CI=[${m.ci95Low.toFixed(4)},${m.ci95High.toFixed(4)}] PF=${m.profitFactor.toFixed(3)}`;
}
