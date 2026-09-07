import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {config} from 'dotenv';
for(const file of ['.env','.env.local'])config({path:path.resolve(file),override:false,quiet:true});
if(process.env.DATABASE_PUBLIC_URL)process.env.DATABASE_URL=process.env.DATABASE_PUBLIC_URL;
const {db}=await import('../../src/database.js');
const {EVALUATION_SNAPSHOT_CONFLICT_RULE,EXECUTION_STATUS_CONFLICT_RULE}=await import('../../src/paper-cycle.js');
const {loadAdaptiveEvidenceV2}=await import('../../src/adaptive-evidence-v2.js');
const pool=db();pool.options.max=1;
const client=await pool.connect();
const fields=['setup_status','direction','entry','stop','target','risk_reward','spread_pips','conditions','features','strategy_family','config_version','regime','trend_strength','volatility_bucket','atr_pips','experiment_id'];
try{
 await client.query('BEGIN');
 // Temporary table only; rollback removes it. Never run INSERT on a public table.
 await client.query(`CREATE TEMP TABLE paper_strategy_evaluations(id int PRIMARY KEY,execution_status text,trade_created boolean,paper_trade_id text,rejection_reason text,${fields.map(f=>`${f} text`).join(',')}) ON COMMIT DROP`);
 const columns=['id','execution_status','trade_created','paper_trade_id','rejection_reason',...fields];
 const upsert=`INSERT INTO pg_temp.paper_strategy_evaluations(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT(id) DO UPDATE SET ${EVALUATION_SNAPSHOT_CONFLICT_RULE},${EXECUTION_STATUS_CONFLICT_RULE}`;
 for(const [i,state,created,tradeId] of [[1,'selected',false,null],[2,'blocked',true,'trade-2'],[3,'blocked',false,null]] as const){
  await client.query(upsert,[i,state,created,tradeId,'original reason',...fields.map(f=>`original ${f}`)]);
  await client.query(upsert,[i,'blocked',false,null,'new rejection',...fields.map(f=>`later ${f}`)]);
  const row=(await client.query('SELECT * FROM pg_temp.paper_strategy_evaluations WHERE id=$1',[i])).rows[0];
  for(const f of fields)assert.equal(row[f],`${i===3?'later':'original'} ${f}`,`snapshot ${i} ${f}`);
  if(i===1){assert.equal(row.execution_status,'selected');assert.equal(row.rejection_reason,'original reason');}
  else assert.equal(row.rejection_reason,'new rejection');
 }
 await client.query('ROLLBACK');
 await client.query('SET default_transaction_read_only=on');
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
try{
 const frozen=JSON.parse(fs.readFileSync('research-v2/four-family-v2-201-trades/cohort.json','utf8'));
 const asOf=new Date('2026-09-05T18:00:00Z');
 const evidence=await loadAdaptiveEvidenceV2(frozen.cohort[0].experiment_id,asOf);
 assert.equal(evidence.evidenceVersion,'four-family-policy-price-risk-v2');
 for(const bucket of evidence.context.values()){assert.ok(Number.isFinite(bucket.netR));assert.ok(bucket.resolved>0);}
 const report={asOf:asOf.toISOString(),evidenceVersion:evidence.evidenceVersion,totalResolved:evidence.totalResolved,families:Object.fromEntries(['ema','breakout','momentum','meanrev'].map(f=>[f,evidence.context.get(`${f}|*|*|*|*`)])),checks:['Selected and trade-linked snapshots immutable','Unexecuted snapshots update and preserve rejection reasons','Current evidence SQL exercised in read-only mode'],productionWrites:0};
 fs.writeFileSync('research-v2/four-family-v2-201-trades/DB_CHECKS.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await pool.end();}
