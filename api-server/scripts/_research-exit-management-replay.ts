/**
 * Read-only exit-management ablation on actual closed paper trades.
 * It never writes Postgres or changes production/paper runtime behaviour.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");

const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA_API_KEY/OANDA_API_TOKEN is required for this read-only historical replay.");
const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const outDir = path.join(root, "research-v2", "actual-exit-management-m1-v1"); mkdirSync(outDir, { recursive: true });
const pip = (pair: string) => pair.endsWith("JPY") ? 0.01 : 0.0001;

type Direction = "long" | "short";
type Trade = { id: string; trade_sequence: string; instrument: string; direction: Direction; decision_time: string; entry: string; stop: string; target: string; result_r: string; outcome: string; exit: string | null; closed_at: string | null; spread_pips: string | null };
type Bar = { t: number; iso: string; bo: number; bh: number; bl: number; bc: number; ao: number; ah: number; al: number; ac: number };
type Config = { id: string; label: string; kind: "baseline" | "fixed" | "be" | "trail" | "partial"; tp?: number; sl?: number; trigger?: number; trail?: number; partialAt?: number; runnerTarget?: number };
type Result = { r: number; kind: string; exitAt: string; mfe: number; mae: number; profitableFirst: boolean; maxProfitBeforeReversal: number; timeToMfeMinutes: number | null; timeToExitMinutes: number; reached: Record<string, boolean>; ambiguity: boolean };

// These policies are predeclared before the data are replayed. The partial arms are
// deliberately limited to two standard, executable policies; more variants would be underpowered.
const configs: Config[] = [
  { id: "baseline", label: "Current exit system (frozen control)", kind: "baseline" },
  { id: "fixed_2_1", label: "Fixed 2:1 +2R / -1R", kind: "fixed", tp: 2, sl: 1 },
  { id: "fixed_1_5", label: "Fixed 2:1 +1.5R / -0.75R", kind: "fixed", tp: 1.5, sl: .75 },
  { id: "fixed_1", label: "Fixed 2:1 +1R / -0.5R", kind: "fixed", tp: 1, sl: .5 },
  { id: "fixed_0_75", label: "Fixed 2:1 +0.75R / -0.375R", kind: "fixed", tp: .75, sl: .375 },
  { id: "fixed_0_5", label: "Fixed 2:1 +0.5R / -0.25R", kind: "fixed", tp: .5, sl: .25 },
  { id: "be_0_5", label: "Breakeven after +0.5R (original target retained)", kind: "be", trigger: .5 },
  { id: "be_0_75", label: "Breakeven after +0.75R (original target retained)", kind: "be", trigger: .75 },
  { id: "trail_0_25", label: "Trail 0.25R after +0.5R (no fixed target after arming)", kind: "trail", trigger: .5, trail: .25 },
  { id: "trail_0_5", label: "Trail 0.5R after +0.75R (no fixed target after arming)", kind: "trail", trigger: .75, trail: .5 },
  { id: "partial_1", label: "50% at +1R, remaining 50% to +2R with breakeven protection", kind: "partial", partialAt: 1, runnerTarget: 2 },
  { id: "partial_0_75", label: "50% at +0.75R, remaining 50% to +1.5R with breakeven protection", kind: "partial", partialAt: .75, runnerTarget: 1.5 },
];
const reaches = [.25, .5, .75, 1, 1.5].map(String);

const rows = (await query<Trade>(`SELECT id, trade_sequence::text, instrument, direction, decision_time::text, entry::text, stop::text, target::text, result_r::text, outcome, exit::text, closed_at::text, spread_pips::text FROM paper_strategy_trades WHERE status='closed' AND result_r IS NOT NULL ORDER BY decision_time, trade_sequence`)).rows;
if (rows.length < 30) throw new Error(`Need at least 30 closed trades; found ${rows.length}.`);
const first = Date.parse(rows[0]!.decision_time), last = Date.parse(rows.at(-1)!.decision_time);
const from = new Date(first - 2 * 3_600_000).toISOString(), to = new Date(last + 49 * 3_600_000).toISOString();

async function barsFor(pair: string): Promise<Bar[]> {
  const out: Bar[] = []; let cursor = from;
  for (let page = 0; page < 15; page += 1) {
    const url = `${host}/v3/instruments/${pair}/candles?price=BA&granularity=M1&count=5000&from=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${pair} candle fetch failed: HTTP ${response.status}`);
    const body = await response.json() as { candles?: Array<{ time: string; complete: boolean; bid?: Record<string, string>; ask?: Record<string, string> }> };
    const pageBars = (body.candles ?? []).filter((c) => c.complete && c.bid && c.ask).map((c) => {
      const t = Date.parse(c.time) + 60_000;
      return { t, iso: new Date(t).toISOString(),
      bo: +c.bid!.o, bh: +c.bid!.h, bl: +c.bid!.l, bc: +c.bid!.c, ao: +c.ask!.o, ah: +c.ask!.h, al: +c.ask!.l, ac: +c.ask!.c,
      };
    });
    out.push(...pageBars);
    const newest = pageBars.at(-1)?.t ?? 0;
    if (!pageBars.length || newest >= Date.parse(to) || pageBars.length < 5000) break;
    cursor = new Date(newest).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return [...new Map(out.map((b) => [b.t, b])).values()].filter((b) => b.t <= Date.parse(to)).sort((a, b) => a.t - b.t);
}
function etDayAndForcedAt(ms: number) { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "longOffset" }).formatToParts(new Date(ms)); const get = (type: string) => p.find((v) => v.type === type)?.value ?? ""; const day = `${get("year")}-${get("month")}-${get("day")}`, zone = get("timeZoneName"); const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone); if (!match) throw new Error(`Unable to parse New York offset ${zone}`); const offset = `${match[1]}${match[2]!.padStart(2, "0")}:${match[3] ?? "00"}`; return { day, forcedAt: Date.parse(`${day}T16:45:00${offset}`) }; }
function firstAfter(bars: Bar[], t: number) { let lo = 0, hi = bars.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (bars[mid]!.t <= t) lo = mid + 1; else hi = mid; } return lo; }
function priceR(dir: Direction, entry: number, risk: number, price: number) { return dir === "long" ? (price - entry) / risk : (entry - price) / risk; }
function hi(dir: Direction, b: Bar) { return dir === "long" ? b.bh : b.ah; }
function lo(dir: Direction, b: Bar) { return dir === "long" ? b.bl : b.al; }
function close(dir: Direction, b: Bar) { return dir === "long" ? b.bc : b.ac; }

function replay(t: Trade, bars: Bar[], cfg: Config): Result {
  const entry = +t.entry, initialStop = +t.stop, originalTarget = +t.target, risk = Math.abs(entry - initialStop), start = firstAfter(bars, Date.parse(t.decision_time));
  const origTp = Math.abs(originalTarget - entry) / risk, origSl = 1;
  let target = cfg.kind === "fixed" ? cfg.tp! : origTp, stopR = cfg.kind === "fixed" ? cfg.sl! : origSl;
  let armed = false, partial = false, realized = 0, remaining = 1, mfe = -Infinity, mae = -Infinity, mfeAt: number | null = null, profitableFirst = false, maxBeforeReversal = 0, sawPositive = false;
  const reached = Object.fromEntries(reaches.map((x) => [x, false])) as Record<string, boolean>;
  const decision = etDayAndForcedAt(Date.parse(t.decision_time)); const horizon = Date.parse(t.decision_time) + 48 * 3_600_000;
  const done = (r: number, kind: string, b: Bar, ambiguity = false): Result => ({ r, kind, exitAt: b.iso, mfe, mae, profitableFirst, maxProfitBeforeReversal: maxBeforeReversal, timeToMfeMinutes: mfeAt === null ? null : (mfeAt - Date.parse(t.decision_time)) / 60_000, timeToExitMinutes: (b.t - Date.parse(t.decision_time)) / 60_000, reached, ambiguity });
  for (let i = start; i < bars.length; i += 1) {
    const b = bars[i]!; if (b.t > horizon) break;
    const fav = priceR(t.direction, entry, risk, hi(t.direction, b)), adv = -priceR(t.direction, entry, risk, lo(t.direction, b));
    if (fav > mfe) { mfe = fav; mfeAt = b.t; } mae = Math.max(mae, adv);
    for (const level of reaches) if (fav >= +level) reached[level] = true;
    if (fav > 0) { sawPositive = true; maxBeforeReversal = Math.max(maxBeforeReversal, fav); }
    const stopPrice = t.direction === "long" ? entry - stopR * risk : entry + stopR * risk;
    const targetPrice = t.direction === "long" ? entry + target * risk : entry - target * risk;
    const hitStop = t.direction === "long" ? b.bl <= stopPrice : b.ah >= stopPrice;
    const hitTarget = t.direction === "long" ? b.bh >= targetPrice : b.al <= targetPrice;
    // Any two actionable levels inside the same M1 candle receive the adverse path.
    if (hitStop && hitTarget) return done(realized + remaining * -stopR, "AMBIGUOUS_CONSERVATIVE_STOP", b, true);
    if (hitStop) { const r = realized + remaining * -stopR; if (sawPositive && r < 0) profitableFirst = true; return done(r, armed ? "PROTECTED_STOP" : "STOP", b); }
    if (cfg.kind === "partial" && !partial && hitTarget) {
      realized += .5 * cfg.partialAt!; remaining = .5; partial = true; stopR = 0; target = cfg.runnerTarget!; continue;
    }
    if (cfg.kind !== "partial" && cfg.kind !== "trail" && hitTarget) return done(realized + remaining * target, "TARGET", b);
    if (cfg.kind === "partial" && partial && hitTarget) return done(realized + remaining * target, "PARTIAL_RUNNER_TARGET", b);
    // Protection is based only on a completed prior candle; it applies from the next candle onward.
    if (!armed && (cfg.kind === "be" || cfg.kind === "trail") && fav >= cfg.trigger!) { armed = true; if (cfg.kind === "be") stopR = 0; }
    if (armed && cfg.kind === "trail") { const nextStop = Math.max(0, fav - cfg.trail!); stopR = Math.max(stopR, nextStop); }
    if (b.t >= decision.forcedAt) { const r = realized + remaining * priceR(t.direction, entry, risk, close(t.direction, b)); if (sawPositive && r < 0) profitableFirst = true; return done(r, "FORCED_CLOSE", b); }
  }
  const b = bars[Math.max(start, Math.min(bars.length - 1, firstAfter(bars, horizon) - 1))]!; const r = realized + remaining * priceR(t.direction, entry, risk, close(t.direction, b)); if (sawPositive && r < 0) profitableFirst = true; return done(r, "HORIZON_CLOSE", b);
}

const pairs = [...new Set(rows.map((r) => r.instrument))]; const history = new Map<string, Bar[]>();
for (const pair of pairs) { const b = await barsFor(pair); history.set(pair, b); console.log(`${pair}: ${b.length} completed M1 bid/ask bars`); }
const all = rows.map((trade) => ({ trade, results: Object.fromEntries(configs.map((cfg) => [cfg.id, replay(trade, history.get(trade.instrument)!, cfg)])) as Record<string, Result> }));
const boundary1 = first + (last - first) * .60, boundary2 = first + (last - first) * .80;
function split(row: typeof all[number]) { const ms = Date.parse(row.trade.decision_time); return ms <= boundary1 ? "train" : ms <= boundary2 ? "dev" : "holdout"; }
function metrics(records: typeof all, id: string) {
  const a = records.map((x) => x.results[id]); const rs = a.map((x) => x.r), wins = rs.filter((x) => x > 0), losses = rs.filter((x) => x < 0); let equity = 0, peak = 0, dd = 0; for (const r of rs) { equity += r; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); }
  const harmed = records.filter((x) => x.results.baseline.r > 0 && x.results[id].r <= 0).length, saved = records.filter((x) => x.results.baseline.r < 0 && x.results[id].r >= 0).length;
  return { n: a.length, winRate: wins.length / a.length, averageR: rs.reduce((s, x) => s + x, 0) / a.length, totalR: rs.reduce((s, x) => s + x, 0), profitFactor: losses.length ? wins.reduce((s, x) => s + x, 0) / -losses.reduce((s, x) => s + x, 0) : null, maxDrawdown: dd, averageWinner: wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0, averageLoser: losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : 0, eventualLosersProfitableFirst: losses.length ? a.filter((x) => x.r < 0 && x.profitableFirst).length / losses.length : 0, reachesAmongEventualLosers: Object.fromEntries(reaches.map((level) => [level, losses.length ? a.filter((x) => x.r < 0 && x.reached[level]).length / losses.length : 0])), baselineWinnersTurnLossOrBe: harmed, baselineLosersSaved: saved, ambiguous: a.filter((x) => x.ambiguity).length };
}
const output: Record<string, unknown> = { generatedAt: new Date().toISOString(), scope: { trades: rows.length, first: rows[0]!.decision_time, last: rows.at(-1)!.decision_time, pricing: "OANDA Practice completed M1 bid/ask; actual recorded entry; exit-side bid for longs and ask for shorts; no added synthetic spread charge because bid/ask fills include it.", ambiguity: "If competing actionable levels occur in one M1 bar, adverse stop path is charged. Protection arms only after a completed candle, never from intrabar lookahead.", split: { trainThrough: new Date(boundary1).toISOString(), developmentThrough: new Date(boundary2).toISOString(), holdoutAfter: new Date(boundary2).toISOString() } }, policies: configs, records: all.map((x) => ({ sequence: x.trade.trade_sequence, pair: x.trade.instrument, direction: x.trade.direction, entryTime: x.trade.decision_time, recordedBaselineR: +x.trade.result_r, replay: x.results })), metrics: Object.fromEntries(configs.map((c) => [c.id, { label: c.label, train: metrics(all.filter((x) => split(x) === "train"), c.id), development: metrics(all.filter((x) => split(x) === "dev"), c.id), holdout: metrics(all.filter((x) => split(x) === "holdout"), c.id) }])) };
writeFileSync(path.join(outDir, "RESULTS.json"), JSON.stringify(output, null, 2));
const m = output.metrics as Record<string, { label: string; train: ReturnType<typeof metrics>; development: ReturnType<typeof metrics>; holdout: ReturnType<typeof metrics> }>;
const ranked = configs.map((c) => ({ id: c.id, label: c.label, ...m[c.id]!.holdout })).sort((a, b) => b.averageR - a.averageR);
const fmt = (n: number | null) => n === null ? "—" : n.toFixed(3); const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
const lines = ["# Actual trade exit-management M1 replay", "", "Research only. No database rows, engine policies, or paper/live execution behavior were changed.", "", `Trades: ${rows.length} actual closed paper trades (${rows[0]!.decision_time} through ${rows.at(-1)!.decision_time}).`, "", "## Holdout ranking (chronological final 20%; not used to select configurations)", "", "| Exit policy | N | Win rate | Avg R | Total R | PF | Max DD | Avg winner | Avg loser | Baseline winners harmed | Baseline losers saved | Ambiguous |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
for (const x of ranked) lines.push(`| ${x.label} | ${x.n} | ${pct(x.winRate)} | ${fmt(x.averageR)} | ${fmt(x.totalR)} | ${fmt(x.profitFactor)} | ${fmt(x.maxDrawdown)} | ${fmt(x.averageWinner)} | ${fmt(x.averageLoser)} | ${x.baselineWinnersTurnLossOrBe} | ${x.baselineLosersSaved} | ${x.ambiguous} |`);
lines.push("", "## OOS discipline", "", "Policies were fixed before replay. The ranking is final-holdout expectancy, but this short recent dataset is not large enough to establish a production change. Consult RESULTS.json for per-trade MFE/MAE, time-to-MFE/exit, reach rates, and train/development/holdout metrics.");
writeFileSync(path.join(outDir, "FINAL_REPORT.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n")); console.log(`\nWrote ${outDir}`);
