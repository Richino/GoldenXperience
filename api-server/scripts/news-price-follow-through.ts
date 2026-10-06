/**
 * Does price follow the news? For every journal release with a beat/miss
 * (news_predictions, backfill + live), the direction the result implies for
 * its currency (polarity × beat/miss) against what the currency did over the
 * next 15 and 60 minutes, measured like the news sheet: the currency rose if
 * it gained against most of its 7 major pairs from the release candle's open.
 *
 * If price followed the implied direction about half the time, inverting a
 * call cannot help: it only swaps which half you are on.
 *
 *   npx tsx scripts/news-price-follow-through.ts
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { STRENGTH_PAIRS } from "../../frontend/src/lib/strategy/pair-strength.js";
import { eventCurrencyPolarity } from "../../frontend/src/lib/news/event-polarity.js";
import { parseCalendarValue } from "../../frontend/src/lib/news/surprise-hint.js";
import { query } from "../src/database.js";

const MINUTE = 60_000;
type Bar = { t: number; open: number; close: number };

async function fetchM5(instrument: string, sinceMs: number): Promise<Bar[]> {
  const out = new Map<number, Bar>();
  let to = Date.now() - 5 * MINUTE;
  for (;;) {
    let batch: ResearchCandle[] = [];
    for (let attempt = 1; ; attempt += 1) {
      try { batch = await getResearchCandles(instrument as never, "M5", 5000, { to: new Date(to).toISOString() }); break; }
      catch (error) { if (attempt >= 4) throw error; await new Promise((resolve) => setTimeout(resolve, 3000 * attempt)); }
    }
    if (!batch.length) break;
    for (const candle of batch) if (candle.complete) out.set(Date.parse(candle.time), { t: Date.parse(candle.time), open: candle.mid.open, close: candle.mid.close });
    const earliest = Math.min(...batch.map((candle) => Date.parse(candle.time)));
    if (earliest <= sinceMs || batch.length < 5000) break;
    to = earliest - 1;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** Pair move (close at release+minutes) minus the release candle's open; null without data. */
function move(bars: Bar[], release: number, minutes: number): number | null {
  let lo = 0; let hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.t < release - MINUTE) lo = mid + 1; else hi = mid; }
  const start = bars[lo];
  if (!start || start.t > release + 10 * MINUTE) return null;
  const end = release + minutes * MINUTE;
  let last: Bar | null = null;
  for (let index = lo; index < bars.length && bars[index]!.t + 5 * MINUTE <= end; index += 1) last = bars[index]!;
  return last ? last.close - start.open : null;
}

async function main() {
  const rows = (await query<{ title: string; currency: string; impact: number | null; event_time: Date; forecast: string | null; actual: string | null; source: string; call: string | null }>(
    "SELECT title, currency, impact, event_time, forecast, actual, source, call FROM news_predictions WHERE actual IS NOT NULL",
  )).rows;
  const since = Math.min(...rows.map((row) => row.event_time.getTime())) - 86_400_000;
  const bars: Record<string, Bar[]> = {};
  for (const pair of STRENGTH_PAIRS) { bars[pair] = await fetchM5(pair, since); console.error(`${pair} ${bars[pair]!.length}`); }

  type Result = { impact: number; currency: string; source: string; expected: 1 | -1; callDir: 1 | -1 | null; m15: 1 | -1 | null; m60: 1 | -1 | null };
  const results: Result[] = [];
  for (const row of rows) {
    const polarity = eventCurrencyPolarity(row.title);
    const actual = parseCalendarValue(row.actual);
    const forecast = parseCalendarValue(row.forecast);
    if (polarity === null || actual === null || forecast === null) continue;
    const epsilon = Math.max(Math.abs(forecast) * 0.001, 1e-9);
    const surprise = actual - forecast > epsilon ? 1 : forecast - actual > epsilon ? -1 : 0;
    if (surprise === 0) continue;
    const release = row.event_time.getTime();
    const direction = (minutes: number): 1 | -1 | null => {
      let gains = 0; let measured = 0;
      for (const pair of STRENGTH_PAIRS) {
        const [base, quote] = pair.split("_");
        if (base !== row.currency && quote !== row.currency) continue;
        const m = move(bars[pair]!, release, minutes);
        if (m === null || m === 0) continue;
        measured += 1;
        if ((base === row.currency) === (m > 0)) gains += 1;
      }
      if (measured < 4 || gains * 2 === measured) return null;
      return gains * 2 > measured ? 1 : -1;
    };
    const callDir = row.call ? (polarity * (row.call === "beat" ? 1 : -1) > 0 ? 1 : -1) : null;
    results.push({ impact: row.impact ?? -1, currency: row.currency, source: row.source, expected: polarity * surprise > 0 ? 1 : -1, callDir, m15: direction(15), m60: direction(60) });
  }

  const rate = (label: string, subset: Result[], pick: (r: Result) => 1 | -1 | null, against: (r: Result) => 1 | -1 | null = (r) => r.expected) => {
    const scored = subset.filter((r) => pick(r) !== null && against(r) !== null);
    const hits = scored.filter((r) => pick(r) === against(r)).length;
    const n = scored.length;
    const p = n ? hits / n : 0;
    const ci = n ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 0;
    console.log(`${label.padEnd(44)} n ${String(n).padStart(5)}  followed ${(100 * p).toFixed(1).padStart(5)}% ±${(100 * ci).toFixed(1)}  → inverted ${(100 * (1 - p)).toFixed(1)}%`);
  };
  console.log(`\nreleases with a beat/miss and a known polarity: ${results.length}\n`);
  console.log("Price moved the way the RESULT implied (perfect knowledge of beat/miss):");
  rate("  first 15 min, all", results, (r) => r.m15);
  rate("  first 60 min, all", results, (r) => r.m60);
  for (const impact of [...new Set(results.map((r) => r.impact))].sort()) rate(`  60 min, impact ${impact}`, results.filter((r) => r.impact === impact), (r) => r.m60);
  for (const currency of [...new Set(results.map((r) => r.currency))].sort()) rate(`  60 min, ${currency}`, results.filter((r) => r.currency === currency), (r) => r.m60);
  const live = results.filter((r) => r.callDir !== null);
  console.log("\nYour live calls (call direction vs price):");
  rate("  first 60 min", live, (r) => r.m60, (r) => r.callDir);
  rate("  call vs result (was the beat/miss call right)", live, (r) => r.callDir, (r) => r.expected);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
