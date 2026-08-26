/**
 * Overlay the legacy-confidence-v2 daemon's setup detector on top of the 111
 * live four-family paper trades. For each trade the detector is run against the
 * candles available at that trade's decision time and classified as:
 *   - CONFLUENCE_AGREE  : daemon fired same direction as four-family took
 *   - CONFLUENCE_DISAGREE: daemon fired opposite direction
 *   - NO_SETUP          : daemon rejected (which gate failed)
 *
 * Then compute several policy P&L variants:
 *   Baseline              : take every four-family trade as-is (what happened)
 *   FILTER_AGREE_ONLY     : keep only trades where daemon fired same direction
 *   FILTER_ANY_SETUP      : keep trades where daemon fired any direction
 *                           (invert when disagree, keep when agree)
 *   DAEMON_DIRECTED       : for every four-family trade, take the direction
 *                           the daemon picked (using its v2 model or baseline)
 *                           and only if it fired
 *
 * All numbers use the four-family trades' own recorded result_r (from when
 * they actually ran). When a policy would have taken the OPPOSITE direction,
 * result_r is negated as an approximation (fine for signed comparison; slightly
 * generous vs a real inversion that pays fresh spread).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { evaluateLegacySetup } = await import("../src/legacy-setup-detector.js");
type LegacyCandle = Parameters<typeof evaluateLegacySetup>[1][number];

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";
const TOKEN = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const HOST = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const GRAN_MIN: Record<string, number> = { M15: 15, H1: 60, H4: 240 };

async function fetchCandles(inst: string, gran: string, count: number, fromIso?: string): Promise<LegacyCandle[]> {
  const from = fromIso ? `&from=${encodeURIComponent(fromIso)}` : "";
  const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=${gran}&count=${count}${from}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) return [];
  const j = await r.json() as { candles?: Array<Record<string, never>> };
  const step = GRAN_MIN[gran]! * 60_000;
  return (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
    const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    const mid = (b: number, a: number) => (b + a) / 2;
    return {
      closeTime: new Date(Date.parse(x.time) + step).toISOString(),
      open: mid(+x.bid.o, +x.ask.o), high: mid(+x.bid.h, +x.ask.h), low: mid(+x.bid.l, +x.ask.l), close: mid(+x.bid.c, +x.ask.c),
      bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
      askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
    };
  });
}

// --- load four-family trades ---
const trades = await query<{ id: string; batch: number; family: string | null; pair: string; direction: "long" | "short"; decision_time: string; result_r: string | null; outcome: string; paper_pl: string | null; strategy_family: string | null }>(
  `SELECT t.id, b.batch_number AS batch, t.strategy_family AS family, t.instrument AS pair, t.direction, t.decision_time,
          t.result_r::text, t.outcome, t.paper_pl::text, t.strategy_family
     FROM paper_strategy_trades t JOIN paper_strategy_batches b ON b.id = t.batch_id
    WHERE t.status = 'closed' AND t.result_r IS NOT NULL
      AND t.strategy_family IS NOT NULL
    ORDER BY t.decision_time`);
const rows = trades.rows;
console.log(`loaded ${rows.length} closed four-family trades`);

// fetch the FULL relevant candle window per pair, once — earliest trade minus 210*15min for warmup
const pairs = [...new Set(rows.map((r) => r.pair))];
// need 15 days of pre-history so even the earliest trade has enough bars for
// the detector's 210-M15, 60-H1, 60-H4 requirements.
const earliestMs = Math.min(...rows.map((r) => Date.parse(r.decision_time))) - 15 * 86400e3;
const latestMs = Math.max(...rows.map((r) => Date.parse(r.decision_time))) + 15 * 60_000;
console.log(`fetching M15/H1/H4 for ${pairs.length} pairs, ${new Date(earliestMs).toISOString()} → ${new Date(latestMs).toISOString()}`);

const M15: Record<string, LegacyCandle[]> = {};
const H1: Record<string, LegacyCandle[]> = {};
const H4: Record<string, LegacyCandle[]> = {};
for (const p of pairs) {
  M15[p] = await fetchCandles(p, "M15", 5000, new Date(earliestMs).toISOString());
  H1[p]  = await fetchCandles(p, "H1", 1500, new Date(earliestMs).toISOString());
  H4[p]  = await fetchCandles(p, "H4", 500, new Date(earliestMs).toISOString());
  console.log(`  ${p}: M15=${M15[p]!.length} H1=${H1[p]!.length} H4=${H4[p]!.length}`);
}

// --- classify each trade against daemon setup ---
type Klass = { klass: "CONFLUENCE_AGREE" | "CONFLUENCE_DISAGREE" | "NO_SETUP"; reason: string | null; daemonDir: "long" | "short" | null };

function classify(pair: string, decisionTime: string, ffDir: "long" | "short"): Klass {
  const decMs = Date.parse(decisionTime);
  // slice each granularity to bars whose close is at-or-before decision time
  const m15 = M15[pair]!.filter((b) => Date.parse(b.closeTime) <= decMs);
  const h1  = H1[pair]!.filter((b) => Date.parse(b.closeTime) <= decMs);
  const h4  = H4[pair]!.filter((b) => Date.parse(b.closeTime) <= decMs);
  if (m15.length < 210 || h1.length < 60 || h4.length < 60) return { klass: "NO_SETUP", reason: `insufficient candles (M15=${m15.length}, H1=${h1.length}, H4=${h4.length})`, daemonDir: null };
  const res = evaluateLegacySetup(pair, m15, h1, h4);
  if (!res.passed) return { klass: "NO_SETUP", reason: res.reason, daemonDir: null };
  return { klass: res.direction === ffDir ? "CONFLUENCE_AGREE" : "CONFLUENCE_DISAGREE", reason: null, daemonDir: res.direction };
}

const enriched = rows.map((r) => ({ ...r, k: classify(r.pair, r.decision_time, r.direction) }));

// --- aggregate & report ---
type Agg = { n: number; w: number; l: number; totalR: number; wR: number; lR: number };
const empty = (): Agg => ({ n: 0, w: 0, l: 0, totalR: 0, wR: 0, lR: 0 });
const push = (a: Agg, r: number) => { a.n++; a.totalR += r; if (r > 0) { a.w++; a.wR += r; } else if (r < 0) { a.l++; a.lR += r; } };
const fmt = (a: Agg) => {
  const wr = a.n ? 100 * a.w / a.n : 0;
  const exp = a.n ? a.totalR / a.n : 0;
  const pf = a.lR < 0 ? a.wR / Math.abs(a.lR) : Infinity;
  return `n=${String(a.n).padStart(3)}  W/L=${a.w}/${a.l}  wr=${wr.toFixed(1)}%  exp=${(exp >= 0 ? "+" : "") + exp.toFixed(4)}R  totalR=${(a.totalR >= 0 ? "+" : "") + a.totalR.toFixed(2).padStart(6)}  PF=${Number.isFinite(pf) ? pf.toFixed(2) : "∞"}`;
};

console.log(`\n=== CLASSIFICATION of ${enriched.length} four-family trades against daemon detector ===`);
const classCount: Record<string, number> = { CONFLUENCE_AGREE: 0, CONFLUENCE_DISAGREE: 0, NO_SETUP: 0 };
const noSetupReasons: Record<string, number> = {};
for (const e of enriched) {
  classCount[e.k.klass] = (classCount[e.k.klass] ?? 0) + 1;
  if (e.k.klass === "NO_SETUP" && e.k.reason) noSetupReasons[e.k.reason] = (noSetupReasons[e.k.reason] ?? 0) + 1;
}
for (const k of Object.keys(classCount)) console.log(`  ${k.padEnd(22)} ${String(classCount[k]).padStart(3)}  (${(100 * classCount[k]! / enriched.length).toFixed(1)}%)`);
console.log(`\n  NO_SETUP reasons:`);
for (const [r, n] of Object.entries(noSetupReasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}  ${r}`);

// --- policies ---
const baseline = empty();
const agreeOnly = empty();
const anySetup = empty();
const daemonDirected = empty();
for (const e of enriched) {
  const r = Number(e.result_r);
  if (!Number.isFinite(r)) continue;
  push(baseline, r);
  if (e.k.klass === "CONFLUENCE_AGREE") {
    push(agreeOnly, r);
    push(anySetup, r);
    push(daemonDirected, r);
  } else if (e.k.klass === "CONFLUENCE_DISAGREE") {
    push(anySetup, -r);       // invert the trade
    push(daemonDirected, -r); // daemon says other side, take that
  }
  // NO_SETUP: skip (daemonDirected requires a daemon fire too)
}

console.log(`\n=== POLICY P&L on the SAME 109-111 four-family trades ===`);
console.log(`  Baseline (take every four-family trade)                    : ${fmt(baseline)}`);
console.log(`  FILTER_AGREE_ONLY (keep only where daemon agreed)          : ${fmt(agreeOnly)}`);
console.log(`  FILTER_ANY_SETUP (keep when daemon fired; invert disagree) : ${fmt(anySetup)}`);
console.log(`  DAEMON_DIRECTED  (only trade when daemon fires; use its dir): ${fmt(daemonDirected)}`);

// per-family breakdown of the AGREE_ONLY policy
console.log(`\n=== FILTER_AGREE_ONLY by family (sniper subset) ===`);
const byFam: Record<string, Agg> = {};
for (const e of enriched) {
  if (e.k.klass !== "CONFLUENCE_AGREE") continue;
  const fam = e.family ?? "(null)";
  if (!byFam[fam]) byFam[fam] = empty();
  push(byFam[fam]!, Number(e.result_r));
}
for (const [f, a] of Object.entries(byFam)) console.log(`  ${f.padEnd(14)} ${fmt(a)}`);

// per-family breakdown of DAEMON_DIRECTED
console.log(`\n=== DAEMON_DIRECTED by family (kept + inverted, only when daemon fires) ===`);
const byFamD: Record<string, Agg> = {};
for (const e of enriched) {
  if (e.k.klass === "NO_SETUP") continue;
  const fam = e.family ?? "(null)";
  if (!byFamD[fam]) byFamD[fam] = empty();
  push(byFamD[fam]!, e.k.klass === "CONFLUENCE_AGREE" ? Number(e.result_r) : -Number(e.result_r));
}
for (const [f, a] of Object.entries(byFamD)) console.log(`  ${f.padEnd(14)} ${fmt(a)}`);

// per-pair confluence
console.log(`\n=== CONFLUENCE_AGREE + CONFLUENCE_DISAGREE by pair ===`);
const byPair: Record<string, { agree: number; disagree: number; noSetup: number }> = {};
for (const e of enriched) {
  if (!byPair[e.pair]) byPair[e.pair] = { agree: 0, disagree: 0, noSetup: 0 };
  const bp = byPair[e.pair]!;
  if (e.k.klass === "CONFLUENCE_AGREE") bp.agree++;
  else if (e.k.klass === "CONFLUENCE_DISAGREE") bp.disagree++;
  else bp.noSetup++;
}
for (const [p, s] of Object.entries(byPair)) {
  const total = s.agree + s.disagree + s.noSetup;
  console.log(`  ${p.padEnd(8)} n=${String(total).padStart(2)}  agree=${s.agree}  disagree=${s.disagree}  no_setup=${s.noSetup}  (${((100 * (s.agree + s.disagree)) / total).toFixed(0)}% daemon-fired)`);
}

process.exit(0);
