/**
 * Canonical M1 trend-pullback direction study. Research only: no database
 * writes, no orders, and no production strategy imports.
 *
 * Frozen before scoring: EMA20/50 alignment + 6-bar >=0.75 ATR impulse +
 * 2-3 candle 20-50% pullback that holds EMA50 + close through pullback.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(root, file), override: false });
const OUT = path.join(root, "research-v2", "trend-pullback-binary-v1");
const REPORT = path.join(OUT, "FINAL_REPORT.txt");
const INSTRUMENTS: MajorInstrument[] = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD", "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD"];
const BARS = 20_000, PAGE_SIZE = 5_000, HORIZON = 10, IMPULSE_BARS = 6, ATR_PERIOD = 14, FAST = 20, SLOW = 50;
const MIN_IMPULSE_ATR = 0.75, MIN_RETRACE = 0.20, MAX_RETRACE = 0.50, DEDUP_MS = 15 * 60_000, BE80 = 1 / 1.8;
type Dir = "up" | "down";
type Candle = { time: string; open: number; high: number; low: number; close: number };
type Event = { instrument: string; at: string; ms: number; direction: Dir; entry: number; exit: number; outcome: "won" | "lost" | "tie"; pullbackBars: number; retracement: number };
type Score = { n: number; wins: number; losses: number; ties: number; rate: number | null; low: number | null; high: number | null };

function ema(values: number[], period: number) {
  const out = new Float64Array(values.length).fill(NaN), a = 2 / (period + 1); let prior = values[0]!;
  for (let i = 0; i < values.length; i++) { prior = i === 0 ? values[0]! : values[i]! * a + prior * (1 - a); out[i] = i >= period - 1 ? prior : NaN; }
  return out;
}
function atr(c: Candle[]) {
  const out = new Float64Array(c.length).fill(NaN); let prior = 0;
  for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i]!.high - c[i]!.low, Math.abs(c[i]!.high - c[i - 1]!.close), Math.abs(c[i]!.low - c[i - 1]!.close)); prior = i === 1 ? tr : (prior * (ATR_PERIOD - 1) + tr) / ATR_PERIOD; if (i >= ATR_PERIOD) out[i] = prior; }
  return out;
}
function continuous(c: Candle[], from: number, to: number) { for (let i = from + 1; i <= to; i++) if (Date.parse(c[i]!.time) - Date.parse(c[i - 1]!.time) !== 60_000) return false; return true; }
function wilson(w: number, n: number) { if (!n) return { low: null, high: null }; const z = 1.96, p = w / n, d = 1 + z * z / n, centre = p + z * z / (2 * n), margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return { low: (centre - margin) / d, high: (centre + margin) / d }; }
function score(events: Event[], invert = false): Score { const wins = events.filter((e) => e.outcome === (invert ? "lost" : "won")).length, losses = events.filter((e) => e.outcome === (invert ? "won" : "lost")).length, ties = events.length - wins - losses, n = wins + losses, ci = wilson(wins, n); return { n, wins, losses, ties, rate: n ? wins / n : null, low: ci.low, high: ci.high }; }
function fmt(s: Score) { return `n=${s.n} W/L/T=${s.wins}/${s.losses}/${s.ties} WR=${s.rate == null ? "n/a" : `${(s.rate * 100).toFixed(2)}%`} CI95=[${s.low == null ? "n/a" : `${(s.low * 100).toFixed(2)}%`},${s.high == null ? "n/a" : `${(s.high * 100).toFixed(2)}%`}]`; }
async function fetchM1(instrument: MajorInstrument): Promise<Candle[]> {
  const rows = new Map<string, Candle>(); let cursor: string | undefined;
  for (let page = 0; page < Math.ceil(BARS / PAGE_SIZE) + 1; page++) {
    const raw = await getResearchCandles(instrument, "M1", PAGE_SIZE, cursor ? { to: cursor } : {});
    const batch = raw.filter((c) => c.complete).map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close }));
    if (!batch.length) break;
    for (const candle of batch) rows.set(candle.time, candle);
    cursor = batch.reduce((first, candle) => candle.time < first ? candle.time : first, batch[0]!.time);
    if (rows.size >= BARS) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return [...rows.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-BARS);
}

function collect(instrument: string, candles: Candle[]): Event[] {
  const closes = candles.map((c) => c.close), fast = ema(closes, FAST), slow = ema(closes, SLOW), ranges = atr(candles), events: Event[] = []; let last = -Infinity;
  for (let impulseEnd = Math.max(SLOW + 10, IMPULSE_BARS); impulseEnd < candles.length - HORIZON - 4; impulseEnd++) {
    const a = ranges[impulseEnd]; if (!(a > 0) || !continuous(candles, impulseEnd - IMPULSE_BARS, impulseEnd + HORIZON + 3)) continue;
    const trendUp = fast[impulseEnd]! > slow[impulseEnd]! && fast[impulseEnd]! > fast[impulseEnd - 10]! && slow[impulseEnd]! > slow[impulseEnd - 10]!;
    const trendDown = fast[impulseEnd]! < slow[impulseEnd]! && fast[impulseEnd]! < fast[impulseEnd - 10]! && slow[impulseEnd]! < slow[impulseEnd - 10]!;
    if (!trendUp && !trendDown) continue;
    for (const direction of (trendUp ? ["up"] : ["down"]) as Dir[]) {
      const start = candles[impulseEnd - IMPULSE_BARS + 1]!;
      const impulseExtreme = direction === "up" ? Math.max(...candles.slice(impulseEnd - IMPULSE_BARS + 1, impulseEnd + 1).map((c) => c.high)) : Math.min(...candles.slice(impulseEnd - IMPULSE_BARS + 1, impulseEnd + 1).map((c) => c.low));
      const impulse = direction === "up" ? impulseExtreme - start.low : start.high - impulseExtreme;
      if (impulse < MIN_IMPULSE_ATR * a) continue;
      for (const pullbackBars of [2, 3]) {
        const pullback = candles.slice(impulseEnd + 1, impulseEnd + 1 + pullbackBars);
        const resume = candles[impulseEnd + 1 + pullbackBars]!;
        const counter = pullback.every((c) => direction === "up" ? c.close < c.open : c.close > c.open);
        if (!counter || (direction === "up" ? Math.min(...pullback.map((c) => c.low)) <= slow[impulseEnd]! : Math.max(...pullback.map((c) => c.high)) >= slow[impulseEnd]!)) continue;
        const retrace = direction === "up" ? (impulseExtreme - Math.min(...pullback.map((c) => c.low))) / impulse : (Math.max(...pullback.map((c) => c.high)) - impulseExtreme) / impulse;
        if (retrace < MIN_RETRACE || retrace > MAX_RETRACE) continue;
        const breakLevel = direction === "up" ? Math.max(...pullback.map((c) => c.high)) : Math.min(...pullback.map((c) => c.low));
        if (!(direction === "up" ? resume.close > resume.open && resume.close > breakLevel : resume.close < resume.open && resume.close < breakLevel)) continue;
        const entryIndex = impulseEnd + 1 + pullbackBars, exitIndex = entryIndex + HORIZON, ms = Date.parse(resume.time);
        if (ms - last < DEDUP_MS) continue;
        const entry = resume.close, exit = candles[exitIndex]!.close, outcome = Math.abs(exit - entry) < 1e-10 ? "tie" : (direction === "up" ? exit > entry : exit < entry) ? "won" : "lost";
        events.push({ instrument, at: resume.time, ms, direction, entry, exit, outcome, pullbackBars, retracement: retrace }); last = ms; break;
      }
    }
  }
  return events;
}

fs.mkdirSync(OUT, { recursive: true });
const all: Event[] = [];
for (const instrument of INSTRUMENTS) {
  const candles = await fetchM1(instrument);
  const events = collect(instrument, candles); all.push(...events); console.log(`${instrument}: ${candles.length} M1, ${events.length} canonical events`);
}
all.sort((a, b) => a.ms - b.ms); const first = all[0]?.ms, last = all.at(-1)?.ms;
if (!first || !last) throw new Error("No events found.");
const t60 = first + (last - first) * .60, t80 = first + (last - first) * .80;
const train = all.filter((e) => e.ms <= t60), dev = all.filter((e) => e.ms > t60 && e.ms <= t80), holdout = all.filter((e) => e.ms > t80);
const devNormal = score(dev), devInverse = score(dev, true);
const qualifies = (s: Score) => s.n >= 100 && (s.rate ?? 0) > BE80 && (s.low ?? 0) > .5;
const selected = qualifies(devNormal) ? "continuation" : qualifies(devInverse) ? "inverse" : null;
const lines = [
  "GOLDENXPERIENCE — CANONICAL M1 TREND-PULLBACK DIRECTION STUDY", "Research only. No production strategy, trade, or prediction row changed.", "",
  "FROZEN RULE: EMA20/EMA50 aligned and both sloping for 10 completed M1 bars; 6-bar impulse >=0.75 ATR14; 2-3 countertrend candles retrace 20-50% while holding EMA50; next completed candle closes through pullback; entry=that close; target=mid close 10 minutes later.",
  `Data: ${all.length} events across ${INSTRUMENTS.length} pairs, ${new Date(first).toISOString()} → ${new Date(last).toISOString()}.`, `Chronological: TRAIN through ${new Date(t60).toISOString()} | DEV through ${new Date(t80).toISOString()} | HOLDOUT after.`, "",
  `TRAIN continuation: ${fmt(score(train))}`, `TRAIN exact inverse: ${fmt(score(train, true))}`, `DEV continuation: ${fmt(devNormal)}`, `DEV exact inverse: ${fmt(devInverse)}`,
  `Gate: n>=100, WR>${(BE80 * 100).toFixed(2)}%, Wilson lower >50%. Selected for holdout: ${selected ?? "NONE"}.`,
];
if (selected) { const h = score(holdout, selected === "inverse"); lines.push(`HOLDOUT ${selected}: ${fmt(h)}`, `Holdout verdict: ${h.n >= 100 && (h.rate ?? 0) > BE80 && (h.low ?? 0) > .5 ? "CANDIDATE" : "FAIL"}`); } else lines.push("HOLDOUT NOT READ — neither continuation nor exact inverse passed the fixed DEV gate.");
lines.push("", "By direction (diagnostic):", ...(["up", "down"] as Dir[]).flatMap((d) => [`${d} DEV continuation: ${fmt(score(dev.filter((e) => e.direction === d)))}`, `${d} DEV inverse: ${fmt(score(dev.filter((e) => e.direction === d), true))}`]));
fs.writeFileSync(REPORT, lines.join("\n") + "\n"); console.log(lines.join("\n")); console.log(`Wrote ${REPORT}`);
