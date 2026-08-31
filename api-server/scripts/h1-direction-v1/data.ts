/**
 * h1-direction-v1 — offline + DB candle loading for all 12 MAJOR_INSTRUMENTS.
 * Does not touch production engines or prior research code paths.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

export const MAJOR_INSTRUMENTS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD",
  "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD",
] as const;

export type Instrument = (typeof MAJOR_INSTRUMENTS)[number];

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const TARGET_START = Date.parse("2022-08-01T00:00:00.000Z");
export const TARGET_END = Date.parse("2026-08-01T00:00:00.000Z");
export const H1_MS = 3_600_000;

export type Bar = {
  t: number;
  iso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  bidClose: number;
  bidHigh: number;
  bidLow: number;
  bidOpen: number;
  askClose: number;
  askHigh: number;
  askLow: number;
  askOpen: number;
};

type RawBar = {
  closeTime: string;
  open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

export type PairCoverage = {
  pair: Instrument;
  source: "json" | "database" | "oanda";
  start: string;
  end: string;
  candles: number;
  missingCandles: number;
  gaps: number;
  maxGapHours: number;
  medianSpreadPips: number;
};

function pipSize(pair: Instrument): number {
  return pair.includes("JPY") ? 0.01 : 0.0001;
}

function rawToBar(b: RawBar): Bar {
  return {
    t: Date.parse(b.closeTime),
    iso: b.closeTime,
    open: b.open, high: b.high, low: b.low, close: b.close,
    bidOpen: b.bidOpen, bidClose: b.bidClose, bidHigh: b.bidHigh, bidLow: b.bidLow,
    askOpen: b.askOpen, askClose: b.askClose, askHigh: b.askHigh, askLow: b.askLow,
  };
}

function dedupeSort(bars: Bar[]): Bar[] {
  bars.sort((a, b) => a.t - b.t);
  const out: Bar[] = [];
  for (const b of bars) {
    if (out.length && out.at(-1)!.t === b.t) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}

function loadJsonPair(pair: Instrument): Bar[] | null {
  const file = path.join(REPO_ROOT, "backtest-legacy-expanded", "candles", `${pair}_H1.json`);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { bars: RawBar[] };
  return dedupeSort(parsed.bars.map(rawToBar));
}

async function loadDbPair(pair: Instrument): Promise<Bar[]> {
  const serviceRoot = path.join(REPO_ROOT, "api-server");
  for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, file), override: false });
  if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  const { query } = await import("../../src/database.js");
  const res = await query<Record<string, unknown>>(
    `SELECT c.close_time,
            c.open::float, c.high::float, c.low::float, c.close::float,
            q.bid_open::float, q.bid_high::float, q.bid_low::float, q.bid_close::float,
            q.ask_open::float, q.ask_high::float, q.ask_low::float, q.ask_close::float
       FROM market_candles c
       LEFT JOIN market_candle_quotes q
         ON q.instrument = c.instrument AND q.timeframe = c.timeframe
        AND q.source = c.source AND q.close_time = c.close_time
      WHERE c.instrument = $1 AND c.timeframe = 'H1' AND c.source = 'oanda'
      ORDER BY c.close_time`,
    [pair],
  );
  const bars = res.rows.map((r): Bar => {
    const iso = new Date(r.close_time as string | Date).toISOString();
    const bidClose = Number(r.bid_close ?? r.close);
    const askClose = Number(r.ask_close ?? r.close);
    return {
      t: Date.parse(iso), iso,
      open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      bidOpen: Number(r.bid_open ?? r.open), bidHigh: Number(r.bid_high ?? r.high),
      bidLow: Number(r.bid_low ?? r.low), bidClose,
      askOpen: Number(r.ask_open ?? r.open), askHigh: Number(r.ask_high ?? r.high),
      askLow: Number(r.ask_low ?? r.low), askClose,
    };
  });
  return dedupeSort(bars);
}

async function loadOandaPair(pair: Instrument, fromIso: string, toIso: string): Promise<Bar[]> {
  const serviceRoot = path.join(REPO_ROOT, "api-server");
  for (const file of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, file), override: false });
  const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) throw new Error(`No local data for ${pair} and OANDA credentials unavailable`);
  const host = process.env.OANDA_ENVIRONMENT === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";
  const all = new Map<number, Bar>();
  let cursor = fromIso;
  for (let page = 0; page < 50; page++) {
    const url = `${host}/v3/instruments/${pair}/candles?price=BA&granularity=H1&count=5000&from=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${pair}: OANDA fetch failed (${response.status})`);
    const json = await response.json() as {
      candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }>;
    };
    const pageBars = (json.candles ?? []).filter((bar) => bar.complete).map((bar) => {
      const mid = (k: string) => (+bar.bid[k]! + +bar.ask[k]!) / 2;
      const closeMs = Date.parse(bar.time) + H1_MS;
      const iso = new Date(closeMs).toISOString();
      return rawToBar({
        closeTime: iso,
        open: mid("o"), high: mid("h"), low: mid("l"), close: mid("c"),
        bidOpen: +bar.bid.o!, bidHigh: +bar.bid.h!, bidLow: +bar.bid.l!, bidClose: +bar.bid.c!,
        askOpen: +bar.ask.o!, askHigh: +bar.ask.h!, askLow: +bar.ask.l!, askClose: +bar.ask.c!,
      });
    });
    for (const b of pageBars) {
      if (b.t <= Date.parse(toIso)) all.set(b.t, b);
    }
    if (pageBars.length < 5000 || !pageBars.length) break;
    cursor = pageBars.at(-1)!.iso;
    if (Date.parse(cursor) >= Date.parse(toIso)) break;
  }
  return dedupeSort([...all.values()]);
}

export function analyzeCoverage(pair: Instrument, bars: Bar[]): Omit<PairCoverage, "pair" | "source"> {
  if (!bars.length) {
    return { start: "", end: "", candles: 0, missingCandles: 0, gaps: 0, maxGapHours: 0, medianSpreadPips: 0 };
  }
  let gaps = 0;
  let maxGapHours = 0;
  let missing = 0;
  const pip = pipSize(pair);
  const spreads: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    spreads.push((bars[i]!.askClose - bars[i]!.bidClose) / pip);
    if (i === 0) continue;
    const dt = bars[i]!.t - bars[i - 1]!.t;
    const expected = Math.round(dt / H1_MS);
    if (expected > 1) {
      gaps++;
      maxGapHours = Math.max(maxGapHours, dt / H1_MS);
      missing += expected - 1;
    }
  }
  spreads.sort((a, b) => a - b);
  return {
    start: bars[0]!.iso,
    end: bars.at(-1)!.iso,
    candles: bars.length,
    missingCandles: missing,
    gaps,
    maxGapHours: +maxGapHours.toFixed(1),
    medianSpreadPips: +spreads[Math.floor(spreads.length / 2)]!.toFixed(2),
  };
}

export type LoadedDataset = {
  pairs: Instrument[];
  barsByPair: Map<Instrument, Bar[]>;
  commonStart: string;
  commonEnd: string;
  coverage: PairCoverage[];
};

export async function loadAllPairs(): Promise<LoadedDataset> {
  const barsByPair = new Map<Instrument, Bar[]>();
  const coverage: PairCoverage[] = [];

  for (const pair of MAJOR_INSTRUMENTS) {
    let bars = loadJsonPair(pair);
    let source: PairCoverage["source"] = "json";

    if (!bars?.length) {
      try {
        bars = await loadOandaPair(pair, "2019-07-01T00:00:00.000Z", "2026-08-26T00:00:00.000Z");
        source = "oanda";
      } catch {
        try {
          bars = await loadDbPair(pair);
          source = "database";
        } catch {
          bars = [];
        }
      }
    }

    // Replace partial DB/short history with full OANDA fetch when start is after target.
    if (bars.length && bars[0]!.t > TARGET_START + 180 * 24 * H1_MS) {
      try {
        const full = await loadOandaPair(pair, "2019-07-01T00:00:00.000Z", "2026-08-26T00:00:00.000Z");
        if (full.length > bars.length) {
          bars = full;
          source = "oanda";
        }
      } catch {
        // keep existing bars
      }
    }

    barsByPair.set(pair, bars);
    coverage.push({ pair, source, ...analyzeCoverage(pair, bars) });
  }

  const starts = [...barsByPair.values()].map((b) => b[0]!.t);
  const ends = [...barsByPair.values()].map((b) => b.at(-1)!.t);
  const commonStartMs = Math.max(TARGET_START, ...starts);
  const commonEndMs = Math.min(TARGET_END, ...ends);

  for (const pair of MAJOR_INSTRUMENTS) {
    const filtered = barsByPair.get(pair)!.filter((b) => b.t >= commonStartMs && b.t <= commonEndMs);
    barsByPair.set(pair, filtered);
    const idx = coverage.findIndex((c) => c.pair === pair)!;
    coverage[idx] = { ...coverage[idx]!, ...analyzeCoverage(pair, filtered) };
  }

  return {
    pairs: [...MAJOR_INSTRUMENTS],
    barsByPair,
    commonStart: new Date(commonStartMs).toISOString(),
    commonEnd: new Date(commonEndMs).toISOString(),
    coverage,
  };
}

export function pipSizeFor(pair: Instrument): number {
  return pipSize(pair);
}
