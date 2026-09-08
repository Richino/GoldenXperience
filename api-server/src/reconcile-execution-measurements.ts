import { query } from './database.js';
import { getPracticeTradeState } from '../../frontend/src/lib/oanda/client.js';
import { measureBrokerExecution, EXECUTION_MEASUREMENT_VERSION } from './execution-measurement.js';
import type { MajorInstrument } from '../../frontend/src/types/forex.js';

/** Add broker facts to closed rows without overwriting their original journal. */
export async function reconcileClosedExecutionMeasurements(limit = 25) {
  const rows = await query<{
    id: string; instrument: MajorInstrument; direction: 'long'|'short'; entry: string; stop: string;
    calculated_units: string; nominal_risk_amount: string; inverted: boolean; broker_trade_id: string;
  }>(`SELECT t.id,t.instrument,t.direction,t.entry,t.stop,t.calculated_units,t.nominal_risk_amount,t.inverted,i.broker_trade_id
      FROM paper_strategy_trades t JOIN practice_order_intents i ON i.paper_trade_id=t.id
     WHERE t.status='closed' AND t.strategy_family IN ('ema','breakout','momentum','meanrev')
       AND i.status='submitted' AND i.broker_trade_id IS NOT NULL
       AND COALESCE(t.features->'executionMeasurementV2'->>'version','')<>$1
       AND COALESCE((t.features->>'executionMeasurementCheckedAt')::timestamptz,'epoch') < now()-interval '10 minutes'
     ORDER BY COALESCE((t.features->>'executionMeasurementCheckedAt')::timestamptz,'epoch'),t.closed_at DESC LIMIT $2`,
    [EXECUTION_MEASUREMENT_VERSION,limit]);
  let measured=0;
  for(const row of rows.rows){
    // Record attempts before the remote read so unavailable broker records do
    // not monopolize every collector tick.
    await query(`UPDATE paper_strategy_trades SET features=COALESCE(features,'{}'::jsonb)||$2::jsonb WHERE id=$1`,
      [row.id,JSON.stringify({executionMeasurementCheckedAt:new Date().toISOString()})]);
    try {
      const state=await getPracticeTradeState(row.broker_trade_id);
      const m=measureBrokerExecution({instrument:row.instrument,direction:row.direction,signalEntry:Number(row.entry),stop:Number(row.stop),requestedUnits:Number(row.calculated_units),nominalRiskAmount:Number(row.nominal_risk_amount),inverted:row.inverted},state);
      await query(`UPDATE paper_strategy_trades SET features=COALESCE(features,'{}'::jsonb)||$2::jsonb WHERE id=$1`,
        [row.id,JSON.stringify({executionMeasurementCheckedAt:new Date().toISOString(),...(m?{executionMeasurementV2:m}:{})})]);
      if(m)measured++;
    }catch(error){console.error('[execution-measurement] broker reconciliation unavailable',error instanceof Error?error.name:'error');}
  }
  return measured;
}
