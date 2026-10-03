import { loadData, simulate, type Config } from "./engine.mts";
import { summarize } from "./lib.mts";
const DIR = process.env.DATA_DIR!;
const t0 = Date.now();
const d = loadData(DIR, Date.parse("2008-01-01T00:00:00Z"), Date.parse("2024-01-01T00:00:00Z"), `${DIR}/calendar_high.json`);
console.log("load", (Date.now() - t0) / 1000);
for (const base of ["M15", "H1", "H4"] as const) {
  for (const extra of [{}, { mid: true }, { mirror: true }]) {
    const cfg: Config = { base, trend: "EMA_STACK", trendTf: "base", zz: 1, minImp: 2, pbMode: "FRACTION", depth: 0.5, entry: "LIMIT", stop: "ATR", stopVal: 1.5, tp: "RR", tpVal: 2, ...extra };
    const t1 = Date.now();
    const tr = simulate(d, cfg);
    const s = summarize(tr);
    console.log(base, JSON.stringify(extra), (Date.now() - t1) / 1000, s.n, s.winPct, s.expR, s.pf, s.totalR);
  }
}
