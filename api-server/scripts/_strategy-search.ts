/**
 * A disciplined search for a better configuration of the day strategy.
 *
 * One expensive pass replays the entry rules over stored candles and records
 * every valid setup. Variants are then simulated cheaply off that record by
 * re-labelling outcomes, so testing a target or a session costs seconds rather
 * than another full replay.
 *
 * The rules that make the result mean anything:
 *
 * - Everything from HOLDOUT_START is sealed. Variants are ranked on the
 *   development period alone, and the holdout is read once, at the end, for the
 *   winner only. A number that has been optimised against is not evidence.
 * - Variants are pre-registered below and vary one factor at a time. Every one
 *   is reported, not just the best, because the best of N attempts flatters
 *   itself by roughly the spread of N draws.
 * - Position-aware selection runs per variant: changing the target changes when
 *   a trade releases, which changes which later setups are even reachable.
 *
 * Writes nothing. Reads candles from the database.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");
const { labelOutcome, selectPositionAwareCandidates } = await import("../src/research.js");
const { evaluateStrategy } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT_START = "2025-08-01T00:00:00Z";
const WINDOW = 260;
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

type Setup = {
  instrument: string;
  decisionTime: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  session: string;
  etHour: number;
  /** Hours of trading left before the 16:45 ET flat. */
  runwayHours: number;
};

function etParts(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour, minutes: hour * 60 + minute };
}

async function loadCandles(instrument: string, timeframe: string): Promise<Candle[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float, volume::float
     FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`,
    [instrument, timeframe],
  );
  return rows.rows.map((row) => ({
    time: new Date(row.close_time as string).toISOString(),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
    volume: Number(row.volume ?? 0), complete: true,
  }));
}

async function loadQuotes(instrument: string): Promise<Quote[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
     FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`,
    [instrument],
  );
  return rows.rows.map((row) => ({
    closeTime: new Date(row.close_time as string).toISOString(),
    bidOpen: Number(row.bid_open), bidHigh: Number(row.bid_high), bidLow: Number(row.bid_low), bidClose: Number(row.bid_close),
    askOpen: Number(row.ask_open), askHigh: Number(row.ask_high), askLow: Number(row.ask_low), askClose: Number(row.ask_close),
  }));
}

/** The one expensive pass: every setup the entry rules accept, with no exit applied. */
async function collectSetups(instrument: string) {
  const [m15, h1, h4, quotes] = await Promise.all([
    loadCandles(instrument, "M15"), loadCandles(instrument, "H1"), loadCandles(instrument, "H4"), loadQuotes(instrument),
  ]);
  const quoteByTime = new Map(quotes.map((quote) => [quote.closeTime, quote]));
  const pip = pipSizeFor(instrument);
  const setups: Setup[] = [];
  let h1Index = 0, h4Index = 0, evaluated = 0;

  for (let index = WINDOW; index < m15.length; index += 1) {
    const decision = m15[index]!.time;
    while (h1Index + 1 < h1.length && h1[h1Index + 1]!.time <= decision) h1Index += 1;
    while (h4Index + 1 < h4.length && h4[h4Index + 1]!.time <= decision) h4Index += 1;
    if (h1Index < WINDOW || h4Index < WINDOW) continue;
    const quote = quoteByTime.get(decision);
    if (!quote) continue;

    const setup = evaluateStrategy({
      instrument: instrument as never,
      accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
      candles15m: m15.slice(index - WINDOW + 1, index + 1),
      candles1h: h1.slice(h1Index - WINDOW + 1, h1Index + 1),
      candles4h: h4.slice(h4Index - WINDOW + 1, h4Index + 1),
      bid: quote.bidClose, ask: quote.askClose,
      spreadPips: (quote.askClose - quote.bidClose) / pip,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: decision,
    });
    evaluated += 1;
    if (setup.status !== "valid" || !setup.direction || setup.entry === null || setup.stop === null) continue;

    const session = setup.conditions.find((item) => item.name === "Session")?.currentValue ?? "Unknown";
    const { hour, minutes } = etParts(new Date(decision));
    setups.push({
      instrument, decisionTime: decision, direction: setup.direction,
      entry: setup.entry, stop: setup.stop, session, etHour: hour,
      runwayHours: (16 * 60 + 45 - minutes) / 60,
    });
  }

  return { setups, quotes, evaluated };
}

type Variant = { name: string; targetR: number; sessions?: string[]; minRunwayHours?: number };

/** Pre-registered, one factor from the baseline at a time. */
const VARIANTS: Variant[] = [
  { name: "baseline (live rules)", targetR: 1.5 },
  { name: "session: drop New York", targetR: 1.5, sessions: ["London", "London/New York overlap"] },
  { name: "session: London only", targetR: 1.5, sessions: ["London"] },
  { name: "target 1.0R", targetR: 1.0 },
  { name: "target 0.75R", targetR: 0.75 },
  { name: "runway >= 3h", targetR: 1.5, minRunwayHours: 3 },
  { name: "runway >= 5h", targetR: 1.5, minRunwayHours: 5 },
];

function simulate(variant: Variant, setups: Setup[], quotesByPair: Map<string, Quote[]>, from: string, to: string) {
  const eligible = setups.filter((setup) =>
    setup.decisionTime >= from && setup.decisionTime < to &&
    (!variant.sessions || variant.sessions.includes(setup.session)) &&
    (variant.minRunwayHours === undefined || setup.runwayHours >= variant.minRunwayHours));

  const labelled = eligible.map((setup) => {
    const risk = Math.abs(setup.entry - setup.stop);
    const target = setup.direction === "long" ? setup.entry + risk * variant.targetR : setup.entry - risk * variant.targetR;
    const quotes = quotesByPair.get(setup.instrument)!;
    const start = quotes.findIndex((quote) => quote.closeTime > setup.decisionTime);
    const result = labelOutcome(setup.direction, setup.entry, setup.stop, target, setup.decisionTime, start < 0 ? [] : quotes.slice(start, start + 400) as never);
    return { ...setup, id: `${setup.instrument}:${setup.decisionTime}`, result };
  });

  // One position at a time, per pair, exactly as the live collector runs.
  const accepted: typeof labelled = [];
  for (const instrument of new Set(labelled.map((item) => item.instrument))) {
    const forPair = labelled.filter((item) => item.instrument === instrument);
    const selections = selectPositionAwareCandidates(forPair.map((item) => ({
      id: item.id, decisionTime: item.decisionTime,
      resolvedAt: item.result.resolvedAt, horizonEndsAt: item.result.horizonEndsAt,
    })) as never) as Array<{ id: string; executionStatus: string }>;
    const ok = new Set(selections.filter((s) => s.executionStatus === "accepted").map((s) => s.id));
    accepted.push(...forPair.filter((item) => ok.has(item.id)));
  }

  const results = accepted.map((item) => item.result.resultR).filter((value): value is number => value !== null);
  const n = results.length;
  const total = results.reduce((sum, value) => sum + value, 0);
  const mean = n ? total / n : 0;
  const sd = n > 1 ? Math.sqrt(results.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    trades: n,
    totalR: Number(total.toFixed(1)),
    avgR: Number(mean.toFixed(4)),
    stdErr: n ? Number((sd / Math.sqrt(n)).toFixed(4)) : 0,
    winPct: n ? Number(((accepted.filter((i) => (i.result.resultR ?? 0) > 0).length / n) * 100).toFixed(1)) : 0,
  };
}

const allSetups: Setup[] = [];
const quotesByPair = new Map<string, Quote[]>();
let evaluatedTotal = 0;

for (const instrument of PAIRS) {
  const started = Date.now();
  const { setups, quotes, evaluated } = await collectSetups(instrument);
  quotesByPair.set(instrument, quotes);
  allSetups.push(...setups);
  evaluatedTotal += evaluated;
  console.log(`${instrument}: ${evaluated} decisions, ${setups.length} valid setups (${Math.round((Date.now() - started) / 1000)}s)`);
}

console.log(`\nTotal: ${evaluatedTotal} decisions evaluated, ${allSetups.length} valid setups`);
console.log(`Development: up to ${HOLDOUT_START} · Holdout sealed from then\n`);

console.log("=== DEVELOPMENT PERIOD — all variants, ranked on this only ===");
const dev = VARIANTS.map((variant) => ({ variant: variant.name, ...simulate(variant, allSetups, quotesByPair, "1900", HOLDOUT_START) }));
console.table(dev);
console.log(`Attempts: ${VARIANTS.length}. The best of ${VARIANTS.length} draws is biased upward; treat any edge under ~2 standard errors as noise.`);

process.exit(0);
