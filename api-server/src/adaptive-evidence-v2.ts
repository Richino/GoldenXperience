import { query } from './database.js';
import { contextKeysFor, type EvidenceStore, type BucketStat } from './adaptive-engine.js';
import { comparableExecutedR, ADAPTIVE_EVIDENCE_VERSION, type ExecutionMeasurement, type ExecutionPolicy } from './execution-measurement.js';
import { SEED_STRATEGY_CONFIGS } from '../../frontend/src/lib/strategy/strategies/index.js';
import { MOMENTUM_DIRECTION_INVERSION, MOMENTUM_INVERSION_EXPERIMENT } from './momentum-inversion.js';
import { dayTradingSession } from '../../frontend/src/lib/strategy/strategy-engine.js';

export interface EvidenceObservationV2 {
  family: string; configVersion: string; policy: ExecutionPolicy;
  instrument: string; session: string; regime: string; direction: string;
  resultR: number; resolvedAt: string;
}

/** No old-config or opposite-policy outcomes can enter a current-policy bucket. */
export function buildEvidenceV2(observations: EvidenceObservationV2[], asOf: Date): EvidenceStore {
  const configs=new Map<string,string>(SEED_STRATEGY_CONFIGS.map(x=>[x.family,x.configVersion]));
  const context=new Map<string,BucketStat>();let totalResolved=0;
  for(const o of observations){
    const policy=o.family==='momentum'&&MOMENTUM_DIRECTION_INVERSION?'momentum-inversion-v1':'follow-v1';
    if(o.policy!==policy||o.configVersion!==configs.get(o.family)||!Number.isFinite(o.resultR)||!Number.isFinite(Date.parse(o.resolvedAt))||Date.parse(o.resolvedAt)>asOf.getTime())continue;
    totalResolved++;
    for(const key of contextKeysFor(o.family,o.instrument,o.session,o.regime,o.direction)){
      const s=context.get(key)??{resolved:0,wins:0,netR:0,sumSqR:0,grossR:0,mfe:null,mae:null};
      s.resolved++;s.wins+=Number(o.resultR>0);s.netR+=o.resultR;s.sumSqR+=o.resultR*o.resultR;
      // No synthetic gross reconstruction from a differently scaled cash R.
      s.grossR+=o.resultR;context.set(key,s);
    }
  }
  return {totalResolved,context,evidenceVersion:ADAPTIVE_EVIDENCE_VERSION};
}

export async function loadAdaptiveEvidenceV2(experimentId: string,asOf: Date): Promise<EvidenceStore>{
  const observations:EvidenceObservationV2[]=[];
  const trades=await query<{
    strategy_family:string;config_version:string;instrument:string;session:string;regime:string;
    original_direction:string|null;direction:string;inverted:boolean;result_basis:string|null;
    result_r:string|null;closed_at:string|Date;order_status:string|null;measurement:ExecutionMeasurement|null;
  }>(`SELECT t.strategy_family,t.config_version,t.instrument,t.session,COALESCE(t.regime,'mixed') regime,
      t.original_direction,t.direction,t.inverted,t.result_basis,COALESCE(t.net_result_r,t.result_r) result_r,t.closed_at,
      i.status order_status,t.features->'executionMeasurementV2' measurement
      FROM paper_strategy_trades t LEFT JOIN practice_order_intents i ON i.paper_trade_id=t.id
      WHERE t.experiment_id=$1 AND t.status='closed' AND t.closed_at<=$2
        AND t.strategy_family IN ('ema','breakout','momentum','meanrev')`,[experimentId,asOf.toISOString()]);
  for(const t of trades.rows){
    const policy:ExecutionPolicy=t.inverted?'momentum-inversion-v1':'follow-v1';
    const resultR=comparableExecutedR({resultBasis:t.result_basis,modelR:t.result_r===null?null:Number(t.result_r),orderStatus:t.order_status,measurement:t.measurement,policy,asOf:asOf.toISOString()});
    if(resultR===null)continue;
    observations.push({family:t.strategy_family,configVersion:t.config_version,policy,instrument:t.instrument,session:t.session,regime:t.regime,direction:t.original_direction??t.direction,resultR,resolvedAt:t.measurement?.closedAt??new Date(t.closed_at).toISOString()});
  }
  const shadows=await query<{strategy_family:string;config_version:string;instrument:string;decision_time:string|Date;regime:string;direction:string;result_r:string;resolved_at:string|Date}>(
    `SELECT e.strategy_family,e.config_version,e.instrument,e.decision_time,COALESCE(e.regime,'mixed') regime,
      e.direction,COALESCE(s.net_result_r,s.result_r) result_r,s.resolved_at
     FROM shadow_candidate_outcomes s JOIN paper_strategy_evaluations e ON e.id=s.evaluation_id
     WHERE e.experiment_id=$1 AND e.strategy_family IN ('ema','breakout','meanrev')
       AND e.direction IS NOT NULL AND s.result_r IS NOT NULL AND s.resolved_at<=$2
       AND s.outcome IN ('target_first','stop_first','forced_close','timeout')
       AND s.superseded_by_trade_id IS NULL AND e.paper_trade_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM paper_strategy_trades t WHERE t.evaluation_id=e.id OR
         (t.instrument=e.instrument AND t.decision_time=e.decision_time AND t.strategy_family=e.strategy_family))`,[experimentId,asOf.toISOString()]);
  for(const s of shadows.rows)observations.push({family:s.strategy_family,configVersion:s.config_version,policy:'follow-v1',instrument:s.instrument,session:dayTradingSession(new Date(s.decision_time)).label,regime:s.regime,direction:s.direction,resultR:Number(s.result_r),resolvedAt:new Date(s.resolved_at).toISOString()});
  // Exactly the policy's own unexecuted arm; the original arm is only its key.
  const momentum=await query<{config_version:string;instrument:string;session:string;regime:string;direction:string;result_r:string;resolved_at:string|Date}>(
    `SELECT a.config_version,a.instrument,a.session,COALESCE(a.regime,'mixed') regime,o.direction,
      COALESCE(a.net_result_r,a.result_r) result_r,a.resolved_at
     FROM momentum_inversion_arms a JOIN momentum_inversion_arms o ON o.pair_id=a.pair_id AND o.arm='original'
     WHERE a.experiment_id=$1 AND a.arm=$2 AND a.status='resolved' AND NOT a.executed
       AND a.outcome_source='shadow' AND a.result_r IS NOT NULL AND a.resolved_at<=$3
       AND NOT EXISTS(SELECT 1 FROM paper_strategy_trades t WHERE t.instrument=a.instrument AND t.decision_time=a.decision_time AND t.strategy_family='momentum')`,
    [MOMENTUM_INVERSION_EXPERIMENT,MOMENTUM_DIRECTION_INVERSION?'inverted':'original',asOf.toISOString()]);
  for(const m of momentum.rows)observations.push({family:'momentum',configVersion:m.config_version,policy:MOMENTUM_DIRECTION_INVERSION?'momentum-inversion-v1':'follow-v1',instrument:m.instrument,session:m.session,regime:m.regime,direction:m.direction,resultR:Number(m.result_r),resolvedAt:new Date(m.resolved_at).toISOString()});
  return buildEvidenceV2(observations,asOf);
}
