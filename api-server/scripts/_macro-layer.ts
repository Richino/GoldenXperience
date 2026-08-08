/**
 * Does macro bias have anything to predict?
 *
 * Real macro inputs — rate expectations, CPI surprises, central-bank stance —
 * are not available here. But whatever drives a currency, it has to show up as
 * that currency moving consistently against *all* its counterparts, and
 * persisting long enough to trade. That is measurable from price alone and it
 * is the premise the whole macro layer rests on.
 *
 * A per-currency strength index is built from every pair the currency appears
 * in, which cancels the counterpart: EUR rising against USD alone is a EUR/USD
 * move, EUR rising against all seven others is EUR strength. The question is
 * then whether past strength predicts future returns.
 *
 * Two horizons matter and they answer different things:
 *   - days to weeks, where macro forces actually operate
 *   - four hours, which is all a same-day bot holding to 16:45 ET can capture
 * A signal can be real at the first and useless at the second.
 *
 * Samples are non-overlapping. Writes nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD", "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY"];
/** Lookback windows for strength, and forward windows to predict, in days. */
const LOOKBACKS = [5, 10, 20, 60];
const FORWARDS = [1, 5, 20];

type Series = Map<string, number>; // date -> close

async function fetchDaily(instrument: string): Promise<Series> {
  const out: Series = new Map();
  let cursor = new Date(Date.now() - 60_000);
  for (let page = 0; page < 3; page += 1) {
    const batch = (await getResearchCandles(instrument as never, "D", 5000, { to: cursor.toISOString() })).filter((c) => c.complete);
    if (!batch.length) break;
    for (const candle of batch as unknown as Array<{ time: string; mid: { close: number } }>) {
      out.set(candle.time.slice(0, 10), candle.mid.close);
    }
    const oldest = Math.min(...batch.map((c) => new Date(c.time).getTime()));
    if (batch.length < 5000) break;
    cursor = new Date(oldest - 1);
  }
  return out;
}

const closes = new Map<string, Series>();
for (const pair of PAIRS) {
  closes.set(pair, await fetchDaily(pair));
  console.log(`${pair}: ${closes.get(pair)!.size} daily bars`);
}

// Dates every pair has, so strength is always measured on the same universe.
const dates = [...closes.get(PAIRS[0]!)!.keys()]
  .filter((date) => PAIRS.every((pair) => closes.get(pair)!.has(date)))
  .sort();
console.log(`\n${dates.length} common trading days: ${dates[0]} to ${dates.at(-1)}\n`);

const CURRENCIES = ["EUR", "USD", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"];

/** Daily log return per pair, and per-currency strength built from them. */
const pairReturn = new Map<string, number[]>();
for (const pair of PAIRS) {
  const series = closes.get(pair)!;
  pairReturn.set(pair, dates.map((date, i) => (i === 0 ? 0 : Math.log(series.get(date)! / series.get(dates[i - 1]!)!))));
}

const strength = new Map<string, number[]>();
for (const currency of CURRENCIES) {
  const daily = dates.map((_, i) => {
    let sum = 0, seen = 0;
    for (const pair of PAIRS) {
      const [base, quote] = pair.split("_");
      if (base === currency) { sum += pairReturn.get(pair)![i]!; seen += 1; }
      else if (quote === currency) { sum -= pairReturn.get(pair)![i]!; seen += 1; }
    }
    return seen ? sum / seen : 0;
  });
  strength.set(currency, daily);
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);

console.log("=== DOES PAST CURRENCY STRENGTH PREDICT FUTURE RETURNS? ===");
const rows: Array<Record<string, unknown>> = [];

for (const lookback of LOOKBACKS) {
  for (const forward of FORWARDS) {
    const xs: number[] = [], ys: number[] = [];
    // Step by the forward window so samples do not overlap.
    for (let i = lookback; i + forward < dates.length; i += forward) {
      for (const pair of PAIRS) {
        const [base, quote] = pair.split("_");
        const baseStrength = mean(strength.get(base!)!.slice(i - lookback, i));
        const quoteStrength = mean(strength.get(quote!)!.slice(i - lookback, i));
        const series = closes.get(pair)!;
        const forwardReturn = Math.log(series.get(dates[i + forward]!)! / series.get(dates[i]!)!);
        xs.push(baseStrength - quoteStrength);
        ys.push(forwardReturn);
      }
    }

    const mx = mean(xs), my = mean(ys);
    const sx = Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)));
    const sy = Math.sqrt(mean(ys.map((y) => (y - my) ** 2)));
    const r = sx && sy ? mean(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / (sx * sy) : 0;
    const t = r * Math.sqrt((xs.length - 2) / Math.max(1e-12, 1 - r * r));

    // Long the strongest decile, short the weakest: what the plan would trade.
    const ordered = xs.map((x, i) => ({ x, y: ys[i]! })).sort((a, b) => a.x - b.x);
    const cut = Math.max(1, Math.floor(ordered.length / 10));
    const top = mean(ordered.slice(-cut).map((o) => o.y));
    const bottom = mean(ordered.slice(0, cut).map((o) => o.y));

    rows.push({
      "strength over": `${lookback}d`,
      "predict next": `${forward}d`,
      samples: xs.length,
      correlation: Number(r.toFixed(4)),
      t: Number(t.toFixed(2)),
      "long-short % ": Number(((top - bottom) * 100).toFixed(3)),
    });
  }
}
console.table(rows);

console.log(`Tests: ${LOOKBACKS.length * FORWARDS.length}. A round trip costs roughly 0.02-0.04% on majors, so a long-short spread under that is not tradeable.`);
console.log("Positive correlation = strength persists (trend). Negative = strength reverses (mean reversion).");
process.exit(0);
