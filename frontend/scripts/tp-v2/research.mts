// TrendPullback V2 staged research on EUR/USD 2008-2023 ONLY.
// Usage: tsx research.mts <stage>   (stages: trend, pullback, entry, exits)
// Ranking rule (fixed before any result was seen): t-stat of net R per trade
// (mean / standard error), eligible only with >= 200 trades in 2008-2023.
import fs from "node:fs";
import type { Config } from "./engine.mts";
import { record, runGrid, type Result } from "./runner.mts";

const DATA = process.env.DATA_DIR!;
export const OUT = process.env.OUT_DIR!;
export const START = Date.parse("2008-01-01T00:00:00Z");
export const END = Date.parse("2024-01-01T00:00:00Z"); // hard development cap
const REG = `${OUT}/grid/registry.json`;
fs.mkdirSync(`${OUT}/grid`, { recursive: true });

export const MIN_N = 200;
export const score = (r: Result) => (r.s.n >= MIN_N ? r.s.tstat : -99);
export const posYears = (r: Result) => Object.values(r.years).filter((y) => y.sum > 0).length;
export const short = (c: Config) => {
  const t = c.trend === "NONE" ? "NONE" : `${c.trend}${c.trend === "SWING" ? `k${c.swingReach ?? 3}` : c.trend === "REG" ? `${c.regN}/${c.regR2}` : ""}@${c.trendTf}`;
  const f = c.filters ? ` F${JSON.stringify(c.filters)}` : "";
  return `${c.base} ${t} zz${c.zz} imp${c.minImp} ${c.pbMode}${c.depth} ${c.entry} SL:${c.stop}${c.stopVal} TP:${c.tp}${c.tpVal}${f}`;
};
export function table(rs: Result[], top = 25) {
  const rows = [...rs].sort((a, b) => score(b) - score(a)).slice(0, top);
  console.table(rows.map((r) => ({ cfg: short(r.cfg), n: r.s.n, win: r.s.winPct, exp: r.s.expR, pf: r.s.pf, totR: r.s.totalR, dd: r.s.maxDD, t: r.s.tstat, posY: posYears(r) })));
}
export async function run(stage: string, cfgs: Config[]) {
  console.error(`${stage}: ${cfgs.length} configs`);
  const rs = await runGrid(cfgs, { dataDir: DATA, start: START, end: END, newsFile: `${DATA}/calendar_high.json` });
  fs.writeFileSync(`${OUT}/grid/${stage}.json`, JSON.stringify(rs));
  console.error(`registry: ${record(REG, rs)} configs evaluated in total`);
  return rs;
}
export const load = (stage: string) => JSON.parse(fs.readFileSync(`${OUT}/grid/${stage}.json`, "utf8")) as Result[];
const uniq = <T,>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];

// Default executions used while the trend read is compared (two, so the trend
// choice does not hinge on one execution style).
const E1 = { zz: 1, minImp: 2, pbMode: "FRACTION", depth: 0.5, entry: "LIMIT", stop: "ATR", stopVal: 1.5, tp: "RR", tpVal: 2 } as const;
const E2 = { zz: 1, minImp: 2, pbMode: "FRACTION", depth: 0.4, entry: "CANDLE", stop: "PB", stopVal: 0.25, tp: "RR", tpVal: 2 } as const;
const TRENDS: Array<Pick<Config, "trend" | "swingReach" | "regN" | "regR2">> = [
  { trend: "SWING", swingReach: 3 }, { trend: "SWING", swingReach: 5 }, { trend: "EMA_STACK" }, { trend: "EMA_PRICE" },
  { trend: "REG", regN: 50, regR2: 0.3 }, { trend: "REG", regN: 100, regR2: 0.3 }, { trend: "REG", regN: 50, regR2: 0.5 },
];
const trendKey = (c: Config) => JSON.stringify([c.base, c.trend, c.trendTf, c.swingReach, c.regN, c.regR2]);
const pick = <K extends keyof Config>(c: Config, keys: K[]) => Object.fromEntries(keys.map((k) => [k, c[k]])) as Pick<Config, K>;
const TREND_KEYS: Array<keyof Config> = ["base", "trend", "trendTf", "swingReach", "regN", "regR2"];
const PB_KEYS: Array<keyof Config> = ["zz", "minImp", "pbMode", "depth"];

const stage = process.argv[2];
if (stage === "trend") {
  const cfgs: Config[] = [];
  for (const base of ["M15", "H1", "H4"] as const) {
    for (const e of [E1, E2]) {
      cfgs.push({ base, trend: "NONE", trendTf: "base", ...e });
      for (const tr of TRENDS) for (const trendTf of ["base", "higher", "both"] as const) cfgs.push({ base, ...tr, trendTf, ...e });
    }
  }
  const rs = await run("trend", cfgs);
  table(rs, 40);
  // Trend reads ranked by their mean t-stat across both default executions.
  const groups = new Map<string, Result[]>();
  for (const r of rs) groups.set(trendKey(r.cfg), [...(groups.get(trendKey(r.cfg)) ?? []), r]);
  console.table([...groups.values()].map((g) => ({ trend: short(g[0]!.cfg).split(" zz")[0], meanT: +(g.reduce((s, r) => s + score(r), 0) / g.length).toFixed(2), exp: g.map((r) => r.s.expR).join(" / "), n: g.map((r) => r.s.n).join(" / ") }))
    .sort((a, b) => b.meanT - a.meanT));
}

/** The best trend reads from the trend stage: top 6 by mean t-stat across the two default executions. */
export function topTrends(k = 6) {
  const rs = load("trend");
  const groups = new Map<string, Result[]>();
  for (const r of rs) groups.set(trendKey(r.cfg), [...(groups.get(trendKey(r.cfg)) ?? []), r]);
  return [...groups.values()].map((g) => ({ g, m: g.reduce((s, r) => s + score(r), 0) / g.length }))
    .sort((a, b) => b.m - a.m).slice(0, k).map(({ g }) => pick(g[0]!.cfg, TREND_KEYS as Array<keyof Config>) as Pick<Config, "base" | "trend" | "trendTf" | "swingReach" | "regN" | "regR2">);
}

if (stage === "pullback") {
  const PBS: Array<Pick<Config, "pbMode" | "depth">> = [
    ...[0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.66, 0.75].map((depth) => ({ pbMode: "FRACTION" as const, depth })),
    ...[0.5, 1, 1.5, 2, 3].map((depth) => ({ pbMode: "ATR" as const, depth })),
    ...[0, 0.25, 0.5].map((depth) => ({ pbMode: "EMA" as const, depth })),
  ];
  const cfgs: Config[] = [];
  for (const tr of topTrends()) for (const pb of PBS) for (const minImp of [1.5, 2, 3]) for (const zz of [0.5, 1, 2]) {
    cfgs.push({ ...tr, ...pb, minImp, zz, entry: "LIMIT", stop: "ATR", stopVal: 1.5, tp: "RR", tpVal: 2 } as Config);
    cfgs.push({ ...tr, ...pb, minImp, zz, entry: "CANDLE", stop: "PB", stopVal: 0.25, tp: "RR", tpVal: 2 } as Config);
  }
  const rs = await run("pullback", cfgs);
  table(rs, 40);
  // Depth profile: mean t-stat per pullback setting across trends/impulse/zz/entries.
  const prof = new Map<string, number[]>();
  for (const r of rs) { const k = `${r.cfg.pbMode}${r.cfg.depth} ${r.cfg.entry}`; prof.set(k, [...(prof.get(k) ?? []), r.s.expR]); }
  console.table([...prof.entries()].map(([k, v]) => ({ k, meanExp: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(4), best: +Math.max(...v).toFixed(4), positive: v.filter((x) => x > 0).length + "/" + v.length })));
}

if (stage === "entry") {
  // Top 8 trend+pullback settings (ranked by t-stat, whatever entry they were found with).
  const pbs = uniq(load("pullback").sort((a, b) => score(b) - score(a)).map((r) => ({ ...pick(r.cfg, TREND_KEYS as Array<keyof Config>), ...pick(r.cfg, PB_KEYS) }))).slice(0, 8);
  const cfgs: Config[] = [];
  for (const p of pbs) for (const entry of ["LIMIT", "CANDLE", "BREAK", "STRUCT_BREAK", "RECLAIM"] as const) for (const [stop, stopVal] of [["ATR", 1.5], ["PB", 0.25], ["ORIGIN", 0.1]] as const) {
    cfgs.push({ ...p, entry, stop, stopVal, tp: "RR", tpVal: 2 } as Config);
  }
  const rs = await run("entry", cfgs);
  table(rs, 40);
  const prof = new Map<string, number[]>();
  for (const r of rs) prof.set(r.cfg.entry, [...(prof.get(r.cfg.entry) ?? []), r.s.expR]);
  console.table([...prof.entries()].map(([k, v]) => ({ k, meanExp: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(4), best: +Math.max(...v).toFixed(4), positive: v.filter((x) => x > 0).length + "/" + v.length })));
}

if (stage === "exits") {
  const ENTRY_KEYS: Array<keyof Config> = [...TREND_KEYS, ...PB_KEYS, "entry"];
  const es = uniq(load("entry").sort((a, b) => score(b) - score(a)).map((r) => pick(r.cfg, ENTRY_KEYS))).slice(0, 8);
  const STOPS: Array<[Config["stop"], number]> = [["ATR", 0.75], ["ATR", 1], ["ATR", 1.5], ["ATR", 2], ["ATR", 3], ["PB", 0.1], ["PB", 0.25], ["PB", 0.5], ["ORIGIN", 0.1], ["ORIGIN", 0.25], ["PIPS", 10], ["PIPS", 15], ["PIPS", 20], ["PIPS", 30], ["PIPS", 40]];
  const TPS: Array<[Config["tp"], number]> = [["RR", 1], ["RR", 1.25], ["RR", 1.5], ["RR", 2], ["RR", 2.5], ["RR", 3], ["PIPS", 10], ["PIPS", 15], ["PIPS", 20], ["PIPS", 25], ["PIPS", 30], ["PIPS", 40], ["PIPS", 50], ["STRUCT", 0]];
  const cfgs: Config[] = [];
  for (const e of es) for (const [stop, stopVal] of STOPS) for (const [tp, tpVal] of TPS) cfgs.push({ ...e, stop, stopVal, tp, tpVal } as Config);
  const rs = await run("exits", cfgs);
  table(rs, 40);
  for (const dim of ["stop", "tp"] as const) {
    const prof = new Map<string, Result[]>();
    for (const r of rs) { const k = dim === "stop" ? `${r.cfg.stop}${r.cfg.stopVal}` : `${r.cfg.tp}${r.cfg.tpVal}`; prof.set(k, [...(prof.get(k) ?? []), r]); }
    console.table([...prof.entries()].map(([k, v]) => ({
      k, meanExp: +(v.reduce((s, r) => s + r.s.expR, 0) / v.length).toFixed(4), meanWin: +(v.reduce((s, r) => s + r.s.winPct, 0) / v.length).toFixed(1),
      meanAvgWin: +(v.reduce((s, r) => s + r.s.avgWin, 0) / v.length).toFixed(2), best: +Math.max(...v.map((r) => r.s.expR)).toFixed(4), positive: v.filter((r) => r.s.expR > 0).length + "/" + v.length,
    })));
  }
}

// PHASE 7 — market filters on the top exits-stage candidates.
// A filter is retained only if, on BOTH halves (2008-2015, 2016-2023), it raises
// expectancy, AND it keeps >= 60% of trades, AND it raises the full-period t-stat.
if (stage === "filters") {
  const { runGrid } = await import("./runner.mts");
  const { summarize } = await import("./lib.mts");
  const cands = load("exits").sort((a, b) => score(b) - score(a)).slice(0, 3).map((r) => r.cfg);
  const MID = Date.parse("2016-01-01T00:00:00Z");
  const FILTERS: Array<[string, import("./engine.mts").Filters]> = [
    ["hours 07-17 (London+NY)", { hours: [7, 17] }], ["hours 12-17 (overlap/NY)", { hours: [12, 17] }], ["hours 07-12 (London)", { hours: [7, 12] }],
    ["no Asia (skip 21-07)", { hours: [7, 21] }], ["no Monday", { noDow: [1] }], ["no Friday", { noDow: [5] }],
    ["spread <= 1.5", { maxSpreadPips: 1.5 }], ["ATR pct 0.2-1", { atrPct: [0.2, 1] }], ["ATR pct 0-0.8", { atrPct: [0, 0.8] }],
    ["ATR pct 0.33-1", { atrPct: [0.33, 1] }], ["ER >= 0.2 (trending)", { minEr: 0.2 }], ["ER >= 0.3", { minEr: 0.3 }],
    ["news: none 4h before", { newsBeforeMin: 240 }], ["news: none 2h before/1h after", { newsBeforeMin: 120, newsAfterMin: 60 }],
  ];
  const cfgs: Config[] = [];
  for (const c of cands) { cfgs.push(c); for (const [, f] of FILTERS) cfgs.push({ ...c, filters: f }); }
  const rs = await runGrid(cfgs, { dataDir: DATA, start: START, end: END, newsFile: `${DATA}/calendar_high.json`, withTrades: true });
  console.error(`registry: ${record(REG, rs)} configs evaluated in total`);
  const out: unknown[] = [];
  for (let ci = 0; ci < cands.length; ci += 1) {
    const base = rs[ci * (FILTERS.length + 1)]!;
    const bt = base.trades as import("./engine.mts").SimTrade[];
    console.log(`\nCANDIDATE ${ci + 1}: ${short(cands[ci]!)}`);
    // Bucket view of the unfiltered candidate.
    const bucket = (name: string, f: (x: import("./engine.mts").SimTrade) => string) => {
      const g = new Map<string, import("./engine.mts").SimTrade[]>();
      for (const x of bt) g.set(f(x), [...(g.get(f(x)) ?? []), x]);
      console.table([...g.entries()].sort().map(([k, v]) => { const s = summarize(v); return { [name]: k, n: s.n, win: s.winPct, exp: s.expR, pf: s.pf, totR: s.totalR }; }));
    };
    bucket("session(UTC decision hr)", (x) => x.hour < 7 ? "a 00-07" : x.hour < 12 ? "b 07-12" : x.hour < 17 ? "c 12-17" : "d 17-24");
    bucket("dow", (x) => String(x.dow));
    bucket("spread", (x) => x.spreadPips <= 1 ? "a <=1.0" : x.spreadPips <= 1.5 ? "b 1.0-1.5" : "c >1.5");
    bucket("ATR pct", (x) => x.atrPct < 0.33 ? "a low" : x.atrPct < 0.67 ? "b mid" : "c high");
    bucket("ER(20)", (x) => x.er < 0.15 ? "a ranging <.15" : x.er < 0.3 ? "b .15-.30" : "c trending >=.30");
    bucket("news (2013+)", (x) => x.year < 2013 ? "z pre-2013 (no calendar)" : x.newsNext <= 120 ? "a event <=2h ahead" : x.newsNext <= 240 ? "b 2-4h ahead" : "c none within 4h");
    const rows = [];
    for (let fi = 0; fi < FILTERS.length; fi += 1) {
      const r = rs[ci * (FILTERS.length + 1) + 1 + fi]!;
      const tr = r.trades as import("./engine.mts").SimTrade[];
      const h1 = summarize(tr.filter((x) => x.t < MID)), h2 = summarize(tr.filter((x) => x.t >= MID));
      const b1 = summarize(bt.filter((x) => x.t < MID)), b2 = summarize(bt.filter((x) => x.t >= MID));
      const keep = h1.expR > b1.expR && h2.expR > b2.expR && r.s.n >= 0.6 * base.s.n && r.s.tstat > base.s.tstat;
      rows.push({ filter: FILTERS[fi]![0], n: r.s.n, exp: r.s.expR, t: r.s.tstat, "exp 08-15": `${b1.expR}→${h1.expR}`, "exp 16-23": `${b2.expR}→${h2.expR}`, keep });
    }
    console.log(`unfiltered: n ${base.s.n} exp ${base.s.expR} t ${base.s.tstat}`);
    console.table(rows);
    out.push({ cfg: cands[ci], base: base.s, rows });
  }
  fs.writeFileSync(`${OUT}/grid/filters.json`, JSON.stringify(out, null, 1));
}

// PHASE 10 — plateau: one-at-a-time sweeps + 2-D grids around the leading candidates (news filter retained).
if (stage === "plateau") {
  const NEWS = { newsBeforeMin: 240 };
  const cands = load("exits").sort((a, b) => score(b) - score(a)).slice(0, 3).map((r) => ({ ...r.cfg, filters: NEWS }) as Config);
  const sweeps: Array<[string, (c: Config) => Config[]]> = [
    ["regN", (c) => [50, 75, 100, 150, 200].map((regN) => ({ ...c, regN }))],
    ["regR2", (c) => [0.1, 0.2, 0.3, 0.4, 0.5].map((regR2) => ({ ...c, regR2 }))],
    ["zz", (c) => [0.5, 1, 1.5, 2, 2.5, 3].map((zz) => ({ ...c, zz }))],
    ["minImp", (c) => [1, 1.25, 1.5, 2, 2.5, 3].map((minImp) => ({ ...c, minImp }))],
    ["depth", (c) => [0.4, 0.45, 0.5, 0.55, 0.6, 0.66, 0.7, 0.75, 0.8].map((depth) => ({ ...c, depth }))],
    ["stop", (c) => c.stop === "ATR" ? [0.5, 0.6, 0.75, 0.9, 1, 1.25, 1.5].map((stopVal) => ({ ...c, stopVal })) : [25, 30, 35, 40, 45, 50, 60].map((stopVal) => ({ ...c, stopVal }))],
    ["tp", (c) => c.tp === "STRUCT" ? [c] : [1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4].map((tpVal) => ({ ...c, tp: "RR" as const, tpVal }))],
    ["trendTf", (c) => (["base", "higher", "both"] as const).map((trendTf) => ({ ...c, trendTf }))],
    ["no news filter", (c) => [{ ...c, filters: undefined }]],
  ];
  const cfgs: Config[] = [];
  const tags: string[] = [];
  cands.forEach((c, ci) => {
    for (const [name, f] of sweeps) for (const v of f(c)) { cfgs.push(v); tags.push(`${ci + 1}|${name}`); }
    // 2-D: depth x stop, stop x tp
    for (const depth of [0.5, 0.55, 0.6, 0.66, 0.7, 0.75]) for (const sv of c.stop === "ATR" ? [0.5, 0.75, 1, 1.25] : [30, 40, 50]) { cfgs.push({ ...c, depth, stopVal: sv }); tags.push(`${ci + 1}|2D depth x stop`); }
    if (c.tp === "RR") for (const sv of c.stop === "ATR" ? [0.5, 0.75, 1, 1.25] : [30, 40, 50]) for (const tpVal of [1.5, 2, 2.5, 3, 3.5]) { cfgs.push({ ...c, stopVal: sv, tpVal }); tags.push(`${ci + 1}|2D stop x tp`); }
  });
  const rs = await run("plateau", cfgs);
  const groups = new Map<string, Result[]>();
  rs.forEach((r, i) => groups.set(tags[i]!, [...(groups.get(tags[i]!) ?? []), r]));
  cands.forEach((c, ci) => console.log(`CANDIDATE ${ci + 1}: ${short(c)}`));
  for (const [tag, g] of groups) {
    const [ci, name] = tag.split("|");
    if (name!.startsWith("2D")) {
      const [ka, kb] = name === "2D depth x stop" ? ["depth", "stopVal"] as const : ["stopVal", "tpVal"] as const;
      const as = [...new Set(g.map((r) => r.cfg[ka] as number))], bs = [...new Set(g.map((r) => r.cfg[kb] as number))];
      console.log(`\n[${ci}] ${name}: expR (n) — rows ${ka}, cols ${kb}`);
      console.table(Object.fromEntries(as.map((a) => [a, Object.fromEntries(bs.map((b) => { const r = g.find((x) => x.cfg[ka] === a && x.cfg[kb] === b)!; return [b, `${r.s.expR.toFixed(3)} (${r.s.n})`]; }))])));
    } else {
      console.log(`\n[${ci}] ${name}`);
      console.table(g.map((r) => ({ v: name === "no news filter" ? "off" : JSON.stringify(name === "stop" ? r.cfg.stopVal : name === "tp" ? r.cfg.tpVal : (r.cfg as Record<string, unknown>)[name]), n: r.s.n, win: r.s.winPct, exp: r.s.expR, pf: r.s.pf, totR: r.s.totalR, dd: r.s.maxDD, t: r.s.tstat, posY: posYears(r) })));
    }
  }
}
