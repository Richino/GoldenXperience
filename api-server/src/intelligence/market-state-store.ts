import type { PoolClient } from "pg";
import { query } from "../database.js";
import type { MarketStateSnapshot, MarketStateView } from "../../../frontend/src/lib/trade-plans/market-state.js";
import { checkCandleFreshness } from "../../../frontend/src/lib/strategy/analyze-v2/data-quality.js";
import { interpretMarketState, MARKET_STATE_VERSION, type InterpretMarketInput } from "./market-state-interpreter.js";

type StoreDb = Pick<PoolClient, "query">;
const liveDb = { query } as StoreDb;

export async function latestMarketState(instrument: string, researchId?: string, db: StoreDb = liveDb): Promise<MarketStateSnapshot | null> {
  try {
    const rows = await db.query<{ snapshot: MarketStateSnapshot }>(
      `SELECT snapshot FROM market_state_snapshots WHERE instrument=$1 AND engine_version=$2 ${researchId ? "AND research_id=$3" : ""} ORDER BY created_at DESC,id DESC LIMIT 1`,
      researchId ? [instrument, MARKET_STATE_VERSION, researchId] : [instrument, MARKET_STATE_VERSION],
    );
    return rows.rows[0]?.snapshot ?? null;
  } catch (error) {
    // During an additive rolling migration, old research remains readable.
    if ((error as { code?: string }).code === "42P01") return null;
    throw error;
  }
}

/** Currentness is checked on read; an old snapshot never silently becomes a fresh interpretation. */
export function marketStateView(snapshot: MarketStateSnapshot, research: { fresh: boolean; reason: string | null }, now: number): MarketStateView {
  const reasons = [...snapshot.quality.issues];
  if (!research.fresh) reasons.push(research.reason ?? "Research is out of date.");
  for (const tf of ["H1", "H4", "D1"] as const) {
    const closeAt = snapshot.source.candleClosedAt[tf];
    const step = tf === "H1" ? 3_600_000 : tf === "H4" ? 14_400_000 : 86_400_000;
    if (!closeAt || !Number.isFinite(Date.parse(closeAt)) || Date.parse(closeAt) > now || now - Date.parse(closeAt) > 96 * 3_600_000) { reasons.push(`${tf} observation is unavailable or out of date.`); continue; }
    const price = 1; // Freshness examines only the timestamp, never this placeholder OHLC.
    const check = checkCandleFreshness(tf, [{ time: new Date(Date.parse(closeAt) - step).toISOString(), open: price, high: price, low: price, close: price, volume: 0, complete: true }], tf, now, 2);
    if (check.status === "FAIL" || check.status === "UNKNOWN") reasons.push(check.reason);
  }
  if (!["VALID", "PARTIAL"].includes(snapshot.quality.status)) reasons.push("The snapshot did not pass its mandatory input checks.");
  return { snapshot, usable: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Insert once for the same inputs. No UPDATE to research, approvals, plans, orders or notifications. */
export async function storeMarketState(input: Omit<InterpretMarketInput, "previous">, db: StoreDb = liveDb) {
  const previous = await latestMarketState(input.market.instrument, undefined, db);
  const snapshot = interpretMarketState({ ...input, previous });
  const row = await db.query<{ snapshot: MarketStateSnapshot }>(
    `INSERT INTO market_state_snapshots(id,instrument,research_id,engine_version,input_hash,quality_status,snapshot,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (instrument,input_hash) DO NOTHING RETURNING snapshot`,
    [snapshot.id, snapshot.instrument, snapshot.researchId, snapshot.engineVersion, snapshot.inputHash, snapshot.quality.status, JSON.stringify(snapshot), snapshot.generatedAt],
  );
  if (row.rows[0]) return row.rows[0].snapshot;
  return (await db.query<{ snapshot: MarketStateSnapshot }>("SELECT snapshot FROM market_state_snapshots WHERE instrument=$1 AND input_hash=$2", [snapshot.instrument, snapshot.inputHash])).rows[0]!.snapshot;
}
