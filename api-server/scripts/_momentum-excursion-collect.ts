/**
 * Momentum actual-trade excursion audit — collection. RESEARCH ONLY.
 *
 * Reconstructs the full price path of every REAL Momentum trade from entry to
 * exit, and for a fixed window after the exit. No strategy is re-run and no
 * hypothetical opportunity is generated: the trades are taken as recorded.
 *
 * EXECUTABLE SIDES (this is where excursion audits usually go wrong):
 *   A LONG is closed by SELLING, so both its TP and SL trigger on the BID.
 *     MFE = max(bidHigh) - entry        MAE = entry - min(bidLow)
 *   A SHORT is closed by BUYING, so both trigger on the ASK.
 *     MFE = entry - min(askLow)         MAE = max(askHigh) - entry
 * Mid prices are never used where bid/ask exist.
 *
 * PIPS: 0.01 for JPY quote pairs, 0.0001 otherwise.
 *
 * TIMESTAMPS: OANDA stamps a candle with its START; market_candles is stamped
 * with the CLOSE. +15m is applied so a bar attributed to a decision is one that
 * had actually closed. This bug was found earlier in this programme.
 *
 * AMBIGUITY: a bar that touches BOTH the target and the stop is flagged, never
 * silently resolved in the favourable direction.
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

const envv = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = envv("OANDA_API_KEY") || envv("OANDA_API_TOKEN");
const HOST = envv("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const OUT = process.env.OUT ?? path.join(serviceRoot, "..", "momentum-excursion.json");
const POST_BARS = [1, 3, 6, 12, 24];

type T = {
  id: string; trade_sequence: string; batch_number: number; strategy_version: string; config_version: string;
  instrument: string; direction: "long" | "short"; decision_time: string; opened_at: string; closed_at: string | null;
  entry: string; stop: string; target: string; exit: string | null; outcome: string; result_r: string | null;
  paper_pl: string | null; spread_pips: string | null; atr_pips: string | null; status: string;
};

const rows = await query<T>(
  `SELECT t.id, t.trade_sequence::text, b.batch_number, sv.version AS strategy_version, t.config_version,
          t.instrument, t.direction, t.decision_time, t.opened_at, t.closed_at,
          t.entry::text, t.stop::text, t.target::text, t.exit::text, t.outcome,
          t.result_r::text, t.paper_pl::text, t.spread_pips::text, t.atr_pips::text, t.status
     FROM paper_strategy_trades t
     JOIN paper_strategy_batches b ON b.id = t.batch_id
     JOIN strategy_versions sv ON sv.id = t.strategy_version_id
    WHERE t.strategy_family = 'momentum' AND t.experiment_id IS NOT NULL
    ORDER BY t.decision_time`);
console.log(`momentum trades in the current engine: ${rows.rows.length}`);
const resolved = rows.rows.filter((t) => t.status === "closed" && t.result_r !== null);
console.log(`closed + resolved: ${resolved.length}   excluded (open): ${rows.rows.length - resolved.length}`);
console.log(`versions: ${[...new Set(resolved.map((t) => t.strategy_version + "/" + t.config_version))].join(", ")}`);
console.log(`batches: ${[...new Set(resolved.map((t) => t.batch_number))].join(", ")}`);

type Bar = { t: number; bh: number; bl: number; bc: number; ah: number; al: number; ac: number };
const bars: Record<string, Bar[]> = {};
const instruments = [...new Set(resolved.map((t) => t.instrument))];
const from = new Date(Math.min(...resolved.map((t) => Date.parse(t.decision_time))) - 2 * 3600e3).toISOString();
for (const inst of instruments) {
  const r = await fetch(`${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=M15&count=1500&from=${encodeURIComponent(from)}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) { console.log(`${inst}: FETCH FAILED ${r.status}`); bars[inst] = []; continue; }
  const j = await r.json() as { candles?: unknown[] };
  bars[inst] = (j.candles ?? []).filter((c) => (c as { complete: boolean }).complete).map((c) => {
    const x = c as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    return { t: Date.parse(x.time) + 15 * 60_000,      // START -> CLOSE stamp
      bh: +x.bid.h, bl: +x.bid.l, bc: +x.bid.c, ah: +x.ask.h, al: +x.ask.l, ac: +x.ask.c };
  });
  console.log(`${inst}: ${bars[inst]!.length} M15 bid/ask bars`);
}

const pipOf = (inst: string) => inst.endsWith("JPY") ? 0.01 : 0.0001;
const out: Record<string, unknown>[] = [];
let flagged = 0;

for (const t of resolved) {
  const series = bars[t.instrument] ?? [];
  const pip = pipOf(t.instrument);
  const entry = Number(t.entry); const stop = Number(t.stop); const target = Number(t.target);
  const dir = t.direction;
  const at = Date.parse(t.decision_time);
  const exitMs = t.closed_at ? Date.parse(t.closed_at) : Number.POSITIVE_INFINITY;

  // path bars: strictly AFTER the decision bar closed, up to and including exit
  const inTrade = series.filter((b) => b.t > at && b.t <= exitMs + 1);
  const afterExit = series.filter((b) => b.t > exitMs);
  if (inTrade.length === 0) { flagged += 1; out.push({ id: t.id, seq: Number(t.trade_sequence), flag: "no path bars" }); continue; }

  const stopPips = Math.abs(entry - stop) / pip;
  const targetPips = Math.abs(target - entry) / pip;
  const risk = Math.abs(entry - stop);

  // Executable excursions. A long is marked out on the bid; a short on the ask.
  let mfe = -Infinity; let mae = -Infinity; let iMfe = 0; let iMae = 0;
  let ambiguous = false;
  inTrade.forEach((b, i) => {
    const fav = dir === "long" ? b.bh - entry : entry - b.al;
    const adv = dir === "long" ? entry - b.bl : b.ah - entry;
    if (fav > mfe) { mfe = fav; iMfe = i + 1; }
    if (adv > mae) { mae = adv; iMae = i + 1; }
    const hitT = dir === "long" ? b.bh >= target : b.al <= target;
    const hitS = dir === "long" ? b.bl <= stop : b.ah >= stop;
    if (hitT && hitS) ambiguous = true;
  });
  if (ambiguous) flagged += 1;

  const mfePips = mfe / pip; const maePips = mae / pip;
  const tpCompletion = targetPips > 0 ? mfePips / targetPips : 0;
  const slConsumed = stopPips > 0 ? maePips / stopPips : 0;

  // post-stop continuation, measured FROM THE EXIT PRICE (not from entry) so a
  // trade already 1R offside does not automatically read as "kept going"
  const exitPx = t.exit !== null ? Number(t.exit) : (dir === "long" ? inTrade.at(-1)!.bc : inTrade.at(-1)!.ac);
  const post: Record<string, number> = {};
  for (const n of POST_BARS) {
    const win = afterExit.slice(0, n);
    if (!win.length) continue;
    const fav = dir === "long" ? Math.max(...win.map((b) => b.bh)) - exitPx : exitPx - Math.min(...win.map((b) => b.al));
    const adv = dir === "long" ? exitPx - Math.min(...win.map((b) => b.bl)) : Math.max(...win.map((b) => b.ah)) - exitPx;
    post[`favPips${n}`] = fav / pip; post[`advPips${n}`] = adv / pip;
  }

  // first-touch race: did +0.25R/+0.50R arrive before -0.25R/-0.50R?
  const race: Record<string, string> = {};
  for (const lvl of [0.25, 0.5]) {
    let res = "neither";
    for (const b of inTrade) {
      const fav = dir === "long" ? b.bh - entry : entry - b.al;
      const adv = dir === "long" ? entry - b.bl : b.ah - entry;
      const f = fav >= lvl * risk; const a = adv >= lvl * risk;
      if (f && a) { res = "same-bar"; break; }
      if (f) { res = "favorable"; break; }
      if (a) { res = "adverse"; break; }
    }
    race[`race${lvl}`] = res;
  }

  // ---- inverted counterfactual on the SAME bar, mirrored geometry ----------
  const entryBar = series.find((b) => Math.abs(b.t - at) < 60_000) ?? series.filter((b) => b.t <= at).at(-1);
  let inv: Record<string, unknown> = { invResolvable: false };
  if (entryBar) {
    const invDir = dir === "long" ? "short" as const : "long" as const;
    const invEntry = invDir === "long" ? entryBar.ac : entryBar.bc;
    const invStop = invDir === "long" ? invEntry - Math.abs(entry - stop) : invEntry + Math.abs(entry - stop);
    const invTarget = invDir === "long" ? invEntry + Math.abs(target - entry) : invEntry - Math.abs(target - entry);
    const fwdQ = series.filter((b) => b.t > at).map((b) => ({
      closeTime: new Date(b.t).toISOString(),
      bidOpen: b.bc, bidHigh: b.bh, bidLow: b.bl, bidClose: b.bc,
      askOpen: b.ac, askHigh: b.ah, askLow: b.al, askClose: b.ac,
    }));
    const res = labelOutcome(invDir, invEntry, invStop, invTarget, new Date(at).toISOString(), fwdQ as never);
    const invExitMs = res.resolvedAt ? Date.parse(res.resolvedAt) : exitMs;
    const invPath = series.filter((b) => b.t > at && b.t <= invExitMs + 1);
    let iF = -Infinity; let iA = -Infinity;
    for (const b of invPath) {
      const fav = invDir === "long" ? b.bh - invEntry : invEntry - b.al;
      const adv = invDir === "long" ? invEntry - b.bl : b.ah - invEntry;
      if (fav > iF) iF = fav; if (adv > iA) iA = adv;
    }
    inv = {
      invResolvable: res.outcome !== "unresolved" && res.resultR !== null,
      invDir, invEntry, invOutcome: res.outcome, invR: res.resultR,
      invMfePips: invPath.length ? iF / pip : null, invMaePips: invPath.length ? iA / pip : null,
      invTpCompletion: invPath.length && targetPips > 0 ? (iF / pip) / targetPips : null,
      invAmbiguous: res.outcome === "ambiguous",
    };
  }

  out.push({
    id: t.id, seq: Number(t.trade_sequence), batch: t.batch_number, date: t.decision_time,
    pair: t.instrument, direction: dir, outcome: t.outcome, actualR: Number(t.result_r),
    pl: t.paper_pl === null ? null : Number(t.paper_pl),
    entry, stop, target, exit: t.exit === null ? null : Number(t.exit),
    spreadPips: t.spread_pips === null ? null : Number(t.spread_pips),
    atrPips: t.atr_pips === null ? null : Number(t.atr_pips),
    stopPips, targetPips, rr: stopPips > 0 ? targetPips / stopPips : null,
    mfePips, maePips, mfeR: mfe / risk, maeR: mae / risk,
    tpCompletion, slConsumed,
    pipsMissingFromTp: Math.max(0, targetPips - mfePips),
    pipsRemainingToSl: Math.max(0, stopPips - maePips),
    barsToMfe: iMfe, barsToMae: iMae,
    minutesToMfe: iMfe * 15, minutesToMae: iMae * 15,
    barsInTrade: inTrade.length, ambiguous, flag: ambiguous ? "same-bar TP+SL touch" : null,
    ...race, ...post, ...inv,
  });
}

writeFileSync(OUT, JSON.stringify({
  scope: { found: rows.rows.length, resolved: resolved.length, excludedOpen: rows.rows.length - resolved.length,
           flagged, versions: [...new Set(resolved.map((t) => t.strategy_version + "/" + t.config_version))],
           batches: [...new Set(resolved.map((t) => t.batch_number))] },
  trades: out,
}, null, 1));
console.log(`\nflagged (ambiguous or unresolvable path): ${flagged}`);
console.log(`wrote ${path.resolve(OUT)}`);
process.exit(0);
