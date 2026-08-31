/**
 * Research only: score the frozen EUR/USD price-only trend learner at supplied
 * high-impact event windows.  Calendar data selects windows; it is never an
 * input feature.  Every model is trained only through the prior calendar month.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Bar = { time: string; close: number; high: number; low: number };
type Row = { time: string; y: 0 | 1; x: number[] };
type Model = { mean: number[]; scale: number[]; weights: number[]; bias: number };
type Event = { releaseTimeUtc: string; actual: string; forecast: string; currency: "EUR" | "USD"; eventName: string };
type Calendar = { events: Event[] };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("OANDA Practice credentials are required.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("This research replay refuses OANDA live.");

const START = "2022-08-01T00:00:00.000Z";
const END = "2026-08-01T00:00:00.000Z";
const EVENT_FILE = path.join(root, "research-v2", "eurusd-ff-high-impact-aug2025-jul2026", "events.json");
const OUTPUT = path.join(root, "research-v2", "eurusd-price-model-at-news-v1");
const CONFIDENCE_MARGIN = 0.02;

function sigmoid(v: number) { return v >= 0 ? 1 / (1 + Math.exp(-v)) : Math.exp(v) / (1 + Math.exp(-v)); }
function ema(values: number[], n: number) { const out = [values[0]!], k = 2 / (n + 1); for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k)); return out; }
function atr(bars: Bar[], n = 14) { const out = new Array<number>(bars.length).fill(NaN); let v = 0; for (let i = 0; i < bars.length; i++) { const b = bars[i]!, prev = bars[i - 1]; const tr = prev ? Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)) : b.high - b.low; if (i < n) { v += tr; if (i === n - 1) out[i] = v / n; } else { v = (out[i - 1]! * (n - 1) + tr) / n; out[i] = v; } } return out; }
function slope(values: number[]) { const mx = (values.length - 1) / 2, my = values.reduce((a, b) => a + b, 0) / values.length; let top = 0, bottom = 0; for (let i = 0; i < values.length; i++) { top += (i - mx) * (values[i]! - my); bottom += (i - mx) ** 2; } return bottom ? top / bottom : 0; }
function monthStart(iso: string) { const d = new Date(iso); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); }
function hash(value: string, seed: number) { let h = 2166136261 ^ seed; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }

async function fetchH1() {
  const all = new Map<string, Bar>(); let cursor = START;
  for (let page = 0; page < 20; page += 1) {
    const q = new URLSearchParams({ price: "BA", granularity: "H1", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`OANDA H1 fetch failed: ${response.status}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const bars = (payload.candles ?? []).filter((b) => b.complete).map((b) => { const mid = (key: string) => (Number(b.bid[key]) + Number(b.ask[key])) / 2; return { time: new Date(Date.parse(b.time) + 3_600_000).toISOString(), close: mid("c"), high: mid("h"), low: mid("l") }; });
    for (const bar of bars) if (bar.time < END) all.set(bar.time, bar);
    if (!bars.length || bars.length < 5000 || bars.at(-1)!.time >= END) break;
    cursor = bars.at(-1)!.time;
  }
  return [...all.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
async function fetchM5() {
  const all = new Map<string, number>(); let cursor = "2025-08-01T00:00:00.000Z";
  for (let page = 0; page < 24; page += 1) {
    const q = new URLSearchParams({ price: "BA", granularity: "M5", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`OANDA M5 fetch failed: ${response.status}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const bars = (payload.candles ?? []).filter((b) => b.complete).map((b) => ({ time: new Date(Date.parse(b.time) + 300_000).toISOString(), close: (Number(b.bid.c) + Number(b.ask.c)) / 2 }));
    for (const bar of bars) if (bar.time < END) all.set(bar.time, bar.close);
    if (!bars.length || bars.length < 5000 || bars.at(-1)!.time >= END) break;
    cursor = bars.at(-1)!.time;
  }
  return all;
}

function makeRows(bars: Bar[]) {
  const close = bars.map((b) => b.close), a14 = atr(bars, 14), a48 = atr(bars, 48), e8 = ema(close, 8), e21 = ema(close, 21), e50 = ema(close, 50);
  const at = (i: number, label = true): Row | null => {
    if (i < 48 || i + 4 >= bars.length || !Number.isFinite(a14[i]) || !Number.isFinite(a48[i])) return null;
    const unit = a14[i]!, w = bars.slice(i - 23, i + 1), lo = Math.min(...w.map((b) => b.low)), hi = Math.max(...w.map((b) => b.high));
    const future = bars[i + 4]!;
    if (label && future.close === bars[i]!.close) return null;
    return { time: bars[i]!.time, y: future.close > bars[i]!.close ? 1 : 0, x: [(bars[i]!.close - bars[i - 4]!.close) / unit, (bars[i]!.close - bars[i - 12]!.close) / unit, slope(close.slice(i - 23, i + 1)) / unit, (e8[i]! - e21[i]!) / unit, (e21[i]! - e50[i]!) / unit, hi === lo ? 0 : (bars[i]!.close - lo) / (hi - lo) - .5, a14[i]! / a48[i]!] };
  };
  const train: Row[] = [], all: Array<Row | null> = [];
  for (let i = 0; i < bars.length; i++) { const row = at(i); all.push(row); if (row && new Date(row.time).getUTCHours() % 4 === 0 && row.time >= "2022-09-01T00:00:00.000Z") train.push(row); }
  return { train, all };
}
function fit(rows: Row[]): Model {
  if (!rows.length) throw new Error("No prior rows available for model training.");
  const n = rows[0]!.x.length, mean = Array.from({ length: n }, (_, j) => rows.reduce((sum, r) => sum + r.x[j]!, 0) / rows.length), scale = mean.map((m, j) => Math.max(1e-8, Math.sqrt(rows.reduce((sum, r) => sum + (r.x[j]! - m) ** 2, 0) / rows.length)));
  const weights = new Array<number>(n).fill(0); let bias = 0;
  for (let epoch = 0; epoch < 700; epoch++) { const g = new Array<number>(n).fill(0); let gb = 0; for (const r of rows) { const x = r.x.map((v, j) => (v - mean[j]!) / scale[j]!); const error = sigmoid(bias + x.reduce((sum, v, j) => sum + v * weights[j]!, 0)) - r.y; for (let j = 0; j < n; j++) g[j] += error * x[j]!; gb += error; } for (let j = 0; j < n; j++) weights[j] -= .04 * (g[j]! / rows.length + .03 * weights[j]!); bias -= .04 * gb / rows.length; }
  return { mean, scale, weights, bias };
}
function predict(model: Model, row: Row) { return sigmoid(model.bias + row.x.reduce((sum, v, j) => sum + ((v - model.mean[j]!) / model.scale[j]!) * model.weights[j]!, 0)); }
function summarize(rows: Array<{ time: string; y: 0 | 1; probability: number }>) {
  const selected = rows.filter((r) => Math.abs(r.probability - .5) >= CONFIDENCE_MARGIN);
  const correct = selected.filter((r) => (r.probability >= .5 ? 1 : 0) === r.y).length;
  const random = Array.from({ length: 1000 }, (_, seed) => selected.length ? selected.filter((r) => (hash(r.time, seed + 1) & 1) === r.y).length / selected.length : 0).sort((a, b) => a - b);
  return { observations: rows.length, selected: selected.length, wait: rows.length - selected.length, accuracy: selected.length ? correct / selected.length : null, inverseAccuracy: selected.length ? 1 - correct / selected.length : null, randomMean: selected.length ? random.reduce((a, b) => a + b, 0) / random.length : null, randomP95: selected.length ? random[949]! : null };
}

const calendar = JSON.parse(readFileSync(EVENT_FILE, "utf8")) as Calendar;
const events = [...new Map(calendar.events.map((event) => [event.releaseTimeUtc, event])).values()].sort((a, b) => Date.parse(a.releaseTimeUtc) - Date.parse(b.releaseTimeUtc));
// A four-hour direction label cannot be counted twice when another release lands
// inside that same four-hour outcome interval. Keep the first timestamp only.
const nonOverlappingEvents: Event[] = [];
for (const event of events) {
  const prior = nonOverlappingEvents.at(-1);
  if (!prior || Date.parse(event.releaseTimeUtc) >= Date.parse(prior.releaseTimeUtc) + 4 * 3_600_000) nonOverlappingEvents.push(event);
}
const bars = await fetchH1(); const m5 = await fetchM5(); const { train, all } = makeRows(bars);
const models = new Map<string, Model>();
function modelFor(time: string) { const cutoff = monthStart(time); let model = models.get(cutoff); if (!model) { model = fit(train.filter((row) => row.time < cutoff)); models.set(cutoff, model); } return model; }
const scored = nonOverlappingEvents.flatMap((event) => {
  const release = Date.parse(event.releaseTimeUtc); let i = -1;
  for (let j = bars.length - 1; j >= 0; j -= 1) if (Date.parse(bars[j]!.time) <= release) { i = j; break; }
  const entry = m5.get(event.releaseTimeUtc), target = m5.get(new Date(release + 4 * 3_600_000).toISOString());
  if (i < 0 || entry === undefined || target === undefined || target === entry) return [];
  const row = all[i]; if (!row) return [];
  return [{ time: event.releaseTimeUtc, y: target > entry ? 1 as const : 0 as const, probability: predict(modelFor(event.releaseTimeUtc), row), currency: event.currency, eventName: event.eventName }];
});
const development = scored.filter((row) => row.time < "2026-02-01T00:00:00.000Z");
const finalHoldout = scored.filter((row) => row.time >= "2026-02-01T00:00:00.000Z");
const report = {
  generatedAt: new Date().toISOString(), verdict: "RESEARCH_ONLY_NO_PROMOTION", scope: { instrument: "EUR_USD", priceData: "raw OANDA Practice H1 features plus M5 bid/ask midpoint outcome marks", calendarData: "user-supplied high-impact EUR/USD release timestamps; calendar is evaluation-only, not a feature", decision: "last completed H1 close before release", label: "M5 midpoint direction from the last completed pre-release M5 close to exactly four hours after the release", training: "same frozen price-only logistic model; retrained at calendar-month starts using only prior 4-hour decision rows", controls: "exact inverse and 1,000 seeded random-direction arms", excludes: "actual/forecast surprise values, stop/target P&L, spreads, execution, and production/paper orders" }, dataIntegrity: { calendarRows: calendar.events.length, uniqueReleaseTimestamps: events.length, nonOverlappingReleaseWindows: nonOverlappingEvents.length, scoredWindows: scored.length, groupedSameTimestampRows: calendar.events.length - events.length, droppedForOverlappingFourHourOutcomes: events.length - nonOverlappingEvents.length }, results: { allNewsWindows: summarize(scored), developmentSummary: summarize(development), finalHoldoutSummary: summarize(finalHoldout), finalHoldoutSample: finalHoldout.slice(0, 10) }
};
mkdirSync(OUTPUT, { recursive: true }); writeFileSync(path.join(OUTPUT, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
