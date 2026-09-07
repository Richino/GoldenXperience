import fs from 'node:fs';
import path from 'node:path';
import {config} from 'dotenv';
for (const name of ['.env','.env.local']) config({path:path.resolve(name),override:false,quiet:true});
if(process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL=process.env.DATABASE_PUBLIC_URL;
const {db}=await import('../src/database.js');
const client=await db().connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='45s'");
  const sql=fs.readFileSync(process.argv[2]!, 'utf8');
  const result=await client.query(sql);
  const output=JSON.stringify({queriedAt:new Date().toISOString(),rows:result.rows},null,2);
  if(process.argv[3]) fs.writeFileSync(process.argv[3],output);
  else console.log(output);
  await client.query('ROLLBACK');
} finally {client.release();await db().end();}
