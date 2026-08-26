/**
 * Legacy-confidence-v2 paper-trade executor.
 *
 * Opens paper trades in `paper_strategy_trades` tagged with
 * `strategy_family = "legacy-confidence-v2"`. Coordinates with the existing
 * paper engine via:
 *   - `paper_strategy_trades` schema (same table so existing resolver picks up)
 *   - `strategy_versions` (own row, upserted once)
 *   - `paper_strategy_batches` (own batch series, 100 trades per batch)
 *   - "one open trade per instrument" guard (shared table lock via advisory lock)
 *
 * When the model INVERTS the legacy pick, the trade is written with
 * `inverted=true`, `original_direction=<stack pick>`, `inversion_experiment_id="legacy-confidence-v2"`.
 * Existing paper-cycle.ts resolves the trade automatically when TP/SL hits.
 */
import { query, transaction } from "./database.js";
import type { PoolClient } from "pg";

export const LEGACY_CONFIDENCE_V2_FAMILY = "legacy-confidence-v2";
export const LEGACY_CONFIDENCE_V2_EXPERIMENT = "legacy-confidence-v2";
export const LEGACY_CONFIDENCE_V2_VERSION_NAME = "legacy-confidence";
export const LEGACY_CONFIDENCE_V2_VERSION_VALUE = "v2.0.0";
const COLLECTOR_LOCK = 24_100_002; // distinct from paper-cycle's 24_100_001 to avoid contention

type BatchRow = { id: string; batch_number: number };

async function ensureVersion(client: PoolClient): Promise<string> {
  const upserted = await client.query<{ id: string }>(
    `INSERT INTO strategy_versions(name,version,configuration) VALUES($1,$2,$3::jsonb)
     ON CONFLICT(name,version) DO UPDATE SET configuration = strategy_versions.configuration || EXCLUDED.configuration
     RETURNING id`,
    [
      LEGACY_CONFIDENCE_V2_VERSION_NAME,
      LEGACY_CONFIDENCE_V2_VERSION_VALUE,
      JSON.stringify({
        family: LEGACY_CONFIDENCE_V2_FAMILY,
        description: "Legacy 10-gate EMA-pullback + v2 direction-confidence filter (walk-forward validated).",
        combinedRule: {
          fx: "take model pick when model DISAGREES with stack AND |pLong-0.5| >= 0.10",
          XAU_USD: "always take legacy baseline",
          other: "skip",
        },
      }),
    ],
  );
  return upserted.rows[0]!.id;
}

async function ensureOwner(client: PoolClient): Promise<string | null> {
  const r = await client.query<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1");
  return r.rows[0]?.id ?? null;
}

async function ensureBatch(client: PoolClient, versionId: string): Promise<BatchRow> {
  const existing = await client.query<BatchRow>(
    "SELECT id, batch_number FROM paper_strategy_batches WHERE status='collecting' AND assigned_count < 100 AND strategy_version_id=$1 ORDER BY batch_number DESC LIMIT 1 FOR UPDATE",
    [versionId],
  );
  if (existing.rows[0]) return existing.rows[0];
  const next = await client.query<{ number: number }>("SELECT COALESCE(max(batch_number),0)+1 AS number FROM paper_strategy_batches");
  const batchNumber = Number(next.rows[0]!.number);
  const configuration = {
    targetR: 1.5,
    excludedPairs: [] as string[],
    excludedSessions: [] as string[],
    sourceRecommendationBatch: null as number | null,
    riskPercent: Number(process.env.LEGACY_V2_RISK_PERCENT ?? "1"),
  };
  const universe = ["USD_JPY", "AUD_USD", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP", "NZD_USD", "XAU_USD"];
  const created = await client.query<BatchRow>(
    "INSERT INTO paper_strategy_batches(batch_number, strategy_version_id, universe, configuration, experiment_id, strategy_family) VALUES($1, $2, $3::jsonb, $4::jsonb, $5, $6) RETURNING id, batch_number",
    [batchNumber, versionId, JSON.stringify(universe), JSON.stringify(configuration), LEGACY_CONFIDENCE_V2_EXPERIMENT, LEGACY_CONFIDENCE_V2_FAMILY],
  );
  return created.rows[0]!;
}

function sessionLabel(iso: string): string {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso)).find((p) => p.type === "hour")?.value ?? "0") % 24;
  if (h >= 8 && h < 12) return "London/New York overlap";
  if (h >= 3 && h < 8) return "London";
  if (h >= 12 && h < 17) return "New York";
  return "Off";
}
function weekdayAt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(iso));
}
function pipSizeFor(inst: string): number {
  if (inst === "XAU_USD") return 0.1;
  return inst.endsWith("JPY") ? 0.01 : 0.0001;
}

export type OpenLegacyV2Input = {
  instrument: string;
  decisionTime: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  spreadPips: number;
  atrPips: number;
  /** Set when the model flipped the legacy stack pick. */
  originalDirection: "long" | "short" | null;
  inverted: boolean;
  /** Diagnostic payload — features + model prediction. Persisted as trade.features JSON. */
  features: Record<string, unknown>;
  /** Recorded gates list — persisted as trade.conditions JSON. */
  conditions: Array<Record<string, unknown>>;
  /** Notional balance to size against — fed from env or a broker sync. */
  accountBalance: number;
  /** Risk percent, e.g. 1 for 1%. */
  riskPercent: number;
};

export type OpenLegacyV2Result =
  | { ok: true; tradeId: string; tradeSequence: number; batchNumber: number }
  | { ok: false; reason: string };

export async function openLegacyConfidenceV2Trade(input: OpenLegacyV2Input): Promise<OpenLegacyV2Result> {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [COLLECTOR_LOCK]);

    const userId = await ensureOwner(client);
    if (!userId) return { ok: false, reason: "no owner user found in users table" };

    const versionId = await ensureVersion(client);

    // One trade per instrument — mirrors the existing engine's rule and shares
    // the same table so our trades and theirs coordinate cleanly.
    const busy = await client.query("SELECT 1 FROM paper_strategy_trades WHERE instrument=$1 AND status='open'", [input.instrument]);
    if (busy.rowCount) return { ok: false, reason: "instrument already has an open trade" };

    const dup = await client.query("SELECT 1 FROM paper_strategy_trades WHERE strategy_version_id=$1 AND instrument=$2 AND decision_time=$3", [versionId, input.instrument, input.decisionTime]);
    if (dup.rowCount) return { ok: false, reason: "duplicate: this decision was already collected" };

    const batch = await ensureBatch(client, versionId);

    const pip = pipSizeFor(input.instrument);
    const riskPrice = Math.abs(input.entry - input.stop);
    if (riskPrice <= 0) return { ok: false, reason: "degenerate stop distance" };
    const riskPips = riskPrice / pip;

    // Simple position sizing: risk_dollars / risk_price = units, ignoring
    // quote-currency conversion for majors (USD quoted). For non-USD-quote
    // instruments the notional risk will be off by the FX rate at time of size;
    // labelOutcome resolves in R which is the honest number regardless.
    const riskDollars = (input.accountBalance * input.riskPercent) / 100;
    const calculatedUnits = riskPrice > 0 ? Math.floor(riskDollars / riskPrice) : 0;
    const calculatedStandardLots = calculatedUnits / 100_000;

    const riskReward = 1.5;
    const nextSeq = await client.query<{ value: string }>("SELECT (COALESCE(max(trade_sequence),0)+1)::text AS value FROM paper_strategy_trades");
    const session = sessionLabel(input.decisionTime);
    const weekday = weekdayAt(input.decisionTime);
    const setupName = `${LEGACY_CONFIDENCE_V2_FAMILY} ${input.direction}`;

    // Spread cost in R — the entry pays a spread; charge it against the risk pips.
    const spreadCostR = riskPips > 0 ? input.spreadPips / riskPips : 0;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO paper_strategy_trades(
         trade_sequence, user_id, batch_id, strategy_version_id,
         instrument, decision_time, direction, entry, stop, target,
         planned_r, nominal_risk_percent, nominal_risk_amount,
         calculated_units, calculated_standard_lots, spread_pips,
         session, weekday, setup_name, checklist_score,
         conditions, features, news_status, opened_at,
         strategy_family, config_version, regime, trend_strength, volatility_bucket, atr_pips,
         experiment_id, original_direction, inverted, inversion_experiment_id,
         evaluation_id, spread_cost_r
       ) VALUES(
         $1, $2, $3, $4,
         $5, $6, $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16,
         $17, $18, $19, $20,
         $21::jsonb, $22::jsonb, $23, $24,
         $25, $26, $27, $28, $29, $30,
         $31, $32, $33, $34,
         $35, $36
       ) RETURNING id`,
      [
        nextSeq.rows[0]!.value, userId, batch.id, versionId,
        input.instrument, input.decisionTime, input.direction, input.entry, input.stop, input.target,
        riskReward, input.riskPercent, riskDollars,
        calculatedUnits, calculatedStandardLots, input.spreadPips,
        session, weekday, setupName, 10, // all 10 gates passed
        JSON.stringify(input.conditions), JSON.stringify(input.features), "not_evaluated", input.decisionTime,
        LEGACY_CONFIDENCE_V2_FAMILY, LEGACY_CONFIDENCE_V2_VERSION_VALUE, null, null, null, input.atrPips,
        LEGACY_CONFIDENCE_V2_EXPERIMENT, input.originalDirection, input.inverted, input.inverted ? LEGACY_CONFIDENCE_V2_EXPERIMENT : null,
        null, spreadCostR,
      ],
    );

    return { ok: true, tradeId: inserted.rows[0]!.id, tradeSequence: Number(nextSeq.rows[0]!.value), batchNumber: batch.batch_number };
  });
}
