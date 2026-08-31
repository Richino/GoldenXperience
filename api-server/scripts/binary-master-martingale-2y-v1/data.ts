/**
 * binary-master-martingale-2y-v1 — M1 data fetch/cache (OANDA).
 * Target window: 2024-08-01 → 2026-08-01 (maximum reliable history).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { PAIRS, type Pair } from "../binary-master-v1/data.js";

export { PAIRS, type Pair };
export { pairLabel } from "../binary-master-v1/data.js";

export type M1Bar = {
  t: number;
  iso: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export const TARGET_START = "2024-08-01T00:00:00.000Z";
export const TARGET_END = "2026-08-01T00:00:00.000Z";

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "research",
  "binary-master-martingale-2y-v1",
);
export const CACHE_PATH = path.join(OUT_DIR, "m1_cache.json");

type CompactBar = [number, number, number, number, number];

function env(k: string): string {
  return (process.env[k] ?? "").trim().replace(/^["']|["']$/g, "");
}

function compact(b: M1Bar): CompactBar {
  return [b.t, b.open, b.high, b.low, b.close];
}

function expand(row: CompactBar): M1Bar {
  return {
    t: row[0],
    iso: new Date(row[0]).toISOString(),
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
  };
}

async function fetchPage(inst: string, fromISO: string, token: string, host: string) {
  const q = new URLSearchParams({
    price: "M",
    granularity: "M1",
    count: "5000",
    from: fromISO,
  });
  const url = `${host}/v3/instruments/${inst}/candles?${q}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${inst} OANDA ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as {
    candles?: Array<{ complete: boolean; time: string; mid: Record<string, string> }>;
  };
  return (j.candles ?? [])
    .filter((c) => c.complete)
    .map((c) => ({
      openTime: c.time,
      o: +c.mid.o!,
      h: +c.mid.h!,
      l: +c.mid.l!,
      c: +c.mid.c!,
    }));
}

async function fetchPairRange(
  inst: Pair,
  token: string,
  host: string,
  startMs: number,
  endMs: number,
): Promise<M1Bar[]> {
  const byOpen = new Map<number, M1Bar>();
  let from = new Date(startMs).toISOString();
  for (let page = 0; page < 400; page++) {
    const rows = await fetchPage(inst, from, token, host);
    if (!rows.length) break;
    let advanced = false;
    for (const r of rows) {
      const openMs = Date.parse(r.openTime);
      const closeMs = openMs + 60_000;
      if (closeMs > endMs) continue;
      if (closeMs < startMs) continue;
      byOpen.set(openMs, {
        t: closeMs,
        iso: new Date(closeMs).toISOString(),
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
      });
      advanced = true;
    }
    const lastOpen = Date.parse(rows.at(-1)!.openTime);
    if (lastOpen + 60_000 >= endMs) break;
    if (!advanced && page > 0) break;
    from = new Date(lastOpen + 60_000).toISOString();
    if (Date.parse(from) >= endMs) break;
    if (page % 20 === 0) console.error(`  ${inst}: page ${page}, bars=${byOpen.size}`);
    await new Promise((res) => setTimeout(res, 110));
  }
  return [...byOpen.values()].sort((a, b) => a.t - b.t);
}

export type LoadedM1 = {
  source: "cache" | "oanda";
  fetchedAt: string;
  targetStart: string;
  targetEnd: string;
  actualStart: string;
  actualEnd: string;
  tradingDays: number;
  pairs: Pair[];
  barsByPair: Map<Pair, M1Bar[]>;
  coverage: Array<{ pair: Pair; candles: number; start: string; end: string; gaps: number; missing: number }>;
  totalCandles: number;
  totalMissing: number;
};

function analyze(barsByPair: Map<Pair, M1Bar[]>): LoadedM1["coverage"] {
  return PAIRS.map((pair) => {
    const bars = barsByPair.get(pair) ?? [];
    if (!bars.length) return { pair, candles: 0, start: "", end: "", gaps: 0, missing: 0 };
    let gaps = 0;
    let missing = 0;
    for (let i = 1; i < bars.length; i++) {
      const dt = bars[i]!.t - bars[i - 1]!.t;
      const exp = Math.round(dt / 60_000);
      if (exp > 1) {
        gaps++;
        missing += exp - 1;
      }
    }
    return {
      pair,
      candles: bars.length,
      start: bars[0]!.iso,
      end: bars.at(-1)!.iso,
      gaps,
      missing,
    };
  });
}

function countTradingDays(barsByPair: Map<Pair, M1Bar[]>): number {
  const days = new Set<string>();
  for (const bars of barsByPair.values()) {
    for (const b of bars) days.add(b.iso.slice(0, 10));
  }
  return days.size;
}

function actualBounds(barsByPair: Map<Pair, M1Bar[]>) {
  let minT = Number.POSITIVE_INFINITY;
  let maxT = 0;
  for (const bars of barsByPair.values()) {
    if (!bars.length) continue;
    minT = Math.min(minT, bars[0]!.t);
    maxT = Math.max(maxT, bars.at(-1)!.t);
  }
  return {
    actualStart: Number.isFinite(minT) ? new Date(minT).toISOString() : "",
    actualEnd: maxT ? new Date(maxT).toISOString() : "",
  };
}

export async function loadM1Data(forceRefresh = false): Promise<LoadedM1> {
  mkdirSync(OUT_DIR, { recursive: true });
  const startMs = Date.parse(TARGET_START);
  const endMs = Date.parse(TARGET_END);

  if (!forceRefresh && existsSync(CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as {
      fetchedAt: string;
      targetStart: string;
      targetEnd: string;
      data: Record<Pair, CompactBar[]>;
    };
    const barsByPair = new Map<Pair, M1Bar[]>();
    for (const p of PAIRS) barsByPair.set(p, (cached.data[p] ?? []).map(expand));
    const coverage = analyze(barsByPair);
    const bounds = actualBounds(barsByPair);
    return {
      source: "cache",
      fetchedAt: cached.fetchedAt,
      targetStart: cached.targetStart,
      targetEnd: cached.targetEnd,
      ...bounds,
      tradingDays: countTradingDays(barsByPair),
      pairs: [...PAIRS],
      barsByPair,
      coverage,
      totalCandles: coverage.reduce((s, c) => s + c.candles, 0),
      totalMissing: coverage.reduce((s, c) => s + c.missing, 0),
    };
  }

  const serviceRoot = path.join(OUT_DIR, "..", "..");
  for (const f of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, f), override: false });
  const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
  if (!token) throw new Error("OANDA credentials required for M1 fetch");
  const host =
    env("OANDA_ENVIRONMENT") === "live"
      ? "https://api-fxtrade.oanda.com"
      : "https://api-fxpractice.oanda.com";

  const data: Record<Pair, CompactBar[]> = {} as Record<Pair, CompactBar[]>;
  for (const p of PAIRS) {
    console.error(`Fetching M1 ${p} ${TARGET_START} → ${TARGET_END}...`);
    const bars = await fetchPairRange(p, token, host, startMs, endMs);
    data[p] = bars.map(compact);
    console.error(`  ${p}: ${bars.length} bars`);
  }

  const fetchedAt = new Date().toISOString();
  writeFileSync(
    CACHE_PATH,
    JSON.stringify({ fetchedAt, host, targetStart: TARGET_START, targetEnd: TARGET_END, data }),
  );
  const barsByPair = new Map<Pair, M1Bar[]>(PAIRS.map((p) => [p, (data[p] ?? []).map(expand)]));
  const coverage = analyze(barsByPair);
  const bounds = actualBounds(barsByPair);
  return {
    source: "oanda",
    fetchedAt,
    targetStart: TARGET_START,
    targetEnd: TARGET_END,
    ...bounds,
    tradingDays: countTradingDays(barsByPair),
    pairs: [...PAIRS],
    barsByPair,
    coverage,
    totalCandles: coverage.reduce((s, c) => s + c.candles, 0),
    totalMissing: coverage.reduce((s, c) => s + c.missing, 0),
  };
}
