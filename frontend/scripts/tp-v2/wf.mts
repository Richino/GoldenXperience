// PHASE 12 — anchored walk-forward of the WHOLE selection procedure, inside 2008-2023.
// For each test year Y in 2012..2023: rerun the staged search (trend → pullback →
// entry → stop×target → news-filter rule) ranking ONLY on 2008..Y-1, take the
// top config, and score it on year Y. Configs are simulated once over 2008-2023
// (a config's path from 2008 does not depend on what is later read), and only
// the training years' per-year sums are used for ranking.
import fs from "node:fs";
import type { Config } from "./engine.mts";
import { byYear, summarize, type Trade } from "./lib.mts";
import { cfgId, runGrid, type Result } from "./runner.mts";

const DATA = process.env.DATA_DIR!;
const OUT = process.env.OUT_DIR!;
const START = Date.parse("2008-01-01T00:00:00Z");
const END = Date.parse("2024-01-01T00:00:00Z");
const REG = `${OUT}/grid/registry.json`;
const reg: Record<string, Result> = JSON.parse(fs.readFileSync(REG, "utf8"));

async function evalAll(cfgs: Config[]) {
  const missing = [...new Map(cfgs.filter((c) => !reg[cfgId(c)]).map((c) => [cfgId(c), c])).values()];
  if (missing.length) {
    const rs = await runGrid(missing, { dataDir: DATA, start: START, end: END, newsFile: `${DATA}/calendar_high.json` });
    for (const r of rs) reg[r.id] = { id: r.id, cfg: r.cfg, s: r.s, years: r.years };
  }
  return cfgs.map((c) => reg[cfgId(c)]!);
}
/** Stats over years [from, to]. */
function stats(r: Result, from: number, to: number) {
  let n = 0, sum = 0, sumsq = 0;
  for (let y = from; y <= to; y += 1) { const v = r.years[y]; if (v) { n += v.n; sum += v.sum; sumsq += v.sumsq; } }
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (sumsq - n * mean * mean) / (n - 1))) : 0;
  return { n, mean, t: sd > 0 ? mean / sd * Math.sqrt(n) : 0 };
}

const TREND_KEYS = ["base", "trend", "trendTf", "swingReach", "regN", "regR2"] as const;
const PB_KEYS = ["zz", "minImp", "pbMode", "depth"] as const;
const pick = (c: Config, keys: readonly (keyof Config)[]) => Object.fromEntries(keys.map((k) => [k, c[k]])) as Partial<Config>;
const uniq = <T,>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
const E1 = { zz: 1, minImp: 2, pbMode: "FRACTION", depth: 0.5, entry: "LIMIT", stop: "ATR", stopVal: 1.5, tp: "RR", tpVal: 2 } as const;
const E2 = { zz: 1, minImp: 2, pbMode: "FRACTION", depth: 0.4, entry: "CANDLE", stop: "PB", stopVal: 0.25, tp: "RR", tpVal: 2 } as const;
const TRENDS: Array<Partial<Config>> = [
  { trend: "SWING", swingReach: 3 }, { trend: "SWING", swingReach: 5 }, { trend: "EMA_STACK" }, { trend: "EMA_PRICE" },
  { trend: "REG", regN: 50, regR2: 0.3 }, { trend: "REG", regN: 100, regR2: 0.3 }, { trend: "REG", regN: 50, regR2: 0.5 },
];
const PBS: Array<Partial<Config>> = [
  ...[0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.66, 0.75].map((depth) => ({ pbMode: "FRACTION" as const, depth })),
  ...[0.5, 1, 1.5, 2, 3].map((depth) => ({ pbMode: "ATR" as const, depth })),
  ...[0, 0.25, 0.5].map((depth) => ({ pbMode: "EMA" as const, depth })),
];
const STOPS: Array<[Config["stop"], number]> = [["ATR", 0.75], ["ATR", 1], ["ATR", 1.5], ["ATR", 2], ["ATR", 3], ["PB", 0.1], ["PB", 0.25], ["PB", 0.5], ["ORIGIN", 0.1], ["ORIGIN", 0.25], ["PIPS", 10], ["PIPS", 15], ["PIPS", 20], ["PIPS", 30], ["PIPS", 40]];
const TPS: Array<[Config["tp"], number]> = [["RR", 1], ["RR", 1.25], ["RR", 1.5], ["RR", 2], ["RR", 2.5], ["RR", 3], ["PIPS", 10], ["PIPS", 15], ["PIPS", 20], ["PIPS", 25], ["PIPS", 30], ["PIPS", 40], ["PIPS", 50], ["STRUCT", 0]];

/** The staged procedure ranking on years 2008..lastTrain. */
async function procedure(lastTrain: number) {
  const yrs = lastTrain - 2008 + 1;
  const minN = 200 * yrs / 16;
  const sc = (r: Result) => { const s = stats(r, 2008, lastTrain); return s.n >= minN ? s.t : -99; };
  const rank = (rs: Result[]) => [...rs].sort((a, b) => sc(b) - sc(a));
  // trend
  const tc: Config[] = [];
  for (const base of ["M15", "H1", "H4"] as const) for (const e of [E1, E2]) {
    tc.push({ base, trend: "NONE", trendTf: "base", ...e } as Config);
    for (const tr of TRENDS) for (const trendTf of ["base", "higher", "both"] as const) tc.push({ base, ...tr, trendTf, ...e } as Config);
  }
  const tr = await evalAll(tc);
  const g = new Map<string, Result[]>();
  for (const r of tr) { const k = JSON.stringify(pick(r.cfg, TREND_KEYS)); g.set(k, [...(g.get(k) ?? []), r]); }
  const trends = [...g.values()].map((x) => ({ x, m: x.reduce((s, r) => s + sc(r), 0) / x.length })).sort((a, b) => b.m - a.m).slice(0, 6).map(({ x }) => pick(x[0]!.cfg, TREND_KEYS));
  // pullback
  const pc: Config[] = [];
  for (const t of trends) for (const pb of PBS) for (const minImp of [1.5, 2, 3]) for (const zz of [0.5, 1, 2]) {
    pc.push({ ...t, ...pb, minImp, zz, entry: "LIMIT", stop: "ATR", stopVal: 1.5, tp: "RR", tpVal: 2 } as Config);
    pc.push({ ...t, ...pb, minImp, zz, entry: "CANDLE", stop: "PB", stopVal: 0.25, tp: "RR", tpVal: 2 } as Config);
  }
  const pbs = uniq(rank(await evalAll(pc)).map((r) => ({ ...pick(r.cfg, TREND_KEYS), ...pick(r.cfg, PB_KEYS) }))).slice(0, 8);
  // entry
  const ec: Config[] = [];
  for (const p of pbs) for (const entry of ["LIMIT", "CANDLE", "BREAK", "STRUCT_BREAK", "RECLAIM"] as const) for (const [stop, stopVal] of [["ATR", 1.5], ["PB", 0.25], ["ORIGIN", 0.1]] as const) ec.push({ ...p, entry, stop, stopVal, tp: "RR", tpVal: 2 } as Config);
  const es = uniq(rank(await evalAll(ec)).map((r) => pick(r.cfg, [...TREND_KEYS, ...PB_KEYS, "entry"]))).slice(0, 8);
  // exits
  const xc: Config[] = [];
  for (const e of es) for (const [stop, stopVal] of STOPS) for (const [tp, tpVal] of TPS) xc.push({ ...e, stop, stopVal, tp, tpVal } as Config);
  const best = rank(await evalAll(xc))[0]!;
  // news-filter rule on the training halves
  const half = Math.floor((2008 + lastTrain) / 2);
  const [withNews] = await evalAll([{ ...best.cfg, filters: { newsBeforeMin: 240 } }]);
  const b = best, f = withNews!;
  const keep = stats(f, 2008, half).mean > stats(b, 2008, half).mean && stats(f, half + 1, lastTrain).mean > stats(b, half + 1, lastTrain).mean
    && stats(f, 2008, lastTrain).n >= 0.6 * stats(b, 2008, lastTrain).n && stats(f, 2008, lastTrain).t > stats(b, 2008, lastTrain).t;
  return { chosen: keep ? f : b, newsKept: keep, trainT: sc(keep ? f : b) };
}

const folds: Array<{ test: number; cfg: Config; newsKept: boolean; trainT: number; train: ReturnType<typeof stats>; test_: { n: number; mean: number } }> = [];
for (let Y = 2012; Y <= 2023; Y += 1) {
  const p = await procedure(Y - 1);
  const te = stats(p.chosen, Y, Y);
  folds.push({ test: Y, cfg: p.chosen.cfg, newsKept: p.newsKept, trainT: +p.trainT.toFixed(2), train: stats(p.chosen, 2008, Y - 1), test_: te });
  console.error(`fold ${Y}: test n ${te.n} mean ${te.mean.toFixed(3)} | ${JSON.stringify(p.chosen.cfg)}`);
}
// Save the registry once (Windows can briefly lock a file rewritten in a tight loop).
for (let attempt = 0; ; attempt += 1) {
  try { fs.writeFileSync(REG, JSON.stringify(reg)); break; } catch (error) { if (attempt > 5) throw error; await new Promise((r) => setTimeout(r, 2000)); }
}
// Trade-level metrics for the out-of-sample years: re-simulate each fold's chosen config and keep its test year.
const sims = await runGrid(folds.map((f) => f.cfg), { dataDir: DATA, start: START, end: END, newsFile: `${DATA}/calendar_high.json`, withTrades: true });
const oos: Trade[] = [];
sims.forEach((r, i) => oos.push(...(r.trades as Trade[]).filter((x) => x.year === folds[i]!.test)));
const s = summarize(oos, 12);
const report = { method: "anchored expanding walk-forward of the full staged procedure; train 2008..Y-1, test Y", folds, oosSummary: s, oosByYear: byYear(oos, 2012, 2023), configsInRegistry: Object.keys(reg).length };
fs.writeFileSync(`${OUT}/WALK_FORWARD.json`, JSON.stringify(report, null, 1));
fs.writeFileSync(`${OUT}/WALK_FORWARD_trades.json`, JSON.stringify(oos));
console.table(folds.map((f) => ({ test: f.test, trainT: f.trainT, trainN: f.train.n, trainExp: +f.train.mean.toFixed(3), testN: f.test_.n, testExp: +f.test_.mean.toFixed(3), news: f.newsKept, cfg: `${f.cfg.base} ${f.cfg.trend}${f.cfg.regN ?? ""}@${f.cfg.trendTf} zz${f.cfg.zz} imp${f.cfg.minImp} ${f.cfg.pbMode}${f.cfg.depth} ${f.cfg.entry} ${f.cfg.stop}${f.cfg.stopVal} ${f.cfg.tp}${f.cfg.tpVal}` })));
console.log(JSON.stringify(s, null, 1));
console.table(report.oosByYear);
