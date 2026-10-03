import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";

type Horizon = "15m" | "30m" | "1h" | "2h" | "4h";
type Direction = "long" | "short";
type Row = { decisionTime: string; candleStart: string; direction: Direction; confidence: number; endpointPips: Record<Horizon, number | null>; correct: Record<Horizon, boolean | null>; mfePips: Partial<Record<Horizon, number | null>>; maePips: Partial<Record<Horizon, number | null>> };
type Candle = ResearchCandle;
const horizons: Horizon[] = ["15m", "30m", "1h", "2h", "4h"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(root, "..", "frontend", "research-output");
const pip = 0.0001;

const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const med = (xs: number[]) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return NaN; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; };
const pct = (n: number, d: number) => d ? 100 * n / d : NaN;
const f = (n: number, d = 1) => Number.isFinite(n) ? n.toFixed(d) : "n/a";
const sign = (v: number) => v > 0 ? 1 : v < 0 ? -1 : 0;
const day = (t: string) => t.slice(0, 10);
const candleMs = (c: Candle) => Date.parse(c.time);

async function load(granularity: string, until: string, needed: number) {
  const result = new Map<string, Candle>(); let to = until;
  while (result.size < needed) {
    const batch = await getResearchCandles("EUR_USD", granularity, 5_000, { to });
    if (!batch.length) break;
    for (const c of batch) result.set(c.time, c);
    const first = [...batch].sort((a, b) => candleMs(a) - candleMs(b))[0]!;
    if (first.time >= to) break;
    to = first.time;
    if (Date.parse(first.time) < Date.parse("2026-05-01T00:00:00Z")) break;
  }
  return [...result.values()].filter((c) => c.complete).sort((a, b) => candleMs(a) - candleMs(b));
}

function baselineDirection(rows: Candle[], at: number, ms: number) {
  const c = rows.filter((x) => candleMs(x) + ms <= at).at(-1);
  return c ? sign(c.mid.close - c.mid.open) : 0;
}

function metric(rows: Row[], label: string, dirs?: Direction[]) {
  const selected = dirs ? rows.filter((r) => dirs.includes(r.direction)) : rows;
  const result = [`${label}: N=${selected.length}; LONG=${selected.filter((r) => r.direction === "long").length}; SHORT=${selected.filter((r) => r.direction === "short").length}`];
  for (const h of horizons) {
    const valid = selected.filter((r) => r.correct[h] !== null);
    const hit = valid.filter((r) => r.correct[h]).length;
    const moves = valid.map((r) => r.endpointPips[h]!).filter(Number.isFinite);
    result.push(`  ${h}: accuracy=${f(pct(hit, valid.length))}% (${hit}/${valid.length}); median signed midpoint move=${f(med(moves))}p`);
  }
  for (const h of horizons) {
    const mfe = selected.map((r) => r.mfePips[h]).filter((x): x is number => typeof x === "number");
    const mae = selected.map((r) => r.maePips[h]).filter((x): x is number => typeof x === "number");
    if (mfe.length || mae.length) result.push(`  ${h}: median MFE=${f(med(mfe))}p; median MAE=${f(med(mae))}p`);
  }
  return result.join("\n");
}

function pearson(xs: number[], ys: number[]) {
  if (xs.length < 2) return NaN;
  const x = avg(xs), y = avg(ys); const den = Math.sqrt(xs.reduce((s, v) => s + (v - x) ** 2, 0) * ys.reduce((s, v) => s + (v - y) ** 2, 0));
  return den ? xs.reduce((s, v, i) => s + (v - x) * (ys[i]! - y), 0) / den : NaN;
}

function regimeForDay(rows: Candle[]) {
  const hi = Math.max(...rows.map((r) => r.mid.high)); const lo = Math.min(...rows.map((r) => r.mid.low));
  const net = (rows.at(-1)!.mid.close - rows[0]!.mid.open) / pip; const range = (hi - lo) / pip; const de = range ? Math.abs(net) / range : 0;
  let flips = 0, prev = 0, overlap = 0, inside = 0;
  const bodies = rows.map((r) => { const z = r.mid.high - r.mid.low; return z ? Math.abs(r.mid.close - r.mid.open) / z : 0; });
  for (let i = 1; i < rows.length; i++) { const a = rows[i - 1]!.mid, b = rows[i]!.mid; const d = sign(b.close - b.open); if (d && prev && d !== prev) flips++; if (d) prev = d; if (Math.min(a.high, b.high) > Math.max(a.low, b.low)) overlap++; if (b.high <= a.high && b.low >= a.low) inside++; }
  const eff: number[] = []; for (let i = 4; i < rows.length; i++) { let path = 0; for (let j = i - 3; j <= i; j++) path += Math.abs(rows[j]!.mid.close - rows[j - 1]!.mid.close); eff.push(path ? Math.abs(rows[i]!.mid.close - rows[i - 4]!.mid.close) / path : 0); }
  // Same frozen M15-proxy CHOP construction used by the prior Sep14 study.
  const nonzero = rows.filter((r) => sign(r.mid.close - r.mid.open)).length;
  const flipRate = nonzero > 1 ? flips / (nonzero - 1) : 0;
  const chop = 100 * (0.2 * flipRate + 0.15 * Math.min(1, flipRate * 1.05) + 0.15 * (1 - avg(bodies)) + 0.15 * overlap / Math.max(1, rows.length - 1) + 0.1 * inside / Math.max(1, rows.length - 1) + 0.15 * (1 - med(eff)));
  const strength = Math.sign(net) * Math.min(10, Math.abs(net) / 5); // compact directional proxy used only for posthoc grouping
  return { de, chop, strength, eff: med(eff), like: de >= .56 && chop <= 51.6 && Math.abs(strength) >= 5.9 && med(eff) >= .52 };
}

async function main() {
  const files = Array.from({ length: 8 }, (_, i) => path.join(out, `sep14-restored-analyzer-hourly-replay-shard-${i}-of-8.json`));
  const shards = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as Row[]));
  const rows = shards.flat().sort((a, b) => a.decisionTime.localeCompare(b.decisionTime));
  if (rows.length !== 1918 || new Set(rows.map((r) => r.decisionTime)).size !== rows.length) throw new Error(`Expected 1,918 unique checkpointed rows; found ${rows.length}.`);
  const m15 = await load("M15", "2026-09-19T05:00:00.000Z", 12_000);
  const h1 = await load("H1", "2026-09-19T05:00:00.000Z", 3_500);
  const h4 = await load("H4", "2026-09-19T05:00:00.000Z", 1_500);
  // Add 15m excursions that were deliberately absent from the first replay checkpoint schema.
  for (const r of rows) { const at = Date.parse(r.decisionTime); const future = m15.filter((c) => candleMs(c) + 15 * 60_000 > at && candleMs(c) + 15 * 60_000 <= at + 15 * 60_000); const signed = (v: number) => (r.direction === "long" ? v - (m15.find((c) => c.time === r.candleStart)!.mid.close) : (m15.find((c) => c.time === r.candleStart)!.mid.close - v)) / pip; const moves = future.flatMap((c) => r.direction === "long" ? [signed(c.mid.high), signed(c.mid.low)] : [signed(c.mid.low), signed(c.mid.high)]); r.mfePips["15m"] = Math.max(0, ...moves); r.maePips["15m"] = Math.max(0, ...moves.map((x) => -x)); }
  const text: string[] = [];
  text.push("SEP14 RESTORED ANALYZER — DIRECTION VALIDATION", "=".repeat(72), "", "STATUS: REPLAYED_ANALYSIS_CALENDAR_OMITTED", "The historical model Outputs were not saved. These are fresh gpt-5-mini / low-reasoning calls through the recovered Sep14 prompt/schema, using the available historical candles. The only intentional prompt difference is upcomingRelevantCalendar: [] authorized by the user. Model aliases and sampling are not snapshot-pinned, so this is direction validation, not exact recovery of the old responses.", "", `Coverage: EURUSD, ${rows[0]!.decisionTime} through ${rows.at(-1)!.decisionTime}; ${rows.length} completed-hour decisions. Future outcome prices are MID only. No spread, fill, P/L, risk/reward, or trade-execution calculation is included.`, "", "1. OVERALL MODEL-DIRECTION OUTCOMES", metric(rows, "ALL"), "", "2. CONFIDENCE BUCKETS (integer convention: <=50, 51-55, 56-60, 61-65, 66-70, >=71)");
  const buckets: [string, (n: number) => boolean][] = [["<=50", n => n <= 50], ["51-55", n => n >= 51 && n <= 55], ["56-60", n => n >= 56 && n <= 60], ["61-65", n => n >= 61 && n <= 65], ["66-70", n => n >= 66 && n <= 70], [">=71", n => n >= 71]];
  for (const [name, test] of buckets) text.push(metric(rows.filter((r) => test(r.confidence)), name));
  text.push("", "3. THRESHOLD TESTS"); for (const [name, test] of [["ALL", (_: number) => true], ["<=50", (n: number) => n <= 50], [">50", (n: number) => n > 50], [">55", (n: number) => n > 55], [">60", (n: number) => n > 60], [">65", (n: number) => n > 65], [">70", (n: number) => n > 70]] as [string, (n: number) => boolean][]) text.push(metric(rows.filter((r) => test(r.confidence)), name));
  text.push("", "4. DIRECTION SPLIT", metric(rows, "LONG recommendations", ["long"]), metric(rows, "SHORT recommendations", ["short"]), "", "5. CONFIDENCE RELATIONSHIP");
  for (const h of horizons) { const valid = rows.filter((r) => r.correct[h] !== null); text.push(`  confidence vs ${h} correctness (Pearson, not probability calibration): r=${f(pearson(valid.map((r) => r.confidence), valid.map((r) => r.correct[h] ? 1 : 0)), 3)}; N=${valid.length}`); }
  text.push("", "6. BASELINES — SAME MIDPOINT ENDPOINTS");
  for (const [name, resolver] of [["Always long", (_: Row) => 1], ["Always short", (_: Row) => -1], ["Previous M15 candle", (r: Row) => baselineDirection(m15, Date.parse(r.decisionTime), 15 * 60_000)], ["Previous H1 candle", (r: Row) => baselineDirection(h1, Date.parse(r.decisionTime), 60 * 60_000)], ["Previous H4 candle", (r: Row) => baselineDirection(h4, Date.parse(r.decisionTime), 4 * 60 * 60_000)]] as [string, (r: Row) => number][]) { const usable = rows.filter((r) => resolver(r)); const lines = [`${name}: N=${usable.length}`]; for (const h of horizons) { const valid = usable.filter((r) => r.endpointPips[h] !== null); const hits = valid.filter((r) => { const actual = (r.direction === "long" ? 1 : -1) * r.endpointPips[h]!; return resolver(r) * actual > 0; }).length; lines.push(`  ${h}: ${f(pct(hits, valid.length))}% (${hits}/${valid.length})`); } text.push(lines.join("\n")); }
  text.push("", "7. POSTHOC FROZEN-REGIME GROUPING");
  const byDay = new Map<string, Candle[]>(); for (const c of m15) { const k = day(c.time); if (k >= "2026-06-01" && k <= "2026-09-18") (byDay.get(k) ?? (byDay.set(k, []), byDay.get(k)!)).push(c); }
  const regimes = new Map<string, ReturnType<typeof regimeForDay>>(); for (const [k, bars] of byDay) if (bars.length >= 80) regimes.set(k, regimeForDay(bars));
  const likeDays = new Set([...regimes].filter(([, x]) => x.like).map(([k]) => k)); const highChop = new Set([...regimes].filter(([, x]) => x.chop > 51.6).map(([k]) => k)); const strongBull = new Set([...regimes].filter(([, x]) => x.strength >= 5.9).map(([k]) => k)); const strongBear = new Set([...regimes].filter(([, x]) => x.strength <= -5.9).map(([k]) => k));
  text.push(`Frozen Sep14-like condition: DE>=0.56, CHOP<=51.6, |direction-strength proxy|>=5.9, median 1h path efficiency>=0.52. The original prior report used a richer H1/H4 trend implementation; this replay report's strength component is explicitly a compact posthoc proxy, so it is a regime stratification—not a confirmation of the original condition.`);
  for (const [name, set] of [["Sep14-like", likeDays], ["High-chop", highChop], ["Strong bullish", strongBull], ["Strong bearish", strongBear]] as [string, Set<string>][]) text.push(metric(rows.filter((r) => set.has(day(r.decisionTime))), `${name} decision rows`));
  text.push("", "8. SEP14 PREDICTION TABLE (REPLAYED_ANALYSIS_CALENDAR_OMITTED)", "UTC time | direction | confidence | +15m | +1h | +4h (signed midpoint pips)");
  const sep14Path = path.join(out, "sep14-restored-analyzer-sep14-replay.json"); const sep14 = JSON.parse(await readFile(sep14Path, "utf8")) as Row[];
  for (const r of sep14.sort((a, b) => a.decisionTime.localeCompare(b.decisionTime))) text.push(`${r.decisionTime} | ${r.direction.toUpperCase()} | ${r.confidence} | ${f(r.endpointPips["15m"]!)} | ${f(r.endpointPips["1h"]!)} | ${f(r.endpointPips["4h"]!)}`);
  text.push("", "9. CLOSEST SAVED MANUAL TRADES (DESCRIPTIVE ONLY)");
  for (const trade of ["2026-09-13T23:28:00.000Z", "2026-09-14T07:38:00.000Z"]) { const nearest = [...sep14].sort((a, b) => Math.abs(Date.parse(a.decisionTime) - Date.parse(trade)) - Math.abs(Date.parse(b.decisionTime) - Date.parse(trade)))[0]!; const gap = Math.round(Math.abs(Date.parse(nearest.decisionTime) - Date.parse(trade)) / 60_000); text.push(`Saved EURUSD short ${trade} -> nearest available replay ${nearest.decisionTime}, ${nearest.direction.toUpperCase()}, confidence ${nearest.confidence}; gap=${gap} minutes; +1h ${f(nearest.endpointPips["1h"]!)}p; +4h ${f(nearest.endpointPips["4h"]!)}p. ${gap > 60 ? "Not a close comparison." : "Descriptive only, not a fill comparison."}`); }
  text.push("", "Conclusion: the full June-Sep hourly replay does not show a model-direction advantage: its 1h and 4h accuracy are both below 50% and below the always-short baseline. A small posthoc Sep14-like group is positive, but it has only 66 valid 4h endpoints, a calendar omission, and a non-exact regime proxy. That is a hypothesis for a separately preregistered retest—not a basis to deploy or alter the production analyzer.");
  await writeFile(path.join(out, "sep14-restored-analyzer-direction-validation.txt"), text.join("\n") + "\n");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
