/**
 * Is there anything predictable in these pairs at this timeframe at all?
 *
 * No entries, no stops, no targets — just: does a candidate predictor line up
 * with what price does next. Strip the strategy away and you find out whether
 * there is signal to build on before spending weeks building on it.
 *
 * Two things keep the numbers honest:
 *
 * - Samples are non-overlapping. A 4-hour forward return measured on every bar
 *   shares 15 of its 16 bars with its neighbour, which manufactures confidence
 *   out of nothing. Each horizon steps by its own length instead.
 * - The sample is large enough that a correlation of 0.01 is "significant" and
 *   worth nothing. The decile spread is the column to read: the average forward
 *   move when the predictor is in its top tenth versus its bottom tenth, in ATR.
 *   That has to clear round-trip costs before it is worth anything.
 *
 * Development period only. The holdout stays sealed. Writes nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");

const HOLDOUT_START = "2025-08-01T00:00:00Z";
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
/** Bars per hour on M15, and the horizons scored, in hours. */
const PER_HOUR = 4;
const HORIZONS = [1, 2, 4];

type Bar = { time: string; close: number; high: number; low: number; atr: number; ema21: number; ema50: number; ema200: number; rsi: number; etMinutes: number };

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0]!;
  for (const value of values) { prev = value * k + prev * (1 - k); out.push(prev); }
  return out;
}

async function loadBars(instrument: string): Promise<Bar[]> {
  const rows = (await query<Record<string, unknown>>(
    `SELECT close_time, high::float, low::float, close::float FROM market_candles
     WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time < $2 ORDER BY close_time`,
    [instrument, HOLDOUT_START],
  )).rows;

  const closes = rows.map((r) => Number(r.close));
  const highs = rows.map((r) => Number(r.high));
  const lows = rows.map((r) => Number(r.low));
  const e21 = ema(closes, 21), e50 = ema(closes, 50), e200 = ema(closes, 200);

  // Wilder ATR and RSI, rolled forward.
  const atr: number[] = []; const rsi: number[] = [];
  let prevAtr = 0, avgGain = 0, avgLoss = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const tr = i === 0 ? highs[i]! - lows[i]! : Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!));
    prevAtr = i === 0 ? tr : (prevAtr * 13 + tr) / 14;
    atr.push(prevAtr);
    const change = i === 0 ? 0 : closes[i]! - closes[i - 1]!;
    const gain = Math.max(0, change), loss = Math.max(0, -change);
    avgGain = i === 0 ? 0 : (avgGain * 13 + gain) / 14;
    avgLoss = i === 0 ? 0 : (avgLoss * 13 + loss) / 14;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return rows.map((row, i) => {
    const at = new Date(row.close_time as string);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    return {
      time: at.toISOString(), close: closes[i]!, high: highs[i]!, low: lows[i]!,
      atr: atr[i]!, ema21: e21[i]!, ema50: e50[i]!, ema200: e200[i]!, rsi: rsi[i]!,
      etMinutes: hour * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? "0"),
    };
  });
}

const bars = new Map<string, Bar[]>();
for (const pair of PAIRS) {
  bars.set(pair, await loadBars(pair));
  console.log(`${pair}: ${bars.get(pair)!.length} bars loaded`);
}

/** Return over the previous `hours`, in ATR, indexed by time — used for the cross-pair dollar read. */
const retByPairTime = new Map<string, Map<string, number>>();
for (const pair of PAIRS) {
  const series = bars.get(pair)!;
  const map = new Map<string, number>();
  for (let i = PER_HOUR; i < series.length; i += 1) {
    const atr = series[i]!.atr;
    if (atr > 0) map.set(series[i]!.time, (series[i]!.close - series[i - PER_HOUR]!.close) / atr);
  }
  retByPairTime.set(pair, map);
}

type Sample = { predictors: Record<string, number>; forward: number };

function collect(horizonHours: number): Sample[] {
  const step = horizonHours * PER_HOUR; // non-overlapping
  const samples: Sample[] = [];

  for (const pair of PAIRS) {
    const series = bars.get(pair)!;
    // Dollar direction implied by the OTHER two pairs, so the read is
    // independent of the pair being predicted. USD_JPY is quoted the other way
    // up, so its sign flips.
    const others = PAIRS.filter((p) => p !== pair);

    for (let i = 200; i + step < series.length; i += step) {
      const bar = series[i]!;
      if (bar.atr <= 0) continue;
      // Only the hours this strategy is allowed to trade.
      if (bar.etMinutes < 3 * 60 || bar.etMinutes >= 16 * 60 + 45) continue;

      const forward = (series[i + step]!.close - bar.close) / bar.atr;

      let usd = 0, seen = 0;
      for (const other of others) {
        const value = retByPairTime.get(other)!.get(bar.time);
        if (value === undefined) continue;
        usd += other === "USD_JPY" ? value : -value; // both express USD getting stronger
        seen += 1;
      }
      const usdStrength = seen ? usd / seen : 0;

      // Session opening range: the first hour after the London open.
      let orHigh = -Infinity, orLow = Infinity;
      const openMinutes = 3 * 60;
      for (let j = i; j >= Math.max(0, i - 60); j -= 1) {
        const candidate = series[j]!;
        if (candidate.etMinutes < openMinutes) break;
        if (candidate.etMinutes < openMinutes + 60) { orHigh = Math.max(orHigh, candidate.high); orLow = Math.min(orLow, candidate.low); }
      }
      const orb = Number.isFinite(orHigh) && Number.isFinite(orLow)
        ? bar.close > orHigh ? (bar.close - orHigh) / bar.atr : bar.close < orLow ? (bar.close - orLow) / bar.atr : 0
        : 0;

      samples.push({
        forward,
        predictors: {
          // Sanity checks: these are the family that already failed.
          momentum1h: (bar.close - series[i - PER_HOUR]!.close) / bar.atr,
          momentum4h: (bar.close - series[i - 4 * PER_HOUR]!.close) / bar.atr,
          emaStack: bar.ema21 > bar.ema50 && bar.ema50 > bar.ema200 ? 1 : bar.ema21 < bar.ema50 && bar.ema50 < bar.ema200 ? -1 : 0,
          rsiCentred: (bar.rsi - 50) / 50,
          stretchFromEma200: (bar.close - bar.ema200) / bar.atr,
          // The two new hypotheses.
          openingRangeBreak: orb,
          dollarStrength: pair === "USD_JPY" ? usdStrength : -usdStrength,
        },
      });
    }
  }
  return samples;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);

for (const horizon of HORIZONS) {
  const samples = collect(horizon);
  const names = Object.keys(samples[0]?.predictors ?? {});
  console.log(`\n=== FORWARD ${horizon}h · ${samples.length} non-overlapping samples ===`);

  const rows = names.map((name) => {
    const xs = samples.map((s) => s.predictors[name]!);
    const ys = samples.map((s) => s.forward);
    const mx = mean(xs), my = mean(ys);
    const sx = Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)));
    const sy = Math.sqrt(mean(ys.map((y) => (y - my) ** 2)));
    const r = sx && sy ? mean(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / (sx * sy) : 0;
    const n = samples.length;
    const t = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r));

    const ordered = [...samples].sort((a, b) => a.predictors[name]! - b.predictors[name]!);
    const cut = Math.floor(ordered.length / 10);
    const bottom = mean(ordered.slice(0, cut).map((s) => s.forward));
    const top = mean(ordered.slice(-cut).map((s) => s.forward));

    return {
      predictor: name,
      correlation: Number(r.toFixed(4)),
      t: Number(t.toFixed(2)),
      "bottom10% fwd": Number(bottom.toFixed(4)),
      "top10% fwd": Number(top.toFixed(4)),
      "decile spread (ATR)": Number((top - bottom).toFixed(4)),
    };
  }).sort((a, b) => Math.abs(b["decile spread (ATR)"]) - Math.abs(a["decile spread (ATR)"]));
  console.table(rows);
}

console.log("\nRound-trip cost is roughly 0.15-0.2 ATR on these pairs, so a decile spread below that is not tradeable however significant it looks.");
process.exit(0);
