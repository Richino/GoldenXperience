/**
 * The predictability scan, widened to every pair the app follows.
 *
 * The first scan covered the three pairs with stored history and found nothing.
 * That is the most efficiently priced corner of FX, so the obvious follow-up is
 * whether the crosses behave differently: EUR_GBP, GBP_JPY and the rest carry
 * wider spreads and thinner flow, which is where an inefficiency would survive
 * if one existed anywhere here.
 *
 * Same method as before, and the same guardrails: non-overlapping samples, the
 * decile spread read against round-trip cost rather than the p-value, and every
 * pair reported rather than the best one. Candles are pulled from OANDA and
 * held in memory; nothing is written.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const { MAJOR_INSTRUMENTS } = await import("../../frontend/src/types/forex.js");

const PER_HOUR = 4;
const HORIZONS = [1, 4];
const PAGES = Number(process.env.PAGES ?? 8); // 8 x 5000 M15 bars ~= 4 years
const PAIRS = (process.env.PAIRS ? process.env.PAIRS.split(",") : [...MAJOR_INSTRUMENTS]) as string[];

type Bar = { time: string; close: number; high: number; low: number; atr: number; ema21: number; ema50: number; ema200: number; rsi: number; etMinutes: number };

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (const value of values) { prev = value * k + prev * (1 - k); out.push(prev); }
  return out;
}

/** Pages backwards through OANDA until the requested span is covered. */
async function fetchBars(instrument: string): Promise<Bar[]> {
  const byTime = new Map<string, { time: string; open: number; high: number; low: number; close: number }>();
  let cursor = new Date(Date.now() - 60_000);
  for (let page = 0; page < PAGES; page += 1) {
    const batch = (await getResearchCandles(instrument as never, "M15", 5000, { to: cursor.toISOString() })).filter((c) => c.complete);
    if (!batch.length) break;
    // The research feed nests the price series under mid/bid/ask rather than
    // flattening it the way the stored candles do.
    for (const candle of batch as unknown as Array<{ time: string; mid: { open: number; high: number; low: number; close: number } }>) {
      byTime.set(candle.time, { time: candle.time, open: candle.mid.open, high: candle.mid.high, low: candle.mid.low, close: candle.mid.close });
    }
    const oldest = Math.min(...batch.map((c) => new Date(c.time).getTime()));
    cursor = new Date(oldest - 1);
  }

  const raw = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
  const closes = raw.map((r) => r.close), highs = raw.map((r) => r.high), lows = raw.map((r) => r.low);
  const e21 = ema(closes, 21), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const atr: number[] = []; const rsi: number[] = [];
  let prevAtr = 0, avgGain = 0, avgLoss = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const tr = i === 0 ? highs[i]! - lows[i]! : Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!));
    prevAtr = i === 0 ? tr : (prevAtr * 13 + tr) / 14;
    atr.push(prevAtr);
    const change = i === 0 ? 0 : closes[i]! - closes[i - 1]!;
    avgGain = i === 0 ? 0 : (avgGain * 13 + Math.max(0, change)) / 14;
    avgLoss = i === 0 ? 0 : (avgLoss * 13 + Math.max(0, -change)) / 14;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return raw.map((row, i) => {
    const at = new Date(row.time);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    return {
      time: at.toISOString(), close: closes[i]!, high: highs[i]!, low: lows[i]!,
      atr: atr[i]!, ema21: e21[i]!, ema50: e50[i]!, ema200: e200[i]!, rsi: rsi[i]!,
      etMinutes: hour * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? "0"),
    };
  });
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);

function scan(series: Bar[], horizonHours: number) {
  const step = horizonHours * PER_HOUR;
  const samples: Array<{ p: Record<string, number>; forward: number }> = [];

  for (let i = 200; i + step < series.length; i += step) {
    const bar = series[i]!;
    if (bar.atr <= 0) continue;
    if (bar.etMinutes < 3 * 60 || bar.etMinutes >= 16 * 60 + 45) continue;

    let orHigh = -Infinity, orLow = Infinity;
    for (let j = i; j >= Math.max(0, i - 60); j -= 1) {
      const candidate = series[j]!;
      if (candidate.etMinutes < 3 * 60) break;
      if (candidate.etMinutes < 4 * 60) { orHigh = Math.max(orHigh, candidate.high); orLow = Math.min(orLow, candidate.low); }
    }
    const orb = Number.isFinite(orHigh) && Number.isFinite(orLow)
      ? bar.close > orHigh ? (bar.close - orHigh) / bar.atr : bar.close < orLow ? (bar.close - orLow) / bar.atr : 0
      : 0;

    samples.push({
      forward: (series[i + step]!.close - bar.close) / bar.atr,
      p: {
        momentum1h: (bar.close - series[i - PER_HOUR]!.close) / bar.atr,
        emaStack: bar.ema21 > bar.ema50 && bar.ema50 > bar.ema200 ? 1 : bar.ema21 < bar.ema50 && bar.ema50 < bar.ema200 ? -1 : 0,
        rsiCentred: (bar.rsi - 50) / 50,
        stretchFromEma200: (bar.close - bar.ema200) / bar.atr,
        openingRangeBreak: orb,
      },
    });
  }

  const names = Object.keys(samples[0]?.p ?? {});
  let best = { predictor: "-", t: 0, spread: 0 };
  for (const name of names) {
    const xs = samples.map((s) => s.p[name]!), ys = samples.map((s) => s.forward);
    const mx = mean(xs), my = mean(ys);
    const sx = Math.sqrt(mean(xs.map((x) => (x - mx) ** 2))), sy = Math.sqrt(mean(ys.map((y) => (y - my) ** 2)));
    const r = sx && sy ? mean(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / (sx * sy) : 0;
    const t = r * Math.sqrt((samples.length - 2) / Math.max(1e-12, 1 - r * r));
    const ordered = [...samples].sort((a, b) => a.p[name]! - b.p[name]!);
    const cut = Math.max(1, Math.floor(ordered.length / 10));
    const spread = mean(ordered.slice(-cut).map((s) => s.forward)) - mean(ordered.slice(0, cut).map((s) => s.forward));
    if (Math.abs(t) > Math.abs(best.t)) best = { predictor: name, t, spread };
  }
  return { samples: samples.length, ...best };
}

const results: Array<Record<string, unknown>> = [];
for (const pair of PAIRS) {
  try {
    const series = await fetchBars(pair);
    if (series.length < 2000) { console.log(`${pair}: only ${series.length} bars, skipped`); continue; }
    const row: Record<string, unknown> = { pair, bars: series.length, from: series[0]!.time.slice(0, 10) };
    for (const horizon of HORIZONS) {
      const s = scan(series, horizon);
      row[`${horizon}h best`] = s.predictor;
      row[`${horizon}h t`] = Number(s.t.toFixed(2));
      row[`${horizon}h spread`] = Number(s.spread.toFixed(3));
    }
    results.push(row);
    console.log(`${pair}: ${series.length} bars scanned`);
  } catch (error) {
    console.log(`${pair}: fetch failed — ${error instanceof Error ? error.message.slice(0, 80) : "unknown"}`);
  }
}

console.log("\n=== STRONGEST PREDICTOR PER PAIR (of 5 tested, each horizon) ===");
console.table(results);
console.log(`\n${PAIRS.length} pairs x 5 predictors x ${HORIZONS.length} horizons = ${PAIRS.length * 5 * HORIZONS.length} tests.`);
console.log("At that count a |t| near 3 is expected by chance alone. A tradeable edge needs a decile spread above ~0.15-0.20 ATR, not just a t-statistic.");
process.exit(0);
