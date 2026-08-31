/**
 * Research only. Test whether the sign of a high-impact economic surprise
 * predicts EUR/USD's next four-hour midpoint direction. No strategy is changed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Event = { releaseTimeUtc: string; currency: "EUR" | "USD"; eventName: string; actual: string; forecast: string };
type Calendar = { events: Event[] };
type Surprise = { event: Event; expected: 1 | -1; classification: "growth" | "labor" | "inflation_or_rate" };
type Group = { time: string; expected: 1 | -1; signals: Surprise[]; hasInflationOrRate: boolean };
type Result = { time: string; expected: 1 | -1; y: 0 | 1; signals: Surprise[]; hasInflationOrRate: boolean };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA Practice credentials are required.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("This research replay refuses OANDA live.");
const eventFile = (process.env.EUR_USD_NEWS_EVENT_FILE ?? path.join(root, "research-v2", "eurusd-ff-high-impact-aug2025-jul2026", "events.json")).trim();
const output = (process.env.EUR_USD_NEWS_OUTPUT_DIR ?? path.join(root, "research-v2", "eurusd-news-surprise-direction-v1")).trim();

function numberValue(value: string) {
  const match = value.trim().replace(/,/g, "").match(/^(-?\d+(?:\.\d+)?)\s*([KMB%])?$/i);
  if (!match) return null;
  const unit = (match[2] ?? "").toUpperCase();
  return { value: Number(match[1]), unit };
}
function classify(event: Event): "growth" | "labor" | "inflation_or_rate" | null {
  const name = event.eventName;
  if (/Unemployment (Rate|Claims)/.test(name)) return "labor";
  if (/(CPI|PPI|PCE|Federal Funds Rate|Main Refinancing Rate)/.test(name)) return "inflation_or_rate";
  if (/(Employment Change|Hourly Earnings|GDP|PMI|Job Openings|Retail Sales|Employment Cost|Consumer Sentiment)/.test(name)) return "growth";
  return null;
}
function surpriseFrom(event: Event): Surprise | null {
  const actual = numberValue(event.actual), forecast = numberValue(event.forecast), classification = classify(event);
  if (!actual || !forecast || !classification || actual.unit !== forecast.unit || actual.value === forecast.value) return null;
  // Higher is normally favourable, except unemployment and initial jobless claims.
  const currencyGood = (actual.value > forecast.value ? 1 : -1) * (classification === "labor" ? -1 : 1);
  // A positive EUR surprise is EUR/USD up; a positive USD surprise is EUR/USD down.
  const expected = (currencyGood * (event.currency === "EUR" ? 1 : -1)) as 1 | -1;
  return { event, expected, classification };
}
function hash(value: string, seed: number) { let h = 2166136261 ^ seed; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
function summary(rows: Result[]) {
  const correct = rows.filter((r) => (r.expected === 1 ? 1 : 0) === r.y).length;
  const random = Array.from({ length: 1000 }, (_, seed) => rows.length ? rows.filter((r) => (hash(r.time, seed + 1) & 1) === r.y).length / rows.length : 0).sort((a, b) => a - b);
  return { observations: rows.length, accuracy: rows.length ? correct / rows.length : null, inverseAccuracy: rows.length ? 1 - correct / rows.length : null, randomMean: rows.length ? random.reduce((a, b) => a + b, 0) / random.length : null, randomP95: rows.length ? random[949]! : null };
}
async function fetchM5(start: string, end: string) {
  const all = new Map<string, number>(); let cursor = start;
  for (let page = 0; page < 24; page += 1) {
    const query = new URLSearchParams({ price: "BA", granularity: "M5", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`OANDA M5 fetch failed: ${response.status}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: { c: string }; ask: { c: string } }> };
    const bars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar) => ({ time: new Date(Date.parse(bar.time) + 300_000).toISOString(), close: (Number(bar.bid.c) + Number(bar.ask.c)) / 2 }));
    for (const bar of bars) if (bar.time < end) all.set(bar.time, bar.close);
    if (!bars.length || bars.length < 5000 || bars.at(-1)!.time >= end) break;
    cursor = bars.at(-1)!.time;
  }
  return all;
}

const calendar = JSON.parse(readFileSync(eventFile, "utf8")) as Calendar;
const surprises = calendar.events.map(surpriseFrom).filter((value): value is Surprise => value !== null);
const perTimestamp = new Map<string, Surprise[]>();
for (const surprise of surprises) perTimestamp.set(surprise.event.releaseTimeUtc, [...(perTimestamp.get(surprise.event.releaseTimeUtc) ?? []), surprise]);
const directionalGroups: Group[] = [...perTimestamp.entries()].flatMap(([time, signals]) => {
  const vote = signals.reduce((sum, signal) => sum + signal.expected, 0);
  return vote === 0 ? [] : [{ time, expected: (vote > 0 ? 1 : -1) as 1 | -1, signals, hasInflationOrRate: signals.some((signal) => signal.classification === "inflation_or_rate") }];
}).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
const nonOverlapping: Group[] = [];
for (const group of directionalGroups) { const prior = nonOverlapping.at(-1); if (!prior || Date.parse(group.time) >= Date.parse(prior.time) + 4 * 3_600_000) nonOverlapping.push(group); }
const earliest = Math.min(...calendar.events.map((event) => Date.parse(event.releaseTimeUtc)));
const latest = Math.max(...calendar.events.map((event) => Date.parse(event.releaseTimeUtc)));
const m5 = await fetchM5(new Date(earliest).toISOString(), new Date(latest + 4 * 3_600_000 + 300_000).toISOString());
const results: Result[] = nonOverlapping.flatMap((group) => {
  const start = m5.get(group.time), finish = m5.get(new Date(Date.parse(group.time) + 4 * 3_600_000).toISOString());
  if (start === undefined || finish === undefined || start === finish) return [];
  return [{ ...group, y: finish > start ? 1 as const : 0 as const }];
});
const splitAt = new Date(earliest); splitAt.setUTCMonth(splitAt.getUTCMonth() + 6);
const firstHalf = results.filter((row) => row.time < splitAt.toISOString());
const secondHalf = results.filter((row) => row.time >= splitAt.toISOString());
const report = {
  generatedAt: new Date().toISOString(), verdict: "RESEARCH_ONLY_NO_PROMOTION", scope: { instrument: "EUR_USD", calendarFile: eventFile, source: "user-supplied ForexFactory high-impact EUR/USD calendar plus raw OANDA Practice M5 bid/ask midpoint candles", hypothesis: "economic surprise sign predicts the four-hour EUR/USD direction after release", directionMap: "stronger EUR data -> UP; stronger USD data -> DOWN; higher unemployment/claims -> weaker currency; higher inflation/rates provisionally treated as more hawkish/stronger", groupRule: "same-timestamp numeric releases are voted into one signal; tied votes are WAIT; overlapping four-hour labels are excluded", label: "midpoint close immediately before release to midpoint exactly four hours after release", controls: "exact inverse and 1,000 seeded random-direction arms", excludes: "speeches, nonnumeric releases, missing actual/forecast, event types absent from the original rule, P&L, stops, targets, spreads, execution, and production/paper orders" }, dataIntegrity: { calendarRows: calendar.events.length, numericMappedRows: surprises.length, directionalTimestampGroups: directionalGroups.length, nonOverlappingGroups: nonOverlapping.length, scoredGroups: results.length, skippedForOverlappingOutcome: directionalGroups.length - nonOverlapping.length, chronologicalSplitAt: splitAt.toISOString() }, results: { all: summary(results), chronologicalFirstHalf: summary(firstHalf), chronologicalSecondHalf: summary(secondHalf), byAssumption: { withoutInflationOrRates: summary(results.filter((row) => !row.hasInflationOrRate)), withInflationOrRates: summary(results.filter((row) => row.hasInflationOrRate)) }, secondHalfSample: secondHalf.slice(0, 10).map((row) => ({ time: row.time, expected: row.expected === 1 ? "UP" : "DOWN", actual: row.y === 1 ? "UP" : "DOWN", events: row.signals.map((signal) => `${signal.event.currency} ${signal.event.eventName}: ${signal.event.actual} vs ${signal.event.forecast}`) })) }
};
mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
