/**
 * Train/dev-only conditional forced-direction screen on settled binary rows.
 * Context is pair + UTC forex session + per-pair M1 volatility tercile, all
 * frozen from TRAIN. HOLDOUT is deliberately never read.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { calculateAtrValues, calculateEmaValues, calculateRsiValues } from "../../frontend/src/lib/strategy/indicators.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";
import { query } from "../src/database.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
if (!process.env.DATABASE_URL && process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const OUT = path.join(root, "research-v2", "binary-conditional-direction-screen-v1"), REPORT = path.join(OUT, "FINAL_REPORT.txt");
const BARS = 20_000, PAGE = 5_000, EXTREME_TRAIN = .60, DEV_MIN = 20;
type Direction = "long" | "short";
type Prediction = { instrument: MajorInstrument; start_at: string | Date; entry_price: string; resolution_price: string; tie_tolerance: string };
type Candle = { closeMs: number; open: number; high: number; low: number; close: number };
type Outcome = "won" | "lost" | "tie";
type Rule = { name: string; direction: (m1: Candle[], m15: Candle[]) => Direction | null };
type Observation = { pair: string; ms: number; session: string; volatility: number; outcomes: Map<string, Outcome> };
type Score = { n: number; wins: number; losses: number; ties: number; rate: number | null; low: number | null; high: number | null };

function follow(a: number, b: number): Direction { return a >= b ? "long" : "short"; }
function inverse(value: Outcome): Outcome { return value === "won" ? "lost" : value === "lost" ? "won" : "tie"; }
function wilson(wins: number, n: number) { if (!n) return { low: null, high: null }; const z = 1.96, p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return { low: (c - m) / d, high: (c + m) / d }; }
function score(values: Outcome[]): Score { const wins = values.filter((value) => value === "won").length, losses = values.filter((value) => value === "lost").length, ties = values.length - wins - losses, n = wins + losses, ci = wilson(wins, n); return { n, wins, losses, ties, rate: n ? wins / n : null, low: ci.low, high: ci.high }; }
function fmt(value: Score) { return `${value.wins}/${value.losses}/${value.ties} ${(value.rate === null ? "n/a" : `${(value.rate * 100).toFixed(1)}%`)} CI=[${value.low === null ? "n/a" : `${(value.low * 100).toFixed(1)}%`},${value.high === null ? "n/a" : `${(value.high * 100).toFixed(1)}%`}]`; }
function indexAtOrBefore(candles: Candle[], at: number) { let low = 0, high = candles.length - 1, found = -1; while (low <= high) { const middle = (low + high) >> 1; if (candles[middle]!.closeMs <= at) { found = middle; low = middle + 1; } else high = middle - 1; } return found; }
function session(ms: number) { const hour = new Date(ms).getUTCHours(); return hour < 7 ? "Asia" : hour < 12 ? "London" : hour < 17 ? "NewYork" : "Late"; }
function quantile(values: number[], q: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]!; }
function flip(value: Outcome, arm: "original" | "inverse") { return arm === "original" ? value : inverse(value); }

async function fetch(pair: MajorInstrument, granularity: "M1" | "M15", count: number) {
  const values = new Map<number, Candle>(); let cursor: string | undefined, priorOldest = Infinity, minutes = granularity === "M1" ? 1 : 15;
  for (let page = 0; values.size < count && page < Math.ceil(count / PAGE) + 2; page += 1) {
    const batch = (await getResearchCandles(pair, granularity, Math.min(PAGE, count), cursor ? { to: cursor } : {})).filter((row) => row.complete).map((row) => ({ closeMs: Date.parse(row.time) + minutes * 60_000, open: row.mid.open, high: row.mid.high, low: row.mid.low, close: row.mid.close }));
    if (!batch.length) break;
    for (const row of batch) values.set(row.closeMs, row);
    const oldest = Math.min(...batch.map((row) => row.closeMs - minutes * 60_000));
    if (oldest >= priorOldest) throw new Error(`${pair} ${granularity} pagination did not advance.`);
    priorOldest = oldest; cursor = new Date(oldest - 1).toISOString(); await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return [...values.values()].sort((a, b) => a.closeMs - b.closeMs).slice(-count);
}

const rules: Rule[] = [
  { name: "M1 return-1 follow", direction: (m1) => m1.length >= 2 ? follow(m1.at(-1)!.close, m1.at(-2)!.close) : null },
  { name: "M1 return-5 follow", direction: (m1) => m1.length >= 6 ? follow(m1.at(-1)!.close, m1.at(-6)!.close) : null },
  { name: "M1 RSI-2 reversal", direction: (m1) => { const value = calculateRsiValues(m1.map((row) => row.close), 2).at(-1); return value === undefined ? null : value < 50 ? "long" : "short"; } },
  { name: "M1 EMA 9/21 follow", direction: (m1) => { const closes = m1.map((row) => row.close), fast = calculateEmaValues(closes, 9).at(-1), slow = calculateEmaValues(closes, 21).at(-1); return fast === undefined || slow === undefined ? null : follow(fast, slow); } },
  { name: "M15 return-1 follow", direction: (_m1, m15) => m15.length >= 2 ? follow(m15.at(-1)!.close, m15.at(-2)!.close) : null },
  { name: "M15 RSI-2 reversal", direction: (_m1, m15) => { const value = calculateRsiValues(m15.map((row) => row.close), 2).at(-1); return value === undefined ? null : value < 50 ? "long" : "short"; } },
  { name: "M15 EMA 9/21 follow", direction: (_m1, m15) => { const closes = m15.map((row) => row.close), fast = calculateEmaValues(closes, 9).at(-1), slow = calculateEmaValues(closes, 21).at(-1); return fast === undefined || slow === undefined ? null : follow(fast, slow); } },
];

fs.mkdirSync(OUT, { recursive: true });
const predictions = (await query<Prediction>(`SELECT instrument,start_at,entry_price,resolution_price,tie_tolerance FROM binary_predictions WHERE model_name='binary-baseline-v1' AND is_authoritative=true AND status='resolved' AND result IN ('won','lost','tie') AND resolution_price IS NOT NULL ORDER BY start_at`)).rows;
if (!predictions.length) throw new Error("No settled authoritative baseline rows.");
const first = Date.parse(String(predictions[0]!.start_at)), last = Date.parse(String(predictions.at(-1)!.start_at)), trainEnd = first + (last - first) * .60, devEnd = first + (last - first) * .80;
const pairs = [...new Set(predictions.map((row) => row.instrument))], series = new Map<string, { m1: Candle[]; m15: Candle[] }>(), coverage: string[] = [];
for (const pair of pairs) { const [m1, m15] = await Promise.all([fetch(pair, "M1", BARS), fetch(pair, "M15", 4_000)]); series.set(pair, { m1, m15 }); coverage.push(`${pair}: ${predictions.filter((row) => row.instrument === pair).length} rows; M1/M15=${m1.length}/${m15.length}.`); console.log(coverage.at(-1)); }

const observations: Observation[] = [];
for (const row of predictions) {
  const ms = Date.parse(String(row.start_at)), data = series.get(row.instrument)!;
  const i1 = indexAtOrBefore(data.m1, ms), i15 = indexAtOrBefore(data.m15, ms);
  if (i1 < 15 || i15 < 25) continue;
  const m1 = data.m1.slice(Math.max(0, i1 - 99), i1 + 1), m15 = data.m15.slice(Math.max(0, i15 - 299), i15 + 1), atr = calculateAtrValues(m1.map((item) => ({ time: new Date(item.closeMs - 60_000).toISOString(), open: item.open, high: item.high, low: item.low, close: item.close, volume: 0, complete: true })), 14).at(-1) ?? 0;
  if (!(atr > 0)) continue;
  const entry = Number(row.entry_price), mark = Number(row.resolution_price), tolerance = Number(row.tie_tolerance); if (![entry, mark, tolerance].every(Number.isFinite)) continue;
  const outcomes = new Map<string, Outcome>();
  for (const rule of rules) { const direction = rule.direction(m1, m15); if (!direction) continue; const move = mark - entry; outcomes.set(rule.name, Math.abs(move) <= tolerance ? "tie" : (direction === "long" ? move > 0 : move < 0) ? "won" : "lost"); }
  observations.push({ pair: row.instrument, ms, session: session(ms), volatility: atr / m1.at(-1)!.close, outcomes });
}
const thresholds = new Map<string, [number, number]>();
for (const pair of pairs) { const train = observations.filter((row) => row.pair === pair && row.ms <= trainEnd).map((row) => row.volatility); thresholds.set(pair, [quantile(train, 1 / 3), quantile(train, 2 / 3)]); }
const volatility = (row: Observation) => { const [low, high] = thresholds.get(row.pair)!; return row.volatility <= low ? "LowVol" : row.volatility <= high ? "NormalVol" : "HighVol"; };
const contexts = (row: Observation) => [`pair-session:${row.pair}/${row.session}`, `pair-vol:${row.pair}/${volatility(row)}`, `session-vol:${row.session}/${volatility(row)}`];
type Candidate = { rule: string; context: string; arm: "original" | "inverse"; train: Score; dev: Score };
const candidates: Candidate[] = [];
for (const rule of rules) for (const context of new Set(observations.flatMap(contexts))) for (const arm of ["original", "inverse"] as const) {
  const trainValues = observations.filter((row) => row.ms <= trainEnd && contexts(row).includes(context)).map((row) => row.outcomes.get(rule.name)).filter((value): value is Outcome => value !== undefined).map((value) => flip(value, arm));
  const train = score(trainValues); if (train.n < 50 || train.rate === null || Math.abs(train.rate - .5) < EXTREME_TRAIN - .5) continue;
  const dev = score(observations.filter((row) => row.ms > trainEnd && row.ms <= devEnd && contexts(row).includes(context)).map((row) => row.outcomes.get(rule.name)).filter((value): value is Outcome => value !== undefined).map((value) => flip(value, arm)));
  candidates.push({ rule: rule.name, context, arm, train, dev });
}
candidates.sort((a, b) => Math.abs((b.train.rate ?? .5) - .5) - Math.abs((a.train.rate ?? .5) - .5));
const confirmed = candidates.filter((row) => row.dev.n >= DEV_MIN && row.dev.rate !== null && ((row.train.rate! > .5 && row.dev.rate > .5556 && (row.dev.low ?? 0) > .5) || (row.train.rate! < .5 && row.dev.rate < .4444 && (row.dev.high ?? 1) < .5)));
const lines = [
  "GOLDENXPERIENCE — CONDITIONAL BINARY DIRECTION SCREEN V1", "Research only. No records or runtime behavior changed.",
  `Sample: ${observations.length}/${predictions.length} M1/M15-backed settled binary rows. TRAIN through ${new Date(trainEnd).toISOString()}; DEV through ${new Date(devEnd).toISOString()}; HOLDOUT unread.`,
  "Rules: the seven forced rules from screen V1. Contexts: pair/session, pair/volatility, and session/volatility. Volatility terciles are computed from TRAIN per pair, then frozen for DEV.",
  `Selection: TRAIN n>=50 and >=60% or <=40%; DEV confirmation requires n>=${DEV_MIN}, same side of 50%, >55.56% (or <44.44%) and a 95% Wilson bound beyond 50%. This is a discovery screen only; many contexts are tested.`, "", "Coverage:", ...coverage, "",
  `TRAIN-extreme candidates: ${candidates.length}. DEV-confirmed candidates: ${confirmed.length}.`,
  ...(candidates.slice(0, 25).map((row, index) => `${index + 1}. ${row.arm.toUpperCase()} ${row.rule} | ${row.context}\n   TRAIN ${fmt(row.train)} | DEV ${fmt(row.dev)}${confirmed.includes(row) ? " | DEV CONFIRMED (still needs holdout)" : ""}`)),
  "", "No holdout outcomes were read. Rows sharing bars are not independent; a DEV-confirmed slice would still need an untouched holdout and then forward collection before activation.",
];
fs.writeFileSync(REPORT, `${lines.join("\n")}\n`); console.log(lines.join("\n")); console.log(`Wrote ${REPORT}`);
