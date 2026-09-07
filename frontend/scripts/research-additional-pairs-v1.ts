import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { evaluateBreakout, DEFAULT_BREAKOUT_CONFIG } from "../src/lib/strategy/strategies/breakout";
import { calculateAtrValues } from "../src/lib/strategy/indicators";
import { classifyRegime } from "../src/lib/strategy/regime";
import { dayTradingSession } from "../src/lib/strategy/strategy-engine";
import type { MarketRegime, StrategyEvaluationInput } from "../src/lib/strategy/types";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

export const PAIRS = ["USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY"] as const;
type Pair = typeof PAIRS[number];
type Frame = "M15" | "H1" | "H4";
const FRAME_MS = { M15: 900_000, H1: 3_600_000, H4: 14_400_000 };
const OUT = resolve(process.cwd(), "../api-server/research-v2/additional-pairs-breakout-v1");
const FROM = "2023-01-01T00:00:00.000Z", TO = "2025-01-01T00:00:00.000Z";
const WARMUP = "2022-09-01T00:00:00.000Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (t: number) => new Date(t).toISOString();
const ms = (c: ResearchCandle) => Date.parse(c.time);
const pip = (pair: Pair) => pair.endsWith("JPY") ? 0.01 : 0.0001;
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function clock(time: number) {
  const parts = ny.formatToParts(new Date(time));
  const part = (key: string) => parts.find(p => p.type === key)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, minutes: +part("hour") * 60 + +part("minute") };
}
export function forcedExit(entry: number, close: number) {
  const a = clock(entry), b = clock(close);
  return a.date === b.date && b.minutes >= 16 * 60 + 45;
}
export type Plan = { direction: "long" | "short"; entry: number; stop: number; target: number; decision: number };
export function replayExit(plan: Plan, candles: ResearchCandle[], start: number) {
  const risk = Math.abs(plan.entry - plan.stop), sign = plan.direction === "long" ? 1 : -1;
  let expected = plan.decision;
  for (let j = start; j < candles.length; j++) {
    const bar = candles[j], openTime = ms(bar), close = openTime + FRAME_MS.M15;
    if (!bar.complete || openTime < plan.decision) continue;
    if (openTime !== expected) return { reason: "DATA_GAP" as const, resultR: null, exit: null, exitTime: expected, ambiguous: false };
    expected = close;
    const q = plan.direction === "long" ? bar.bid : bar.ask;
    const stop = sign === 1 ? q.low <= plan.stop : q.high >= plan.stop;
    const target = sign === 1 ? q.high >= plan.target : q.low <= plan.target;
    // Gapped stops fill at the worse opening price; positive target gaps get no improvement.
    if (stop) {
      const price = sign === 1 ? Math.min(plan.stop, q.open) : Math.max(plan.stop, q.open);
      return { reason: "SL" as const, resultR: sign * (price - plan.entry) / risk, exit: price, exitTime: close, ambiguous: target };
    }
    if (target) return { reason: "TP" as const, resultR: sign * (plan.target - plan.entry) / risk, exit: plan.target, exitTime: close, ambiguous: false };
    if (forcedExit(plan.decision, close) || close >= plan.decision + 48 * FRAME_MS.H1)
      return { reason: "TIME_EXIT" as const, resultR: sign * (q.close - plan.entry) / risk, exit: q.close, exitTime: close, ambiguous: false };
  }
  return { reason: "CENSORED" as const, resultR: null, exit: null, exitTime: expected, ambiguous: false };
}

function midpoint(c: ResearchCandle): Candle { return { time: iso(ms(c)), ...c.mid, volume: c.volume, complete: c.complete }; }
export function atrOnlyRegime(atr: number, pair: Pair, evaluatedAt: string): MarketRegime {
  // Breakout V1 reads only ATR and ATR pips for its decisions. Other fields are
  // diagnostics, deliberately marked neutral/unavailable, never selection inputs.
  return { regime: "mixed", trendDirection: "none", trendStrength: 0, volatility: "normal", atr, atrPips: atr / pip(pair),
    momentumState: "steady", emaFast: null, emaMid: null, emaSlow: null, slopeAtrPerBar: null,
    rangeHigh: null, rangeLow: null, rangeWidthAtr: null, rangeAgeBars: null, lookbackBars: 50, evaluatedAt };
}

async function freeze(name: string, data: unknown) {
  const text = JSON.stringify(data, null, 2) + "\n", path = resolve(OUT, name);
  try { await writeFile(path, text, { flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; assert.equal(await readFile(path, "utf8"), text, `Frozen ${name} changed; do not overwrite`); }
}
async function history(pair: Pair, frame: Frame) {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const dir = resolve(OUT, "data"); await mkdir(dir, { recursive: true });
  const file = resolve(dir, `${pair}-${frame}-MBA.json`);
  let rows: ResearchCandle[] = [], cursor = TO;
  try { const saved = JSON.parse(await readFile(file, "utf8")); assert.equal(saved.from, WARMUP); assert.equal(saved.to, TO); rows = saved.candles; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (rows.length) cursor = iso(Math.min(...rows.map(ms)));
  while (!rows.length || Date.parse(cursor) > Date.parse(WARMUP)) {
    let batch: ResearchCandle[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try { batch = await getResearchCandles(pair, frame, 5000, { to: cursor }); break; }
      catch { if (attempt === 2) throw new Error(`${pair} ${frame} MBA unavailable after three attempts`); }
    }
    assert.ok(batch.length, "Empty historical response");
    const prior = Date.parse(cursor);
    rows = [...new Map([...rows, ...batch].filter(c => c.complete && ms(c) + FRAME_MS[frame] <= Date.parse(TO)).map(c => [ms(c), c])).values()].sort((a, b) => ms(a) - ms(b));
    cursor = iso(ms(rows[0])); assert.ok(Date.parse(cursor) < prior, "History cursor did not advance");
    await writeFile(file, JSON.stringify({ from: WARMUP, to: TO, candles: rows }));
    console.log(`${pair} ${frame}: ${rows.length} completed MBA bars; oldest ${cursor}`);
  }
  rows = rows.filter(c => ms(c) >= Date.parse(WARMUP));
  for (const c of rows) {
    for (const q of [c.mid, c.bid, c.ask]) assert.ok(Object.values(q).every(Number.isFinite) && q.low <= Math.min(q.open, q.close) && q.high >= Math.max(q.open, q.close));
    assert.ok(c.ask.close >= c.bid.close, "Crossed closing quote");
  }
  return rows;
}

type Trade = { pair: Pair; decisionTime: string; direction: "long" | "short"; entry: number; stop: number; target: number; atr: number; spreadPips: number; spreadToStop: number;
  resultR: number | null; midpointResultR: number | null; reason: string; exitTime: string; holdingMinutes: number; ambiguous: boolean; costWinnerToLoser: boolean };
function metrics(trades: Trade[]) {
  const closed = trades.filter(t => t.resultR !== null), r = closed.map(t => t.resultR!);
  const wins = r.filter(x => x > 0), losses = r.filter(x => x < 0), sorted = [...r].sort((a, b) => a - b);
  let total = 0, peak = 0, dd = 0;
  for (const t of [...closed].sort((a, b) => a.exitTime.localeCompare(b.exitTime))) { total += t.resultR!; peak = Math.max(peak, total); dd = Math.max(dd, peak - total); }
  return { n: closed.length, unresolved: trades.length - closed.length, winRate: wins.length / r.length || 0,
    tp: closed.filter(t => t.reason === "TP").length, sl: closed.filter(t => t.reason === "SL").length, timeExit: closed.filter(t => t.reason === "TIME_EXIT").length,
    expectancyR: r.length ? sum(r) / r.length : null, profitFactor: losses.length ? sum(wins) / -sum(losses) : null,
    totalR: sum(r), medianR: r.length ? (sorted[Math.floor((r.length - 1) / 2)] + sorted[Math.floor(r.length / 2)]) / 2 : null,
    averageWinR: wins.length ? sum(wins) / wins.length : null, averageLossR: losses.length ? sum(losses) / losses.length : null,
    closedTradeDrawdownR: dd, averageHoldingMinutes: closed.length ? sum(closed.map(t => t.holdingMinutes)) / closed.length : null,
    averageSpreadPips: closed.length ? sum(closed.map(t => t.spreadPips)) / closed.length : null,
    averageSpreadToStop: closed.length ? sum(closed.map(t => t.spreadToStop)) / closed.length : null,
    ambiguousStopFirst: closed.filter(t => t.ambiguous).length, costWinnerToLoser: closed.filter(t => t.costWinnerToLoser).length };
}
function confidence(trades: Trade[]) {
  // Calendar-month blocks preserve within-month serial dependence. Include empty months.
  const blocks: number[][] = Array.from({ length: 24 }, () => []);
  for (const t of trades) if (t.resultR !== null) { const d = new Date(t.decisionTime); blocks[(d.getUTCFullYear() - 2023) * 12 + d.getUTCMonth()].push(t.resultR); }
  let state = 914203;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const values: number[] = [];
  for (let b = 0; b < 5000; b++) { let n = 0, total = 0; for (let j = 0; j < 24; j++) { const block = blocks[Math.floor(random() * 24)]; n += block.length; total += sum(block); } if (n) values.push(total / n); }
  values.sort((a, b) => a - b);
  return { lower95: values[Math.floor(values.length * .025)] ?? null, upper95: values[Math.floor(values.length * .975)] ?? null };
}
function research(pair: Pair, raw: Record<Frame, ResearchCandle[]>) {
  const m15 = raw.M15.map(midpoint), h1 = raw.H1.map(midpoint), h4 = raw.H4.map(midpoint);
  const atr = calculateAtrValues(m15, 14); const trades: Trade[] = [];
  let end1 = 0, end4 = 0, activeUntil = -Infinity, signals = 0, blocked = 0, parityChecks = 0;
  for (let i = 209; i < m15.length; i++) {
    const decision = ms(raw.M15[i]) + FRAME_MS.M15;
    if (decision < Date.parse(FROM) || decision >= Date.parse(TO) - 48 * FRAME_MS.H1) continue;
    while (end1 < h1.length && Date.parse(h1[end1].time) + FRAME_MS.H1 <= decision) end1++;
    while (end4 < h4.length && Date.parse(h4[end4].time) + FRAME_MS.H4 <= decision) end4++;
    if (end1 < 210 || end4 < 210 || !dayTradingSession(new Date(decision)).open) continue;
    const q = raw.M15[i], evaluatedAt = iso(decision);
    const input: StrategyEvaluationInput = { instrument: pair, accountBalance: 100, accountCurrency: "USD", dataSource: "oanda",
      candles15m: m15.slice(i - 209, i + 1), candles1h: h1.slice(end1 - 210, end1), candles4h: h4.slice(end4 - 210, end4),
      bid: q.bid.close, ask: q.ask.close, spreadPips: (q.ask.close - q.bid.close) / pip(pair), marketOpen: true,
      calendarConnected: false, highImpactNewsWithinMinutes: null, evaluatedAt, evaluationMode: "historical_replay" };
    const setup = evaluateBreakout(input, atrOnlyRegime(atr[i]!, pair, evaluatedAt), DEFAULT_BREAKOUT_CONFIG);
    if (setup.status !== "valid" || setup.entry === null || setup.stop === null || setup.target === null || !setup.direction) continue;
    signals++;
    if (parityChecks < 20) {
      const full = evaluateBreakout({ ...input, candles15m: m15.slice(0, i + 1) }, classifyRegime(pair, m15.slice(0, i + 1), evaluatedAt), DEFAULT_BREAKOUT_CONFIG);
      assert.deepEqual([setup.status, setup.direction, setup.entry, setup.stop, setup.target], [full.status, full.direction, full.entry, full.stop, full.target]); parityChecks++;
    }
    if (decision < activeUntil) { blocked++; continue; }
    const plan = { direction: setup.direction, entry: setup.entry, stop: setup.stop, target: setup.target, decision };
    const result = replayExit(plan, raw.M15, i + 1);
    // A gap does not magically close a trade: block all remaining entries until data is repaired.
    activeUntil = result.resultR === null ? Infinity : result.exitTime;
    const midBars = raw.M15.slice(i + 1, i + 194).map(c => ({ ...c, bid: c.mid, ask: c.mid }));
    // Diagnostic midpoint counterfactual: same timestamps/direction/fixed absolute barriers.
    const mid = replayExit({ ...plan, entry: q.mid.close }, midBars, 0);
    const midRisk = Math.abs(plan.entry - plan.stop);
    const midR = mid.exit === null ? null : (setup.direction === "long" ? 1 : -1) * (mid.exit - q.mid.close) / midRisk;
    trades.push({ pair, decisionTime: evaluatedAt, direction: setup.direction, entry: setup.entry, stop: setup.stop, target: setup.target,
      atr: atr[i]!, spreadPips: input.spreadPips!, spreadToStop: (q.ask.close - q.bid.close) / midRisk, resultR: result.resultR,
      midpointResultR: midR, reason: result.reason, exitTime: iso(result.exitTime), holdingMinutes: (result.exitTime - decision) / 60_000,
      ambiguous: result.ambiguous, costWinnerToLoser: midR !== null && midR > 0 && result.resultR !== null && result.resultR < 0 });
  }
  const overall = metrics(trades), byYear = [2023, 2024].map(year => ({ year, ...metrics(trades.filter(t => t.decisionTime.startsWith(String(year)))) }));
  const ci = confidence(trades);
  const passed = overall.unresolved === 0 && overall.n >= 100 && (overall.expectancyR ?? -Infinity) >= .10 && (overall.profitFactor ?? 0) >= 1.15
    && byYear.every(y => y.n >= 40 && (y.expectancyR ?? -Infinity) > 0) && (ci.lower95 ?? -Infinity) > 0;
  return { pair, status: overall.unresolved ? "DATA_INCOMPLETE" : passed ? "DEVELOPMENT_PASS_VALIDATION_REQUIRED" : "DEVELOPMENT_FAIL_DO_NOT_ADMIT",
    signals, overlapBlocked: blocked, parityChecks, overall, byYear, confidence: ci,
    byDirection: { long: metrics(trades.filter(t => t.direction === "long")), short: metrics(trades.filter(t => t.direction === "short")) }, trades };
}

async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server")); await mkdir(OUT, { recursive: true });
  const paths = ["scripts/research-additional-pairs-v1.ts", "src/lib/strategy/strategies/breakout.ts", "src/lib/strategy/strategy-common.ts", "src/lib/strategy/indicators.ts", "src/lib/strategy/regime.ts", "src/lib/strategy/strategy-engine.ts", "src/lib/strategy/session.ts", "src/lib/instruments/catalog.ts", "src/lib/risk/engine.ts", "src/lib/oanda/client.ts"];
  const hashes = Object.fromEntries(await Promise.all(paths.map(async p => [p, sha(await readFile(resolve(process.cwd(), p), "utf8"))])));
  const controls = Object.fromEntries(await Promise.all(["eurusd", "usdjpy", "gbpusd", "audusd"].map(async p => [p, sha(await readFile(resolve(process.cwd(), `src/lib/strategy/strategies/${p}-strategy.ts`), "utf8"))])));
  await freeze("PROTOCOL.json", { id: "ADDITIONAL_PAIRS_BREAKOUT_V1", pairs: PAIRS, pairRationale: "Two additional USD majors and two JPY crosses; not selected by this experiment's historical P&L", strategy: DEFAULT_BREAKOUT_CONFIG,
    development: { from: FROM, to: TO, warmup: WARMUP, endPurgeHours: 48 }, validation: { from: TO, to: "2026-09-01T00:00:00.000Z", status: "NOT_RUN_UNTIL_DEVELOPMENT_PASS", notGloballyPristine: true },
    gates: { minimumN: 100, minimumEachYearN: 40, expectancyR: .10, profitFactor: 1.15, positiveEachYear: true, monthBootstrap95LowerAboveZero: true, bootstrapSamples: 5000, seed: 914203 },
    execution: { prices: "Historical completed OANDA MBA M15", long: "ask entry / bid exit", short: "bid entry / ask exit", stopFirst: true, adverseOpeningStopGaps: true,
      entry: "signal-bar closing quote; zero latency assumption", targetR: 2, riskR: 1, holding: "16:45 America/New_York same-day close; 48h fallback", onePositionPerPair: true,
      gapPolicy: "Unresolved and block all following entries; never silently remove and reopen", noTimeExitExperiment: false },
    limitations: ["Historical news not retained; technical-only replay mode", "No commission, financing, extra slippage or broker latency model", "R evidence only: no USD account simulation or 3% risk activation", "Not proof of a new strategy or globally pristine holdout"],
    antiOverfit: "No parameter changes, no inversion, no alternative strategy family sweep, no failed spread selector applied. Failed pairs do not open validation.", hashes, controls });
  const results = [];
  const manifests = [];
  for (const pair of PAIRS) {
    const raw = { M15: await history(pair, "M15"), H1: await history(pair, "H1"), H4: await history(pair, "H4") };
    for (const frame of ["M15", "H1", "H4"] as const) manifests.push({ pair, frame, count: raw[frame].length, first: raw[frame][0].time, last: raw[frame].at(-1)!.time, sha256: sha(JSON.stringify(raw[frame])) });
    const result = research(pair, raw); results.push(result);
    await writeFile(resolve(OUT, `${pair}-DEVELOPMENT.json`), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ pair, status: result.status, ...result.overall, ci: result.confidence }));
  }
  for (const [pair, hash] of Object.entries(controls)) assert.equal(sha(await readFile(resolve(process.cwd(), `src/lib/strategy/strategies/${pair}-strategy.ts`), "utf8")), hash, "Frozen control changed during research");
  await writeFile(resolve(OUT, "DATA_MANIFEST.json"), JSON.stringify(manifests, null, 2) + "\n");
  await writeFile(resolve(OUT, "RESULTS.json"), JSON.stringify({ generatedAt: new Date().toISOString(), validationStatus: "NOT_RUN", results: results.map(r => ({ ...r, trades: undefined })) }, null, 2) + "\n");
  const fmt = (n: number | null) => n === null ? "N/A" : n.toFixed(3);
  const lines = ["# Additional pairs: frozen Breakout V1 development screen", "", "Research only. Existing four strategies unchanged; NZD/USD excluded. No deployments, settings changes or orders.", "",
    "Development: 2023–2024 with a 48-hour entry purge. Completed historical OANDA M15 bid/ask; unchanged generic Breakout V1 entry rules and executable +2R target/-1R stop geometry. Stop-first ambiguity, adverse opening stop gaps, same-day 16:45 New York exit, one open trade per pair. This is a separate generic baseline, not a copy of the four pair-specific strategies.", "",
    "| Pair | N | WR | TP | SL | TIME | PF | Exp R | Total R | Closed DD R | 2023 exp | 2024 exp | Status |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"];
  for (const r of results) { const m = r.overall; lines.push(`| ${r.pair} | ${m.n} | ${(m.winRate * 100).toFixed(1)}% | ${m.tp} | ${m.sl} | ${m.timeExit} | ${fmt(m.profitFactor)} | ${fmt(m.expectancyR)} | ${fmt(m.totalR)} | ${fmt(m.closedTradeDrawdownR)} | ${fmt(r.byYear[0].expectancyR)} | ${fmt(r.byYear[1].expectancyR)} | ${r.status} |`); }
  lines.push("", "## Interpretation and limitations", "", "Admission requires N >=100, each year N >=40 and positive expectancy, pooled expectancy >=0.10R, PF >=1.15, a positive lower 95% calendar-month bootstrap bound, and no unresolved trades. These gates were saved before fetching development data. Passing would only authorize the next research stage, not execution.", "",
    "The 2025–2026 validation period has not been replayed. It is not asserted to be globally untouched by previous research. Negative development results are not tuned or reversed. The raw full dataset is cached separately from result artifacts and identified by hashes.", "",
    "Historical news filters are unavailable. Signal-close entry assumes zero latency. No extra slippage, commissions or financing are charged; gaps at stops can exceed -1R. Drawdown is closed-trade R drawdown, not marked-to-market account drawdown. Midpoint results are only a same-entry-time/fixed-barrier cost diagnostic, never the admission basis. The failed low-spread selector was not applied.", "",
    "This stage does not simulate a 3% USD account: crossing currency conversion, actual instrument margin, correlated concurrent exposure and realistic order sizing must be modeled before any addition to the earlier account simulation. More pairs alone are not evidence of greater profit.", "",
    results.some(r => r.status === "DEVELOPMENT_PASS_VALIDATION_REQUIRED") ? "Recommendation: keep qualifying candidates in research; run their predeclared chronological validation before considering portfolio admission." : "Recommendation: admit none of these additional pairs under this baseline. Keep the existing controls unchanged; do not tune this losing baseline or reuse later years to rescue it.");
  await writeFile(resolve(OUT, "FINAL_REPORT.md"), lines.join("\n") + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e instanceof Error ? e.message : "Research failed"); process.exitCode = 1; });
