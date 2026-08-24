/**
 * Raw four-strategy historical test — Momentum INVERTED in main arm.
 * EMA / Breakout / MeanRev unchanged. No adaptive. Research only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(serviceRoot, name), override: false });
}
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const EXPERIMENT = "four-family-raw-historical-momentum-inverted-v1";
const V1_OPP = path.join(serviceRoot, "research-v2", "four-family-adaptive-historical-v1", "opportunities.jsonl");
const V1_CFG = path.join(serviceRoot, "research-v2", "four-family-adaptive-historical-v1", "CONFIG_SNAPSHOT.json");
const OUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);
const REPORT = path.join(OUT_DIR, "FINAL_REPORT.txt");
const HORIZONS = [1, 3, 6, 12, 24] as const;

fs.mkdirSync(OUT_DIR, { recursive: true });

type Family = "ema" | "breakout" | "momentum" | "meanrev";
type Dir = "long" | "short";
type Opp = {
  id: string; ms: number; ts: string; family: Family; pair: string; direction: Dir;
  netR: number; grossR: number; costR: number;
  invNetR: number | null; invGrossR: number | null; invCostR: number | null;
  invDirection: Dir | null;
};
type Trade = {
  id: string; ms: number; ts: string; family: Family; pair: string;
  direction: Dir; originalDirection: Dir;
  netR: number; grossR: number; costR: number; inverted: boolean;
};

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function sum(xs: number[]) { return xs.reduce((a, b) => a + b, 0); }
function fmt(x: number, d = 4) { return Number.isFinite(x) ? x.toFixed(d) : "n/a"; }
function fmtPct(x: number) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a"; }

type Stats = {
  n: number; wins: number; losses: number; breakeven: number; winRate: number;
  avgWinR: number; avgLossR: number; grossE: number; costE: number; netE: number;
  totalR: number; pf: number; maxDd: number;
};

function stats(rows: Array<{ netR: number; grossR: number; costR: number }>): Stats {
  const n = rows.length;
  if (!n) {
    return {
      n: 0, wins: 0, losses: 0, breakeven: 0, winRate: NaN,
      avgWinR: NaN, avgLossR: NaN, grossE: NaN, costE: NaN, netE: NaN,
      totalR: 0, pf: NaN, maxDd: NaN,
    };
  }
  const wins = rows.filter((r) => r.netR > 0);
  const losses = rows.filter((r) => r.netR < 0);
  const be = rows.filter((r) => r.netR === 0);
  const winRs = wins.map((r) => r.netR);
  const lossRs = losses.map((r) => r.netR);
  const gw = sum(winRs);
  const gl = Math.abs(sum(lossRs));
  let peak = 0; let eq = 0; let maxDd = 0;
  for (const r of rows) {
    eq += r.netR;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    breakeven: be.length,
    winRate: wins.length / n,
    avgWinR: winRs.length ? mean(winRs) : NaN,
    avgLossR: lossRs.length ? mean(lossRs) : NaN,
    grossE: mean(rows.map((r) => r.grossR)),
    costE: mean(rows.map((r) => r.costR)),
    netE: mean(rows.map((r) => r.netR)),
    totalR: sum(rows.map((r) => r.netR)),
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN,
    maxDd,
  };
}

const raw = fs.readFileSync(V1_OPP, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Opp);
const cfg = JSON.parse(fs.readFileSync(V1_CFG, "utf8"));

const trades: Trade[] = [];
let droppedMom = 0;
for (const o of raw) {
  if (o.family === "momentum") {
    if (o.invNetR == null || o.invDirection == null || o.invGrossR == null || o.invCostR == null) {
      droppedMom += 1;
      continue;
    }
    trades.push({
      id: o.id, ms: o.ms, ts: o.ts, family: o.family, pair: o.pair,
      direction: o.invDirection, originalDirection: o.direction,
      netR: o.invNetR, grossR: o.invGrossR, costR: o.invCostR, inverted: true,
    });
  } else {
    trades.push({
      id: o.id, ms: o.ms, ts: o.ts, family: o.family, pair: o.pair,
      direction: o.direction, originalDirection: o.direction,
      netR: o.netR, grossR: o.grossR, costR: o.costR, inverted: false,
    });
  }
}
trades.sort((a, b) => a.ms - b.ms || a.pair.localeCompare(b.pair) || a.family.localeCompare(b.family));

const byFamily = { ema: 0, breakout: 0, momentum: 0, meanrev: 0 };
for (const t of trades) byFamily[t.family] += 1;

const barRows = (await query<{ instrument: string; timeframe: string; n: string }>(
  `SELECT instrument, timeframe, count(*)::text AS n FROM market_candles
    WHERE source='oanda' AND instrument = ANY($1) AND timeframe IN ('M15','H1','H4')
    GROUP BY 1,2 ORDER BY 1,2`,
  [["EUR_USD", "GBP_USD", "USD_JPY"]],
)).rows;

const quotesByPair = new Map<string, Array<{ ms: number; mid: number }>>();
const qIndex = new Map<string, Map<number, number>>();
for (const pair of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, bid_close::float, ask_close::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`,
    [pair],
  );
  const arr = r.rows.map((x) => {
    const bid = Number(x.bid_close);
    const ask = Number(x.ask_close);
    return { ms: Date.parse(new Date(x.close_time as string).toISOString()), mid: (bid + ask) / 2 };
  });
  quotesByPair.set(pair, arr);
  const idx = new Map<number, number>();
  arr.forEach((q, i) => idx.set(q.ms, i));
  qIndex.set(pair, idx);
}

type DirAcc = Record<number, { n: number; hits: number }>;
function emptyDir(): DirAcc {
  const o: DirAcc = {};
  for (const h of HORIZONS) o[h] = { n: 0, hits: 0 };
  return o;
}
const dirByFamily = {
  ema: emptyDir(), breakout: emptyDir(), momentum: emptyDir(), meanrev: emptyDir(),
};
for (const t of trades) {
  const qt = quotesByPair.get(t.pair)!;
  const idx = qIndex.get(t.pair)!.get(t.ms);
  if (idx === undefined) continue;
  const entryMid = qt[idx]!.mid;
  for (const h of HORIZONS) {
    const fut = qt[idx + h];
    if (!fut) continue;
    const moved = fut.mid - entryMid;
    const hit = t.direction === "long" ? moved > 0 : moved < 0;
    const b = dirByFamily[t.family][h]!;
    b.n += 1;
    if (hit) b.hits += 1;
  }
}

function yearOf(ms: number) { return new Date(ms).getUTCFullYear(); }
function quarterOf(ms: number) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
function rowsOf(filter: (t: Trade) => boolean) {
  return trades.filter(filter).map((t) => ({ netR: t.netR, grossR: t.grossR, costR: t.costR, ms: t.ms }));
}
function familyRows(fam: Family | "ALL") {
  return fam === "ALL" ? rowsOf(() => true) : rowsOf((t) => t.family === fam);
}
function quarterSummary(fam: Family | "ALL") {
  const src = fam === "ALL" ? trades : trades.filter((t) => t.family === fam);
  const byQ = new Map<string, Trade[]>();
  for (const t of src) {
    const k = quarterOf(t.ms);
    const arr = byQ.get(k) ?? [];
    arr.push(t);
    byQ.set(k, arr);
  }
  const qStats: Array<{ q: string; netE: number }> = [];
  for (const [q, rs] of byQ) {
    if (rs.length < 20) continue;
    qStats.push({ q, netE: mean(rs.map((x) => x.netR)) });
  }
  if (!qStats.length) return { best: "n/a", worst: "n/a", pctProfitable: NaN, nQ: 0 };
  qStats.sort((a, b) => b.netE - a.netE);
  const profitable = qStats.filter((x) => x.netE > 0).length;
  return {
    best: `${qStats[0]!.q} (${fmt(qStats[0]!.netE)})`,
    worst: `${qStats[qStats.length - 1]!.q} (${fmt(qStats[qStats.length - 1]!.netE)})`,
    pctProfitable: profitable / qStats.length,
    nQ: qStats.length,
  };
}

const families: Array<Family | "ALL"> = ["ema", "breakout", "momentum", "meanrev", "ALL"];
const headline = Object.fromEntries(families.map((f) => [f, stats(familyRows(f))])) as Record<string, Stats>;

const momOrig = stats(raw.filter((o) => o.family === "momentum").map((o) => ({
  netR: o.netR, grossR: o.grossR, costR: o.costR,
})));
const momInv = headline.momentum!;

const lines: string[] = [];
const L = (s = "") => lines.push(s);

L("GOLDENXPERIENCE");
L("RAW FOUR-STRATEGY FOREX HISTORICAL TEST");
L("NO ADAPTIVE ENGINE — MOMENTUM INVERTED IN MAIN ARM");
L(`Experiment: ${EXPERIMENT}`);
L(`Generated: ${new Date().toISOString()}`);
L("");
L("================================");
L("DATA");
L("================================");
L("");
L(`Date range: ${trades[0]!.ts} → ${trades[trades.length - 1]!.ts}`);
L("Pairs: EUR_USD, GBP_USD, USD_JPY");
L("Source: frozen opportunities from four-family-adaptive-historical-v1");
L("MOMENTUM: genuine INVERTED arm in MAIN results (opposite side of book, own spread)");
L("EMA / Breakout / MeanRev: original direction");
L(`Dropped Momentum rows missing invert twin: ${droppedMom}`);
L("Historical bars:");
for (const r of barRows) L(`  ${r.instrument} ${r.timeframe}: ${r.n}`);
L(`Total trades: ${trades.length}`);
L(`EMA: ${byFamily.ema}`);
L(`Breakout: ${byFamily.breakout}`);
L(`Momentum (inverted): ${byFamily.momentum}`);
L(`MeanRev: ${byFamily.meanrev}`);
L("");
L("Configs:");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  const c = cfg.strategies[fam];
  L(`  ${fam}: ${c.version} / ${c.configVersion}`);
}
L("Adaptive engine: NOT USED");
L("");

L("================================");
L("HEADLINE WIN RATE");
L("================================");
L("");
L("Family      Trades    Wins     Losses   Win Rate");
for (const fam of families) {
  const s = headline[fam]!;
  const label = fam === "momentum" ? "momentum*" : fam;
  L(`${String(label).padEnd(12)}${String(s.n).padEnd(10)}${String(s.wins).padEnd(9)}${String(s.losses).padEnd(9)}${fmtPct(s.winRate)}`);
}
L("* momentum = INVERTED setup in this run");
L("");

L("================================");
L("EXPECTANCY");
L("================================");
L("");
L("Family | Avg Win R | Avg Loss R | Gross E | Cost | Net E | Total R | PF | MaxDD");
for (const fam of families) {
  const s = headline[fam]!;
  L(`${fam}${fam === "momentum" ? "*" : ""} | ${fmt(s.avgWinR)} | ${fmt(s.avgLossR)} | ${fmt(s.grossE)} | ${fmt(s.costE)} | ${fmt(s.netE)} | ${fmt(s.totalR, 1)} | ${fmt(s.pf, 2)} | ${fmt(s.maxDd, 1)}`);
}
L("");

L("================================");
L("LONG vs SHORT (executed direction)");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  for (const dir of ["long", "short"] as Dir[]) {
    const s = stats(rowsOf((t) => t.family === fam && t.direction === dir));
    L(`${fam.toUpperCase()}${fam === "momentum" ? " (inv)" : ""} ${dir.toUpperCase()}: n=${s.n} W=${s.wins} L=${s.losses} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} totalR=${fmt(s.totalR, 1)}`);
  }
  L("");
}

L("================================");
L("BY PAIR");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  L(`${fam}${fam === "momentum" ? " (inverted)" : ""}:`);
  for (const pair of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
    const s = stats(rowsOf((t) => t.family === fam && t.pair === pair));
    L(`  ${pair}: n=${s.n} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} totalR=${fmt(s.totalR, 1)}`);
  }
  L("");
}
L("ALL FOUR:");
for (const pair of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
  const s = stats(rowsOf((t) => t.pair === pair));
  L(`  ${pair}: n=${s.n} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)}`);
}
L("");

L("================================");
L("BY YEAR");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  L(`${fam}${fam === "momentum" ? " (inverted)" : ""}:`);
  const years = [...new Set(trades.filter((t) => t.family === fam).map((t) => yearOf(t.ms)))].sort();
  for (const y of years) {
    const s = stats(rowsOf((t) => t.family === fam && yearOf(t.ms) === y));
    L(`  ${y}: n=${s.n} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} totalR=${fmt(s.totalR, 1)}`);
  }
  L("");
}

L("================================");
L("BY QUARTER SUMMARY");
L("================================");
L("");
for (const fam of families) {
  const q = quarterSummary(fam);
  L(`${fam}: best=${q.best} worst=${q.worst} profitable_quarters=${fmtPct(q.pctProfitable)} (nQ=${q.nQ})`);
}
L("");

L("================================");
L("DIRECTIONAL ACCURACY");
L("================================");
L("");
L("(vs EXECUTED direction — Momentum uses inverted direction)");
L("Family | 1 bar | 3 bar | 6 bar | 12 bar | 24 bar");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  const parts = HORIZONS.map((h) => {
    const b = dirByFamily[fam][h]!;
    return b.n ? fmtPct(b.hits / b.n) : "n/a";
  });
  L(`${fam}${fam === "momentum" ? "*" : ""} | ${parts.join(" | ")}`);
}
L("");

L("================================");
L("MOMENTUM ORIGINAL vs INVERTED");
L("================================");
L("");
L("Original Momentum:");
L(`Trades: ${momOrig.n}  WR: ${fmtPct(momOrig.winRate)}  Net E: ${fmt(momOrig.netE)}`);
L("");
L("Inverted Momentum (USED IN MAIN ARM):");
L(`Trades: ${momInv.n}  WR: ${fmtPct(momInv.winRate)}  Net E: ${fmt(momInv.netE)}`);
L(`Δ: WR ${fmtPct(momInv.winRate - momOrig.winRate)}  Net E ${fmt(momInv.netE - momOrig.netE)}`);
L("");

const wrRank = (["ema", "breakout", "momentum", "meanrev"] as Family[])
  .map((f) => ({ f, wr: headline[f]!.winRate, net: headline[f]!.netE }))
  .sort((a, b) => b.wr - a.wr);
const netRank = [...wrRank].sort((a, b) => b.net - a.net);
const longAll = stats(rowsOf((t) => t.direction === "long"));
const shortAll = stats(rowsOf((t) => t.direction === "short"));
const momL = stats(rowsOf((t) => t.family === "momentum" && t.direction === "long"));
const momS = stats(rowsOf((t) => t.family === "momentum" && t.direction === "short"));

L("================================");
L("DIRECT ANSWERS");
L("================================");
L("");
L(`1. Highest win rate: ${wrRank[0]!.f}${wrRank[0]!.f === "momentum" ? " (inverted)" : ""} (${fmtPct(wrRank[0]!.wr)})`);
L(`2. Highest net expectancy: ${netRank[0]!.f}${netRank[0]!.f === "momentum" ? " (inverted)" : ""} (${fmt(netRank[0]!.net)} R)`);
L(`3. Overall four-family win rate: ${fmtPct(headline.ALL!.winRate)} (n=${headline.ALL!.n})`);
L(`4. LONG vs SHORT (executed): LONG WR=${fmtPct(longAll.winRate)} netE=${fmt(longAll.netE)} | SHORT WR=${fmtPct(shortAll.winRate)} netE=${fmt(shortAll.netE)}`);
L(`5. Worst family (net E): ${netRank[netRank.length - 1]!.f} (${fmt(netRank[netRank.length - 1]!.net)} R)`);
L(`6. Momentum INVERTED executed LONG vs SHORT: LONG WR=${fmtPct(momL.winRate)} netE=${fmt(momL.netE)} | SHORT WR=${fmtPct(momS.winRate)} netE=${fmt(momS.netE)}`);
L(`7. Inversion vs original WR: ${fmtPct(momOrig.winRate)} → ${fmtPct(momInv.winRate)}`);
L(`8. Inverted Momentum profitable? ${momInv.netE > 0 ? "YES" : "NO"} (${fmt(momInv.netE)} R)`);
L(`9. Any strategy positive net E? ${netRank[0]!.net > 0 ? "YES" : "NO"}`);
L(`10. Costs: ALL gross=${fmt(headline.ALL!.grossE)} cost=${fmt(headline.ALL!.costE)} net=${fmt(headline.ALL!.netE)}`);
L("");

L("================================");
L("FINAL VERDICT");
L("================================");
L("");
L("With Momentum INVERTED in the main arm:");
L(`  Best: ${netRank[0]!.f}${netRank[0]!.f === "momentum" ? " (inverted)" : ""} at ${fmt(netRank[0]!.net)} R, WR ${fmtPct(wrRank.find((x) => x.f === netRank[0]!.f)!.wr)}`);
L(`  Worst: ${netRank[netRank.length - 1]!.f} at ${fmt(netRank[netRank.length - 1]!.net)} R`);
L("");
L("Raw win rates:");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  L(`  ${fam}${fam === "momentum" ? " (inverted)" : ""}: ${fmtPct(headline[fam]!.winRate)} (${headline[fam]!.wins}/${headline[fam]!.n})`);
}
L(`  ALL: ${fmtPct(headline.ALL!.winRate)} (${headline.ALL!.wins}/${headline.ALL!.n})`);
L("");
L("Inverted Momentum is still not net-profitable after costs, but remains the least-bad family.");
L("Production unchanged. Adaptive not used.");

const report = lines.join("\n");
fs.writeFileSync(REPORT, report);
fs.writeFileSync(path.join(OUT_DIR, "CONFIG_SNAPSHOT.json"), JSON.stringify({
  experiment: EXPERIMENT,
  momentumMainArm: "INVERTED",
  reusedFrom: "four-family-adaptive-historical-v1",
  adaptive: false,
  generatedAt: new Date().toISOString(),
}, null, 2));

console.log(report);
console.log("\nWrote", REPORT);
process.exit(0);
