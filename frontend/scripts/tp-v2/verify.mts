// Checks on a config: (1) causality — truncating all data at CUT must not change
// any trade that closed before CUT; (2) gross (mid, no slippage) vs net; (3) the
// mirror trade (opposite direction, same distances) as a direction control;
// (4) year-by-year table. Usage: CFG='<json>' tsx verify.mts
import { loadData, simulate, type Config, type Data } from "./engine.mts";
import { byYear, countLE, summarize, type Bars } from "./lib.mts";

const DIR = process.env.DATA_DIR!;
const START = Date.parse("2008-01-01T00:00:00Z"), END = Date.parse(process.env.END ?? "2024-01-01T00:00:00Z");
const cfg = JSON.parse(process.env.CFG!) as Config;
const d = loadData(DIR, START, END, `${DIR}/calendar_high.json`);

const net = simulate(d, cfg);
const gross = simulate(d, { ...cfg, mid: true });
const mirror = simulate(d, { ...cfg, mirror: true });

// Causality: rebuild the data cut at CUT (every candle that has not CLOSED by CUT is removed).
const CUT = Date.parse("2015-06-01T00:00:00Z");
const cutBars = (b: Bars): Bars => {
  const n = countLE(b.end, CUT);
  return { t: b.t.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), end: b.end.slice(0, n), n };
};
const m5n = countLE(d.m5.a, CUT - 300_000, 9);
const dc: Data = {
  ...d, cache: new Map(), m5: { a: d.m5.a.slice(0, m5n * 9), n: m5n },
  tf: { M15: cutBars(d.tf.M15), H1: cutBars(d.tf.H1), H4: cutBars(d.tf.H4), D: cutBars(d.tf.D) }, end: CUT,
};
dc.m5Start = Object.fromEntries((Object.keys(dc.tf) as Array<keyof Data["tf"]>).map((k) => [k, d.m5Start[k].slice(0, dc.tf[k].n)])) as Data["m5Start"];
const cutTrades = simulate(dc, cfg);
const closedBefore = (x: { t: number; holdH: number }) => x.t + x.holdH * 3_600_000 < CUT - 86_400_000;
const a = net.filter(closedBefore), b = cutTrades.filter(closedBefore);
const same = a.length === b.length && a.every((x, i) => x.t === b[i]!.t && Math.abs(x.r - b[i]!.r) < 1e-9);
console.log(`causality (cut ${new Date(CUT).toISOString().slice(0, 10)}): ${a.length} vs ${b.length} trades closed before cut — ${same ? "IDENTICAL" : "DIFFERENT"}`);

const sNet = summarize(net), sGross = summarize(gross), sMirror = summarize(mirror);
console.table({ net: sNet, gross_mid: sGross, mirror_net: sMirror });
const med = (v: number[]) => [...v].sort((p, q) => p - q)[v.length >> 1]!;
console.log(`median risk ${med(net.map((x) => x.riskPips)).toFixed(1)} pips, median spread at fill ${med(net.map((x) => x.spreadPips)).toFixed(2)} pips, median hold ${med(net.map((x) => x.holdH)).toFixed(1)}h`);
const outs: Record<string, number> = {};
for (const x of net) outs[x.out] = (outs[x.out] ?? 0) + 1;
console.log("exits", outs, "long", net.filter((x) => x.long).length, "short", net.filter((x) => !x.long).length);
console.table(byYear(net, new Date(START).getUTCFullYear(), new Date(END - 1).getUTCFullYear()));
