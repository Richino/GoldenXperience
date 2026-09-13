import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(serviceRoot, name), override: false, quiet: true });
}

const { query } = await import("../src/database.js");
const { getPracticeTradeState } = await import("../../frontend/src/lib/oanda/client.js");
const { measureBrokerExecution } = await import("../src/execution-measurement.js");
const DRY_RUN = process.argv.slice(2).includes("--dry-run");
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = limitArgument ? Number(limitArgument.slice("--limit=".length)) : null;
if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
  throw new Error("--limit must be a positive integer.");
}
const REPAIR_VERSION = "capped-practice-risk-v1";

type CappedTrade = {
  id: string;
  instrument: import("../../frontend/src/types/forex.js").MajorInstrument;
  direction: "long" | "short";
  entry: string;
  stop: string;
  calculated_units: string;
  nominal_risk_amount: string;
  inverted: boolean;
  result_r: string | null;
  broker_trade_id: string;
};

const rows = await query<CappedTrade>(
  `SELECT t.id,t.instrument,t.direction,t.entry,t.stop,t.calculated_units,t.nominal_risk_amount,
          t.inverted,t.result_r,i.broker_trade_id
     FROM paper_strategy_trades t
     JOIN practice_order_intents i ON i.paper_trade_id=t.id
    WHERE t.status='closed'
      AND i.status='submitted'
      AND i.broker_trade_id IS NOT NULL
      AND COALESCE((i.request_payload->>'notionalCapped')::boolean,false)=true
    ORDER BY t.closed_at ASC
    LIMIT COALESCE($1::integer,2147483647)`,
  [limit],
);

let repaired = 0;
let unchanged = 0;
let unavailable = 0;

for (const row of rows.rows) {
  try {
    const state = await getPracticeTradeState(row.broker_trade_id);
    const measurement = measureBrokerExecution({
      instrument: row.instrument,
      direction: row.direction,
      signalEntry: Number(row.entry),
      stop: Number(row.stop),
      requestedUnits: Number(row.calculated_units),
      nominalRiskAmount: Number(row.nominal_risk_amount),
      inverted: row.inverted,
    }, state);
    if (measurement === null || measurement.cashRiskR === null || !Number.isFinite(measurement.cashRiskR)) {
      unavailable += 1;
      continue;
    }
    const correctedR = measurement.cashRiskR;

    const priorR = row.result_r === null ? null : Number(row.result_r);
    if (priorR !== null && Math.abs(priorR - correctedR) <= 1e-9) {
      unchanged += 1;
      continue;
    }

    if (!DRY_RUN) {
      await query(
        `UPDATE paper_strategy_trades
            SET result_r=$2::numeric,
                net_result_r=$2::numeric,
                gross_result_r=CASE WHEN spread_cost_r IS NULL THEN NULL ELSE $2::numeric+spread_cost_r END,
                result_basis='broker',
                features=COALESCE(features,'{}'::jsonb)||jsonb_build_object(
                  'executionMeasurementV2',$3::jsonb,
                  'executionRiskRepair',jsonb_build_object(
                  'version',$4::text,
                    'repairedAt',now(),
                    'priorResultR',result_r,
                  'effectiveRiskHome',$5::numeric,
                  'resultR',$2::numeric
                  )
                ),
                updated_at=now()
          WHERE id=$1`,
        [row.id, correctedR, JSON.stringify(measurement), REPAIR_VERSION, measurement.sizingSnapshotRiskHome],
      );
    }
    repaired += 1;
  } catch (error) {
    unavailable += 1;
    console.error(`[capped-risk-repair] ${row.id}: ${error instanceof Error ? error.message : "broker lookup failed"}`);
  }
}

console.log(JSON.stringify({
  dryRun: DRY_RUN,
  scanned: rows.rowCount ?? rows.rows.length,
  repaired,
  unchanged,
  unavailable,
}, null, 2));
