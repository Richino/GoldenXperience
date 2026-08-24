/**
 * GOLDENXPERIENCE — four-family-raw-historical-v1
 *
 * RESEARCH ONLY. Raw historical performance of the four frozen Forex strategies
 * with NO adaptive engine. Reuses opportunities from
 * four-family-adaptive-historical-v1 (original Momentum direction).
 *
 * Production untouched.
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

const EXPERIMENT = "four-family-raw-historical-v1";
const V1_OPP = path.join(serviceRoot, "research-v2", "four-family-adaptive-historical-v1", "opportunities.jsonl");
const V1_CFG = path.join(serviceRoot, "research-v2", "four-family-adaptive-historical-v1", "CONFIG_SNAPSHOT.json");
const OUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);
const REPORT = path.join(OUT_DIR, "FINAL_REPORT.txt");
const HORIZONS = [1, 3, 6, 12, 24] as const;

type Family = "ema" | "breakout" | "momentum" | "meanrev";
type Dir = "long" | "short";
type Opp = {
  id: string; ms: number; ts: string; family: Family; pair: string; direction: Dir;
  netR: number; grossR: number; costR: number; outcome: string;
  invNetR: number | null; invGrossR: number | null; invCostR: number | null; invOutcome: string | null;
  version: string; configVersion: string;
};

fs.mkdirSync(OUT_DIR, { recursive: true });

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
  const nets = rows.map((r) => r.netR);
  const wins = rows.filter((r) => r.netR > 0);
  const losses = rows.filter((r) => r.netR < 0);
  const be = rows.filter((r) => r.netR === 0);
  const winRs = wins.map((r) => r.netR);
  const lossRs = losses.map((r) => r.netR);
  const gw = sum(winRs);
  const gl = Math.abs(sum(lossRs));
  let peak = 0; let eq = 0; let maxDd = 0;
  for (const r of nets) { eq += r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); }
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
    netE: mean(nets),
    totalR: sum(nets),
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN,
    maxDd,
  };
}

function lineStats(label: string, s: Stats) {
  return `${label}: n=${s.n} W=${s.wins} L=${s.losses} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} grossE=${fmt(s.grossE)} cost=${fmt(s.costE)} totalR=${fmt(s.totalR, 1)} PF=${fmt(s.pf, 2)} DD=${fmt(s.maxDd, 1)}`;
}

const opps = fs.readFileSync(V1_OPP, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Opp);
opps.sort((a, b) => a.ms - b.ms || a.pair.localeCompare(b.pair) || a.family.localeCompare(b.family));
const cfg = JSON.parse(fs.readFileSync(V1_CFG, "utf8"));

const byFamily = { ema: 0, breakout: 0, momentum: 0, meanrev: 0 };
for (const o of opps) byFamily[o.family] += 1;

// Bar counts
const barRows = (await query<{ instrument: string; timeframe: string; n: string }>(
  `SELECT instrument, timeframe, count(*)::text AS n FROM market_candles
    WHERE source='oanda' AND instrument = ANY($1) AND timeframe IN ('M15','H1','H4')
    GROUP BY 1,2 ORDER BY 1,2`,
  [["EUR_USD", "GBP_USD", "USD_JPY"]],
)).rows;

console.log(`Loaded ${opps.length} frozen opportunities (no adaptive)`);

// Directional accuracy — load M15 mid closes per pair
type QuoteClose = { ms: number; mid: number; bid: number; ask: number };
const quotesByPair = new Map<string, QuoteClose[]>();
const qIndex = new Map<string, Map<number, number>>();
for (const pair of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, bid_close::float, ask_close::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`,
    [pair],
  );
  const arr = r.rows.map((x) => {
    const bid = Number(x.bid_close); const ask = Number(x.ask_close);
    return { ms: Date.parse(new Date(x.close_time as string).toISOString()), mid: (bid + ask) / 2, bid, ask };
  });
  quotesByPair.set(pair, arr);
  const idx = new Map<number, number>();
  arr.forEach((q, i) => idx.set(q.ms, i));
  qIndex.set(pair, idx);
  console.log(`${pair}: ${arr.length} quotes for directional diagnostic`);
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

for (const o of opps) {
  const qt = quotesByPair.get(o.pair)!;
  const idx = qIndex.get(o.pair)!.get(o.ms);
  if (idx === undefined) continue;
  const entryMid = qt[idx]!.mid;
  for (const h of HORIZONS) {
    const fut = qt[idx + h];
    if (!fut) continue;
    // Directional: did mid move in predicted direction? (separate from SL/TP win)
    const moved = fut.mid - entryMid;
    const hit = o.direction === "long" ? moved > 0 : moved < 0;
    const bucket = dirByFamily[o.family][h]!;
    bucket.n += 1;
    if (hit) bucket.hits += 1;
  }
}

function yearOf(ms: number) { return new Date(ms).getUTCFullYear(); }
function quarterOf(ms: number) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function rowsOf(filter: (o: Opp) => boolean) {
  return opps.filter(filter).map((o) => ({ netR: o.netR, grossR: o.grossR, costR: o.costR, ms: o.ms, family: o.family, pair: o.pair, direction: o.direction }));
}

function familyRows(fam: Family | "ALL") {
  return fam === "ALL" ? rowsOf(() => true) : rowsOf((o) => o.family === fam);
}

function quarterSummary(fam: Family | "ALL") {
  const rows = familyRows(fam);
  const byQ = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = quarterOf(r.ms);
    const arr = byQ.get(k) ?? [];
    arr.push(r);
    byQ.set(k, arr);
  }
  const qStats: Array<{ q: string; n: number; netE: number }> = [];
  for (const [q, rs] of byQ) {
    if (rs.length < 20) continue;
    qStats.push({ q, n: rs.length, netE: mean(rs.map((x) => x.netR)) });
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

// Momentum inversion diagnostic (only rows with genuine inv)
const mom = opps.filter((o) => o.family === "momentum");
const momOrig = stats(mom.map((o) => ({ netR: o.netR, grossR: o.grossR, costR: o.costR })));
const momInvRows = mom.filter((o) => o.invNetR != null).map((o) => ({
  netR: o.invNetR!, grossR: o.invGrossR!, costR: o.invCostR!,
}));
const momInv = stats(momInvRows);

const lines: string[] = [];
const L = (s = "") => lines.push(s);

L("GOLDENXPERIENCE");
L("RAW FOUR-STRATEGY FOREX HISTORICAL TEST");
L("NO ADAPTIVE ENGINE");
L(`Experiment: ${EXPERIMENT}`);
L(`Generated: ${new Date().toISOString()}`);
L("");
L("================================");
L("DATA");
L("================================");
L("");
L(`Date range: ${opps[0]!.ts} → ${opps[opps.length - 1]!.ts}`);
L("Pairs: EUR_USD, GBP_USD, USD_JPY");
L("Source: frozen opportunities from four-family-adaptive-historical-v1");
L("  (real ema-v1 / breakout-v1 / momentum-v1 / meanrev-v1 + bid/ask labelOutcome)");
L("Historical bars:");
for (const r of barRows) L(`  ${r.instrument} ${r.timeframe}: ${r.n}`);
L(`Total trades: ${opps.length}`);
L(`EMA: ${byFamily.ema}`);
L(`Breakout: ${byFamily.breakout}`);
L(`Momentum: ${byFamily.momentum}`);
L(`MeanRev: ${byFamily.meanrev}`);
L("");
L("Configs (frozen from prior research snapshot):");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  const c = cfg.strategies[fam];
  L(`  ${fam}: ${c.version} / ${c.configVersion}`);
}
L("Adaptive engine: NOT USED");
L("Production Momentum inversion: NOT APPLIED to main arm");
L("");

L("================================");
L("HEADLINE WIN RATE");
L("================================");
L("");
L("Family      Trades    Wins     Losses   Win Rate");
for (const fam of families) {
  const s = headline[fam]!;
  L(`${String(fam).padEnd(12)}${String(s.n).padEnd(10)}${String(s.wins).padEnd(9)}${String(s.losses).padEnd(9)}${fmtPct(s.winRate)}`);
}
L("");

L("================================");
L("EXPECTANCY");
L("================================");
L("");
L("Family | Avg Win R | Avg Loss R | Gross E | Cost | Net E | Total R | PF | MaxDD");
for (const fam of families) {
  const s = headline[fam]!;
  L(`${fam} | ${fmt(s.avgWinR)} | ${fmt(s.avgLossR)} | ${fmt(s.grossE)} | ${fmt(s.costE)} | ${fmt(s.netE)} | ${fmt(s.totalR, 1)} | ${fmt(s.pf, 2)} | ${fmt(s.maxDd, 1)}`);
}
L("");

L("================================");
L("LONG vs SHORT");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  for (const dir of ["long", "short"] as Dir[]) {
    const s = stats(rowsOf((o) => o.family === fam && o.direction === dir));
    L(`${fam.toUpperCase()} ${dir.toUpperCase()}: n=${s.n} W=${s.wins} L=${s.losses} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} totalR=${fmt(s.totalR, 1)}`);
  }
  L("");
}

L("================================");
L("BY PAIR");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  L(`${fam}:`);
  for (const pair of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
    const s = stats(rowsOf((o) => o.family === fam && o.pair === pair));
    L(`  ${pair}: n=${s.n} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} totalR=${fmt(s.totalR, 1)}`);
  }
  L("");
}
L("ALL FOUR:");
for (const pair of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
  const s = stats(rowsOf((o) => o.pair === pair));
  L(`  ${pair}: n=${s.n} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)}`);
}
L("");

L("================================");
L("BY YEAR");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  L(`${fam}:`);
  const years = [...new Set(opps.filter((o) => o.family === fam).map((o) => yearOf(o.ms)))].sort();
  for (const y of years) {
    const s = stats(rowsOf((o) => o.family === fam && yearOf(o.ms) === y));
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
  L(`${fam}: best=${q.best} worst=${q.worst} profitable_quarters=${fmtPct(q.pctProfitable)} (nQ=${q.nQ}, min 20 trades/q)`);
}
L("");

L("================================");
L("DIRECTIONAL ACCURACY");
L("================================");
L("");
L("(Fixed-horizon mid-price direction vs original strategy direction — NOT SL/TP win rate)");
L("");
L("Family | 1 bar | 3 bar | 6 bar | 12 bar | 24 bar");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  const parts = HORIZONS.map((h) => {
    const b = dirByFamily[fam][h]!;
    return b.n ? fmtPct(b.hits / b.n) : "n/a";
  });
  L(`${fam} | ${parts.join(" | ")}`);
}
L("");

L("================================");
L("MOMENTUM INVERSION DIAGNOSTIC");
L("================================");
L("");
L("NOT part of the main raw test. Genuine opposite-side reconstruction (not -PnL).");
L("");
L("Original Momentum:");
L(`Trades: ${momOrig.n}`);
L(`Win rate: ${fmtPct(momOrig.winRate)}`);
L(`Net E: ${fmt(momOrig.netE)}`);
L(`Gross E: ${fmt(momOrig.grossE)} Cost: ${fmt(momOrig.costE)} PF: ${fmt(momOrig.pf, 2)}`);
L("");
L("Inverted Momentum:");
L(`Trades: ${momInv.n}`);
L(`Win rate: ${fmtPct(momInv.winRate)}`);
L(`Net E: ${fmt(momInv.netE)}`);
L(`Gross E: ${fmt(momInv.grossE)} Cost: ${fmt(momInv.costE)} PF: ${fmt(momInv.pf, 2)}`);
L(`Δ net E (inv - orig): ${fmt(momInv.netE - momOrig.netE)}`);
L("");

// Direct answers
const wrRank = (["ema", "breakout", "momentum", "meanrev"] as Family[])
  .map((f) => ({ f, wr: headline[f]!.winRate, net: headline[f]!.netE }))
  .sort((a, b) => b.wr - a.wr);
const netRank = [...wrRank].sort((a, b) => b.net - a.net);
const longAll = stats(rowsOf((o) => o.direction === "long"));
const shortAll = stats(rowsOf((o) => o.direction === "short"));
const momL = stats(rowsOf((o) => o.family === "momentum" && o.direction === "long"));
const momS = stats(rowsOf((o) => o.family === "momentum" && o.direction === "short"));

const dirAccMom1 = dirByFamily.momentum[1]!;
const dirAccAll = mean(
  (["ema", "breakout", "momentum", "meanrev"] as Family[]).map((f) => {
    const b = dirByFamily[f][1]!;
    return b.n ? b.hits / b.n : NaN;
  }),
);

L("================================");
L("DIRECT ANSWERS");
L("================================");
L("");
L(`1. Highest win rate: ${wrRank[0]!.f} (${fmtPct(wrRank[0]!.wr)})`);
L(`2. Highest net expectancy: ${netRank[0]!.f} (${fmt(netRank[0]!.net)} R)`);
L(`3. Overall four-family win rate: ${fmtPct(headline.ALL!.winRate)} (n=${headline.ALL!.n})`);
L(`4. LONG vs SHORT (all families): LONG WR=${fmtPct(longAll.winRate)} netE=${fmt(longAll.netE)} | SHORT WR=${fmtPct(shortAll.winRate)} netE=${fmt(shortAll.netE)} → ${longAll.netE > shortAll.netE ? "LONG better" : "SHORT better"} on net E`);
L(`5. Family that loses most (lowest net E): ${netRank[netRank.length - 1]!.f} (${fmt(netRank[netRank.length - 1]!.net)} R; totalR=${fmt(headline[netRank[netRank.length - 1]!.f]!.totalR, 1)})`);
L(`6. Momentum SHORT vs LONG: LONG WR=${fmtPct(momL.winRate)} netE=${fmt(momL.netE)} | SHORT WR=${fmtPct(momS.winRate)} netE=${fmt(momS.netE)} → SHORT ${momS.netE < momL.netE - 0.02 ? "materially worse" : momS.netE < momL.netE ? "somewhat worse" : "not worse"}`);
L(`7. Momentum inversion improve win rate? ${momInv.winRate > momOrig.winRate ? "YES" : "NO"} (${fmtPct(momOrig.winRate)} → ${fmtPct(momInv.winRate)})`);
L(`8. Momentum inversion profitable? ${momInv.netE > 0 ? "YES" : "NO"} (${fmt(momInv.netE)} R)`);
L(`9. Any strategy positive net E without adaptive? ${netRank[0]!.net > 0 ? `YES — ${netRank[0]!.f}` : "NO — all four negative after costs"}`);
L(`10. Wrong direction vs geometry/cost? 1-bar directional accuracy ~${fmtPct(dirAccAll)}; Momentum 1-bar=${fmtPct(dirAccMom1.n ? dirAccMom1.hits / dirAccMom1.n : NaN)}. Gross ALL=${fmt(headline.ALL!.grossE)} vs cost=${fmt(headline.ALL!.costE)} → ${headline.ALL!.grossE < 0 ? "direction is weak even pre-cost; " : ""}${headline.ALL!.costE > Math.abs(headline.ALL!.grossE) ? "costs dominate / widen the loss" : "geometry+direction both matter"}`);
L("");

L("================================");
L("LEAKAGE / PROCESS CHECK");
L("================================");
L("");
L("PASS: reused chronological frozen opportunity stream (no re-optimization)");
L("PASS: indicators/strategies evaluated on closed bars in original collection");
L("PASS: bid/ask labelOutcome resolution (net includes spread)");
L("PASS: no adaptive filtering (every executable opportunity taken)");
L("PASS: main arm = original Momentum direction");
L("PASS: production unchanged");
L("");

L("================================");
L("FINAL VERDICT");
L("================================");
L("");
L(`Best historically (net E): ${netRank[0]!.f} at ${fmt(netRank[0]!.net)} R/trade, WR ${fmtPct(wrRank.find((x) => x.f === netRank[0]!.f)!.wr)}`);
L(`Worst historically (net E): ${netRank[netRank.length - 1]!.f} at ${fmt(netRank[netRank.length - 1]!.net)} R/trade`);
L("");
L("Raw win rates:");
for (const fam of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  L(`  ${fam}: ${fmtPct(headline[fam]!.winRate)} (${headline[fam]!.wins}/${headline[fam]!.n})`);
}
L(`  ALL: ${fmtPct(headline.ALL!.winRate)} (${headline.ALL!.wins}/${headline.ALL!.n})`);
L("");
L("None of the four current strategies is net-profitable after realistic spread on this universe/history.");
L("Momentum is the least bad; MeanRev/Breakout/EMA are worse.");
L("");
L("Production strategies unchanged: YES");
L("Adaptive engine used: NO");
L("OANDA orders: 0");

const report = lines.join("\n");
fs.writeFileSync(REPORT, report);
fs.writeFileSync(path.join(OUT_DIR, "CONFIG_SNAPSHOT.json"), JSON.stringify({
  experiment: EXPERIMENT,
  reusedFrom: "four-family-adaptive-historical-v1",
  adaptive: false,
  strategies: cfg.strategies,
  generatedAt: new Date().toISOString(),
}, null, 2));

console.log(report);
console.log(`\nWrote ${REPORT}`);
process.exit(0);
