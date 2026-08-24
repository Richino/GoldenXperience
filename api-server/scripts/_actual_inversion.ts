/**
 * Actual-trade inversion audit. RESEARCH ONLY. No production behaviour changes.
 *
 * Uses ONLY trades GoldenXperience actually opened and recorded. No candle
 * replay, no regenerated signals, no hypothetical opportunities. Historical
 * prices are used for exactly one purpose: resolving what the opposite
 * direction would have done AFTER each real entry.
 *
 * Exit geometry is not re-implemented. The counterfactual is resolved by
 * `labelOutcome` — the same resolver the live pipeline uses — so the inverted
 * trade inherits the identical 16:45 ET forced close, 48h horizon, and
 * conservative same-candle ambiguity handling. A trade whose stop and target
 * are both touched inside one candle is marked AMBIGUOUS, never resolved in the
 * favourable direction.
 *
 * The inverted fill is taken from the other side of the book at the real entry
 * bar and the stop/target distances are mirrored around it. P&L is never
 * negated: both directions pay the spread independently.
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
const OUT = process.env.OUT ?? path.join(serviceRoot, "..", "actual-inversion.json");

type Row = {
  id: string; trade_sequence: string; batch_number: number; strategy_family: string; config_version: string;
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
    WHERE t.experiment_id IS NOT NULL          -- current four-family engine only
      AND t.strategy_family IS NOT NULL
    ORDER BY t.decision_time, t.trade_sequence`);
console.log(`current-engine trades found: ${trades.rows.length}`);

const resolved = trades.rows.filter((t) => t.status === "closed" && t.result_r !== null);
const excludedOpen = trades.rows.length - resolved.length;
console.log(`closed+resolved: ${resolved.length}   still open (excluded): ${excludedOpen}`);

// ---- price history around the real entries, fetched once per instrument -----
const instruments = [...new Set(resolved.map((t) => t.instrument))];
const earliest = new Date(Math.min(...resolved.map((t) => Date.parse(t.decision_time))) - 2 * 3600e3).toISOString();
type Q = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
const series: Record<string, Q[]> = {};
for (const inst of instruments) {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=M15&count=1500&from=${encodeURIComponent(earliest)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`${inst}: FETCH FAILED ${r.status}`); series[inst] = []; continue; }
  const j = await r.json() as { candles?: Array<Record<string, never>> };
  series[inst] = (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
    const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    return {
      // OANDA stamps the candle START; the rest of this codebase uses the CLOSE.
      closeTime: new Date(Date.parse(x.time) + 15 * 60_000).toISOString(),
      bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
      askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
    };
  });
  console.log(`${inst}: ${series[inst]!.length} M15 bid/ask bars`);
}

const out: Record<string, unknown>[] = [];
let missingQuotes = 0; let ambiguous = 0;

for (const t of resolved) {
  const s = series[t.instrument] ?? [];
  const at = Date.parse(t.decision_time);
  // the entry bar: the quote whose close_time matches the decision bar
  const entryBar = s.find((q) => Math.abs(Date.parse(q.closeTime) - at) < 60_000)
                ?? s.filter((q) => Date.parse(q.closeTime) <= at).at(-1);
  const forward = s.filter((q) => Date.parse(q.closeTime) > at);
  if (!entryBar || forward.length < 4) { missingQuotes += 1; continue; }

  const entry = Number(t.entry); const stop = Number(t.stop); const target = Number(t.target);
  const stopDist = Math.abs(entry - stop);
  const tgtDist = Math.abs(target - entry);
  const inv = t.direction === "long" ? "short" as const : "long" as const;
  // fill the OTHER side of the book at the same bar, mirror the same distances
  const invEntry = inv === "long" ? entryBar.askClose : entryBar.bidClose;
  const invStop = inv === "long" ? invEntry - stopDist : invEntry + stopDist;
  const invTarget = inv === "long" ? invEntry + tgtDist : invEntry - tgtDist;

  const res = labelOutcome(inv, invEntry, invStop, invTarget, new Date(at).toISOString(), forward as never);
  const isAmb = res.outcome === "ambiguous" || res.resultR === null;
  if (isAmb) ambiguous += 1;

  const risk = Number(t.nominal_risk_amount);
  out.push({
    id: t.id, seq: Number(t.trade_sequence), batch: t.batch_number, family: t.strategy_family,
    cfg: t.config_version, pair: t.instrument, ts: t.decision_time,
    origDir: t.direction, origOutcome: t.outcome, origR: Number(t.result_r),
    origPl: t.paper_pl === null ? null : Number(t.paper_pl), riskAmount: Number.isFinite(risk) ? risk : null,
    invDir: inv, invOutcome: res.outcome, invR: isAmb ? null : res.resultR,
    invPl: isAmb || !Number.isFinite(risk) ? null : risk * (res.resultR as number),
    ambiguous: isAmb,
  });
}

writeFileSync(OUT, JSON.stringify({
  scope: { engine: "multi-strategy-1 (four-family)", found: trades.rows.length,
           resolved: resolved.length, excludedOpen, missingQuotes, ambiguous },
  trades: out,
}, null, 1));
console.log(`\nresolvable counterfactuals: ${out.length - ambiguous}   ambiguous: ${ambiguous}   missing quotes: ${missingQuotes}`);
console.log(`wrote ${path.resolve(OUT)}`);
process.exit(0);
