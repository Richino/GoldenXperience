import { query, transaction } from "./database.js";
import { getStrategySnapshot } from "../../frontend/src/lib/strategy/strategy-service.js";

const INSTRUMENTS = [{ code: "EUR_USD", display: "EUR/USD", precision: 5 }, { code: "GBP_USD", display: "GBP/USD", precision: 5 }, { code: "USD_JPY", display: "USD/JPY", precision: 3 }];

function decisionTime(value: string) { const date = new Date(value); date.setUTCSeconds(0, 0); date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 15) * 15); return date.toISOString(); }

export async function collectForwardEvaluation() {
  const snapshot = await getStrategySnapshot();
  if (snapshot.accountStatus.source !== "oanda" || snapshot.accountStatus.state !== "connected") return { collected: 0, reason: "OANDA is not connected" };
  for (const instrument of INSTRUMENTS) await query("INSERT INTO instruments(code,display_name,price_precision) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING", [instrument.code, instrument.display, instrument.precision]);
  const version = await query<{ id: string }>("INSERT INTO strategy_versions(name,version,configuration) VALUES('deterministic-forex','v1','{\"timeframes\":[\"M15\",\"H1\",\"H4\"]}') ON CONFLICT(name,version) DO UPDATE SET name=EXCLUDED.name RETURNING id");
  let collected = 0;
  for (const setup of snapshot.strategy.setups) {
    if (setup.dataSource !== "oanda") continue;
    const time = decisionTime(setup.evaluatedAt);
    await transaction(async (client) => {
      const saved = await client.query<{ id: string }>("INSERT INTO strategy_evaluations(strategy_version_id,instrument,decision_time,source_kind,status,direction,entry,stop,target,risk_reward,spread_pips,conditions,candle_cutoff) VALUES($1,$2,$3,'forward',$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(strategy_version_id,instrument,decision_time,source_kind) DO NOTHING RETURNING id", [version.rows[0]!.id, setup.instrument, time, setup.status, setup.direction, setup.entry, setup.stop, setup.target, setup.riskReward, null, JSON.stringify(setup.conditions), time]);
      const id = saved.rows[0]?.id; if (!id) return;
      await client.query("INSERT INTO evaluation_features(evaluation_id,feature_version,features) VALUES($1,'strategy-output-v1',$2)", [id, JSON.stringify({ summary: setup.summary, passedConditions: setup.passedConditions, failedConditions: setup.failedConditions, positionSize: setup.positionSize })]);
      if (setup.status === "valid" && setup.entry !== null && setup.stop !== null && setup.target !== null) await client.query("INSERT INTO trade_candidates(evaluation_id,status,raw_units,applied_units) VALUES($1,'planned',$2,$3)", [id, setup.positionSize?.calculatedUnits ?? null, setup.positionSize?.units ?? null]);
      collected += 1;
    });
  }
  return { collected };
}
