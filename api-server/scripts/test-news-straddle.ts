import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { decideNewsStraddleTick, newsSlippagePips, newsZones, parseNewsStraddleSettings, upcomingPairReleases, type NewsDeps } from "../src/news-straddle.js";
import type { MarketPriceTick } from "../src/market-stream-types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ── Part 1: pure decisions ─────────────────────────────────────────
// GBP/JPY from the user's example: anchor 210.595, lines ±10 pips.
const pip = 0.01;
const base = { upper: 210.695, lower: 210.495, expiresAt: null, now: Date.parse("2026-10-16T12:30:00Z"), pip, slippagePips: 3, spreadCapPips: 8 };

await test("inside the band holds", () => {
  assert.deepEqual(decideNewsStraddleTick({ ...base, bid: 210.59, ask: 210.6 }), { kind: "hold" });
});
await test("the ask reaching the buy line fires a long; the bid reaching the sell line fires a short", () => {
  const up = decideNewsStraddleTick({ ...base, bid: 210.68, ask: 210.70 });
  assert.equal(up.kind, "fire");
  assert.equal(up.kind === "fire" && up.side, "long");
  assert.ok(up.kind === "fire" && Math.abs(up.bound - 210.725) < 1e-9, "bound is line + 3 pips");
  const down = decideNewsStraddleTick({ ...base, bid: 210.49, ask: 210.51 });
  assert.equal(down.kind === "fire" && down.side, "short");
  assert.ok(down.kind === "fire" && Math.abs(down.bound - 210.465) < 1e-9, "bound is line − 3 pips");
});
await test("both lines crossed by one quote: the side the mid moved through, else no order", () => {
  const wide = { ...base, spreadCapPips: 50 };
  // 30-pip spread, mid between the lines: both executable prices are past, no side is real.
  assert.equal(decideNewsStraddleTick({ ...wide, bid: 210.44, ask: 210.74 }).kind, "ambiguous");
  // Mid above the buy line: price went up.
  const up = decideNewsStraddleTick({ ...wide, slippagePips: 30, bid: 210.49, ask: 210.92 });
  assert.equal(up.kind === "fire" && up.side, "long");
  const down = decideNewsStraddleTick({ ...wide, slippagePips: 30, bid: 210.27, ask: 210.70 });
  assert.equal(down.kind === "fire" && down.side, "short");
});
await test("a spread above the cap blocks the tick; a price past line ± slippage is a missed bound", () => {
  const blocked = decideNewsStraddleTick({ ...base, bid: 210.60, ask: 210.70 });
  assert.equal(blocked.kind, "spread_blocked");
  const missed = decideNewsStraddleTick({ ...base, bid: 210.72, ask: 210.73 });
  assert.equal(missed.kind, "missed_bound");
  // Exactly at the bound still fires.
  assert.equal(decideNewsStraddleTick({ ...base, bid: 210.715, ask: 210.725 }).kind, "fire");
});
await test("an ended window disarms before any crossing", () => {
  assert.equal(decideNewsStraddleTick({ ...base, expiresAt: "2026-10-16T12:29:59Z", bid: 210.68, ask: 210.70 }).kind, "expired");
});
await test("slippage is measured against the line, positive when worse", () => {
  assert.equal(newsSlippagePips("long", 210.695, 210.712, pip), 1.7);
  assert.equal(newsSlippagePips("short", 210.495, 210.501, pip), -0.6);
});
await test("settings default to 10-pip zones 3 pips deep, 15-minute watch and time exit; a release is required", () => {
  const release = { title: "CPI y/y", currency: "GBP", time: "2026-10-16T06:00:00Z" };
  const settings = parseNewsStraddleSettings({ stopPips: 15, targetPips: 30, release, anchor: 999 });
  assert.equal("anchor" in settings, false, "no anchor setting: it is always the live price");
  assert.equal(settings.distancePips, 10);
  assert.equal(settings.slippagePips, 3);
  assert.equal(settings.armedMinutes, 15);
  assert.equal(settings.closeAfterMinutes, 15);
  assert.throws(() => parseNewsStraddleSettings({ targetPips: 30, release }), /stop/);
  assert.throws(() => parseNewsStraddleSettings({ stopPips: 15, targetPips: 30, slippagePips: 99, release }), /zone depth/);
  assert.throws(() => parseNewsStraddleSettings({ stopPips: 15, targetPips: 30 }), /Pick the release/);
});
await test("zones: entry edge 10 pips out, far edge 3 pips further", () => {
  assert.deepEqual(newsZones("GBP_JPY", 210.595, 10, 3), { upper: 210.695, upperFar: 210.725, lower: 210.495, lowerFar: 210.465 });
});
await test("only the pair's releases inside 5 hours count", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const events = [
    { currency: "GBP", title: "a", timestamp: "2026-10-16T16:59:00Z" },
    { currency: "JPY", title: "b", timestamp: "2026-10-16T12:30:00Z" },
    { currency: "USD", title: "c", timestamp: "2026-10-16T12:10:00Z" },
    { currency: "GBP", title: "d", timestamp: "2026-10-16T17:01:00Z" },
    { currency: "GBP", title: "e", timestamp: "2026-10-16T11:59:00Z" },
  ];
  assert.deepEqual(upcomingPairReleases("GBP_JPY", events, now).map((event) => event.title), ["b", "a"]);
});

// ── Part 2: the database path, on one connection, always rolled back ──
if (!process.env.DATABASE_URL) {
  console.log(`news straddle: ${passed} checks passed (database checks skipped)`);
  process.exit(0);
}
const { db } = await import("../src/database.js");
const { armNewsStraddle, evaluateNewsStraddles, sweepNewsStraddles, cancelNewsStraddle } = await import("../src/news-straddle.js");
const { OandaRequestError } = await import("../../frontend/src/lib/oanda/client.js");
const client = await db().connect();
type Row = Record<string, unknown>;
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '3s'");
  const txStart = Date.parse((await client.query<{ now: Date }>("SELECT now()")).rows[0]!.now.toISOString());
  const userId = (await client.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,role) VALUES($1,'x','owner') RETURNING id",
    [`news-straddle-test-${Date.now()}@example.invalid`],
  )).rows[0]!.id;

  let clock = txStart + 1_000;
  const notices: Array<{ event: string; key: string; title: string; message: string }> = [];
  const calls = { submit: 0, close: 0, setLevels: 0, lookups: 0 };
  let submitImpl: NewsDeps["broker"]["submit"] = async () => { throw new Error("unexpected submit"); };
  let lookupImpl: NewsDeps["broker"]["orderByClientId"] = async () => null;
  const openTrades = new Map<string, { closed: boolean; entry: number }>();
  let savepoint = 0;
  let queries = 0;
  // The calendar the server checks: by default one GBP release 30s from "now".
  let releaseAt = clock + 30_000;
  let calendarImpl: NewsDeps["releases"] = async () => [{ currency: "GBP", title: "CPI y/y", timestamp: new Date(releaseAt).toISOString() }];
  let quoteImpl: NewsDeps["quote"] = async () => null;
  const deps: NewsDeps = {
    db: {
      query: (text, values) => { queries += 1; return client.query(text, values) as never; },
      tx: async (fn) => {
        const name = `sp${++savepoint}`;
        await client.query(`SAVEPOINT ${name}`);
        try {
          const result = await fn({ query: (text, values) => client.query(text, values) as never });
          await client.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          throw error;
        }
      },
    },
    broker: {
      submit: async (order) => { calls.submit += 1; return submitImpl(order); },
      orderByClientId: async (id) => { calls.lookups += 1; return lookupImpl(id); },
      tradeState: async (id) => {
        const trade = openTrades.get(id);
        return trade ? {
          state: trade.closed ? "CLOSED" : "OPEN", closed: trade.closed, averageClosePrice: trade.closed ? trade.entry + 0.05 : null,
          realizedPL: trade.closed ? 12.5 : null, closeTime: trade.closed ? new Date(clock).toISOString() : null,
          entryPrice: trade.entry, initialUnits: 1000, openTime: null, openTransactionId: null, financing: 0,
        } : null;
      },
      protection: async (id) => ({ state: "OPEN", instrument: "GBP_JPY", currentUnits: 1000, entryPrice: openTrades.get(id)?.entry ?? null, openTime: null, stopLoss: Number(((openTrades.get(id)?.entry ?? 0) - 0.15).toFixed(3)), takeProfit: Number(((openTrades.get(id)?.entry ?? 0) + 0.3).toFixed(3)), realizedPL: null, averageClosePrice: null, closeTime: null }),
      closeTrade: async (id) => { calls.close += 1; const trade = openTrades.get(id); if (!trade || trade.closed) throw new Error("TRADE_DOESNT_EXIST"); trade.closed = true; return "fill"; },
      setLevels: async () => { calls.setLevels += 1; },
      environment: () => "practice",
    },
    size: async () => ({ units: 1000, riskPercent: 0.5 }),
    notify: async (input) => { notices.push({ event: input.event, key: input.key, title: input.title, message: input.message }); },
    releases: () => calendarImpl(),
    quote: (instrument) => quoteImpl(instrument),
    now: () => clock,
  };
  const tick = (bid: number, ask: number): MarketPriceTick => ({
    type: "price", instrument: "GBP_JPY" as never, displayName: "GBP/JPY", bid, ask, mid: (bid + ask) / 2, spread: ask - bid,
    status: "tradeable", time: new Date(clock).toISOString(), source: "oanda", sequence: clock,
  });
  // Arms around the live mid 210.595, for a release 30s away (inside the 1-minute lead, so the zones are set now).
  const arm = (extra: Row = {}, at = clock + 30_000) => {
    releaseAt = at;
    return armNewsStraddle(userId, { instrument: "GBP_JPY", stopPips: 15, targetPips: 30, release: { title: "CPI y/y", currency: "GBP", time: new Date(at).toISOString() }, ...extra }, tick(210.59, 210.60), deps);
  };
  const rowsOf = async (straddleId: string) => (await client.query<Row>(
    "SELECT id,direction,status,failure_reason,stop_price::text,target_price::text,trigger_price::text,paper_trade_id,metadata FROM pending_manual_entries WHERE metadata->>'straddleId'=$1 ORDER BY direction",
    [straddleId],
  )).rows;
  const straddleOf = (entries: Array<{ metadata: Record<string, unknown> }>) => String(entries[0]!.metadata.straddleId);
  const fill = (price: number, tradeId: string): NewsDeps["broker"]["submit"] => async () => {
    openTrades.set(tradeId, { closed: false, entry: price });
    return { orderId: "o1", tradeId, fillPrice: price, fillSpread: 0.021, cancelReason: null };
  };

  await test("arming stores two linked PENDING lines 10 pips either side and notifies", async () => {
    const entries = await arm();
    assert.equal(entries.length, 2);
    const long = entries.find((entry) => entry.direction === "long")!;
    const short = entries.find((entry) => entry.direction === "short")!;
    assert.equal(long.entryPrice, 210.695);
    assert.equal(short.entryPrice, 210.495);
    assert.ok(entries.every((entry) => entry.status === "PENDING" && entry.stopPrice === null));
    assert.equal(notices.at(-1)?.event, "armed");
    // The pair now holds one setup; a second is refused.
    await assert.rejects(arm(), /waiting entry/);
    await cancelNewsStraddle(userId, straddleOf(entries), deps);
  });

  await test("first crossing wins: one order, the other line cancelled; later ticks send nothing", async () => {
    const entries = await arm();
    const id = straddleOf(entries);
    const orders: Array<Parameters<NewsDeps["broker"]["submit"]>[0]> = [];
    submitImpl = async (order) => { orders.push(order); return fill(210.712, "T1")(order); };
    await evaluateNewsStraddles(tick(210.59, 210.60), deps);
    assert.equal(calls.submit, 0, "no order inside the band");
    await evaluateNewsStraddles(tick(210.69, 210.70), deps);
    assert.equal(calls.submit, 1);
    assert.equal(orders[0]!.direction, "long");
    assert.ok(Math.abs(orders[0]!.priceBound - 210.725) < 1e-9, "bound = line + 3 pips");
    assert.ok(Math.abs(orders[0]!.stopDistance - 0.15) < 1e-9, "stop sent as a 15-pip distance from the fill");
    const [long, short] = await rowsOf(id);
    assert.equal(long!.status, "TRIGGERED");
    assert.equal(short!.status, "CANCELLED");
    assert.equal(Number(long!.stop_price), 210.562, "stop measured from the 210.712 fill, not the line");
    assert.equal((long!.metadata as Row).slippagePips, 1.7);
    assert.equal((long!.metadata as Row).spreadAtFillPips, 2.1);
    assert.ok(long!.paper_trade_id, "app trade opened");
    const triggered = notices.find((notice) => notice.event === "triggered" && notice.key === id)!;
    assert.match(triggered.message, /Bought at 210\.712 \(line 210\.695, slippage \+1\.7 pips\)\. Spread 2\.1 pips at fill/);
    // The same crossing again, and a crossing of the cancelled line: nothing more is sent.
    await evaluateNewsStraddles(tick(210.69, 210.70), deps);
    await evaluateNewsStraddles(tick(210.40, 210.41), deps);
    assert.equal(calls.submit, 1);
  });

  await test("time exit: closed at market once due, exactly once", async () => {
    const id = (await client.query<{ id: string }>("SELECT metadata->>'straddleId' AS id FROM pending_manual_entries WHERE metadata->>'brokerTradeId'='T1'")).rows[0]!.id;
    await sweepNewsStraddles(deps);
    assert.equal(calls.close, 0, "not before 15 minutes");
    clock += 15 * 60_000 + 1_000;
    await sweepNewsStraddles(deps);
    assert.equal(calls.close, 1);
    const trade = (await client.query<Row>("SELECT t.status,t.exit::text,t.result FROM paper_trades t JOIN pending_manual_entries e ON e.paper_trade_id=t.id WHERE e.metadata->>'straddleId'=$1", [id])).rows[0]!;
    assert.equal(trade.status, "closed");
    assert.equal(Number(trade.exit), 210.762);
    assert.ok(notices.some((notice) => notice.event === "time_exit"));
    await sweepNewsStraddles(deps);
    assert.equal(calls.close, 1, "never closed twice");
  });

  await test("priceBound missed before sending: reported, not chased, nothing sent", async () => {
    const entries = await arm();
    const before = calls.submit;
    await evaluateNewsStraddles(tick(210.44, 210.45), deps); // bid 210.44 < sell bound 210.465
    assert.equal(calls.submit, before);
    const [long, short] = await rowsOf(straddleOf(entries));
    assert.equal(short!.status, "FAILED");
    assert.match(String(short!.failure_reason), /Missed the price bound/);
    assert.equal(long!.status, "CANCELLED");
    assert.equal(notices.at(-1)?.event, "missed_bound");
  });

  await test("priceBound missed at OANDA (BOUNDS_VIOLATION): FAILED, both lines off", async () => {
    const entries = await arm();
    submitImpl = async () => ({ orderId: "o2", tradeId: null, fillPrice: null, fillSpread: null, cancelReason: "BOUNDS_VIOLATION" });
    await evaluateNewsStraddles(tick(210.48, 210.49), deps);
    const [long, short] = await rowsOf(straddleOf(entries));
    assert.equal(short!.status, "FAILED");
    assert.equal((short!.metadata as Row).execution, "news_missed_bound");
    assert.equal(long!.status, "CANCELLED");
    assert.equal(notices.at(-1)?.event, "missed_bound");
  });

  await test("spread above the cap waits (one notice), then fires when it narrows", async () => {
    const entries = await arm({ spreadCapPips: 4 });
    submitImpl = fill(210.70, "T2");
    const before = calls.submit;
    await evaluateNewsStraddles(tick(210.64, 210.70), deps); // 6-pip spread
    await evaluateNewsStraddles(tick(210.64, 210.70), deps);
    assert.equal(calls.submit, before);
    assert.equal(notices.filter((notice) => notice.event === "spread_blocked" && notice.key === straddleOf(entries)).length, 1);
    await evaluateNewsStraddles(tick(210.69, 210.70), deps);
    assert.equal(calls.submit, before + 1);
    // Close it so the pair is free again.
    clock += 16 * 60_000;
    await sweepNewsStraddles(deps);
  });

  await test("disarm on expiry, by the sweep with no quotes", async () => {
    const entries = await arm({ armedMinutes: 5 });
    clock += 30_000 + 5 * 60_000 + 1;
    await sweepNewsStraddles(deps);
    const rows = await rowsOf(straddleOf(entries));
    assert.deepEqual(rows.map((row) => row.status), ["EXPIRED", "EXPIRED"]);
    assert.equal(notices.at(-1)?.event, "disarmed");
  });

  await test("kill switch on at the crossing: no order, both lines off", async () => {
    const entries = await arm();
    await client.query("INSERT INTO trade_plan_risk_settings(user_id,kill_switch) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET kill_switch=true", [userId]);
    const before = calls.submit;
    await evaluateNewsStraddles(tick(210.69, 210.70), deps);
    assert.equal(calls.submit, before);
    assert.equal((await rowsOf(straddleOf(entries)))[0]!.status, "FAILED");
    assert.equal(notices.at(-1)?.event, "blocked");
    await assert.rejects(arm(), /kill switch/);
    await client.query("UPDATE trade_plan_risk_settings SET kill_switch=false WHERE user_id=$1", [userId]);
  });

  await test("restart recovery: a lost response is looked up by client id and never resent", async () => {
    const entries = await arm();
    const id = straddleOf(entries);
    submitImpl = async () => { throw new OandaRequestError("OANDA request timed out."); };
    const before = calls.submit;
    await evaluateNewsStraddles(tick(210.69, 210.70), deps);
    assert.equal(calls.submit, before + 1);
    let [long] = await rowsOf(id);
    assert.equal(long!.status, "TRIGGERING");
    assert.equal((long!.metadata as Row).execution, "news_unknown");
    // A "restart": a fresh sweep finds it in flight. Too soon to decide → wait.
    lookupImpl = async () => null;
    await sweepNewsStraddles(deps);
    assert.equal((await rowsOf(id))[0]!.status, "TRIGGERING");
    // OANDA did fill it.
    clock += 20_000;
    openTrades.set("T3", { closed: false, entry: 210.70 });
    lookupImpl = async (clientId) => (clientId === `gx-news-${long!.id}` ? { state: "FILLED", tradeId: "T3", fillPrice: 210.70, cancelReason: null } : null);
    await sweepNewsStraddles(deps);
    [long] = await rowsOf(id);
    assert.equal(long!.status, "TRIGGERED");
    assert.equal((long!.metadata as Row).brokerTradeId, "T3");
    assert.equal(calls.submit, before + 1, "never resent");
    clock += 16 * 60_000;
    await sweepNewsStraddles(deps);
  });

  await test("restart recovery: nothing at OANDA after the give-up window → FAILED, not resent", async () => {
    const entries = await arm();
    submitImpl = async () => { throw new OandaRequestError("OANDA could not be reached."); };
    const before = calls.submit;
    await evaluateNewsStraddles(tick(210.49, 210.50), deps);
    lookupImpl = async () => null;
    clock += 4 * 60_000;
    await sweepNewsStraddles(deps);
    const [, short] = await rowsOf(straddleOf(entries));
    assert.equal(short!.status, "FAILED");
    assert.equal((short!.metadata as Row).execution, "news_lost");
    assert.equal(calls.submit, before + 1);
  });

  await test("phase 1: no release in the next 5 hours, an unknown release, or no calendar → not armed", async () => {
    calendarImpl = async () => [{ currency: "USD", title: "NFP", timestamp: new Date(clock + 60 * 60_000).toISOString() }];
    await assert.rejects(arm(), /No GBP or JPY news in the next 5 hours/);
    calendarImpl = async () => [{ currency: "GBP", title: "CPI y/y", timestamp: new Date(clock + 6 * 60 * 60_000).toISOString() }];
    await assert.rejects(arm({}, clock + 6 * 60 * 60_000), /No GBP or JPY news/);
    calendarImpl = async () => [{ currency: "JPY", title: "BoJ", timestamp: new Date(clock + 2 * 60 * 60_000).toISOString() }];
    await assert.rejects(arm(), /not in the calendar/);
    calendarImpl = async () => null;
    await assert.rejects(arm(), /calendar can't be read/);
    calendarImpl = async () => [{ currency: "GBP", title: "CPI y/y", timestamp: new Date(releaseAt).toISOString() }];
  });

  await test("an ordinary tick inside both zones costs no database query", async () => {
    const entries = await arm();
    const before = queries;
    await evaluateNewsStraddles(tick(210.60, 210.61), deps);
    await evaluateNewsStraddles(tick(210.55, 210.56), deps);
    assert.equal(queries, before, "decided from memory");
    await cancelNewsStraddle(userId, straddleOf(entries), deps);
  });

  await test("phase 2: a release 2h away waits; 1 minute before it the live price becomes the anchor, then a zone entry fires", async () => {
    const release = clock + 2 * 60 * 60_000;
    const entries = await arm({}, release);
    const id = straddleOf(entries);
    assert.equal(entries[0]!.metadata.execution, "news_waiting");
    const before = calls.submit;
    // Price wanders far before the release: nothing fires while waiting.
    await evaluateNewsStraddles(tick(211.50, 211.51), deps);
    assert.equal(calls.submit, before);
    // One minute before the release, the tick's mid (211.505) becomes the anchor.
    clock = release - 60_000;
    await evaluateNewsStraddles(tick(211.50, 211.51), deps);
    const [long, short] = await rowsOf(id);
    assert.equal((long!.metadata as Row).execution, "news_armed");
    assert.equal((long!.metadata as Row).anchor, 211.505);
    assert.equal((long!.metadata as Row).upperFar, 211.635);
    assert.equal((short!.metadata as Row).lowerLine, 211.405);
    assert.ok(notices.some((notice) => notice.event === "live" && notice.key === id));
    // The release hits: the ask enters the buy zone (211.605–211.635).
    clock = release + 2_000;
    submitImpl = fill(211.61, "T4");
    await evaluateNewsStraddles(tick(211.60, 211.61), deps);
    assert.equal(calls.submit, before + 1);
    assert.equal((await rowsOf(id))[0]!.status, "TRIGGERED");
    clock += 16 * 60_000;
    await sweepNewsStraddles(deps);
  });

  await test("phase 2 with no stream tick: the sweep sets the anchor from a fetched quote", async () => {
    const release = clock + 30 * 60_000;
    const entries = await arm({}, release);
    clock = release - 59_000;
    quoteImpl = async () => tick(210.80, 210.81);
    await sweepNewsStraddles(deps);
    const [long] = await rowsOf(straddleOf(entries));
    assert.equal((long!.metadata as Row).anchor, 210.805);
    quoteImpl = async () => null;
    await cancelNewsStraddle(userId, straddleOf(entries), deps);
  });

  await test("cancelling one line from the chart cancels both", async () => {
    const entries = await arm();
    // The chart's Cancel (cancelPendingManualEntry) runs this same both-lines
    // update on the shared pool, which cannot see this uncommitted transaction.
    const cancelled = await cancelNewsStraddle(userId, straddleOf(entries), deps);
    assert.equal(cancelled.length, 2);
    assert.ok(cancelled.every((entry) => entry.status === "CANCELLED"));
  });
} finally {
  await client.query("ROLLBACK");
  client.release();
  await db().end();
}
console.log(`news straddle: ${passed} checks passed (database checks rolled back)`);
