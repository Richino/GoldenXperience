/**
 * Price-only directional audit of the current liquidity engine.
 *
 * This is intentionally separate from the paper-trade P&L resolver.  It
 * replays the exact `evaluateLiquiditySetup` technical gates at each completed
 * M15 close, freezes UP/DOWN/WAIT, then measures mid price at +10 minutes.
 * Historical macro snapshots and calendar state were not retained, so macro
 * is neutral and the news gate is recorded as not evaluated.
 *
 * Research only: reads OANDA Practice candles and writes one local report. It
 * never writes the database, prediction table, paper trades, or configuration.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { evaluateLiquiditySetup, LIQUIDITY_STRATEGY_VERSION } from "../../frontend/src/lib/strategy/liquidity-strategy.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });

const OUT = path.join(root, "research-v2", "liquidity-price-only-binary-v1");
const REPORT = path.join(OUT, "FINAL_REPORT.txt");
const INSTRUMENTS: MajorInstrument[] = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD", "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD"];
const PAGE = 5_000;
const M1_BARS = 32_000;
const M15_BARS = 4_000;
const H1_BARS = 1_100;
const H4_BARS = 500;
const REPLAY_WINDOW = 260;
const HORIZON_MS = 10 * 60_000;
const BREAK_EVEN_80 = 1 / 1.8;

type Row = { candle: ResearchCandle; closeMs: number };
type Event = { instrument: MajorInstrument; time: string; ms: number; direction: "up" | "down"; entry: number; mark: number; outcome: "won" | "lost" | "tie" };
type Score = { n: number; wins: number; losses: number; ties: number; rate: number | null; low: number | null; high: number | null };

function timeframeMs(timeframe: "M1" | "M15" | "H1" | "H4") {
  return timeframe === "M1" ? 60_000 : timeframe === "M15" ? 15 * 60_000 : timeframe === "H1" ? 60 * 60_000 : 4 * 60 * 60_000;
}

function candle(row: Row): Candle {
  const { candle: value } = row;
  return { time: value.time, open: value.mid.open, high: value.mid.high, low: value.mid.low, close: value.mid.close, volume: value.volume, complete: true };
}

async function fetchHistory(instrument: MajorInstrument, timeframe: "M1" | "M15" | "H1" | "H4", wanted: number): Promise<Row[]> {
  const rows = new Map<number, Row>();
  let cursor: string | undefined;
  let previousOldest = Number.POSITIVE_INFINITY;
  for (let page = 0; rows.size < wanted && page < Math.ceil(wanted / PAGE) + 2; page += 1) {
    const batch = (await getResearchCandles(instrument, timeframe, Math.min(PAGE, wanted), cursor ? { to: cursor } : {}))
      .filter((item) => item.complete)
      .map((item) => ({ candle: item, closeMs: Date.parse(item.time) + timeframeMs(timeframe) }));
    if (!batch.length) break;
    for (const item of batch) rows.set(item.closeMs, item);
    const oldest = Math.min(...batch.map((item) => item.closeMs - timeframeMs(timeframe)));
    if (oldest >= previousOldest) throw new Error(`${instrument} ${timeframe} pagination did not advance.`);
    previousOldest = oldest;
    cursor = new Date(oldest - 1).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [...rows.values()].sort((left, right) => left.closeMs - right.closeMs).slice(-wanted);
}

function marketOpen(at: Date) {
  const day = at.getUTCDay(), hour = at.getUTCHours();
  return !((day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 22));
}

function wilson(wins: number, n: number) {
  if (!n) return { low: null, high: null };
  const z = 1.96, p = wins / n, divisor = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return { low: (center - margin) / divisor, high: (center + margin) / divisor };
}

function score(events: Event[], inverted = false): Score {
  const wins = events.filter((event) => event.outcome === (inverted ? "lost" : "won")).length;
  const losses = events.filter((event) => event.outcome === (inverted ? "won" : "lost")).length;
  const ties = events.length - wins - losses;
  const n = wins + losses, ci = wilson(wins, n);
  return { n, wins, losses, ties, rate: n ? wins / n : null, low: ci.low, high: ci.high };
}

function format(score: Score) {
  const percent = (value: number | null) => value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
  return `n=${score.n} W/L/T=${score.wins}/${score.losses}/${score.ties} WR=${percent(score.rate)} CI95=[${percent(score.low)}, ${percent(score.high)}]`;
}

function qualifies(score: Score) {
  return score.n >= 100 && (score.rate ?? 0) > BREAK_EVEN_80 && (score.low ?? 0) > 0.5;
}

async function collect(instrument: MajorInstrument) {
  const [m1, m15, h1, h4] = await Promise.all([
    fetchHistory(instrument, "M1", M1_BARS), fetchHistory(instrument, "M15", M15_BARS),
    fetchHistory(instrument, "H1", H1_BARS), fetchHistory(instrument, "H4", H4_BARS),
  ]);
  const m1MarkByClose = new Map(m1.map((row) => [row.closeMs, row.candle.mid.close]));
  const firstOutcomeAt = m1[0]?.closeMs ?? Infinity;
  const lastOutcomeAt = m1.at(-1)?.closeMs ?? -Infinity;
  const events: Event[] = [];
  let considered = 0, eligible = 0, h1End = 0, h4End = 0;
  for (let index = REPLAY_WINDOW - 1; index < m15.length; index += 1) {
    const decision = m15[index]!.closeMs;
    while (h1End < h1.length && h1[h1End]!.closeMs <= decision) h1End += 1;
    while (h4End < h4.length && h4[h4End]!.closeMs <= decision) h4End += 1;
    if (h1End < REPLAY_WINDOW || h4End < REPLAY_WINDOW || decision < firstOutcomeAt || decision + HORIZON_MS > lastOutcomeAt) continue;
    const mark = m1MarkByClose.get(decision + HORIZON_MS);
    if (mark === undefined) continue;
    considered += 1;
    const current = m15[index]!;
    const spreadPips = (current.candle.ask.close - current.candle.bid.close) / pipSizeFor(instrument);
    const setup = evaluateLiquiditySetup({
      instrument, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
      candles15m: m15.slice(index + 1 - REPLAY_WINDOW, index + 1).map(candle),
      candles1h: h1.slice(h1End - REPLAY_WINDOW, h1End).map(candle),
      candles4h: h4.slice(h4End - REPLAY_WINDOW, h4End).map(candle),
      bid: current.candle.bid.close, ask: current.candle.ask.close, spreadPips,
      marketOpen: marketOpen(new Date(decision)), calendarConnected: false, highImpactNewsWithinMinutes: null,
      newsRequired: false, evaluationMode: "historical_replay", evaluatedAt: new Date(decision).toISOString(),
      macroBias: "neutral", macroDetail: "Historical FRED snapshots were not retained; macro tilt is neutral in replay.",
    });
    if (setup.status !== "valid" || !setup.direction) continue;
    eligible += 1;
    const entry = current.candle.mid.close;
    const movement = mark - entry;
    const outcome = Math.abs(movement) < 1e-12 ? "tie" : (setup.direction === "long" ? movement > 0 : movement < 0) ? "won" : "lost";
    events.push({ instrument, time: new Date(decision).toISOString(), ms: decision, direction: setup.direction === "long" ? "up" : "down", entry, mark, outcome });
  }
  return { events, coverage: { m1: m1.length, m15: m15.length, h1: h1.length, h4: h4.length, considered, eligible } };
}

fs.mkdirSync(OUT, { recursive: true });
const all: Event[] = [];
const coverages: string[] = [];
for (const instrument of INSTRUMENTS) {
  const result = await collect(instrument);
  all.push(...result.events);
  const c = result.coverage;
  coverages.push(`${instrument}: M1=${c.m1}, M15=${c.m15}, H1=${c.h1}, H4=${c.h4}; eligible M15 decisions=${c.considered}; valid strategy signals=${c.eligible}.`);
  console.log(coverages.at(-1));
}
all.sort((left, right) => left.ms - right.ms);
if (!all.length) throw new Error("No valid price-only liquidity signals in the fetched OANDA window.");
const first = all[0]!.ms, last = all.at(-1)!.ms;
const trainEnd = first + (last - first) * 0.60;
const devEnd = first + (last - first) * 0.80;
const train = all.filter((event) => event.ms <= trainEnd);
const development = all.filter((event) => event.ms > trainEnd && event.ms <= devEnd);
const holdout = all.filter((event) => event.ms > devEnd);
const developmentOriginal = score(development);
const developmentInverse = score(development, true);
const selected = qualifies(developmentOriginal) ? "original" : qualifies(developmentInverse) ? "inverse" : null;
const lines = [
  "GOLDENXPERIENCE — LIQUIDITY ENGINE PRICE-ONLY BINARY DIRECTION AUDIT", "Research only. No database rows, paper trades, predictions, or strategy configuration changed.", "",
  `Engine: ${LIQUIDITY_STRATEGY_VERSION}; exact evaluateLiquiditySetup technical gates at every completed M15 close.`,
  "Direction measurement: freeze strategy UP/DOWN/WAIT at M15 close; entry=OANDA M15 mid close; mark=the OANDA M1 mid close exactly +10 minutes later; ties excluded from win rate. Exact inverse means the same entry and mark with the direction reversed.",
  "Historical limitation: news was not evaluated and macro was neutral because historical calendar/FRED snapshots were not retained. This tests the technical core only, not the full live/practice policy.",
  `Data window: ${new Date(first).toISOString()} → ${new Date(last).toISOString()}; ${all.length} valid UP/DOWN signals across ${INSTRUMENTS.length} pairs.`,
  `Chronological split: TRAIN through ${new Date(trainEnd).toISOString()} | DEV through ${new Date(devEnd).toISOString()} | HOLDOUT after.`, "",
  "Coverage:", ...coverages, "",
  `TRAIN original: ${format(score(train))}`,
  `TRAIN exact inverse: ${format(score(train, true))}`,
  `DEV original: ${format(developmentOriginal)}`,
  `DEV exact inverse: ${format(developmentInverse)}`,
  `Predeclared gate: at least 100 decided DEV signals, WR > ${(BREAK_EVEN_80 * 100).toFixed(2)}%, Wilson lower bound >50%. Selected for holdout: ${selected?.toUpperCase() ?? "NONE"}.`,
];
if (selected) {
  const result = score(holdout, selected === "inverse");
  lines.push(`HOLDOUT ${selected}: ${format(result)}`, `Holdout verdict: ${qualifies(result) ? "CANDIDATE — requires forward confirmation; do not activate yet." : "FAIL — do not activate or invert."}`);
} else {
  lines.push("HOLDOUT NOT READ — neither the original nor exact inverse passed the fixed DEV gate.");
}
lines.push("", "Development diagnostics only — not selection criteria:");
for (const direction of ["up", "down"] as const) {
  const subset = development.filter((event) => event.direction === direction);
  lines.push(`${direction.toUpperCase()} original: ${format(score(subset))}`, `${direction.toUpperCase()} exact inverse: ${format(score(subset, true))}`);
}
fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`Wrote ${REPORT}`);
