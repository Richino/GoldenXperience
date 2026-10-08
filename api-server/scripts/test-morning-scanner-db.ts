import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { config } from "dotenv";
import { runMorningScan, MorningRefreshLimited, morningPicksSnapshot } from "../src/morning-market-scanner.js";
import { db, query } from "../src/database.js";
import { computeSessionTradability } from "../../frontend/src/lib/strategy/ny-tradability.js";
import { fixtureInput, FIXTURE_TIME } from "./fixtures/morning-scan.js";
import { evaluateSelection } from "../src/market-selection-service.js";

config({ path: new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), quiet: true });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required for the isolated-schema integration test.");
const base = process.env.DATABASE_URL;
const admin = new Pool({ connectionString: base, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
const schema = `gx_morning_test_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA "${schema}"`);
const url = new URL(base); url.searchParams.set("options", `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
let checks = 0;
const check = async (name: string, fn: () => Promise<void>) => { await fn(); checks++; console.log(`ok ${name}`); };
const pairs = ["EUR_USD","GBP_USD","USD_JPY"].map(i => computeSessionTradability(fixtureInput(i)));
let calls = 0;
const dependencies = {
  discover: async () => pairs.map(p => p.instrument),
  evaluate: async () => { calls++; return { pairs, evaluatedAt: FIXTURE_TIME.toISOString(), newsFetchedAt: FIXTURE_TIME.toISOString(), newsCoverageUntil: "2026-10-09T20:00:00Z" }; },
  timeoutMs: 1000,
};
try {
  await query(await readFile(new URL("../migrations/053_morning_market_scans.sql", import.meta.url), "utf8"));
  await check("schedule persists once and repeat/replica run is idempotent", async () => {
    await Promise.all([runMorningScan("scheduled", FIXTURE_TIME, dependencies), runMorningScan("scheduled", FIXTURE_TIME, dependencies)]);
    assert.equal(calls, 1);
    assert.equal((await query("SELECT 1 FROM morning_market_scans")).rowCount, 1);
    const snapshot = await morningPicksSnapshot(FIXTURE_TIME);
    assert.equal(snapshot.state, "READY"); assert.equal(snapshot.current!.shortlist.length, 3);
    assert.deepEqual(snapshot.current!.sharedCurrencies, ["USD"]);
  });
  await check("manual endpoint service deduplicates slot and enforces persisted cooldown", async () => {
    await runMorningScan("manual", FIXTURE_TIME, dependencies);
    await assert.rejects(runMorningScan("manual", FIXTURE_TIME, dependencies), MorningRefreshLimited);
    assert.equal(calls, 1);
  });
  await check("provider failure is recorded, old good run remains explicitly stale", async () => {
    await runMorningScan("scheduled", new Date("2026-10-07T10:40:00Z"), { ...dependencies, discover: async () => { throw new Error("Synthetic provider outage"); } });
    const snapshot = await morningPicksSnapshot(new Date("2026-10-07T10:40:00Z"));
    assert.equal(snapshot.state, "STALE"); assert.equal(snapshot.lastAttempt!.status, "FAILED"); assert.match(snapshot.lastAttempt!.error!, /Synthetic provider outage/);
    assert.equal(snapshot.current!.shortlist.length, 3);
  });
  await check("job timeout aborts work and leaves no partial current snapshot", async () => {
    await runMorningScan("scheduled", new Date("2026-10-07T10:45:00Z"), { ...dependencies, timeoutMs: 10,
      evaluate: async (_names: string[], signal?: AbortSignal) => { await new Promise((resolve, reject) => { const t = setTimeout(resolve, 100); signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true }); }); return dependencies.evaluate(); } });
    const snapshot = await morningPicksSnapshot(new Date("2026-10-07T10:45:00Z"));
    assert.equal(snapshot.lastAttempt!.status, "FAILED"); assert.match(snapshot.lastAttempt!.error!, /deadline/);
    assert.equal(snapshot.current!.shortlist.length, 3);
  });
  await check("partial failures excluded from ranking but retained in history", async () => {
    const missing = computeSessionTradability({ ...fixtureInput("EUR_GBP"), quote: null });
    await runMorningScan("scheduled", new Date("2026-10-07T10:50:00Z"), { ...dependencies, discover: async () => [...pairs.map(p=>p.instrument), "EUR_GBP"],
      evaluate: async () => ({ ...await dependencies.evaluate(), pairs: [...pairs, missing] }) });
    const current = (await morningPicksSnapshot(FIXTURE_TIME)).current!;
    assert.equal(current.status, "PARTIAL"); assert.equal(current.shortlist.length, 3); assert.equal(current.failures.length, 1);
    assert.equal((await query("SELECT 1 FROM morning_market_scans WHERE status='SUCCESS'")).rowCount, 1);
  });
  await check("all broker instruments halted publishes CLOSED with no recommendations", async () => {
    const halted = pairs.map(p => computeSessionTradability({ ...fixtureInput(p.instrument), quote: { ...fixtureInput(p.instrument).quote!, tradeable: false } }));
    await runMorningScan("scheduled", new Date("2026-10-07T10:55:00Z"), { ...dependencies, evaluate: async () => ({ ...await dependencies.evaluate(), pairs: halted }) });
    const snapshot = await morningPicksSnapshot(FIXTURE_TIME);
    assert.equal(snapshot.state, "CLOSED"); assert.equal(snapshot.current!.shortlist.length, 0);
  });
  await check("broker inputs archive into existing candle/quote schemas without duplicate candle histories", async () => {
    await query(`CREATE TABLE market_candles(instrument text,timeframe text,close_time timestamptz,open numeric,high numeric,low numeric,close numeric,volume bigint,source text, UNIQUE(instrument,timeframe,close_time,source));
      CREATE TABLE quote_snapshots(instrument text,observed_at timestamptz,bid numeric,ask numeric,spread_pips numeric,source text)`);
    const originalFetch=globalThis.fetch; const originalNow=Date.now;
    const originalToken=process.env.OANDA_API_KEY; const originalAccount=process.env.OANDA_ACCOUNT_ID;
    process.env.OANDA_API_KEY="synthetic-test-token";process.env.OANDA_ACCOUNT_ID="synthetic-test-account";
    Date.now=()=>FIXTURE_TIME.getTime();
    const input=fixtureInput("EUR_USD");
    globalThis.fetch=async destination=>{
      const url=new URL(String(destination));
      if(url.pathname.endsWith("/candles"))return Response.json({granularity:url.searchParams.get("granularity"),candles:(url.searchParams.get("granularity")==="M15"?input.m15:input.h1)!.map(b=>({time:b.time,volume:b.volume,complete:b.complete,mid:{o:String(b.open),h:String(b.high),l:String(b.low),c:String(b.close)}}))});
      if(url.pathname.endsWith("/pricing"))return Response.json({prices:[{instrument:"EUR_USD",time:input.quote!.time,status:"tradeable",bids:[{price:String(input.quote!.bid)}],asks:[{price:String(input.quote!.ask)}]}]});
      if(url.hostname==="nfs.faireconomy.media")return Response.json([{title:"Synthetic release",country:"USD",date:"2026-10-09T12:30:00Z",impact:"High"}]);
      throw new Error("Unexpected provider in isolated archive test");
    };
    try {
      await evaluateSelection(["EUR_USD"],undefined,true);
      assert.equal((await query("SELECT 1 FROM market_candles")).rowCount,620);
      assert.equal((await query("SELECT 1 FROM quote_snapshots")).rowCount,1);
      await evaluateSelection(["EUR_USD"],undefined,true);
      assert.equal((await query("SELECT 1 FROM market_candles")).rowCount,620);
      const quotes=await query<{bid:string;ask:string}>("SELECT bid,ask FROM quote_snapshots LIMIT 1");
      assert.equal(Number(quotes.rows[0]!.bid),input.quote!.bid);assert.equal(Number(quotes.rows[0]!.ask),input.quote!.ask);
    } finally {
      globalThis.fetch=originalFetch;Date.now=originalNow;
      if(originalToken===undefined)delete process.env.OANDA_API_KEY;else process.env.OANDA_API_KEY=originalToken;
      if(originalAccount===undefined)delete process.env.OANDA_ACCOUNT_ID;else process.env.OANDA_ACCOUNT_ID=originalAccount;
    }
  });
  console.log(`${checks} isolated PostgreSQL integration checks passed.`);
} finally {
  await db().end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  process.env.DATABASE_URL = base;
}
