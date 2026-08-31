/**
 * binary-master-v1 — M1 data fetch/cache (OANDA).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

export const PAIRS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD",
  "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD",
] as const;

export type Pair = (typeof PAIRS)[number];

export type M1Bar = {
  t: number;
  iso: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "binary-master-v1");
export const CACHE_PATH = path.join(OUT_DIR, "m1_cache.json");

/** Calendar days to page backward (~35+ trading days of M1). */
export const DAYS_BACK = 45;

function env(k: string): string {
  return (process.env[k] ?? "").trim().replace(/^["']|["']$/g, "");
}

async function fetchPage(inst: string, toISO: string | undefined, token: string, host: string) {
  const q = new URLSearchParams({ price: "M", granularity: "M1", count: "5000" });
  if (toISO) q.set("to", toISO);
  const url = `${host}/v3/instruments/${inst}/candles?${q}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${inst} OANDA ${r.status}: ${await r.text()}`);
  const j = await r.json() as { candles?: Array<{ complete: boolean; time: string; mid: Record<string, string> }> };
  return (j.candles ?? []).filter((c) => c.complete).map((c) => ({
    openTime: c.time,
    o: +c.mid.o!, h: +c.mid.h!, l: +c.mid.l!, c: +c.mid.c!,
  }));
}

async function fetchPair(inst: Pair, token: string, host: string, daysBack: number): Promise<M1Bar[]> {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const byOpen = new Map<number, M1Bar>();
  let to: string | undefined;
  for (let page = 0; page < 25; page++) {
    const rows = await fetchPage(inst, to, token, host);
    if (!rows.length) break;
    for (const r of rows) {
      const openMs = Date.parse(r.openTime);
      const closeMs = openMs + 60_000;
      byOpen.set(openMs, {
        t: closeMs,
        iso: new Date(closeMs).toISOString(),
        open: r.o, high: r.h, low: r.l, close: r.c,
      });
    }
    const earliest = Date.parse(rows[0]!.openTime);
    if (earliest <= cutoff) break;
    to = rows[0]!.openTime;
    await new Promise((res) => setTimeout(res, 100));
  }
  return [...byOpen.values()].sort((a, b) => a.t - b.t).filter((b) => b.t >= cutoff);
}

export type LoadedM1 = {
  source: "cache" | "oanda";
  fetchedAt: string;
  pairs: Pair[];
  barsByPair: Map<Pair, M1Bar[]>;
  coverage: Array<{ pair: Pair; candles: number; start: string; end: string; gaps: number; missing: number }>;
};

export async function loadM1Data(forceRefresh = false): Promise<LoadedM1> {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!forceRefresh && existsSync(CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as {
      fetchedAt: string;
      data: Record<Pair, M1Bar[]>;
    };
    const barsByPair = new Map<Pair, M1Bar[]>();
    for (const p of PAIRS) barsByPair.set(p, cached.data[p] ?? []);
    return { source: "cache", fetchedAt: cached.fetchedAt, pairs: [...PAIRS], barsByPair, coverage: analyze(barsByPair) };
  }

  const serviceRoot = path.join(OUT_DIR, "..", "..");
  for (const f of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, f), override: false });
  const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
  if (!token) throw new Error("OANDA credentials required for M1 fetch");
  const host = env("OANDA_ENVIRONMENT") === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";

  const data: Record<Pair, M1Bar[]> = {} as Record<Pair, M1Bar[]>;
  for (const p of PAIRS) {
    console.error(`Fetching M1 ${p}...`);
    data[p] = await fetchPair(p, token, host, DAYS_BACK);
    console.error(`  ${p}: ${data[p]!.length} bars`);
  }
  const fetchedAt = new Date().toISOString();
  writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt, host, daysBack: DAYS_BACK, data }));
  const barsByPair = new Map<Pair, M1Bar[]>(PAIRS.map((p) => [p, data[p]!]));
  return { source: "oanda", fetchedAt, pairs: [...PAIRS], barsByPair, coverage: analyze(barsByPair) };
}

function analyze(barsByPair: Map<Pair, M1Bar[]>): LoadedM1["coverage"] {
  return PAIRS.map((pair) => {
    const bars = barsByPair.get(pair)!;
    if (!bars.length) return { pair, candles: 0, start: "", end: "", gaps: 0, missing: 0 };
    let gaps = 0, missing = 0;
    for (let i = 1; i < bars.length; i++) {
      const dt = bars[i]!.t - bars[i - 1]!.t;
      const exp = Math.round(dt / 60_000);
      if (exp > 1) { gaps++; missing += exp - 1; }
    }
    return { pair, candles: bars.length, start: bars[0]!.iso, end: bars.at(-1)!.iso, gaps, missing };
  });
}

export function pairLabel(p: Pair): string {
  return p.replace("_", "/");
}
