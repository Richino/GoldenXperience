import type { TrendRead } from "@/lib/strategy/analyze-v2/structure";

export type TrendLabelRead = Pick<TrendRead, "timeframe" | "direction" | "closeTime" | "evidence">;
export type PairTrend = { w1: TrendLabelRead | null; d1: TrendLabelRead | null; h4: TrendLabelRead | null; asOf?: string };
export const TREND_READ_TTL_MS = 15 * 60_000;
const directions = new Set(["UPTREND", "DOWNTREND", "RANGE", "TRANSITION", "UNCLEAR"]);
const storageKey = (instrument: string) => `gx:trend-read:v1:${instrument}`;

function validRead(value: unknown, timeframe: string): value is TrendLabelRead {
  if (!value || typeof value !== "object") return false;
  const read = value as TrendLabelRead;
  return read.timeframe === timeframe && directions.has(read.direction) && typeof read.closeTime === "string" &&
    Number.isFinite(Date.parse(read.closeTime)) && Array.isArray(read.evidence) && read.evidence.every(item => typeof item === "string");
}

/** Public structure only. Pending reads and stored completed reads are shared by all labels. */
export function createPairTrendReadCache(read: (instrument: string) => Promise<PairTrend>, options: {
  now?: () => number;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
} = {}) {
  const now = options.now ?? Date.now;
  const values = new Map<string, PairTrend>();
  const pending = new Map<string, Promise<PairTrend>>();
  const fresh = (value: PairTrend) => {
    const age = now() - Date.parse(value.asOf ?? "");
    return age >= 0 && age < TREND_READ_TTL_MS;
  };
  const complete = (value: PairTrend) => validRead(value.w1, "Weekly") && validRead(value.d1, "Daily") && validRead(value.h4, "4H");
  const peek = (instrument: string): PairTrend | null => {
    const memory = values.get(instrument);
    if (memory && fresh(memory)) return memory;
    try {
      const raw = options.storage?.().getItem(storageKey(instrument));
      const stored = raw ? JSON.parse(raw) : null;
      if (stored?.instrument === instrument && stored.value && complete(stored.value) && fresh(stored.value)) {
        values.set(instrument, stored.value);
        return stored.value;
      }
    } catch { /* Optional storage may be unavailable or contain an old record. */ }
    return null;
  };
  return {
    peek,
    load(instrument: string): Promise<PairTrend> {
      const hit = peek(instrument);
      if (hit) return Promise.resolve(hit);
      const active = pending.get(instrument);
      if (active) return active;
      const request = Promise.resolve().then(() => read(instrument)).then(value => {
        if (complete(value) && fresh(value)) {
          values.set(instrument, value);
          try { options.storage?.().setItem(storageKey(instrument), JSON.stringify({ instrument, value })); } catch { /* Memory cache still works. */ }
        }
        return value;
      }).finally(() => pending.delete(instrument));
      pending.set(instrument, request);
      return request;
    },
  };
}
