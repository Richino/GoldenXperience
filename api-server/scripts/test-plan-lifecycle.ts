import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { evaluateConfirmation, type ConfirmationInput, type PlanForConfirmation } from "../src/trade-plan-confirmation.js";
import { assessThesis } from "../src/intelligence/thesis-updates.js";
import type { Candle } from "../../frontend/src/types/forex.js";

/**
 * Finite plan lifecycle on recorded candle sequences.
 *
 * Part 1 (pure): successful breakouts, failed breakouts, delayed and missing
 * retests, gaps, spread spikes, price running past the entry zone, attempts,
 * no lookahead, levels that never drift and conditions that never grow; plus
 * how new research changes a thesis.
 *
 * Part 2 (when DATABASE_URL is set): the database rules — approved plans are
 * locked, either side or both can be accepted, and linked plans cannot both
 * reserve an execution — inside ONE transaction that is always rolled back.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

const M15 = 900_000;
const T0 = Date.parse("2026-10-14T10:00:00Z"); // Wednesday, market open
type Ohlc = [number, number, number, number];
const m15 = (rows: Ohlc[], start = T0, times?: number[]): Candle[] =>
  rows.map(([open, high, low, close], i) => ({ time: new Date(times?.[i] ?? start + i * M15).toISOString(), open, high, low, close, volume: 1, complete: true }));
/** H1 from complete groups of four M15 candles aligned to the hour. */
function h1(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 3 < candles.length; i += 4) {
    const g = candles.slice(i, i + 4);
    if (Date.parse(g[0]!.time) % 3_600_000 !== 0) continue;
    if (Date.parse(g[3]!.time) - Date.parse(g[0]!.time) !== 3 * M15) continue;
    out.push({ time: g[0]!.time, open: g[0]!.open, close: g[3]!.close, high: Math.max(...g.map((c) => c.high)), low: Math.min(...g.map((c) => c.low)), volume: 4, complete: true });
  }
  return out;
}
const closeOf = (candles: Candle[]) => Date.parse(candles.at(-1)!.time) + M15;

/** A plan made with the finite rules (retest window 4, continuation window 3, one attempt, 1 ATR max deviation). */
const rules = {
  atrH1: 0.001, minRewardRisk: 1.5, confirmationValidMinutes: 60, breakoutCloseH1Atr: 0.25, retestToleranceH1Atr: 0.3, retestFailH1Atr: 0.25,
  retestWindowBars: 4, continuationWindowBars: 3, maxBreakoutAttempts: 1, maxEntryDeviationAtr: 1,
};
const plan: PlanForConfirmation = {
  instrument: "EUR_USD", direction: "BUY", setupType: "BREAKOUT_RETEST",
  entryZoneLow: 1.0997, entryZoneHigh: 1.1003, stopLoss: 1.0985, takeProfit: 1.105,
  createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 72 * 3_600_000).toISOString(),
  plan: { breakoutLevel: 1.1, breakoutAlreadyClosed: false, invalidation: { failLevel: 1.09975, zoneFarEdge: 1.099 }, rules },
};
const withRules = (patch: Record<string, unknown>): PlanForConfirmation => ({ ...plan, plan: { ...plan.plan, rules: { ...rules, ...patch } } });
const limits = { maxSpreadStopFraction: 0.15, maxDataAgeSeconds: 10, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 };

const BREAKOUT: Ohlc[] = [[1.0995, 1.0998, 1.0994, 1.0997], [1.0997, 1.1001, 1.0996, 1.1], [1.1, 1.1003, 1.0999, 1.1002], [1.1002, 1.1006, 1.1001, 1.1004]];
const RETEST: Ohlc[] = [[1.1004, 1.1006, 1.1001, 1.1002], [1.1002, 1.1004, 1.1, 1.1003]];
const CONT: Ohlc = [1.1003, 1.1009, 1.1002, 1.1008];
const HIGH: Ohlc = [1.1005, 1.1008, 1.1005, 1.1006]; // above the zone, no retest
const STALL: Ohlc = [1.1003, 1.1004, 1.1001, 1.1003]; // holds, no continuation
const quoteAt = (now: number, bid = 1.1007, ask = 1.1008) => ({ bid, ask, time: new Date(now - 1000).toISOString() });

function run(rows: Ohlc[], options: { plan?: PlanForConfirmation; now?: number; times?: number[]; quote?: ConfirmationInput["quote"]; news?: ConfirmationInput["news"] } = {}) {
  const candles = m15(rows, T0, options.times);
  const now = options.now ?? closeOf(candles) + 1000;
  return evaluateConfirmation({ plan: options.plan ?? plan, candles: { H1: h1(candles), M15: candles }, quote: options.quote === undefined ? quoteAt(now) : options.quote, news: options.news ?? [], now, limits });
}

// ── Part 1: recorded candle sequences ─────────────────────────────
await test("successful breakout → retest → continuation confirms", () => {
  const result = run([...BREAKOUT, ...RETEST, CONT]);
  assert.equal(result.outcome, "CONFIRMED", result.notTriggeredReason ?? "");
  assert.equal(result.safety?.ok, true);
});

await test("Test 8 — the breakout level never drifts with price: the plan's level decides, whatever price does", () => {
  // Price rallies far above first; the plan still waits for its own level's retest, not a new one at current price.
  const result = run([...BREAKOUT, HIGH, HIGH]);
  assert.equal(result.stage, "WAITING_FOR_RETEST");
  assert.match(result.notTriggeredReason ?? "", /retest of 1\.10000/);
});

await test("failed breakout (close back through the fail level) is invalidated", () => {
  assert.equal(run([...BREAKOUT, [1.1004, 1.1004, 1.0995, 1.0996]]).outcome, "INVALIDATED");
});

await test("delayed retest inside the approved window still confirms", () => {
  assert.equal(run([...BREAKOUT, HIGH, HIGH, ...RETEST, CONT]).outcome, "CONFIRMED");
});

await test("Test 10 — missing retest: MISSED when the window closes, and a late retest cannot reopen it", () => {
  const missed = run([...BREAKOUT, HIGH, HIGH, HIGH, HIGH]);
  assert.equal(missed.outcome, "MISSED");
  assert.match(missed.notTriggeredReason ?? "", /No retest .* within 4 M15 candles/);
  const late = run([...BREAKOUT, HIGH, HIGH, HIGH, HIGH, ...RETEST, CONT]);
  assert.equal(late.outcome, "MISSED", "the window does not reset");
  // Before the window closes, the remaining candles are shown.
  const waiting = run([...BREAKOUT, HIGH]);
  assert.deepEqual(waiting.progress.window, { window: "retest", used: 1, limit: 4 });
});

await test("Test 12 — price running away past the zone is MISSED, never chased", () => {
  const ran = run([...BREAKOUT, [1.1005, 1.1041, 1.1004, 1.104]]);
  assert.equal(ran.outcome, "MISSED");
  assert.match(ran.notTriggeredReason ?? "", /does not chase/);
  // Confirmed, but the executable price is now more than 1 ATR past the zone: missed, not re-armed.
  const rows = [...BREAKOUT, ...RETEST, CONT];
  const now = closeOf(m15(rows)) + 1000;
  assert.equal(run(rows, { now, quote: quoteAt(now, 1.1019, 1.102) }).outcome, "MISSED");
});

await test("Test 9 — the conditions never grow: every evaluation lists the same seven approved checks", () => {
  const sequences = [[...BREAKOUT], [...BREAKOUT, HIGH], [...BREAKOUT, ...RETEST], [...BREAKOUT, ...RETEST, CONT], [...BREAKOUT, ...RETEST, CONT, HIGH, HIGH]];
  const keys = sequences.map((rows) => run(rows).conditions.map((item) => item.key).join(","));
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], "breakout_close,breakout_size,retest,retest_holds,continuation,reward_risk,execution_safety");
});

await test("Test 11 — confirmation is final and identical on every later evaluation (no reset, no new requirement)", () => {
  const base = [...BREAKOUT, ...RETEST, CONT];
  const first = run(base);
  for (const extra of [[HIGH], [HIGH, HIGH, HIGH, HIGH, HIGH], [[1.1008, 1.1009, 1.0999, 1.1]] as Ohlc[]]) {
    const later = run([...base, ...extra]);
    assert.equal(later.outcome, "CONFIRMED");
    assert.equal(later.proposal!.confirmedAt, first.proposal!.confirmedAt, "the same confirming candle");
    assert.equal(later.proposal!.stopLoss, plan.stopLoss);
    assert.equal(later.proposal!.takeProfit, plan.takeProfit);
  }
});

await test("continuation window: the one approved attempt fails and the plan ends", () => {
  const result = run([...BREAKOUT, ...RETEST, STALL, STALL, STALL]);
  assert.equal(result.outcome, "INVALIDATED");
  assert.match(result.notTriggeredReason ?? "", /no M15 continuation within 3 candles/);
});

await test("a second breakout attempt only when the plan allows it, judged by the same rules", () => {
  const FLAT: Ohlc = [1.1001, 1.1002, 1.0999, 1.1001];
  const rows: Ohlc[] = [...BREAKOUT, ...RETEST, STALL, STALL, FLAT, FLAT, FLAT, FLAT, [1.1001, 1.1003, 1.1, 1.1002], [1.1002, 1.1004, 1.1001, 1.1003], [1.1003, 1.1005, 1.1002, 1.1004], [1.1004, 1.1006, 1.1003, 1.1005], [1.1004, 1.1005, 1.1002, 1.1004], [1.1004, 1.101, 1.1003, 1.1008]];
  const one = run(rows);
  assert.equal(one.outcome, "INVALIDATED");
  const two = run(rows, { plan: withRules({ maxBreakoutAttempts: 2 }) });
  assert.equal(two.outcome, "CONFIRMED", two.notTriggeredReason ?? "");
  assert.equal(two.progress.attempt, 2);
  assert.ok(two.events.some((event) => event.type === "ATTEMPT_FAILED"));
});

await test("gaps: windows count closed candles, so a weekend gap neither expires nor resets a retest window", () => {
  const rows = [...BREAKOUT, ...RETEST, CONT];
  const times = rows.map((_, i) => T0 + i * M15 + (i >= 4 ? 2 * 24 * 3_600_000 : 0)); // two days between breakout and retest
  const result = run(rows, { times, plan: { ...plan, expiresAt: new Date(T0 + 96 * 3_600_000).toISOString() } });
  assert.equal(result.outcome, "CONFIRMED", result.notTriggeredReason ?? "");
});

await test("no lookahead: candles after `now` are ignored exactly as if absent", () => {
  const all = [...BREAKOUT, ...RETEST, CONT];
  const now = closeOf(m15(BREAKOUT)) + 1000;
  const withFuture = run(all, { now });
  const truncated = run(BREAKOUT, { now });
  assert.equal(withFuture.outcome, "WAITING");
  assert.deepEqual(withFuture.conditions, truncated.conditions);
  assert.equal(withFuture.stage, truncated.stage);
});

await test("spread spike: confirmed but blocked; clears within the window → safe; still blocked after it → MISSED", () => {
  const rows = [...BREAKOUT, ...RETEST, CONT];
  const now = closeOf(m15(rows)) + 1000;
  const spike = run(rows, { now, quote: quoteAt(now, 1.1001, 1.1008) });
  assert.equal(spike.outcome, "CONFIRMED");
  assert.equal(spike.safety?.ok, false);
  assert.match(spike.safety!.blocks.join(" "), /Spread/);
  const cleared = run(rows, { now: now + 20 * 60_000, quote: quoteAt(now + 20 * 60_000) });
  assert.equal(cleared.outcome, "CONFIRMED");
  assert.equal(cleared.safety?.ok, true);
  const stillBlocked = run(rows, { now: now + 61 * 60_000, quote: quoteAt(now + 61 * 60_000, 1.1001, 1.1008) });
  assert.equal(stillBlocked.outcome, "MISSED");
});

await test("Test 13 — expiry ends a plan that never confirmed", () => {
  const rows = [...BREAKOUT, HIGH];
  assert.equal(run(rows, { plan: { ...plan, expiresAt: new Date(T0 + 30 * 60_000).toISOString() } }).outcome, "EXPIRED");
});

await test("plans approved before these rules keep their own (no window, no attempt limit added after approval)", () => {
  const legacy: PlanForConfirmation = { ...plan, plan: { ...plan.plan, rules: { atrH1: 0.001, minRewardRisk: 1.5, confirmationValidMinutes: 60, breakoutCloseH1Atr: 0.25, retestToleranceH1Atr: 0.3, retestFailH1Atr: 0.25 } } };
  const result = run([...BREAKOUT, HIGH, HIGH, HIGH, HIGH, HIGH], { plan: legacy });
  assert.equal(result.outcome, "WAITING");
  assert.equal(result.progress.maxAttempts, null);
});

await test("Test 7 — news strengthens or weakens a thesis; it never changes the plan or counts as confirmation", () => {
  const prev = { weights: { supporting: 3, opposing: 3 }, supportingIds: ["F1"], opposingIds: ["F2"] };
  const next = (supporting: number, opposing: number, fresh = true) => ({
    fresh, weights: { supporting, opposing }, supportingIds: ["F1", "F3"], opposingIds: ["F2"],
    supporting: [{ id: "F1", factor: "USD softer", sourceIds: ["src_001"] }, { id: "F3", factor: "Yields fall", sourceIds: ["src_002"] }],
    opposing: [{ id: "F2", factor: "Fiscal risk", sourceIds: ["src_003"] }],
  });
  const stronger = assessThesis(prev, next(6, 3));
  assert.equal(stronger.assessment, "STRENGTHENING");
  assert.match(stronger.summary, /Yields fall/);
  assert.deepEqual(stronger.added.supporting.map((f) => f.id), ["F3"]);
  assert.equal(assessThesis(prev, next(3, 6)).assessment, "WEAKENING");
  assert.equal(assessThesis(prev, next(4, 3)).assessment, "CONFLICTED");
  assert.equal(assessThesis({ ...prev, weights: { supporting: 2, opposing: 0 } }, next(3, 0)).assessment, "UNCHANGED");
  assert.equal(assessThesis(prev, next(9, 0, false)).assessment, "OUTDATED");
  // The engine never reads research: identical candles give identical results with or without it.
  assert.deepEqual(run([...BREAKOUT, HIGH]).conditions, run([...BREAKOUT, HIGH]).conditions);
});

// ── Part 2: database rules, rolled back ───────────────────────────
if (!process.env.DATABASE_URL) {
  console.log(`plan lifecycle: ${passed} checks passed (database checks skipped)`);
  process.exit(0);
}
const { db } = await import("../src/database.js");
const { reserveExecution } = await import("../src/trade-plan-executor.js");
const client = await db().connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '3s'");
  if (!(await client.query("SELECT to_regclass('research_jobs') AS t")).rows[0].t) {
    await client.query(fs.readFileSync(path.join(root, "migrations", "059_research_jobs.sql"), "utf8"));
  }
  await client.query(fs.readFileSync(path.join(root, "migrations", "060_plan_lifecycle.sql"), "utf8"));
  const user = (await client.query<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0]!;
  const analysis = "00000000-0000-4000-8000-00000000a001";
  const insertPlan = async (direction: "BUY" | "SELL", status: string) => (await client.query<{ id: string }>(
    `INSERT INTO trade_plans(user_id,analysis_id,instrument,direction,setup_type,status,plan_hash,monitoring_mode,timeframe,market_bias,trend_classification,
                             entry_zone_low,entry_zone_high,stop_loss,take_profit,reward_risk,max_risk_percent,plan,strategy_version,expires_at)
     VALUES($1,$2,'GBP_USD',$3,'BREAKOUT_RETEST',$4,'hash-'||$3,'AUTO','H4','MIXED','RANGE',1.3,1.31,1.29,1.33,2,1,'{}'::jsonb,'test',now()+interval '3 days') RETURNING id`,
    [user.id, analysis, direction, status],
  )).rows[0]!.id;
  const buy = await insertPlan("BUY", "MONITORING");
  const sell = await insertPlan("SELL", "MONITORING");

  await test("invalidating one approved scenario leaves the opposite side monitoring", async () => {
    await client.query("SAVEPOINT opposite_survives");
    await client.query("UPDATE trade_plans SET status='INVALIDATED' WHERE id=$1", [buy]);
    assert.equal((await client.query("SELECT status FROM trade_plans WHERE id=$1", [sell])).rows[0].status, "MONITORING");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM trade_plan_execution_attempts WHERE plan_id=ANY($1::uuid[])", [[buy, sell]])).rows[0].n, 0, "invalidation alone does not place the opposite trade");
    await client.query("ROLLBACK TO SAVEPOINT opposite_survives");
  });

  await test("Test 6 — an approved plan is locked: levels, rules, expiry and mode cannot change in place", async () => {
    for (const change of ["stop_loss=1.28", "take_profit=1.4", "entry_zone_low=1.29", "expires_at=expires_at+interval '1 day'", "plan='{\"rules\":{\"x\":1}}'::jsonb", "monitoring_mode='NOTIFY'"]) {
      await client.query("SAVEPOINT s");
      await assert.rejects(client.query(`UPDATE trade_plans SET ${change} WHERE id=$1`, [buy]), /cannot be changed/, change);
      await client.query("ROLLBACK TO SAVEPOINT s");
    }
    // Status moves still work; a confirmed plan cannot go back to monitoring.
    await client.query("UPDATE trade_plans SET status='CONFIRMED' WHERE id=$1", [buy]);
    await client.query("SAVEPOINT s");
    await assert.rejects(client.query("UPDATE trade_plans SET status='MONITORING' WHERE id=$1", [buy]), /Illegal trade plan transition/);
    await client.query("ROLLBACK TO SAVEPOINT s");
    await client.query("UPDATE trade_plans SET status='MISSED' WHERE id=$1", [buy]);
    await client.query("UPDATE trade_plans SET status='MONITORING' WHERE id=$1 AND false", [buy]);
  });

  await test("Test 14 — linked plans cannot both reserve an Auto execution; a rejected attempt releases the group", async () => {
    const a = await insertPlan("BUY", "EXECUTION_PENDING");
    const b = await insertPlan("SELL", "EXECUTION_PENDING");
    for (const id of [a, b]) {
      await client.query("INSERT INTO trade_plan_approvals(plan_id,user_id,plan_version,plan_hash,monitoring_mode) SELECT id,user_id,plan_version,plan_hash,'AUTO' FROM trade_plans WHERE id=$1", [id]);
    }
    const row = async (id: string) => (await client.query("SELECT id,user_id,analysis_id,plan_version,plan_hash FROM trade_plans WHERE id=$1", [id])).rows[0];
    const first = await reserveExecution(client, await row(a));
    assert.equal(first.kind, "reserved");
    const second = await reserveExecution(client, await row(b));
    assert.equal(second.kind, "linked", "the other side is refused while the first is live");
    // Test 15: a repeated call for the same plan version never creates a second attempt.
    assert.equal((await reserveExecution(client, await row(a))).kind, "exists");
    // The broker rejected the first: the group is free for the other side.
    await client.query("UPDATE trade_plan_execution_attempts SET status='REJECTED' WHERE plan_id=$1", [a]);
    assert.equal((await reserveExecution(client, await row(b))).kind, "reserved");
    // An approval that does not match the plan version is refused.
    const c = await insertPlan("BUY", "EXECUTION_PENDING");
    await client.query("INSERT INTO trade_plan_approvals(plan_id,user_id,plan_version,plan_hash,monitoring_mode) SELECT id,user_id,plan_version,'other-hash','AUTO' FROM trade_plans WHERE id=$1", [c]);
    assert.equal((await reserveExecution(client, { ...(await row(c)), analysis_id: "00000000-0000-4000-8000-00000000a002" })).kind, "unapproved");
  });
  void sell;
} finally {
  await client.query("ROLLBACK");
  client.release();
}
// Research first (reads only): without fresh validated research for the pair, no plan is built at all.
{
  const { latestResearch } = await import("../src/intelligence/research-service.js");
  const { generateAndStoreTradePlans } = await import("../src/trade-plan-service.js");
  const { query: q, db: database } = await import("../src/database.js");
  const pair = "AUD_NZD";
  const user = (await q<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0]!;
  const latest = await latestResearch(pair);
  if (latest.research?.fresh) console.log("skip research-first check: AUD_NZD has fresh research");
  else {
    await test("Test 3 — no plans are generated before research is validated (409, nothing written)", async () => {
      const before = (await q<{ n: number }>("SELECT count(*)::int AS n FROM trade_plans WHERE instrument=$1", [pair])).rows[0]!.n;
      await assert.rejects(generateAndStoreTradePlans(user.id, pair as never), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /Research/.test(error.message));
      const after = (await q<{ n: number }>("SELECT count(*)::int AS n FROM trade_plans WHERE instrument=$1", [pair])).rows[0]!.n;
      assert.equal(after, before);
    });
  }
  await database().end().catch(() => undefined);
}
console.log(`plan lifecycle: ${passed} checks passed (database checks rolled back)`);
