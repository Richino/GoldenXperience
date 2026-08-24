import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Currency, YieldObs } from "../types.js";
import { YIELD_SERIES, availableAtFor } from "./series.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const YIELDS_PATH = path.resolve(HERE, "../../data/yields.jsonl");

export async function fetchFredSeries(seriesId: string, apiKey: string): Promise<Array<{ date: string; value: number }>> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}` +
    `&api_key=${apiKey}&file_type=json&observation_start=2015-01-01&sort_order=asc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId} → ${res.status}`);
  const payload = (await res.json()) as { observations?: Array<{ date: string; value: string }> };
  const out: Array<{ date: string; value: number }> = [];
  for (const o of payload.observations ?? []) {
    if (!o.value || o.value === ".") continue;
    const v = Number(o.value);
    if (!Number.isFinite(v)) continue;
    out.push({ date: o.date, value: v });
  }
  return out;
}

export async function ingestAllYields(apiKey: string): Promise<{ n: number; path: string; bySeries: Record<string, number> }> {
  fs.mkdirSync(path.dirname(YIELDS_PATH), { recursive: true });
  const rows: YieldObs[] = [];
  const bySeries: Record<string, number> = {};

  for (const def of YIELD_SERIES) {
    try {
      const obs = await fetchFredSeries(def.seriesId, apiKey);
      bySeries[def.seriesId] = obs.length;
      for (const o of obs) {
        rows.push({
          currency: def.currency,
          seriesId: def.seriesId,
          observationDate: o.date,
          availableAt: availableAtFor(o.date, def.frequency),
          value: o.value,
          frequency: def.frequency,
          source: "fred",
        });
      }
      console.log(`  ${def.seriesId} (${def.currency}): ${obs.length} obs`);
    } catch (e) {
      console.warn(`  FAIL ${def.seriesId}:`, e instanceof Error ? e.message : e);
      bySeries[def.seriesId] = 0;
    }
  }

  const lines = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  fs.writeFileSync(YIELDS_PATH, lines, "utf8");
  return { n: rows.length, path: YIELDS_PATH, bySeries };
}

export function loadYields(): YieldObs[] {
  if (!fs.existsSync(YIELDS_PATH)) return [];
  return fs
    .readFileSync(YIELDS_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as YieldObs);
}

/** Primary series per currency (prefer IR3TIB short-rate, else first primary). */
export function primarySeriesId(currency: Currency): string {
  const defs = YIELD_SERIES.filter((s) => s.currency === currency);
  const short = defs.find((s) => s.seriesId.startsWith("IR3TIB") && s.role === "primary");
  if (short) return short.seriesId;
  const daily = defs.find((s) => s.frequency === "daily" && s.role === "primary");
  if (daily) return daily.seriesId;
  const monthly = defs.find((s) => s.role === "primary");
  return monthly?.seriesId ?? defs[0]!.seriesId;
}

/**
 * Point-in-time yield as of `asOfIso`: latest observation with availableAt <= asOf.
 */
export function yieldAsOf(yields: YieldObs[], currency: Currency, asOfIso: string, seriesId?: string): number | null {
  const sid = seriesId ?? primarySeriesId(currency);
  const asOf = Date.parse(asOfIso);
  let best: YieldObs | null = null;
  for (const y of yields) {
    if (y.currency !== currency || y.seriesId !== sid) continue;
    const avail = Date.parse(y.availableAt);
    if (avail > asOf) continue;
    if (!best || Date.parse(y.availableAt) > Date.parse(best.availableAt)) best = y;
  }
  return best?.value ?? null;
}

/** Yield N calendar days earlier (PIT), for change features. */
export function yieldChange(
  yields: YieldObs[],
  currency: Currency,
  asOfIso: string,
  lookbackDays: number,
  seriesId?: string,
): number | null {
  const now = yieldAsOf(yields, currency, asOfIso, seriesId);
  if (now == null) return null;
  const pastDate = new Date(asOfIso);
  pastDate.setUTCDate(pastDate.getUTCDate() - lookbackDays);
  const past = yieldAsOf(yields, currency, pastDate.toISOString(), seriesId);
  if (past == null) return null;
  return now - past;
}
