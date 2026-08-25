/**
 * Actual-trade inversion for EVERY paper batch (1..N). RESEARCH ONLY.
 *
 * Same rules as _actual_inversion.ts / _invert_batches_1_6.ts:
 * flip direction, fill the other side of the bid/ask book at the original
 * entry bar, mirror stop/target distances, pay a fresh spread, resolve with
 * the production `labelOutcome` (16:45 ET forced close, 48h horizon,
 * conservative same-candle ambiguity). Nothing in the DB is mutated.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const OUT = process.env.OUT ?? path.join(serviceRoot, "..", "actual-inversion-all-batches.json");

type Row = {
  id: string; trade_sequence: string; batch_number: number; strategy_family: string | null; config_version: string | null;
  instrument: string; direction: "long" | "short"; decision_time: string; entry: string; stop: string;
  target: string; exit: string | null; result_r: string | null; paper_pl: string | null;
  nominal_risk_amount: string; outcome: string; status: string; closed_at: string | null; spread_pips: string | null;
};

const trades = await query<Row>(
  `SELECT t.id, t.trade_sequence::text, b.batch_number, t.strategy_family, t.config_version,
          t.instrument, t.direction, t.decision_time, t.entry::text, t.stop::text, t.target::text,
          t.exit::text, t.result_r::text, t.paper_pl::text, t.nominal_risk_amount::text,
          t.outcome, t.status, t.closed_at, t.spread_pips::text
     FROM paper_strategy_trades t
     JOIN paper_strategy_batches b ON b.id = t.batch_id
    ORDER BY b.batch_number, t.decision_time, t.trade_sequence`);
console.log(`all-batch trades found: ${trades.rows.length}`);

const resolved = trades.rows.filter((t) => t.status === "closed" && t.result_r !== null);
const excludedOpen = trades.rows.length - resolved.length;
console.log(`closed+resolved: ${resolved.length}   still open/unresolved (excluded): ${excludedOpen}`);

type Q = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

async function fetchAllBars(inst: string, fromIso: string, toIso: string): Promise<Q[]> {
  const out: Q[] = [];
  let cursor = fromIso;
  const toMs = Date.parse(toIso);
  for (let page = 0; page < 20; page++) {
    const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=M15&count=5000&from=${encodeURIComponent(cursor)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) { console.log(`${inst}: FETCH FAILED page=${page} ${r.status}`); break; }
    const j = await r.json() as { candles?: Array<Record<string, never>> };
    const batch = (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
      const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
      return {
        closeTime: new Date(Date.parse(x.time) + 15 * 60_000).toISOString(),
        bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
        askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
      };
    });
    if (batch.length === 0) break;
    out.push(...batch);
    const lastCloseMs = Date.parse(batch[batch.length - 1]!.closeTime);
    if (lastCloseMs >= toMs || batch.length < 5000) break;
    cursor = new Date(lastCloseMs + 60_000).toISOString();
  }
  return out;
}

const instruments = [...new Set(resolved.map((t) => t.instrument))];
const earliestMs = Math.min(...resolved.map((t) => Date.parse(t.decision_time))) - 2 * 3600e3;
const latestMs = Math.max(...resolved.map((t) => Date.parse(t.decision_time))) + 72 * 3600e3;
const earliest = new Date(earliestMs).toISOString();
const latest = new Date(latestMs).toISOString();
console.log(`fetching M15 bid/ask from ${earliest} to ${latest} for ${instruments.length} pairs`);

const series: Record<string, Q[]> = {};
for (const inst of instruments) {
  series[inst] = await fetchAllBars(inst, earliest, latest);
  console.log(`${inst}: ${series[inst]!.length} M15 bid/ask bars`);
}

const out: Record<string, unknown>[] = [];
let missingQuotes = 0; let ambiguous = 0;

for (const t of resolved) {
  const s = series[t.instrument] ?? [];
  const at = Date.parse(t.decision_time);
  const entryBar = s.find((q) => Math.abs(Date.parse(q.closeTime) - at) < 60_000)
                ?? s.filter((q) => Date.parse(q.closeTime) <= at).at(-1);
  const forward = s.filter((q) => Date.parse(q.closeTime) > at);
  if (!entryBar || forward.length < 4) { missingQuotes += 1; continue; }

  const entry = Number(t.entry); const stop = Number(t.stop); const target = Number(t.target);
  const stopDist = Math.abs(entry - stop);
  const tgtDist = Math.abs(target - entry);
  const inv = t.direction === "long" ? "short" as const : "long" as const;
  const invEntry = inv === "long" ? entryBar.askClose : entryBar.bidClose;
  const invStop = inv === "long" ? invEntry - stopDist : invEntry + stopDist;
  const invTarget = inv === "long" ? invEntry + tgtDist : invEntry - tgtDist;

  const res = labelOutcome(inv, invEntry, invStop, invTarget, new Date(at).toISOString(), forward as never);
  const isAmb = res.outcome === "ambiguous" || res.resultR === null;
  if (isAmb) ambiguous += 1;

  const risk = Number(t.nominal_risk_amount);
  out.push({
    id: t.id, seq: Number(t.trade_sequence), batch: t.batch_number, family: t.strategy_family, cfg: t.config_version,
    pair: t.instrument, ts: t.decision_time,
    origDir: t.direction, origOutcome: t.outcome, origR: Number(t.result_r),
    origPl: t.paper_pl === null ? null : Number(t.paper_pl),
    riskAmount: Number.isFinite(risk) ? risk : null,
    invDir: inv, invOutcome: res.outcome, invR: isAmb ? null : res.resultR,
    invPl: isAmb || !Number.isFinite(risk) ? null : risk * (res.resultR as number),
    ambiguous: isAmb,
  });
}

writeFileSync(OUT, JSON.stringify({
  scope: { engine: "all paper batches (1..N)", found: trades.rows.length,
           resolved: resolved.length, excludedOpen, missingQuotes, ambiguous },
  trades: out,
}, null, 1));

type Agg = { n: number; wins: number; losses: number; totalR: number; totalPl: number; grossWinR: number; grossLossR: number };
const empty = (): Agg => ({ n: 0, wins: 0, losses: 0, totalR: 0, totalPl: 0, grossWinR: 0, grossLossR: 0 });
function push(a: Agg, r: number, pl: number | null) {
  a.n += 1; a.totalR += r; if (pl !== null && Number.isFinite(pl)) a.totalPl += pl;
  if (r > 0) { a.wins += 1; a.grossWinR += r; } else if (r < 0) { a.losses += 1; a.grossLossR += r; }
}
function fmt(a: Agg): string {
  const wr = a.n ? (100 * a.wins / a.n) : 0;
  const exp = a.n ? (a.totalR / a.n) : 0;
  const pf = a.grossLossR < 0 ? a.grossWinR / Math.abs(a.grossLossR) : Infinity;
  return `n=${a.n} W/L=${a.wins}/${a.losses} winrate=${wr.toFixed(1)}% exp=${exp.toFixed(3)}R totalR=${a.totalR >= 0 ? "+" : ""}${a.totalR.toFixed(2)} totalPl=$${a.totalPl.toFixed(2)} PF=${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`;
}

const origAll = empty(); const invAll = empty();
const origByBatch = new Map<number, Agg>(); const invByBatch = new Map<number, Agg>();
const origByFamily = new Map<string, Agg>(); const invByFamily = new Map<string, Agg>();
let ambCount = 0;

for (const r of out) {
  const origR = r.origR as number; const origPl = r.origPl as number | null;
  push(origAll, origR, origPl);
  const b = r.batch as number; const fam = (r.family as string | null) ?? "(legacy-null)";
  const ob = origByBatch.get(b) ?? empty(); push(ob, origR, origPl); origByBatch.set(b, ob);
  const of = origByFamily.get(fam) ?? empty(); push(of, origR, origPl); origByFamily.set(fam, of);

  if (r.ambiguous) { ambCount += 1; continue; }
  const invR = r.invR as number; const invPl = r.invPl as number | null;
  push(invAll, invR, invPl);
  const ib = invByBatch.get(b) ?? empty(); push(ib, invR, invPl); invByBatch.set(b, ib);
  const ifm = invByFamily.get(fam) ?? empty(); push(ifm, invR, invPl); invByFamily.set(fam, ifm);
}

console.log(`\nresolvable counterfactuals: ${out.length - ambCount}   ambiguous: ${ambCount}   missing quotes: ${missingQuotes}`);
console.log(`wrote ${path.resolve(OUT)}`);
console.log(`\n=== OVERALL (all batches, matched sample where inv is resolvable) ===`);
console.log(`  ORIGINAL: ${fmt(origAll)}`);
console.log(`  INVERTED: ${fmt(invAll)}`);
console.log(`  DIFF:     totalR ${(invAll.totalR - origAll.totalR).toFixed(2)}   totalPl $${(invAll.totalPl - origAll.totalPl).toFixed(2)}   wins ${invAll.wins - origAll.wins >= 0 ? "+" : ""}${invAll.wins - origAll.wins}`);

console.log(`\n=== BY BATCH ===`);
for (const b of [...origByBatch.keys()].sort((a, z) => a - z)) {
  console.log(`  #${b} ORIG: ${fmt(origByBatch.get(b)!)}`);
  console.log(`     INV:  ${fmt(invByBatch.get(b)!)}`);
}

console.log(`\n=== BY STRATEGY FAMILY ===`);
for (const [f, ag] of origByFamily) {
  console.log(`  ${f}  ORIG: ${fmt(ag)}`);
  console.log(`  ${f}  INV:  ${fmt(invByFamily.get(f) ?? empty())}`);
}

process.exit(0);
