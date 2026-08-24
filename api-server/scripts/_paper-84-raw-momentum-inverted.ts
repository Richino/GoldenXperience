/**
 * Apply the inverted-Momentum raw setup to the user's actual 84 paper trades.
 * RESEARCH ONLY. No production changes.
 *
 * - EMA / Breakout: actual executed results
 * - Momentum: genuine opposite-side INVERT counterfactual (not -PnL)
 * - Legacy null-family trades reported separately
 * - Open trades excluded from expectancy (listed)
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
const { labelOutcome } = await import("../src/research.js");

const EXPERIMENT = "paper-84-raw-momentum-inverted";
const OUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);
fs.mkdirSync(OUT_DIR, { recursive: true });

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live"
  ? "https://api-fxtrade.oanda.com"
  : "https://api-fxpractice.oanda.com";

type TradeRow = {
  id: string;
  trade_sequence: string;
  strategy_family: string | null;
  setup_name: string | null;
  instrument: string;
  direction: "long" | "short";
  decision_time: string;
  entry: number;
  stop: number;
  target: number;
  result_r: number | null;
  spread_pips: number | null;
  status: string;
  outcome: string | null;
  session: string | null;
  paper_pl: number | null;
};

type Quote = {
  closeTime: string;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function sum(xs: number[]) { return xs.reduce((a, b) => a + b, 0); }
function fmt(x: number, d = 4) { return Number.isFinite(x) ? x.toFixed(d) : "n/a"; }
function fmtPct(x: number) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a"; }

type Stats = {
  n: number; wins: number; losses: number; breakeven: number; winRate: number;
  netE: number; totalR: number; pf: number; avgWin: number; avgLoss: number;
};

function stats(rows: Array<{ netR: number }>): Stats {
  const n = rows.length;
  if (!n) {
    return { n: 0, wins: 0, losses: 0, breakeven: 0, winRate: NaN, netE: NaN, totalR: 0, pf: NaN, avgWin: NaN, avgLoss: NaN };
  }
  const wins = rows.filter((r) => r.netR > 0);
  const losses = rows.filter((r) => r.netR < 0);
  const be = rows.filter((r) => r.netR === 0);
  const gw = sum(wins.map((r) => r.netR));
  const gl = Math.abs(sum(losses.map((r) => r.netR)));
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    breakeven: be.length,
    winRate: wins.length / n,
    netE: mean(rows.map((r) => r.netR)),
    totalR: sum(rows.map((r) => r.netR)),
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN,
    avgWin: wins.length ? mean(wins.map((r) => r.netR)) : NaN,
    avgLoss: losses.length ? mean(losses.map((r) => r.netR)) : NaN,
  };
}

function inferFamily(t: TradeRow): string {
  if (t.strategy_family) return t.strategy_family;
  const s = (t.setup_name ?? "").toLowerCase();
  if (s.includes("bundled ema") || s.startsWith("ema ")) return "ema_legacy";
  if (s.includes("sweep") || s.includes("asian") || s.includes("swing") || s.includes("previous-")) return "liquidity_legacy";
  return "unknown_legacy";
}

const trades = (await query<Record<string, unknown>>(
  `SELECT id, trade_sequence::text, strategy_family, setup_name, instrument, direction,
          decision_time, entry::float, stop::float, target::float, result_r::float,
          spread_pips::float, status, outcome, session, paper_pl::float
     FROM paper_strategy_trades
    ORDER BY decision_time NULLS LAST, trade_sequence`,
)).rows.map((r) => ({
  id: String(r.id),
  trade_sequence: String(r.trade_sequence),
  strategy_family: r.strategy_family as string | null,
  setup_name: r.setup_name as string | null,
  instrument: String(r.instrument),
  direction: r.direction as "long" | "short",
  decision_time: new Date(r.decision_time as string).toISOString(),
  entry: Number(r.entry),
  stop: Number(r.stop),
  target: Number(r.target),
  result_r: r.result_r == null ? null : Number(r.result_r),
  spread_pips: r.spread_pips == null ? null : Number(r.spread_pips),
  status: String(r.status),
  outcome: r.outcome as string | null,
  session: r.session as string | null,
  paper_pl: r.paper_pl == null ? null : Number(r.paper_pl),
})) as TradeRow[];

console.log(`Loaded ${trades.length} paper trades`);

const closed = trades.filter((t) => t.status === "closed" && t.result_r != null);
const open = trades.filter((t) => t.status !== "closed" || t.result_r == null);
const fourFamily = closed.filter((t) => t.strategy_family === "ema" || t.strategy_family === "breakout" || t.strategy_family === "momentum");
const momentumClosed = closed.filter((t) => t.strategy_family === "momentum");

// ---- Load quotes for momentum invert counterfactuals ----
async function loadQuotes(instrument: string, fromIso: string): Promise<Quote[]> {
  // Prefer local DB
  const db = await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
       FROM market_candle_quotes
      WHERE instrument=$1 AND timeframe='M15' AND source='oanda'
        AND close_time >= $2::timestamptz - interval '2 hours'
        AND close_time <= $2::timestamptz + interval '3 days'
      ORDER BY close_time`,
    [instrument, fromIso],
  );
  if (db.rows.length >= 20) {
    return db.rows.map((x) => ({
      closeTime: new Date(x.close_time as string).toISOString(),
      bidOpen: Number(x.bid_open), bidHigh: Number(x.bid_high), bidLow: Number(x.bid_low), bidClose: Number(x.bid_close),
      askOpen: Number(x.ask_open), askHigh: Number(x.ask_high), askLow: Number(x.ask_low), askClose: Number(x.ask_close),
    }));
  }
  if (!TOKEN) return [];
  const url = `${HOST}/v3/instruments/${instrument}/candles?price=BA&granularity=M15&count=500&from=${encodeURIComponent(new Date(Date.parse(fromIso) - 2 * 3600e3).toISOString())}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) {
    console.log(`OANDA fetch failed ${instrument}: ${r.status}`);
    return [];
  }
  const j = await r.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
  return (j.candles ?? []).filter((c) => c.complete).map((c) => ({
    closeTime: new Date(Date.parse(c.time) + 15 * 60_000).toISOString(),
    bidOpen: +c.bid.o, bidHigh: +c.bid.h, bidLow: +c.bid.l, bidClose: +c.bid.c,
    askOpen: +c.ask.o, askHigh: +c.ask.h, askLow: +c.ask.l, askClose: +c.ask.c,
  }));
}

type MomPair = {
  trade: TradeRow;
  actualR: number;
  invDirection: "long" | "short";
  invEntry: number;
  invStop: number;
  invTarget: number;
  invR: number | null;
  invOutcome: string | null;
  ok: boolean;
  reason?: string;
};

const momPairs: MomPair[] = [];
const quoteCache = new Map<string, Quote[]>();

for (const t of momentumClosed) {
  const cacheKey = `${t.instrument}|${t.decision_time.slice(0, 10)}`;
  let qt = quoteCache.get(cacheKey);
  if (!qt) {
    qt = await loadQuotes(t.instrument, t.decision_time);
    quoteCache.set(cacheKey, qt);
  }
  const stopDist = Math.abs(t.entry - t.stop);
  const tgtDist = Math.abs(t.target - t.entry);
  if (!(stopDist > 0) || !(tgtDist > 0)) {
    momPairs.push({
      trade: t, actualR: t.result_r!, invDirection: t.direction === "long" ? "short" : "long",
      invEntry: NaN, invStop: NaN, invTarget: NaN, invR: null, invOutcome: null, ok: false, reason: "bad geometry",
    });
    continue;
  }

  // Entry-bar quote: closest close_time at or after decision, else nearest
  const decisionMs = Date.parse(t.decision_time);
  let qi = qt.findIndex((q) => Date.parse(q.closeTime) >= decisionMs);
  if (qi < 0) qi = qt.length - 1;
  // Prefer bar whose close equals decision if present
  const exact = qt.findIndex((q) => Date.parse(q.closeTime) === decisionMs);
  if (exact >= 0) qi = exact;
  const q = qt[qi];
  if (!q) {
    momPairs.push({
      trade: t, actualR: t.result_r!, invDirection: t.direction === "long" ? "short" : "long",
      invEntry: NaN, invStop: NaN, invTarget: NaN, invR: null, invOutcome: null, ok: false, reason: "no quotes",
    });
    continue;
  }

  const invDirection: "long" | "short" = t.direction === "long" ? "short" : "long";
  const invEntry = invDirection === "long" ? q.askClose : q.bidClose;
  const invStop = invDirection === "long" ? invEntry - stopDist : invEntry + stopDist;
  const invTarget = invDirection === "long" ? invEntry + tgtDist : invEntry - tgtDist;
  const forward = qt.slice(qi + 1, qi + 400);
  const labeled = labelOutcome(invDirection, invEntry, invStop, invTarget, t.decision_time, forward as never);
  const usable = labeled.outcome !== "unresolved" && labeled.outcome !== "ambiguous" && labeled.resultR != null;

  momPairs.push({
    trade: t,
    actualR: t.result_r!,
    invDirection,
    invEntry,
    invStop,
    invTarget,
    invR: usable ? labeled.resultR : null,
    invOutcome: labeled.outcome,
    ok: usable,
    reason: usable ? undefined : `outcome=${labeled.outcome}`,
  });
}

const momInvOk = momPairs.filter((p) => p.ok && p.invR != null);
console.log(`Momentum closed=${momentumClosed.length} invert-resolved=${momInvOk.length}`);

// ---- Build "setup" trade list: EMA/Breakout actual + Momentum inverted ----
type SetupTrade = {
  family: string;
  pair: string;
  direction: string;
  netR: number;
  source: "actual" | "momentum_inverted";
  seq: string;
};

const setupTrades: SetupTrade[] = [];
for (const t of closed.filter((x) => x.strategy_family === "ema" || x.strategy_family === "breakout")) {
  setupTrades.push({
    family: t.strategy_family!,
    pair: t.instrument,
    direction: t.direction,
    netR: t.result_r!,
    source: "actual",
    seq: t.trade_sequence,
  });
}
for (const p of momInvOk) {
  setupTrades.push({
    family: "momentum",
    pair: p.trade.instrument,
    direction: p.invDirection,
    netR: p.invR!,
    source: "momentum_inverted",
    seq: p.trade.trade_sequence,
  });
}

// Actual four-family (momentum original) for comparison
const actualFour: SetupTrade[] = fourFamily.map((t) => ({
  family: t.strategy_family!,
  pair: t.instrument,
  direction: t.direction,
  netR: t.result_r!,
  source: "actual" as const,
  seq: t.trade_sequence,
}));

const lines: string[] = [];
const L = (s = "") => lines.push(s);

L("GOLDENXPERIENCE");
L("PAPER 84 TRADES — RAW SETUP WITH MOMENTUM INVERTED");
L(`Experiment: ${EXPERIMENT}`);
L(`Generated: ${new Date().toISOString()}`);
L("");
L("================================");
L("DATA");
L("================================");
L("");
L(`Total paper trades: ${trades.length}`);
L(`Closed with result_r: ${closed.length}`);
L(`Still open / unresolved: ${open.length}`);
L(`  open seqs: ${open.map((t) => t.trade_sequence).join(", ") || "none"}`);
L("");
L("By stored family:");
for (const fam of ["ema", "breakout", "momentum", null] as const) {
  const n = trades.filter((t) => t.strategy_family === fam).length;
  const c = closed.filter((t) => t.strategy_family === fam).length;
  L(`  ${fam ?? "legacy(null)"}: ${n} total / ${c} closed`);
}
L("MeanRev paper trades: 0");
L("");
L("THIS SETUP (main results below):");
L("  EMA actual");
L("  Breakout actual");
L("  Momentum = genuine INVERT counterfactual on the same signals you took");
L("  (opposite side of book, mirrored SL/TP, own spread — not -PnL)");
L(`  Momentum invert resolved: ${momInvOk.length} / ${momentumClosed.length} closed`);
L("");

function printBlock(title: string, rows: SetupTrade[]) {
  L(title);
  L("");
  const families = ["ema", "breakout", "momentum", "ALL"] as const;
  L("Family | Trades | Wins | Losses | Win Rate | Net E | Total R | PF");
  for (const fam of families) {
    const subset = fam === "ALL" ? rows : rows.filter((r) => r.family === fam);
    const s = stats(subset);
    L(`${fam} | ${s.n} | ${s.wins} | ${s.losses} | ${fmtPct(s.winRate)} | ${fmt(s.netE)} | ${fmt(s.totalR, 2)} | ${fmt(s.pf, 2)}`);
  }
  L("");
}

printBlock("================================\nSETUP RESULTS (Momentum INVERTED)\n================================", setupTrades);

L("================================");
L("LONG vs SHORT — SETUP (executed/inverted direction)");
L("================================");
L("");
for (const fam of ["ema", "breakout", "momentum"]) {
  for (const dir of ["long", "short"]) {
    const s = stats(setupTrades.filter((r) => r.family === fam && r.direction === dir));
    L(`${fam} ${dir}: n=${s.n} W=${s.wins} L=${s.losses} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} totalR=${fmt(s.totalR, 2)}`);
  }
  L("");
}

L("================================");
L("BY PAIR — SETUP");
L("================================");
L("");
const pairs = [...new Set(setupTrades.map((r) => r.pair))].sort();
for (const pair of pairs) {
  const s = stats(setupTrades.filter((r) => r.pair === pair));
  L(`${pair}: n=${s.n} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} totalR=${fmt(s.totalR, 2)}`);
}
L("");

printBlock("================================\nACTUAL AS-TRADED (Momentum ORIGINAL — for comparison)\n================================", actualFour);

L("================================");
L("MOMENTUM TRADE-BY-TRADE: ACTUAL vs INVERT");
L("================================");
L("");
L("seq | pair | actualDir | actualR | invDir | invR | outcome");
for (const p of momPairs) {
  L(`${p.trade.trade_sequence} | ${p.trade.instrument} | ${p.trade.direction} | ${fmt(p.actualR)} | ${p.invDirection} | ${p.ok ? fmt(p.invR!) : `FAIL(${p.reason})`} | ${p.invOutcome ?? "-"}`);
}
L("");
{
  const a = stats(momPairs.filter((p) => p.ok).map((p) => ({ netR: p.actualR })));
  const i = stats(momInvOk.map((p) => ({ netR: p.invR! })));
  L(`Momentum actual (matched set n=${a.n}): WR=${fmtPct(a.winRate)} netE=${fmt(a.netE)} totalR=${fmt(a.totalR, 2)}`);
  L(`Momentum inverted (same n): WR=${fmtPct(i.winRate)} netE=${fmt(i.netE)} totalR=${fmt(i.totalR, 2)}`);
  L(`Δ net E: ${fmt(i.netE - a.netE)}   Δ total R: ${fmt(i.totalR - a.totalR, 2)}`);
}
L("");

L("================================");
L("FULL ACCOUNT — ALL 80 CLOSED (as actually traded)");
L("================================");
L("");
{
  const all = stats(closed.map((t) => ({ netR: t.result_r! })));
  L(`ALL closed: n=${all.n} W=${all.wins} L=${all.losses} WR=${fmtPct(all.winRate)} netE=${fmt(all.netE)} totalR=${fmt(all.totalR, 2)} PF=${fmt(all.pf, 2)}`);
}
for (const fam of ["ema", "breakout", "momentum", "ema_legacy", "liquidity_legacy"]) {
  const rows = closed.filter((t) => inferFamily(t) === fam);
  if (!rows.length) continue;
  const s = stats(rows.map((t) => ({ netR: t.result_r! })));
  L(`  ${fam}: n=${s.n} WR=${fmtPct(s.winRate)} netE=${fmt(s.netE)} totalR=${fmt(s.totalR, 2)}`);
}
L("");

L("================================");
L("DIRECT ANSWERS");
L("================================");
L("");
{
  const setupAll = stats(setupTrades);
  const setupMom = stats(setupTrades.filter((r) => r.family === "momentum"));
  const actualMom = stats(actualFour.filter((r) => r.family === "momentum"));
  const actualAll = stats(actualFour);
  L(`1. On your paper Momentum trades, does inversion help? ${setupMom.netE > actualMom.netE ? "YES" : "NO"} (actual ${fmt(actualMom.netE)} → invert ${fmt(setupMom.netE)})`);
  L(`2. Is inverted Momentum profitable on these trades? ${setupMom.netE > 0 ? "YES" : "NO"}`);
  L(`3. Setup (EMA+BO+Mom invert) net E: ${fmt(setupAll.netE)} (n=${setupAll.n}, WR=${fmtPct(setupAll.winRate)})`);
  L(`4. Actual four-family net E: ${fmt(actualAll.netE)} (n=${actualAll.n}, WR=${fmtPct(actualAll.winRate)})`);
  L(`5. Full 80 closed account net E: ${fmt(stats(closed.map((t) => ({ netR: t.result_r! }))).netE)}`);
  L(`6. Momentum SHORT actual was especially bad — invert flips those to LONG counterfactuals (see trade table).`);
}
L("");
L("Production unchanged. Research only.");
L(`Open trades excluded from expectancy: ${open.map((t) => `#${t.trade_sequence} ${t.strategy_family}/${t.direction} ${t.instrument}`).join("; ")}`);

const report = lines.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "FINAL_REPORT.txt"), report);
fs.writeFileSync(path.join(OUT_DIR, "momentum_pairs.json"), JSON.stringify(momPairs.map((p) => ({
  seq: p.trade.trade_sequence,
  pair: p.trade.instrument,
  actualDir: p.trade.direction,
  actualR: p.actualR,
  invDir: p.invDirection,
  invR: p.invR,
  invOutcome: p.invOutcome,
  ok: p.ok,
  reason: p.reason,
})), null, 2));

console.log(report);
console.log("\nWrote", path.join(OUT_DIR, "FINAL_REPORT.txt"));
process.exit(0);
