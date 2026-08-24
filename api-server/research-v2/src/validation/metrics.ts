import { meanCi95, maxDrawdown, mean, profitFactor, sharpeLike } from "../math.js";
import type { MetricBundle, TradeSim } from "../types.js";

export function metricsFromTrades(trades: TradeSim[]): MetricBundle {
  const nets = trades.map((t) => t.netReturn);
  const ci = meanCi95(nets);
  const wins = nets.filter((r) => r > 0).length;
  const byPair: MetricBundle["byPair"] = {};
  const byMonth: MetricBundle["byMonth"] = {};

  for (const t of trades) {
    const p = byPair[t.instrument] ?? { n: 0, netExpectancy: 0 };
    p.n += 1;
    p.netExpectancy += t.netReturn;
    byPair[t.instrument] = p;
    const month = t.closeTime.slice(0, 7);
    const m = byMonth[month] ?? { n: 0, netExpectancy: 0 };
    m.n += 1;
    m.netExpectancy += t.netReturn;
    byMonth[month] = m;
  }
  for (const k of Object.keys(byPair)) {
    const row = byPair[k]!;
    row.netExpectancy = row.n ? row.netExpectancy / row.n : 0;
  }
  for (const k of Object.keys(byMonth)) {
    const row = byMonth[k]!;
    row.netExpectancy = row.n ? row.netExpectancy / row.n : 0;
  }

  return {
    n: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    grossExpectancy: mean(trades.map((t) => t.grossReturn)),
    netExpectancy: ci.mean,
    ci95Low: ci.low,
    ci95High: ci.high,
    profitFactor: profitFactor(nets),
    maxDrawdown: maxDrawdown(nets),
    avgSpreadCost: mean(trades.map((t) => t.spreadCost)),
    byPair,
    byMonth,
  };
}

export function concentrationOk(trades: TradeSim[]): { ok: boolean; reason: string } {
  if (trades.length === 0) return { ok: false, reason: "empty" };
  const total = trades.reduce((s, t) => s + Math.max(0, t.netReturn), 0);
  if (total <= 0) return { ok: true, reason: "no_positive_mass" };
  const sorted = [...trades].sort((a, b) => b.netReturn - a.netReturn);
  const top5 = sorted.slice(0, 5).reduce((s, t) => s + Math.max(0, t.netReturn), 0);
  if (top5 / total > 0.6) return { ok: false, reason: "top5_trades_dominate" };

  const byPair = new Map<string, number>();
  for (const t of trades) byPair.set(t.instrument, (byPair.get(t.instrument) ?? 0) + t.netReturn);
  const pairProfit = [...byPair.values()].filter((v) => v > 0);
  const pairTotal = pairProfit.reduce((a, b) => a + b, 0) || 1;
  const maxPair = Math.max(0, ...pairProfit);
  if (maxPair / pairTotal > 0.85 && byPair.size > 1) return { ok: false, reason: "single_pair_dominates" };
  return { ok: true, reason: "ok" };
}

export { sharpeLike };
