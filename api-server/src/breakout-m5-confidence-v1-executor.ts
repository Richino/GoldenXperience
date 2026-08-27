/**
 * Breakout-m5-confidence-v1 paper-trade executor.
 * Same pattern as breakout-confidence-v1-executor. Tags trades with
 * strategy_family="breakout-m5-confidence-v1" in own batch series.
 */
import { transaction } from "./database.js";
import type { PoolClient } from "pg";

export const BREAKOUT_M5_FAMILY = "breakout-m5-confidence-v1";
export const BREAKOUT_M5_EXPERIMENT = "breakout-m5-confidence-v1";
export const BREAKOUT_M5_VERSION_NAME = "breakout-m5-confidence";
export const BREAKOUT_M5_VERSION_VALUE = "v1.0.0";
const COLLECTOR_LOCK = 24_100_004;

type BatchRow = { id: string; batch_number: number };

async function ensureVersion(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO strategy_versions(name,version,configuration) VALUES($1,$2,$3::jsonb)
     ON CONFLICT(name,version) DO UPDATE SET configuration = strategy_versions.configuration || EXCLUDED.configuration
     RETURNING id`,
    [
      BREAKOUT_M5_VERSION_NAME, BREAKOUT_M5_VERSION_VALUE,
      JSON.stringify({
        family: BREAKOUT_M5_FAMILY,
        description: "M5 breakout scalper + confidence flip. Walk-forward 72.6% winrate.",
        combinedRule: "flip whenever model DISAGREES with strategy direction (CONF_T=0.00)",
        trainedPairs: ["EUR_USD", "GBP_USD", "USD_JPY"],
      }),
    ],
  );
  return r.rows[0]!.id;
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
  const configuration = {
    targetR: 2.0, excludedPairs: [] as string[], excludedSessions: [] as string[],
    sourceRecommendationBatch: null as number | null,
    riskPercent: Number(process.env.BREAKOUT_M5_RISK_PERCENT ?? "1"),
  };
  const created = await client.query<BatchRow>(
    "INSERT INTO paper_strategy_batches(batch_number, strategy_version_id, universe, configuration, experiment_id, strategy_family) VALUES($1, $2, $3::jsonb, $4::jsonb, $5, $6) RETURNING id, batch_number",
    [Number(next.rows[0]!.number), versionId, JSON.stringify(["EUR_USD", "GBP_USD", "USD_JPY"]), JSON.stringify(configuration), BREAKOUT_M5_EXPERIMENT, BREAKOUT_M5_FAMILY],
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
function weekdayAt(iso: string): string { return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(iso)); }
function pipSizeFor(inst: string): number { return inst.endsWith("JPY") ? 0.01 : 0.0001; }

export type OpenM5Input = {
  instrument: string; decisionTime: string; direction: "long" | "short";
  entry: number; stop: number; target: number; spreadPips: number; atrPips: number;
  originalDirection: "long" | "short" | null; inverted: boolean;
  features: Record<string, unknown>; conditions: Array<Record<string, unknown>>;
  accountBalance: number; riskPercent: number;
};
export type OpenM5Result = { ok: true; tradeId: string; tradeSequence: number; batchNumber: number } | { ok: false; reason: string };

export async function openBreakoutM5Trade(input: OpenM5Input): Promise<OpenM5Result> {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [COLLECTOR_LOCK]);
    const userId = await ensureOwner(client);
    if (!userId) return { ok: false, reason: "no owner user found" };
    const versionId = await ensureVersion(client);
    const busy = await client.query("SELECT 1 FROM paper_strategy_trades WHERE instrument=$1 AND status='open'", [input.instrument]);
    if (busy.rowCount) return { ok: false, reason: "instrument already has an open trade" };
    const dup = await client.query("SELECT 1 FROM paper_strategy_trades WHERE strategy_version_id=$1 AND instrument=$2 AND decision_time=$3", [versionId, input.instrument, input.decisionTime]);
    if (dup.rowCount) return { ok: false, reason: "duplicate: this decision was already collected" };
    const batch = await ensureBatch(client, versionId);
    const pip = pipSizeFor(input.instrument);
    const riskPrice = Math.abs(input.entry - input.stop);
    if (riskPrice <= 0) return { ok: false, reason: "degenerate stop distance" };
    const riskPips = riskPrice / pip;
    const riskDollars = (input.accountBalance * input.riskPercent) / 100;
    const calculatedUnits = Math.floor(riskDollars / riskPrice);
    const calculatedStandardLots = calculatedUnits / 100_000;
    const targetDistance = Math.abs(input.target - input.entry);
    const riskReward = riskPrice > 0 ? targetDistance / riskPrice : 2.0;
    const nextSeq = await client.query<{ value: string }>("SELECT (COALESCE(max(trade_sequence),0)+1)::text AS value FROM paper_strategy_trades");
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
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21::jsonb, $22::jsonb, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36
       ) RETURNING id`,
      [
        nextSeq.rows[0]!.value, userId, batch.id, versionId,
        input.instrument, input.decisionTime, input.direction, input.entry, input.stop, input.target,
        riskReward, input.riskPercent, riskDollars,
        calculatedUnits, calculatedStandardLots, input.spreadPips,
        sessionLabel(input.decisionTime), weekdayAt(input.decisionTime), `${BREAKOUT_M5_FAMILY} ${input.direction}`, 5,
        JSON.stringify(input.conditions), JSON.stringify(input.features), "not_evaluated", input.decisionTime,
        BREAKOUT_M5_FAMILY, BREAKOUT_M5_VERSION_VALUE, null, null, null, input.atrPips,
        BREAKOUT_M5_EXPERIMENT, input.originalDirection, input.inverted, input.inverted ? BREAKOUT_M5_EXPERIMENT : null,
        null, spreadCostR,
      ],
    );
    return { ok: true, tradeId: inserted.rows[0]!.id, tradeSequence: Number(nextSeq.rows[0]!.value), batchNumber: batch.batch_number };
  });
}
