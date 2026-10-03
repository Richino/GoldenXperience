// PHASE 1 — TREND_PULLBACK_BASELINE: the existing TrendPullbackV1 (normal mode,
// unchanged code) on EUR/USD 2008-01-01 → 2023-12-31.
//
// Every hour on the hour, when there is no open position and no working order,
// the rule is run as Analyze runs it: M15 x500 (base), H1 x250 and H4 x250 for
// the higher-timeframe check, current price = last M15 close, only candles
// closed by then. Its plan is traded as the app trades it:
//   - ENTRY_AVAILABLE_NOW → market order on the next M5 bar;
//   - otherwise a limit at the entry that expires 4h after it starts watching
//     and is pulled if price reaches the target first;
//   - the recommended stop (the structure stop when available), target 2R
//     (1R counter-trend) from that stop; no time exit except a 30-day cap.
// NEWS=1 also applies the V1 news hold (calendar exists only from 2013).
import fs from "node:fs";
import { analyzeTrendPullbackV1, type NewsEvent } from "../../src/lib/strategy/trend-pullback-v1";
import type { Candle } from "../../src/types/forex";
import { byYear, countLE, loadM5, loadMid, PIP, runPosition, SLIP, summarize, type Bars, type Trade } from "./lib.mts";

const DIR = process.env.DATA_DIR!;
const OUT = process.env.OUT_DIR!;
const START = Date.parse(process.env.START ?? "2008-01-01T00:00:00Z");
const END = Date.parse(process.env.END ?? "2024-01-01T00:00:00Z");
const NEWS = process.env.NEWS === "1";
const STEP = 3_600_000;
const LIFE = 4 * 3_600_000;
const MAX_HOLD = 30 * 86_400_000;

const toCandles = (b: Bars, from: number, to: number): Candle[] => {
  const out: Candle[] = [];
  for (let i = from; i < to; i += 1) out.push({ time: new Date(b.t[i]!).toISOString(), open: b.o[i]!, high: b.h[i]!, low: b.l[i]!, close: b.c[i]!, volume: 0, complete: true });
  return out;
};
const m15 = loadMid(DIR, "M15"), h1 = loadMid(DIR, "H1"), h4 = loadMid(DIR, "H4");
const m5 = loadM5(DIR);
const a = m5.a;
const news: NewsEvent[] = NEWS
  ? (JSON.parse(fs.readFileSync(`${DIR}/calendar_high.json`, "utf8")) as Array<{ t: string; cur: string; title: string }>)
    .filter((e) => e.cur === "EUR" || e.cur === "USD").map((e) => ({ title: e.title, currency: e.cur, impact: 3, timestamp: e.t }))
  : [];
const newsTimes = news.map((e) => Date.parse(e.timestamp));

const trades: Trade[] = [];
const stats = { decisions: 0, plans: 0, market: 0, limitPlaced: 0, noFill: 0, cancelledAtTarget: 0 };
const t0 = Date.now();
let t = START;
while (t < END) {
  const n15 = countLE(m15.end, t), nH1 = countLE(h1.end, t), nH4 = countLE(h4.end, t);
  // Skip closed market: no M15 candle ended in the last 30 minutes.
  if (!n15 || t - m15.end[n15 - 1]! > 1_800_000) { t += STEP; continue; }
  stats.decisions += 1;
  const candles = toCandles(m15, Math.max(0, n15 - 500), n15);
  let events: NewsEvent[] | undefined;
  if (NEWS) {
    const lo = countLE(newsTimes, t - 3_600_000), hi = countLE(newsTimes, t + 5 * 3_600_000);
    events = news.slice(lo, hi);
  }
  const plan = analyzeTrendPullbackV1({
    instrument: "EUR_USD", candles, currentPrice: candles.at(-1)!.close,
    h1Candles: toCandles(h1, Math.max(0, nH1 - 250), nH1), h4Candles: toCandles(h4, Math.max(0, nH4 - 250), nH4),
    newsEvents: events, now: t,
  });
  if (!plan.action || plan.entry === null || plan.stopLoss === null || plan.takeProfit === null) { t += STEP; continue; }
  stats.plans += 1;
  const long = plan.action === "LONG";
  const structure = plan.structureStop?.available ? plan.structureStop : null;
  const stop = structure ? structure.stop : plan.stopLoss;
  const target = structure ? structure.takeProfit : plan.takeProfit;
  const market = plan.status === "ENTRY_AVAILABLE_NOW" && !plan.activateAfter;
  const watchFrom = plan.activateAfter ? Date.parse(plan.activateAfter) : t;
  const expires = watchFrom + LIFE;

  let i = countLE(a, Math.max(t, watchFrom) - 1, 9);
  let fill: number | null = null, intrabar = false;
  for (; i < m5.n; i += 1) {
    const b = i * 9, bt = a[b]!;
    if (bt >= END) break;
    if (market) { fill = long ? a[b + 5]! + SLIP : a[b + 1]! - SLIP; intrabar = false; break; }
    if (bt >= expires) break;
    if (long ? a[b + 2]! >= target : a[b + 7]! <= target) { stats.cancelledAtTarget += 1; break; }
    if (long ? a[b + 7]! <= plan.entry : a[b + 2]! >= plan.entry) {
      fill = long ? Math.min(a[b + 5]!, plan.entry) : Math.max(a[b + 1]!, plan.entry);
      intrabar = true; break;
    }
  }
  if (market) stats.market += 1; else stats.limitPlaced += 1;
  if (fill === null) {
    stats.noFill += 1;
    const until = Math.min(i < m5.n ? a[i * 9]! : END, expires);
    t = Math.max(t + STEP, Math.ceil(until / STEP) * STEP);
    continue;
  }
  const riskDist = Math.abs(fill - stop);
  if (!(riskDist > 0) || (long ? stop >= fill : stop <= fill)) { t += STEP; continue; }
  const ex = runPosition(m5, i, long, fill, stop, target, riskDist, intrabar, MAX_HOLD, END);
  const ft = a[i * 9]!;
  trades.push({
    t: ft, year: new Date(ft).getUTCFullYear(), long, r: ex.r, out: ex.out, holdH: (ex.endT - ft) / 3_600_000,
    riskPips: riskDist / PIP, spreadPips: (a[i * 9 + 8]! - a[i * 9 + 4]!) / PIP,
    market, counter: plan.counterTrend, structure: !!structure, kind: plan.debug.pullbackLevelKind,
  });
  t = Math.max(t + STEP, Math.ceil(ex.endT / STEP) * STEP);
}

const s = summarize(trades, (END - START) / (365.25 * 86_400_000));
const outs: Record<string, number> = {};
for (const x of trades) outs[x.out] = (outs[x.out] ?? 0) + 1;
const med = (f: (x: Trade) => number) => { const v = trades.map(f).sort((p, q) => p - q); return +v[v.length >> 1]!.toFixed(1); };
const report = {
  name: NEWS ? "TREND_PULLBACK_BASELINE_NEWS_HOLD" : "TREND_PULLBACK_BASELINE",
  period: [new Date(START).toISOString(), new Date(END).toISOString()], stats, summary: s, exits: outs,
  medianRiskPips: med((x) => x.riskPips), medianSpreadPips: med((x) => x.spreadPips), medianHoldH: med((x) => x.holdH),
  byYear: byYear(trades, new Date(START).getUTCFullYear(), new Date(END - 1).getUTCFullYear()),
  splits: {
    withTrend: summarize(trades.filter((x) => !x.counter)), counterTrend: summarize(trades.filter((x) => x.counter)),
    market: summarize(trades.filter((x) => x.market)), limit: summarize(trades.filter((x) => !x.market)),
    long: summarize(trades.filter((x) => x.long)), short: summarize(trades.filter((x) => !x.long)),
  },
  runtimeSec: (Date.now() - t0) / 1000,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/${report.name}.json`, JSON.stringify(report, null, 2));
fs.writeFileSync(`${OUT}/${report.name}_trades.json`, JSON.stringify(trades));
console.log(JSON.stringify({ ...report, byYear: undefined, splits: undefined }, null, 1));
console.table(report.byYear);
console.table(Object.entries(report.splits).map(([k, v]) => ({ k, n: v.n, winPct: v.winPct, expR: v.expR, pf: v.pf, totalR: v.totalR })));
