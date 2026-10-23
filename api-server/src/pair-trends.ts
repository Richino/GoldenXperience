import { getCandles } from "../../frontend/src/lib/oanda/client.js";
import { INSTRUMENT_CATALOG } from "../../frontend/src/lib/instruments/catalog.js";
import { readSwingTrend } from "../../frontend/src/lib/swing-trend-read.js";
import type { TrendDirection } from "../../frontend/src/lib/strategy/analyze-v2/structure.js";
import type { PairTrendRow, PairTrendsSnapshot } from "../../frontend/src/lib/home/weekly-trends.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";
import { db, query } from "./database.js";
import { createPairTrendsRunner } from "./pair-trends-runner.js";

/**
 * Weekly, Daily and 4H structure (the chart's trend label) for every pair, in
 * one shared snapshot. Structure moves as 4H bars close, so it is rebuilt at
 * most every 15 minutes. Pairs whose candles fell back to generated data are
 * left out rather than read on fake prices.
 */

const CONCURRENCY = 6;

export type { PairTrendRow, PairTrendsSnapshot };

async function readDirection(instrument: string, granularity: "H4" | "D" | "W"): Promise<TrendDirection | null> {
  const series = await getCandles(instrument as MajorInstrument, granularity, 250);
  if (series.status.state !== "connected" || series.data.source !== "oanda") return null;
  return readSwingTrend(instrument, granularity, series.data)?.direction ?? null;
}

async function build(): Promise<PairTrendsSnapshot> {
  const queue = INSTRUMENT_CATALOG.map((item) => item.name);
  const pairs: PairTrendRow[] = [];
  const worker = async () => {
    for (let instrument = queue.shift(); instrument; instrument = queue.shift()) {
      try {
        const [h4, d1, w1] = await Promise.all([readDirection(instrument, "H4"), readDirection(instrument, "D"), readDirection(instrument, "W")]);
        if (h4 && d1 && w1) pairs.push({ instrument, h4, d1, w1 });
      } catch {
        // One pair failing leaves it out of the snapshot; the rest still read.
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  pairs.sort((a, b) => a.instrument.localeCompare(b.instrument));
  return { checkedAt: new Date().toISOString(), pairs };
}

let runner: ReturnType<typeof createPairTrendsRunner> | null = null;
let backgroundStarted = false;
function scanner() {
  if (runner) return runner;
  const key = `weekly-v1:${process.env.OANDA_ENVIRONMENT === "live" ? "live" : "practice"}`;
  runner = createPairTrendsRunner({
    scan: build,
    load: async () => (await query<{ snapshot: PairTrendsSnapshot }>("SELECT snapshot FROM pair_trend_snapshots WHERE snapshot_key=$1", [key])).rows[0]?.snapshot ?? null,
    save: async snapshot => {
      await query(`INSERT INTO pair_trend_snapshots(snapshot_key,checked_at,snapshot) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(snapshot_key) DO UPDATE SET checked_at=EXCLUDED.checked_at,snapshot=EXCLUDED.snapshot,updated_at=now()
        WHERE pair_trend_snapshots.checked_at < EXCLUDED.checked_at`, [key, snapshot.checkedAt, JSON.stringify(snapshot)]);
    },
    lock: async () => {
      const client = await db().connect();
      try {
        const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`pair-trends:${key}`]);
        if (!result.rows[0]?.locked) { client.release(); return null; }
        return async () => {
          try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`pair-trends:${key}`]); }
          finally { client.release(); }
        };
      } catch (error) { client.release(true); throw error; }
    },
    failed: error => {
      const code = (error as { code?: unknown })?.code;
      console.warn("[pair-trends] Background refresh failed; keeping the previous snapshot.", { code: typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : null });
    },
  });
  return runner;
}

export const pairTrends = async () => {
  const snapshot = await scanner().read();
  return !backgroundStarted && !snapshot.pairs.length ? { ...snapshot, scanStatus: "unavailable" as const } : snapshot;
};
export const pairTrendsHealth = () => scanner().health();

/** Public market-data discovery; independent of every order/trading scheduler. */
export function startPairTrendsScanner() {
  backgroundStarted = true;
  const instance = scanner();
  void instance.refresh();
  const timer = setInterval(() => { void instance.refresh(); }, 60_000);
  timer.unref();
  return () => { clearInterval(timer); backgroundStarted = false; };
}
