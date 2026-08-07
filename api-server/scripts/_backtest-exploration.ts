import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const { evaluateStrategy, ACTIVE_STRATEGY_VERSION, dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { labelOutcome } = await import("../src/research.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");
const { MAJOR_INSTRUMENTS } = await import("../../frontend/src/types/forex.js");

type ResearchCandle = Awaited<ReturnType<typeof getResearchCandles>>[number];
type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

const MONTHS = Number(process.env.MONTHS ?? 24);
const PAIRS = (process.env.PAIRS ? process.env.PAIRS.split(",") : [...MAJOR_INSTRUMENTS]) as string[];
const WINDOW = 260; // the live snapshot fetches 260 candles per timeframe
const TF_MS: Record<string, number> = { M15: 15 * 60_000, H1: 60 * 60_000, H4: 4 * 60 * 60_000 };

function marketOpen(at: Date) {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return !((day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 22));
}

function etDay(at: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Pages backward through OANDA until the whole requested span is covered. */
async function history(instrument: string, timeframe: string, since: Date) {
  const byTime = new Map<string, ResearchCandle>();
  let cursor = new Date(Date.now() - 60_000);
  for (let page = 0; page < 40; page += 1) {
    const batch = (await getResearchCandles(instrument as never, timeframe, 5_000, { to: cursor.toISOString() })).filter((candle) => candle.complete);
    if (!batch.length) break;
    for (const candle of batch) byTime.set(candle.time, candle);
    const oldest = Math.min(...batch.map((candle) => Date.parse(candle.time)));
    if (oldest <= since.getTime()) break;
    cursor = new Date(oldest - 1);
  }
  return [...byTime.values()]
    .filter((candle) => Date.parse(candle.time) >= since.getTime())
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

function toCandles(items: ResearchCandle[]): Candle[] {
  return items.map((item) => ({ time: item.time, open: item.mid.open, high: item.mid.high, low: item.mid.low, close: item.mid.close, volume: item.volume, complete: true }));
}

function toQuotes(items: ResearchCandle[], timeframe: string): Quote[] {
  return items.map((item) => ({
    closeTime: new Date(Date.parse(item.time) + TF_MS[timeframe]!).toISOString(),
    bidOpen: item.bid.open, bidHigh: item.bid.high, bidLow: item.bid.low, bidClose: item.bid.close,
    askOpen: item.ask.open, askHigh: item.ask.high, askLow: item.ask.low, askClose: item.ask.close,
  }));
}

type Accepted = { instrument: string; decisionTime: string; direction: "long" | "short"; resultR: number | null; outcome: string; etHour: number };

const since = new Date(Date.now() - MONTHS * 30 * 24 * 60 * 60_000);
const perPair: Array<{ instrument: string; evaluated: number; valid: number; validDays: number; accepted: number; blockedByOpen: number; sessionOnly: number; sessionOnlyByHour: number[] }> = [];
const accepted: Accepted[] = [];
const tradingDays = new Set<string>();
const startedAt = Date.now();

for (const instrument of PAIRS) {
  const [m15Raw, h1Raw, h4Raw] = await Promise.all([
    history(instrument, "M15", since),
    history(instrument, "H1", new Date(since.getTime() - 60 * 24 * 60 * 60_000)),
    history(instrument, "H4", new Date(since.getTime() - 300 * 24 * 60 * 60_000)),
  ]);
  const m15 = toCandles(m15Raw);
  const h1 = toCandles(h1Raw);
  const h4 = toCandles(h4Raw);
  const m15Quotes = toQuotes(m15Raw, "M15");
  const pip = pipSizeFor(instrument as never);

  let h1Index = 0;
  let h4Index = 0;
  let evaluated = 0;
  let valid = 0;
  let sessionOnly = 0;
  let acceptedCount = 0;
  let blockedByOpen = 0;
  const sessionOnlyByHour = new Array<number>(24).fill(0);
  const validDays = new Set<string>();
  let openUntil = 0;

  for (let index = 0; index < m15.length; index += 1) {
    const closeMs = Date.parse(m15[index]!.time) + TF_MS.M15!;
    const decisionTime = new Date(closeMs);
    if (!marketOpen(decisionTime)) continue;
    while (h1Index + 1 < h1.length && Date.parse(h1[h1Index + 1]!.time) + TF_MS.H1! <= closeMs) h1Index += 1;
    while (h4Index + 1 < h4.length && Date.parse(h4[h4Index + 1]!.time) + TF_MS.H4! <= closeMs) h4Index += 1;
    if (index < WINDOW || h1Index < WINDOW || h4Index < WINDOW) continue;

    const quote = m15Quotes[index]!;
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    const setup = evaluateStrategy({
      instrument: instrument as never,
      accountBalance: 10_000,
      accountCurrency: "USD",
      dataSource: "oanda",
      candles15m: m15.slice(index - WINDOW + 1, index + 1),
      candles1h: h1.slice(h1Index - WINDOW + 1, h1Index + 1),
      candles4h: h4.slice(h4Index - WINDOW + 1, h4Index + 1),
      bid: quote.bidClose,
      ask: quote.askClose,
      spreadPips,
      marketOpen: true,
      calendarConnected: false,
      highImpactNewsWithinMinutes: null,
      newsRequired: false,
      evaluatedAt: decisionTime.toISOString(),
    });
    evaluated += 1;

    const failed = setup.conditions.filter((item) => item.required && !item.passed);
    const inWindow = dayTradingSession(decisionTime).open;
    if (failed.length === 1 && failed[0]!.name === "Session" && !inWindow) {
      sessionOnly += 1;
      sessionOnlyByHour[Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(decisionTime))] += 1;
    }
    if (setup.status !== "valid" || setup.entry === null || setup.stop === null || setup.target === null || !setup.direction) continue;

    valid += 1;
    validDays.add(etDay(decisionTime));
    if (closeMs < openUntil) { blockedByOpen += 1; continue; }

    const outcome = labelOutcome(setup.direction, setup.entry, setup.stop, setup.target, decisionTime.toISOString(), m15Quotes.slice(index + 1, index + 400) as never);
    acceptedCount += 1;
    tradingDays.add(etDay(decisionTime));
    accepted.push({
      instrument,
      decisionTime: decisionTime.toISOString(),
      direction: setup.direction,
      resultR: outcome.outcome === "ambiguous" ? null : outcome.resultR,
      outcome: outcome.outcome,
      etHour: Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(decisionTime)),
    });
    openUntil = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : closeMs + 24 * 60 * 60_000;
  }

  perPair.push({ instrument, evaluated, valid, validDays: validDays.size, accepted: acceptedCount, blockedByOpen, sessionOnly, sessionOnlyByHour });
  console.log(`${instrument}: evaluated ${evaluated}, valid ${valid}, accepted ${acceptedCount}, blocked by an open trade ${blockedByOpen}  (${Math.round((Date.now() - startedAt) / 1000)}s)`);
}

// --- report ---------------------------------------------------------------

const days = new Set<string>();
for (const instrument of PAIRS) void instrument;
const spanDays = perPair.length ? Math.max(...perPair.map((row) => row.evaluated)) / (24 * 4 * 0.71) : 0;
const marketDays = Math.round(spanDays);

console.log(`\n=== ${ACTIVE_STRATEGY_VERSION} · ${MONTHS} months · ${PAIRS.length} pairs ===`);
console.log("pair       valid  accepted  blocked  trades/mkt-day");
for (const row of perPair) {
  console.log(
    `${row.instrument.padEnd(9)} ${String(row.valid).padStart(5)} ${String(row.accepted).padStart(9)} ${String(row.blockedByOpen).padStart(8)}  ${(row.accepted / Math.max(1, marketDays)).toFixed(3)}`,
  );
}

const totalAccepted = accepted.length;
const perDayCounts = new Map<string, number>();
for (const trade of accepted) perDayCounts.set(etDay(new Date(trade.decisionTime)), (perDayCounts.get(etDay(new Date(trade.decisionTime))) ?? 0) + 1);
const distribution = new Map<number, number>();
for (const count of perDayCounts.values()) distribution.set(count, (distribution.get(count) ?? 0) + 1);

console.log(`\ntotal accepted trades: ${totalAccepted} over ~${marketDays} market days`);
console.log(`portfolio rate: ${(totalAccepted / Math.max(1, marketDays)).toFixed(2)} trades per market day`);
console.log(`days with at least one trade: ${perDayCounts.size} (${((perDayCounts.size / Math.max(1, marketDays)) * 100).toFixed(1)}% of market days)`);
console.log("\ntrades on a day  ·  number of days");
for (const [count, dayTotal] of [...distribution.entries()].sort((a, b) => a[0] - b[0])) console.log(`${String(count).padStart(2)}  ·  ${dayTotal}`);

const resolved = accepted.filter((trade) => trade.resultR !== null).map((trade) => trade.resultR!);
const wins = resolved.filter((value) => value > 0);
const losses = resolved.filter((value) => value < 0);
const grossWin = wins.reduce((sum, value) => sum + value, 0);
const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
console.log(`\nresolved ${resolved.length} · win rate ${resolved.length ? ((wins.length / resolved.length) * 100).toFixed(1) : "—"}% · average ${resolved.length ? (resolved.reduce((s, v) => s + v, 0) / resolved.length).toFixed(3) : "—"}R · profit factor ${grossLoss ? (grossWin / grossLoss).toFixed(2) : "—"} · net ${resolved.reduce((s, v) => s + v, 0).toFixed(1)}R`);

const byOutcome = new Map<string, number>();
for (const trade of accepted) byOutcome.set(trade.outcome, (byOutcome.get(trade.outcome) ?? 0) + 1);
console.log("outcomes: " + [...byOutcome.entries()].map(([name, total]) => `${name} ${total}`).join(" · "));

function edge(trades: Accepted[]) {
  const values = trades.filter((trade) => trade.resultR !== null).map((trade) => trade.resultR!);
  if (!values.length) return "no resolved trades";
  const won = values.filter((value) => value > 0);
  const lost = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const gained = won.reduce((sum, value) => sum + value, 0);
  return `${String(values.length).padStart(4)} trades · win ${((won.length / values.length) * 100).toFixed(1).padStart(5)}% · avg ${(values.reduce((s, v) => s + v, 0) / values.length).toFixed(3).padStart(6)}R · PF ${lost ? (gained / lost).toFixed(2) : "—"} · net ${values.reduce((s, v) => s + v, 0).toFixed(1).padStart(7)}R`;
}

console.log("\n--- edge by pair ---");
for (const row of perPair) {
  console.log(`${row.instrument.padEnd(9)} ${edge(accepted.filter((trade) => trade.instrument === row.instrument))}`);
}

console.log("\n--- edge by ET entry hour ---");
for (let hour = 0; hour < 24; hour += 1) {
  const hourTrades = accepted.filter((trade) => trade.etHour === hour);
  if (hourTrades.length) console.log(`${String(hour).padStart(2)}:00  ${edge(hourTrades)}`);
}

console.log("\n--- edge by direction ---");
for (const direction of ["long", "short"] as const) {
  console.log(`${direction.padEnd(9)} ${edge(accepted.filter((trade) => trade.direction === direction))}`);
}

const sessionOnlyByHour = new Array<number>(24).fill(0);
let sessionOnlyTotal = 0;
for (const row of perPair) {
  sessionOnlyTotal += row.sessionOnly;
  row.sessionOnlyByHour.forEach((value, hour) => { sessionOnlyByHour[hour] += value; });
}
console.log(`\nsetups that passed everything EXCEPT the entry window: ${sessionOnlyTotal} (what widening the window would expose)`);
for (let hour = 0; hour < 24; hour += 1) if (sessionOnlyByHour[hour]) console.log(`${String(hour).padStart(2)}:00 ET  ${sessionOnlyByHour[hour]}`);

console.log(`\ndone in ${Math.round((Date.now() - startedAt) / 1000)}s`);
void days;
