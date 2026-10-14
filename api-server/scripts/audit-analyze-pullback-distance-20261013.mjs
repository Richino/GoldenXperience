import {config} from 'dotenv';import pg from 'pg';import fs from 'node:fs';
for(const p of ['.env','.env.local'])config({path:p,quiet:true});
const pool=new pg.Pool({connectionString:process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL});const db=await pool.connect();await db.query('BEGIN READ ONLY');
const plans=await db.query("SELECT instrument,status,created_at,plan FROM market_observer_plans WHERE created_at>=now()-interval '14 days' ORDER BY created_at DESC LIMIT 100");
const pending=await db.query("SELECT instrument,direction,entry_price,current_price_at_creation,status,created_at,expires_at,metadata FROM pending_manual_entries WHERE created_at>=now()-interval '14 days' ORDER BY created_at DESC LIMIT 100");
await db.query('ROLLBACK');db.release();await pool.end();
const dir='research-v2/analyze-pullback-distance-20261013';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/source.json',JSON.stringify({plans:plans.rows,pending:pending.rows},null,2));
console.log(JSON.stringify({plans:plans.rows.map(x=>({pair:x.instrument,status:x.status,at:x.created_at,entry:x.plan.entry,zone:x.plan.zone,mode:x.plan.mode,pullback:x.plan.pullback?.phase,thesis:x.plan.thesis,reason:x.plan.reason})),pending:pending.rows.slice(0,8)},null,2));
