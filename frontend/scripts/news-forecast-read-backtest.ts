/**
 * Backtest of the forecast-vs-previous read on the live news journal.
 *
 *   npx tsx scripts/news-forecast-read-backtest.ts <export.json>
 *
 * Input: rows exported from news_predictions (source = 'live', scored). Each
 * release is read as Bullish (+1) / Slightly bullish (+0.5) / Neutral (0) /
 * Slightly bearish (−0.5) / Bearish (−1) for its currency. Releases for the
 * same currency at the same moment are added up, so the dominant read wins.
 *
 * Scored two ways:
 *  - surprise: did the actuals (vs forecast) come out the way the read said?
 *  - price: did the currency move that way in the 30 minutes after release,
 *    counted across the app's pairs that contain it (OANDA M5 mid candles)?
 * Read-only: OANDA candle reads only, no database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { forecastRead } from "../src/lib/news/forecast-read";
import { newsSurpriseHint } from "../src/lib/news/surprise-hint";
import { getCandles } from "../src/lib/oanda/client";
import { MAJOR_INSTRUMENTS } from "../src/types/forex";

// OANDA credentials live in the API server's env file (run from frontend/).
for (const line of readFileSync(path.resolve(process.cwd(), "../api-server/.env"), "utf8").split(/\r?\n/)) {
  const match = line.match(/^(OANDA_[A-Z_]+)=(.*)$/);
  if (match && !process.env[match[1]!]) process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
}

type Row = {
  title: string; currency: string; impact: number | null; event_time: string;
  forecast: string | null; previous: string | null; actual: string | null;
  outcome: "beat" | "miss" | "inline"; call: "beat" | "miss" | null; currency_call: "up" | "down" | null; correct: boolean | null;
};

const rows = (JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Row[]).filter((row) => row.correct !== null);
const WINDOW_MIN = 30;

const score = (row: Row) => {
  const read = forecastRead(row);
  if (!read || read.direction === "flat") return { read, points: 0 };
  return { read, points: (read.direction === "up" ? 1 : -1) * (read.weight === 2 ? 1 : 0.5) };
};
const label = (points: number) =>
  points >= 1 ? "Bullish" : points > 0 ? "Slightly bullish" : points <= -1 ? "Bearish" : points < 0 ? "Slightly bearish" : "Neutral";

// Group: same currency, same release time.
const groups = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.currency}|${Date.parse(row.event_time)}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}

async function currencyMove(currency: string, time: string) {
  const start = Date.parse(time);
  const pairs = MAJOR_INSTRUMENTS.filter((pair) => pair.split("_").includes(currency));
  let gains = 0, measured = 0, pipsSum = 0;
  for (const pair of pairs) {
    const to = new Date(start + (WINDOW_MIN + 10) * 60_000).toISOString();
    const result = await getCandles(pair, "M5", 12, { to });
    const candles = result.status.state === "connected" ? result.data.candles : [];
    const time = (c: { time?: string; timestamp?: string }) => Date.parse((c.time ?? c.timestamp)!);
    const first = candles.find((c) => time(c as never) === start);
    const last = candles.find((c) => time(c as never) === start + (WINDOW_MIN - 5) * 60_000);
    if (!first || !last) continue;
    const pip = pair.includes("JPY") ? 0.01 : 0.0001;
    const pips = (last.close - first.open) / pip * (pair.startsWith(currency) ? 1 : -1);
    measured += 1;
    pipsSum += pips;
    if (pips > 0) gains += 1;
  }
  if (!measured) return null;
  return { direction: gains * 2 > measured ? "up" as const : gains * 2 < measured ? "down" as const : null, avgPips: pipsSum / measured, measured };
}

type Tally = { n: number; right: number };
const tally = () => ({ n: 0, right: 0 });
const add = (t: Tally, right: boolean) => { t.n += 1; if (right) t.right += 1; };
const results = {
  readSurprise: tally(), readPrice: tally(),
  appSurprise: tally(), appPrice: tally(),
  byStrength: new Map<string, { surprise: Tally; price: Tally; pips: number }>(),
};
const lines: string[] = [];
let neutral = 0, noPrice = 0;

async function main() {
for (const [key, group] of groups) {
  const [currency] = key.split("|") as [string];
  const scored = group.map((row) => ({ row, ...score(row) }));
  const total = scored.reduce((sum, entry) => sum + entry.points, 0);
  const readDir = total > 0 ? "up" : total < 0 ? "down" : null;

  // What the actuals said: each release's surprise for the currency, added up.
  const surprise = group.reduce((sum, row) => {
    const hint = newsSurpriseHint(row);
    return sum + (hint.kind === "after" ? (hint.direction === "up" ? 1 : hint.direction === "down" ? -1 : 0) : 0);
  }, 0);
  const surpriseDir = surprise > 0 ? "up" : surprise < 0 ? "down" : null;
  // The app's own call for the group (journal currency_call; majority when several).
  const appSum = group.reduce((sum, row) => sum + (row.currency_call === "up" ? 1 : row.currency_call === "down" ? -1 : 0), 0);
  const appDir = appSum > 0 ? "up" : appSum < 0 ? "down" : null;

  const price = await currencyMove(currency, group[0]!.event_time);
  if (!price) noPrice += 1;

  if (!readDir) neutral += 1;
  else {
    const strength = label(total);
    const bucket = results.byStrength.get(strength) ?? { surprise: tally(), price: tally(), pips: 0 };
    results.byStrength.set(strength, bucket);
    if (surpriseDir) { add(results.readSurprise, readDir === surpriseDir); add(bucket.surprise, readDir === surpriseDir); }
    if (price?.direction) {
      add(results.readPrice, readDir === price.direction);
      add(bucket.price, readDir === price.direction);
      bucket.pips += (readDir === "up" ? 1 : -1) * price.avgPips;
    }
  }
  if (appDir) {
    if (surpriseDir) add(results.appSurprise, appDir === surpriseDir);
    if (price?.direction) add(results.appPrice, appDir === price.direction);
  }
  lines.push(`${group[0]!.event_time.slice(0, 16)} ${currency} ${scored.map((e) => `${e.row.title} [${e.read?.label ?? "no read"}]`).join(" + ")} → ${label(total)} (${total >= 0 ? "+" : ""}${total}) | surprise ${surpriseDir ?? "flat"} | price ${price?.direction ?? "n/a"} ${price ? `${price.avgPips >= 0 ? "+" : ""}${price.avgPips.toFixed(1)}p` : ""}`);
}

const pct = (t: Tally) => (t.n ? `${t.right}/${t.n} (${Math.round((t.right / t.n) * 100)}%)` : "—");
console.log(lines.join("\n"));
console.log(`\nReleases: ${rows.length} in ${groups.size} release moments (${neutral} read Neutral, ${noPrice} without price data)\n`);
console.log(`Forecast read  vs surprise: ${pct(results.readSurprise)}   vs price (30 min): ${pct(results.readPrice)}`);
console.log(`App's own call vs surprise: ${pct(results.appSurprise)}   vs price (30 min): ${pct(results.appPrice)}`);
console.log("\nBy strength of the combined read:");
for (const strength of ["Bullish", "Slightly bullish", "Slightly bearish", "Bearish"]) {
  const bucket = results.byStrength.get(strength);
  if (!bucket) continue;
  console.log(`  ${strength.padEnd(17)} surprise ${pct(bucket.surprise).padEnd(14)} price ${pct(bucket.price).padEnd(14)} avg ${(bucket.pips / Math.max(bucket.price.n, 1)).toFixed(1)} pips with the read`);
}
}

void main();
