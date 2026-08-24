/**
 * Test structural fixes that can beat spread drag:
 * 1) Consensus — 2+ families agree on direction
 * 2) Tight spread only
 * 3) Early-session runway (enter before 12:00 ET)
 * 4) H1 ATR stop floor (wider stops → lower spread/R)
 * Combined with 0.75R targets matching observed MFE.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { classifyRegime } = await import("../../frontend/src/lib/strategy/regime.js");
const { evaluateEma, DEFAULT_EMA_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/ema.js");
const { evaluateBreakout, DEFAULT_BREAKOUT_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/breakout.js");
const { evaluateMomentum, DEFAULT_MOMENTUM_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/momentum.js");
const { evaluateMeanReversion, DEFAULT_MEANREV_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/meanrev.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2023-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");
const W = 260;

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

type Raw = {
  ms: number; instrument: string; family: string; direction: "long" | "short";
  entry: number; stop: number; atr: number; spreadPips: number; session: string; regime: string;
  etMinutes: number; quoteIndex: number;
};

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
function lastClosedIndex(times: number[], atMs: number, from: number): number {
  let index = from;
  while (index + 1 < times.length && times[index + 1]! <= atMs) index += 1;
  return index;
}
function etMinutes(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
}

const STRATEGIES = [
  { name: "ema", run: (i: never, r: never) => evaluateEma(i, r, DEFAULT_EMA_CONFIG) },
  { name: "breakout", run: (i: never, r: never) => evaluateBreakout(i, r, DEFAULT_BREAKOUT_CONFIG) },
  { name: "momentum", run: (i: never, r: never) => evaluateMomentum(i, r, DEFAULT_MOMENTUM_CONFIG) },
  { name: "meanrev", run: (i: never, r: never) => evaluateMeanReversion(i, r, DEFAULT_MEANREV_CONFIG) },
];

const raw: Raw[] = [];
const quotesByPair = new Map<string, Quote[]>();
const spreads: number[] = [];

for (const instrument of PAIRS) {
  const t0 = Date.now();
  const [m15, h1, h4, quotes] = await Promise.all([
    loadCandles(instrument, "M15"), loadCandles(instrument, "H1"), loadCandles(instrument, "H4"), loadQuotes(instrument),
  ]);
  quotesByPair.set(instrument, quotes);
  if (m15.length < W || h1.length < W || h4.length < W) { console.log(instrument, "skip"); continue; }
  const h1Times = h1.map((c) => Date.parse(c.time));
  const h4Times = h4.map((c) => Date.parse(c.time));
  const quoteTimes = quotes.map((q) => Date.parse(q.closeTime));
  let h1Cursor = 0; let h4Cursor = 0; let quoteCursor = 0;

  for (let index = W; index < m15.length; index += 1) {
    const bar = m15[index]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY) continue;
    h1Cursor = lastClosedIndex(h1Times, atMs, h1Cursor);
    h4Cursor = lastClosedIndex(h4Times, atMs, h4Cursor);
    quoteCursor = lastClosedIndex(quoteTimes, atMs, quoteCursor);
    if (h1Cursor < W || h4Cursor < W) continue;
    const at = new Date(atMs);
    if (!dayTradingSession(at).open) continue;
    const quote = quotes[quoteCursor];
    if (!quote || quoteTimes[quoteCursor] !== atMs) continue;
    const pip = pipSizeFor(instrument as never);
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0)) continue;
    spreads.push(spreadPips);
    const candles15m = m15.slice(index - W + 1, index + 1);
    const input = {
      instrument: instrument as never, accountBalance: 10_000, accountCurrency: "USD" as const, dataSource: "oanda" as const,
      candles15m, candles1h: h1.slice(h1Cursor - W + 1, h1Cursor + 1), candles4h: h4.slice(h4Cursor - W + 1, h4Cursor + 1),
      bid: quote.bidClose, ask: quote.askClose, spreadPips,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: bar.time, evaluationMode: "historical_replay" as const,
    };
    const regime = classifyRegime(instrument as never, candles15m, bar.time);
    for (const strategy of STRATEGIES) {
      const c = strategy.run(input as never, regime as never);
      if (c.status !== "valid" || !c.direction || c.entry == null || c.stop == null) continue;
      raw.push({
        ms: atMs, instrument, family: strategy.name, direction: c.direction,
        entry: c.entry, stop: c.stop, atr: regime.atr ?? 0, spreadPips,
        session: dayTradingSession(at).label, regime: regime.regime,
        etMinutes: etMinutes(at), quoteIndex: quoteCursor,
      });
    }
  }
  console.log(instrument, "setups", raw.filter((r) => r.instrument === instrument).length, `${Math.round((Date.now() - t0) / 1000)}s`);
}

spreads.sort((a, b) => a - b);
const spreadP50 = spreads[Math.floor(spreads.length * 0.5)]!;
const spreadP25 = spreads[Math.floor(spreads.length * 0.25)]!;
console.log(`spread p25=${spreadP25.toFixed(2)} p50=${spreadP50.toFixed(2)} (n=${spreads.length})`);

type Rule = {
  name: string;
  families?: string[];
  minAgree?: number; // consensus across families at same bar/instrument/direction
  maxSpread?: number;
  maxEtMinutes?: number;
  regimes?: string[];
  minStopAtr?: number; // widen stop to at least this ATR
  targetR: number;
  preferFamilies?: string[]; // when consensus, pick stop from this family order
};

const RULES: Rule[] = [
  { name: "baseline each-family 0.75R", targetR: 0.75 },
  { name: "ema only 0.75R", families: ["ema"], targetR: 0.75 },
  { name: "breakout only 0.75R", families: ["breakout"], targetR: 0.75 },
  { name: "consensus≥2 0.75R", minAgree: 2, targetR: 0.75 },
  { name: "consensus≥2 trending 0.75R", minAgree: 2, regimes: ["trending"], targetR: 0.75 },
  { name: "consensus≥2 + spread≤p25 0.75R", minAgree: 2, maxSpread: spreadP25, targetR: 0.75 },
  { name: "consensus≥2 + before 12ET 0.75R", minAgree: 2, maxEtMinutes: 12 * 60, targetR: 0.75 },
  { name: "consensus≥2 + p25 spread + before 12ET 0.75R", minAgree: 2, maxSpread: spreadP25, maxEtMinutes: 12 * 60, targetR: 0.75 },
  { name: "consensus≥3 0.75R", minAgree: 3, targetR: 0.75 },
  { name: "consensus≥2 + stop≥2ATR 0.75R", minAgree: 2, minStopAtr: 2.0, targetR: 0.75 },
  { name: "consensus≥2 + stop≥2ATR 1.0R", minAgree: 2, minStopAtr: 2.0, targetR: 1.0 },
  { name: "ema+breakout agree trending 0.75R", minAgree: 2, families: ["ema", "breakout"], regimes: ["trending"], targetR: 0.75 },
  { name: "ema only + p25 spread + before 12ET + stop≥2ATR 0.75R", families: ["ema"], maxSpread: spreadP25, maxEtMinutes: 12 * 60, minStopAtr: 2.0, targetR: 0.75 },
  { name: "breakout only + p25 + before 12ET + stop≥2ATR 0.75R", families: ["breakout"], maxSpread: spreadP25, maxEtMinutes: 12 * 60, minStopAtr: 2.0, targetR: 0.75 },
];

function summarise(label: string, results: number[]) {
  const n = results.length;
  if (n < 2) return { label, n, avg: "-", win: "-", ci: "-", verdict: "too few", _mean: -999 };
  const net = results.reduce((a, b) => a + b, 0);
  const mean = net / n;
  const se = Math.sqrt(results.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    label, n,
    avg: mean.toFixed(3),
    win: ((100 * results.filter((r) => r > 0).length) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

function simulate(rule: Rule, fromMs: number, toMs: number | null) {
  // Group by instrument+ms for consensus
  const byKey = new Map<string, Raw[]>();
  for (const setup of raw) {
    if (setup.ms < fromMs) continue;
    if (toMs !== null && setup.ms >= toMs) continue;
    if (rule.families && !rule.families.includes(setup.family)) continue;
    if (rule.regimes && !rule.regimes.includes(setup.regime)) continue;
    if (rule.maxSpread !== undefined && setup.spreadPips > rule.maxSpread) continue;
    if (rule.maxEtMinutes !== undefined && setup.etMinutes > rule.maxEtMinutes) continue;
    const key = `${setup.instrument}|${setup.ms}|${setup.direction}`;
    const list = byKey.get(key) ?? [];
    list.push(setup);
    byKey.set(key, list);
  }

  type Pick = Raw & { families: string[] };
  const picks: Pick[] = [];
  for (const [, list] of byKey) {
    const agree = new Set(list.map((x) => x.family)).size;
    if (rule.minAgree && agree < rule.minAgree) continue;
    // Prefer EMA stop geometry, else first
    const ordered = [...list].sort((a, b) => {
      const rank = (f: string) => (rule.preferFamilies ?? ["ema", "breakout", "momentum", "meanrev"]).indexOf(f);
      return rank(a.family) - rank(b.family);
    });
    const chosen = ordered[0]!;
    picks.push({ ...chosen, families: [...new Set(list.map((x) => x.family))] });
  }
  picks.sort((a, b) => a.ms - b.ms);

  const openUntil = new Map<string, number>();
  const results: number[] = [];
  for (const setup of picks) {
    if (setup.ms < (openUntil.get(setup.instrument) ?? 0)) continue;
    let stop = setup.stop;
    const entry = setup.entry;
    if (rule.minStopAtr && setup.atr > 0) {
      const minDist = rule.minStopAtr * setup.atr;
      if (setup.direction === "long") stop = Math.min(stop, entry - minDist);
      else stop = Math.max(stop, entry + minDist);
    }
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const target = setup.direction === "long" ? entry + risk * rule.targetR : entry - risk * rule.targetR;
    const quotes = quotesByPair.get(setup.instrument)!;
    const forward = quotes.slice(setup.quoteIndex + 1, setup.quoteIndex + 401);
    if (!forward.length) continue;
    const outcome = labelOutcome(setup.direction, entry, stop, target, new Date(setup.ms).toISOString(), forward as never);
    if (outcome.resultR === null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(setup.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : setup.ms);
    results.push(outcome.resultR);
  }
  return summarise(rule.name, results);
}

console.log("\n=== DEVELOPMENT ===");
const dev = RULES.map((r) => simulate(r, REPLAY, HOLDOUT));
console.table(dev.map(({ _mean, ...row }) => row));

console.log("\n=== HOLDOUT for best / WINS ===");
const interesting = [...dev].sort((a, b) => b._mean - a._mean).slice(0, 8);
for (const row of interesting) {
  const rule = RULES.find((r) => r.name === row.label)!;
  const hold = simulate(rule, HOLDOUT, null);
  console.log(`${row.label}: dev ${row.avg} (${row.verdict}, n=${row.n}) → hold ${hold.avg} (${hold.verdict}, n=${hold.n})`);
}

process.exit(0);
