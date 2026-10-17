import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  NEWS_TRANSITIONS, canTransition, decideNewsTick, exitReasonOf, levelsFromFill, newsSlippagePips, newsZones,
  parseNewsStraddleSettings, quoteProblem, upcomingPairReleases, type NewsDeps, type NewsQuote, type NewsZones,
} from "../src/news-straddle.js";
import type { MarketPriceTick } from "../src/market-stream-types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ── Part 1: pure geometry and decisions ─────────────────────────────
// GBP/JPY from the spec: anchor 210.595, 10-pip distance, 3-pip depth.
const zones: NewsZones = newsZones("GBP_JPY", 210.595, 10, 3);
const T0 = Date.parse("2026-10-16T12:30:00Z");
const q = (bid: number, ask: number, at = T0): NewsQuote => ({ bid, ask, time: new Date(at).toISOString(), tradeable: true });
const decide = (quote: NewsQuote, extra: Partial<Parameters<typeof decideNewsTick>[0]> = {}) =>
  decideNewsTick({ zones, quote, now: T0, releaseAt: T0 - 1_000, expiresAt: T0 + 15 * 60_000, pip: 0.01, precision: 3, spreadCapPips: 8, ...extra });

await test("10. zones and pips: GBP/JPY 210.595 → BUY 210.695–210.725, SELL 210.465–210.495; EUR/USD 1.17000 → 1.17100–1.17130 / 1.16870–1.16900", () => {
  assert.deepEqual(zones, { buy: { lower: 210.695, upper: 210.725 }, sell: { lower: 210.465, upper: 210.495 } });
  assert.deepEqual(newsZones("EUR_USD", 1.17, 10, 3), { buy: { lower: 1.171, upper: 1.1713 }, sell: { lower: 1.1687, upper: 1.169 } });
});
await test("1. BUY triggers on the executable ask (the bid can still be outside the zone)", () => {
  const decision = decide(q(210.68, 210.70));
  assert.equal(decision.kind, "fire");
  assert.equal(decision.kind === "fire" && decision.side, "long");
  assert.equal(decision.kind === "fire" && decision.bound, 210.725, "price bound = BUY zone upper edge");
});
await test("2. SELL triggers on the executable bid", () => {
  const decision = decide(q(210.49, 210.51));
  assert.equal(decision.kind === "fire" && decision.side, "short");
  assert.equal(decision.kind === "fire" && decision.bound, 210.465, "price bound = SELL zone lower edge");
});
await test("3. prices exactly on the zone edges fire; one step past the far edge does not (float-safe)", () => {
  assert.equal(decide(q(210.68, 210.695)).kind, "fire");
  assert.equal(decide(q(210.68, 210.725)).kind, "fire");
  assert.equal(decide(q(210.68, 210.6949999999)).kind, "fire", "rounds to the 0.001 step before comparing");
  assert.equal(decide(q(210.495, 210.51)).kind, "fire");
  assert.equal(decide(q(210.465, 210.47)).kind, "fire");
  assert.equal(decide(q(210.70, 210.726)).kind, "jumped_past");
  assert.equal(decide(q(210.464, 210.47)).kind, "jumped_past");
  assert.equal(decide(q(210.6, 210.694)).kind, "hold");
});
await test("4. price jumping completely past a zone is skipped, not chased", () => {
  assert.equal(decide(q(210.79, 210.80)).kind, "jumped_past");
});
await test("5. a spread above the cap blocks the touch (8.0 pips allowed, 8.1 not)", () => {
  assert.equal(decide(q(210.62, 210.70)).kind, "fire");
  assert.equal(decide(q(210.619, 210.70)).kind, "spread_blocked");
});
await test("7. no trigger before the release, and none after the window", () => {
  assert.equal(decide(q(210.68, 210.70), { releaseAt: T0 + 1 }).kind, "before_release");
  assert.equal(decide(q(210.68, 210.70), { expiresAt: T0 }).kind, "expired");
});
await test("quotes: crossed, stale, non-tradeable or non-positive are never used", () => {
  assert.equal(quoteProblem(q(210.7, 210.6), T0), "crossed quote");
  assert.equal(quoteProblem(q(210.6, 210.61, T0 - 6_000), T0), "stale quote");
  assert.equal(quoteProblem({ ...q(210.6, 210.61), tradeable: false }, T0), "instrument not tradeable");
  assert.equal(quoteProblem(q(0, 210.61), T0), "non-positive price");
  assert.equal(decide(q(210.68, 210.70, T0 - 6_000)).kind, "bad_quote");
});
await test("both zones reached by one wide quote with the mid between them: nothing", () => {
  assert.equal(decide(q(210.44, 210.74), { spreadCapPips: 50 }).kind, "ambiguous");
});
await test("16. stop and target from the actual fill; slippage vs the triggering quote", () => {
  assert.deepEqual(levelsFromFill("GBP_JPY", "long", 210.712, 15, 30), { stop: 210.562, target: 211.012 });
  assert.deepEqual(levelsFromFill("GBP_JPY", "short", 210.48, 15, 30), { stop: 210.63, target: 210.18 });
  assert.deepEqual(levelsFromFill("EUR_USD", "long", 1.17105, 15, 30), { stop: 1.16955, target: 1.17405 });
  assert.equal(newsSlippagePips("long", 210.70, 210.712, 0.01), 1.2);
  assert.equal(newsSlippagePips("short", 210.49, 210.495, 0.01), -0.5);
});
await test("exit reason from where the trade closed", () => {
  assert.equal(exitReasonOf("long", 210.56, 210.562, 211.012, 0.01), "stop");
  assert.equal(exitReasonOf("long", 211.02, 210.562, 211.012, 0.01), "target");
  assert.equal(exitReasonOf("long", 210.8, 210.562, 211.012, 0.01), "manual");
  assert.equal(exitReasonOf("short", 210.64, 210.63, 210.18, 0.01), "stop");
});
await test("state machine: only listed moves are allowed; terminal states go nowhere", () => {
  assert.ok(canTransition("WATCHING", "TRIGGER_RESERVED"));
  assert.ok(!canTransition("ZONES_LOCKED", "TRIGGER_RESERVED"), "no trigger before WATCHING");
  assert.ok(!canTransition("ORDER_REJECTED", "WATCHING"), "a rejection never reopens a side");
  assert.ok(!canTransition("TRIGGER_RESERVED", "CANCELLED"), "a reserved order can't be cancelled");
  for (const state of ["ORDER_REJECTED", "CLOSED", "EXPIRED", "SKIPPED", "CANCELLED"] as const) assert.deepEqual(NEWS_TRANSITIONS[state], []);
});
await test("settings: defaults 10 / 3 / 8 / 15 / 15, release required, no anchor setting", () => {
  const release = { title: "CPI y/y", currency: "GBP", time: "2026-10-16T06:00:00Z" };
  const settings = parseNewsStraddleSettings({ stopPips: 15, targetPips: 30, release, anchor: 999 });
  assert.equal("anchor" in settings, false);
  assert.deepEqual([settings.distancePips, settings.slippagePips, settings.spreadCapPips, settings.armedMinutes, settings.closeAfterMinutes], [10, 3, 8, 15, 15]);
  assert.throws(() => parseNewsStraddleSettings({ stopPips: 15, targetPips: 30 }), /Pick the release/);
});
await test("only the pair's releases inside 5 hours count", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const events = [
    { currency: "GBP", title: "a", timestamp: "2026-10-16T16:59:00Z" }, { currency: "JPY", title: "b", timestamp: "2026-10-16T12:30:00Z" },
    { currency: "USD", title: "c", timestamp: "2026-10-16T12:10:00Z" }, { currency: "GBP", title: "d", timestamp: "2026-10-16T17:01:00Z" },
  ];
  assert.deepEqual(upcomingPairReleases("GBP_JPY", events, now).map((event) => event.title), ["b", "a"]);
});

// ── Part 2: the server lifecycle, on one connection, always rolled back ──
if (!process.env.DATABASE_URL) {
  console.log(`news straddle: ${passed} checks passed (database checks skipped)`);
  process.exit(0);
}
const { db } = await import("../src/database.js");
const news = await import("../src/news-straddle.js");
const { OandaRequestError } = await import("../../frontend/src/lib/oanda/client.js");
const client = await db().connect();
type Row = Record<string, unknown> & { metadata: Record<string, unknown> };
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '3s'");
  const txStart = Date.parse((await client.query<{ now: Date }>("SELECT now()")).rows[0]!.now.toISOString());
  const userId = (await client.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,role) VALUES($1,'x','owner') RETURNING id",
    [`news-straddle-test-${Date.now()}@example.invalid`],
  )).rows[0]!.id;

  let clock = txStart + 1_000;
  const notices: Array<{ event: string; key: string; message: string }> = [];
  const seenKeys = new Set<string>();
  const calls = { submit: 0, close: 0, lookups: 0 };
  let submitImpl: NewsDeps["broker"]["submit"] = async () => { throw new Error("unexpected submit"); };
  let lookupImpl: NewsDeps["broker"]["orderByClientId"] = async () => null;
  let calendarImpl: NewsDeps["releases"] = async () => null;
  let quoteImpl: NewsDeps["quote"] = async () => null;
  let closeImpl: ((id: string) => void) | null = null;
  const trades = new Map<string, { closed: boolean; entry: number; exit: number | null }>();
  let savepoint = 0;
  let queries = 0;
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
        const trade = trades.get(id);
        return trade ? {
          state: trade.closed ? "CLOSED" : "OPEN", closed: trade.closed, averageClosePrice: trade.closed ? trade.exit : null,
          realizedPL: trade.closed ? Number(((trade.exit! - trade.entry) * 1000).toFixed(2)) : null, closeTime: trade.closed ? new Date(clock).toISOString() : null,
          entryPrice: trade.entry, initialUnits: 1000, openTime: null, openTransactionId: null, financing: 0,
        } : null;
      },
      protection: async (id) => {
        const entry = trades.get(id)?.entry ?? 0;
        return { state: "OPEN", instrument: "GBP_JPY", currentUnits: 1000, entryPrice: entry, openTime: null, stopLoss: Number((entry - 0.15).toFixed(3)), takeProfit: Number((entry + 0.3).toFixed(3)), realizedPL: null, averageClosePrice: null, closeTime: null };
      },
      closeTrade: async (id) => {
        calls.close += 1;
        closeImpl?.(id);
        const trade = trades.get(id);
        if (!trade || trade.closed) throw new Error("TRADE_DOESNT_EXIST");
        trade.closed = true;
        trade.exit = trade.entry + 0.05;
        return "fill";
      },
      setLevels: async () => undefined,
      environment: () => "practice",
    },
    size: async () => ({ units: 1000, riskPercent: 0.5 }),
    notify: async (input) => {
      const key = `${input.key}:${input.event}`;
      if (seenKeys.has(key)) return; // same dedupe rule as notification_events
      seenKeys.add(key);
      notices.push({ event: input.event, key: input.key, message: input.message });
    },
    releases: () => calendarImpl(),
    quote: (instrument) => quoteImpl(instrument),
    now: () => clock,
    log: () => undefined,
  };
  const tick = (bid: number, ask: number, at = clock): MarketPriceTick => ({
    type: "price", instrument: "GBP_JPY" as never, displayName: "GBP/JPY", bid, ask, mid: (bid + ask) / 2, spread: ask - bid,
    status: "tradeable", time: new Date(at).toISOString(), source: "oanda", sequence: at,
  });
  const run = (bid: number, ask: number) => news.evaluateNewsStraddles(tick(bid, ask), deps);
  const stateOf = async (id: string) => (await client.query<Row>("SELECT metadata FROM pending_manual_entries WHERE metadata->>'straddleId'=$1 LIMIT 1", [id])).rows[0]!.metadata.newsState as string;
  const rowsOf = async (id: string) => (await client.query<Row>(
    "SELECT id,direction,status,failure_reason,stop_price::text,target_price::text,paper_trade_id,metadata FROM pending_manual_entries WHERE metadata->>'straddleId'=$1 ORDER BY direction",
    [id],
  )).rows;
  const eventsFor = (id: string) => notices.filter((notice) => notice.key === id).map((notice) => notice.event);
  const fill = (price: number, tradeId: string): NewsDeps["broker"]["submit"] => async () => {
    trades.set(tradeId, { closed: false, entry: price, exit: null });
    return { orderId: `o-${tradeId}`, tradeId, fillPrice: price, fillSpread: 0.021, cancelReason: null };
  };
  /** Arms for a GBP release `inMs` from now, the calendar agreeing. */
  let releaseAt = 0;
  const arm = async (inMs = 2 * 60 * 60_000, extra: Record<string, unknown> = {}) => {
    releaseAt = clock + inMs;
    calendarImpl = async () => [{ currency: "GBP", title: "CPI y/y", timestamp: new Date(releaseAt).toISOString() }];
    const entries = await news.armNewsStraddle(userId, { instrument: "GBP_JPY", stopPips: 15, targetPips: 30, release: { title: "CPI y/y", currency: "GBP", time: new Date(releaseAt).toISOString() }, ...extra }, tick(210.59, 210.60), deps);
    return String(entries[0]!.metadata.straddleId);
  };
  /** Lock at 210.595 one minute before, then open the watch at the release. */
  const toWatching = async () => {
    clock = releaseAt - 60_000;
    await run(210.59, 210.60);
    clock = releaseAt;
    await run(210.59, 210.60);
  };
  const finish = async (id: string) => {
    const state = await stateOf(id);
    if (["ARMED", "LOCKING", "ZONES_LOCKED", "WATCHING"].includes(state)) await news.cancelNewsStraddle(userId, id, deps);
    if (state === "FILLED") { clock += 16 * 60_000; await news.sweepNewsStraddles(deps); }
  };

  await test("phase 1: no release in 5 hours, an unknown release, or no calendar → not armed", async () => {
    releaseAt = clock + 60 * 60_000;
    const body = { instrument: "GBP_JPY", stopPips: 15, targetPips: 30, release: { title: "CPI y/y", currency: "GBP", time: new Date(releaseAt).toISOString() } };
    calendarImpl = async () => [{ currency: "USD", title: "NFP", timestamp: new Date(releaseAt).toISOString() }];
    await assert.rejects(news.armNewsStraddle(userId, body, tick(210.59, 210.6), deps), /No GBP or JPY news/);
    calendarImpl = async () => [{ currency: "JPY", title: "BoJ", timestamp: new Date(releaseAt + 30 * 60_000).toISOString() }];
    await assert.rejects(news.armNewsStraddle(userId, body, tick(210.59, 210.6), deps), /not in the calendar/);
    calendarImpl = async () => null;
    await assert.rejects(news.armNewsStraddle(userId, body, tick(210.59, 210.6), deps), /calendar can't be read/);
  });

  await test("arming persists ARMED with config, lock time and a timeline; preview ticks cost no query", async () => {
    const id = await arm();
    const [long] = await rowsOf(id);
    assert.equal(long!.metadata.newsState, "ARMED");
    assert.equal(long!.metadata.lockAt, new Date(releaseAt - 60_000).toISOString());
    assert.equal(long!.metadata.configVersion, 2);
    assert.equal((long!.metadata.timeline as unknown[]).length, 1);
    assert.ok(eventsFor(id).includes("news_setup_armed"));
    const before = queries;
    await run(211.5, 211.51); // far away, before the lock: nothing, and no database work
    assert.equal(queries, before);
    assert.equal(await stateOf(id), "ARMED");
    await finish(id);
  });

  await test("8. the lock happens at release − 60 s exactly, from that tick's mid; locked zones never move", async () => {
    const id = await arm();
    clock = releaseAt - 60_001;
    await run(210.59, 210.60);
    assert.equal(await stateOf(id), "ARMED", "1 ms early: not locked");
    clock = releaseAt - 60_000;
    await run(210.80, 210.81);
    const [long] = await rowsOf(id);
    assert.equal(long!.metadata.newsState, "ZONES_LOCKED");
    assert.equal(long!.metadata.anchor, 210.805);
    assert.deepEqual(long!.metadata.zones, { buy: { lower: 210.905, upper: 210.935 }, sell: { lower: 210.675, upper: 210.705 } });
    clock += 20_000;
    await run(210.5, 210.51);
    assert.deepEqual((await rowsOf(id))[0]!.metadata.zones, long!.metadata.zones, "a later quote does not move them");
    assert.ok(eventsFor(id).includes("news_zones_locked"));
    await finish(id);
  });

  await test("7. no entry between the lock and the release, even inside a zone", async () => {
    const id = await arm();
    clock = releaseAt - 60_000;
    await run(210.59, 210.60);
    clock = releaseAt - 1;
    await run(210.69, 210.70); // ask inside the BUY zone, 1 ms before the release
    assert.equal(calls.submit, 0);
    assert.equal(await stateOf(id), "ZONES_LOCKED");
    await finish(id);
  });

  await test("9. no valid quote at lock time: LOCKING, retried, then SKIPPED at the release (no old quote reused)", async () => {
    const id = await arm();
    clock = releaseAt - 60_000;
    await news.evaluateNewsStraddles(tick(210.59, 210.60, clock - 10_000), deps); // stale
    assert.equal(await stateOf(id), "LOCKING");
    quoteImpl = async () => null;
    clock = releaseAt - 30_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "LOCKING");
    clock = releaseAt;
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "SKIPPED");
    assert.ok(eventsFor(id).includes("news_setup_skipped"));
  });

  await test("a quiet market: the sweep locks from a fetched quote", async () => {
    const id = await arm();
    clock = releaseAt - 59_000;
    quoteImpl = async () => tick(210.80, 210.81);
    await news.sweepNewsStraddles(deps);
    assert.equal((await rowsOf(id))[0]!.metadata.anchor, 210.805);
    quoteImpl = async () => null;
    await finish(id);
  });

  await test("release moved in the calendar before the lock → SKIPPED; calendar unreadable → locked and noted", async () => {
    let id = await arm();
    calendarImpl = async () => [{ currency: "GBP", title: "CPI y/y", timestamp: new Date(releaseAt + 30 * 60_000).toISOString() }];
    clock = releaseAt - 60_000;
    await run(210.59, 210.60);
    assert.equal(await stateOf(id), "SKIPPED");
    assert.match(String((await rowsOf(id))[0]!.failure_reason), /moved/);
    id = await arm();
    calendarImpl = async () => null;
    clock = releaseAt - 60_000;
    await run(210.59, 210.60);
    assert.equal(await stateOf(id), "ZONES_LOCKED");
    assert.equal((await rowsOf(id))[0]!.metadata.calendarVerifiedAtLock, false);
    await finish(id);
  });

  await test("1 + 16. BUY at the ask after the release: one bounded order, stop/target from the fill, SELL side off", async () => {
    const id = await arm();
    await toWatching();
    assert.equal(await stateOf(id), "WATCHING");
    const orders: Array<Parameters<NewsDeps["broker"]["submit"]>[0]> = [];
    submitImpl = async (order) => { orders.push(order); return fill(210.712, "T1")(order); };
    await run(210.68, 210.70);
    assert.equal(calls.submit, 1);
    assert.equal(orders[0]!.direction, "long");
    assert.equal(orders[0]!.priceBound, 210.725);
    assert.equal(orders[0]!.stopDistance, 0.15);
    assert.match(orders[0]!.clientRequestId, /^news-[0-9a-f-]{36}$/);
    const [long, short] = await rowsOf(id);
    assert.equal(long!.metadata.newsState, "FILLED");
    assert.equal(long!.status, "TRIGGERED");
    assert.equal(short!.status, "CANCELLED");
    assert.equal(Number(long!.stop_price), 210.562);
    assert.equal(Number(long!.target_price), 211.012);
    assert.equal(long!.metadata.slippageVsQuotePips, 1.2);
    assert.equal(long!.metadata.spreadAtFillPips, 2.1);
    const timeline = (long!.metadata.timeline as Array<{ to?: string }>).map((entry) => entry.to).filter(Boolean);
    assert.deepEqual(timeline, ["ARMED", "ZONES_LOCKED", "WATCHING", "TRIGGER_RESERVED", "ORDER_SUBMITTING", "FILLED"]);
    assert.deepEqual(eventsFor(id).filter((event) => event.startsWith("news_order") || event === "news_zone_triggered"), ["news_order_filled"], "triggered/submitting are logged, not pushed");
    // 12. The same update again, and the SELL zone afterwards: nothing more is sent.
    await run(210.68, 210.70);
    await run(210.40, 210.41);
    assert.equal(calls.submit, 1);
  });

  await test("time exit: closed at market once, 15 minutes after the confirmed fill", async () => {
    const id = String((await client.query<{ id: string }>("SELECT metadata->>'straddleId' AS id FROM pending_manual_entries WHERE metadata->>'brokerTradeId'='T1'")).rows[0]!.id);
    clock += 14 * 60_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(calls.close, 0, "not before 15 minutes");
    clock += 61_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(calls.close, 1);
    const [long] = await rowsOf(id);
    assert.equal(long!.metadata.newsState, "CLOSED");
    assert.equal(long!.metadata.exitReason, "time");
    await news.sweepNewsStraddles(deps);
    assert.equal(calls.close, 1, "never closed twice");
  });

  await test("2. SELL at the bid", async () => {
    const id = await arm();
    await toWatching();
    submitImpl = fill(210.49, "T2");
    await run(210.49, 210.51);
    const [long, short] = await rowsOf(id);
    assert.equal(short!.metadata.newsState, "FILLED");
    assert.equal(short!.status, "TRIGGERED");
    assert.equal(long!.status, "CANCELLED");
    await finish(id);
  });

  await test("4. a jump straight past the zone is SKIPPED with no order", async () => {
    const before = calls.submit;
    const id = await arm();
    await toWatching();
    await run(210.79, 210.80);
    assert.equal(calls.submit, before);
    assert.equal(await stateOf(id), "SKIPPED");
  });

  await test("5 + 6. spread over the cap waits (one notice); narrowing while still in the zone fires", async () => {
    const id = await arm(2 * 60 * 60_000, { spreadCapPips: 4 });
    await toWatching();
    submitImpl = fill(210.70, "T3");
    const before = calls.submit;
    await run(210.64, 210.70);
    await run(210.64, 210.70);
    assert.equal(calls.submit, before);
    assert.equal(eventsFor(id).filter((event) => event === "news_spread_blocked").length, 1);
    await run(210.69, 210.70);
    assert.equal(calls.submit, before + 1);
    assert.equal(await stateOf(id), "FILLED");
    await finish(id);
  });

  await test("11 + 12. once one side is reserved, an opposite touch or a stale watch list cannot send", async () => {
    const id = await arm();
    await toWatching();
    submitImpl = async () => { throw new OandaRequestError("OANDA request timed out."); };
    const before = calls.submit;
    await run(210.69, 210.70);
    assert.equal(calls.submit, before + 1);
    await news.refreshArmedNewsStraddles(deps);
    await run(210.48, 210.49);
    await run(210.69, 210.70);
    assert.equal(calls.submit, before + 1);
    assert.equal(await stateOf(id), "ORDER_UNKNOWN");
    lookupImpl = async () => ({ state: "CANCELLED", tradeId: null, fillPrice: null, cancelReason: "CANCELLED" });
    clock += 20_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "ORDER_REJECTED");
    lookupImpl = async () => null;
  });

  await test("13 + 24. timeout after OANDA received it: ORDER_UNKNOWN, reconciled to FILLED by client id, never resent", async () => {
    const id = await arm();
    await toWatching();
    submitImpl = async () => { throw new OandaRequestError("OANDA could not be reached."); };
    const before = calls.submit;
    await run(210.69, 210.70);
    assert.equal(await stateOf(id), "ORDER_UNKNOWN");
    const clientRequestId = String(((await rowsOf(id))[0]!.metadata.reservation as Record<string, unknown>).clientRequestId);
    clock += 5_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "ORDER_UNKNOWN", "too soon to decide");
    trades.set("T4", { closed: false, entry: 210.71, exit: null });
    lookupImpl = async (clientId) => (clientId === `gx-${clientRequestId}` ? { state: "FILLED", tradeId: "T4", fillPrice: 210.71, cancelReason: null } : null);
    clock += 20_000;
    await news.sweepNewsStraddles(deps);
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "FILLED");
    assert.equal(calls.submit, before + 1);
    assert.equal(eventsFor(id).filter((event) => event === "news_order_filled").length, 1, "one fill notice");
    lookupImpl = async () => null;
    await finish(id);
  });

  await test("14. rejected by the price bound: ORDER_REJECTED, the other side stays off", async () => {
    const id = await arm();
    await toWatching();
    submitImpl = async () => ({ orderId: "o", tradeId: null, fillPrice: null, fillSpread: null, cancelReason: "BOUNDS_VIOLATION" });
    await run(210.48, 210.49);
    const [long, short] = await rowsOf(id);
    assert.equal(short!.metadata.newsState, "ORDER_REJECTED");
    assert.match(String(short!.failure_reason), /price bound/);
    assert.equal(long!.status, "CANCELLED");
    const before = calls.submit;
    await run(210.69, 210.70);
    assert.equal(calls.submit, before, "the BUY side is not reopened");
  });

  await test("insufficient margin and other broker refusals are reported in plain words", async () => {
    const id = await arm();
    await toWatching();
    submitImpl = async () => ({ orderId: "o", tradeId: null, fillPrice: null, fillSpread: null, cancelReason: "INSUFFICIENT_MARGIN" });
    await run(210.69, 210.70);
    assert.match(String((await rowsOf(id))[0]!.failure_reason), /margin/);
  });

  await test("15. restart while an order was pending: SUBMITTING is looked up; reserved-but-unsent is skipped, never sent", async () => {
    // A crash after ORDER_SUBMITTING was written: the sweep asks OANDA.
    let id = await arm();
    await toWatching();
    submitImpl = async () => { throw new Error("process died"); }; // a non-OANDA error counts as unknown
    await run(210.69, 210.70);
    await client.query(`UPDATE pending_manual_entries SET metadata=metadata||'{"newsState":"ORDER_SUBMITTING"}'::jsonb WHERE metadata->>'straddleId'=$1`, [id]);
    await news.refreshArmedNewsStraddles(deps);
    trades.set("T5", { closed: false, entry: 210.70, exit: null });
    lookupImpl = async () => ({ state: "FILLED", tradeId: "T5", fillPrice: 210.70, cancelReason: null });
    clock += 20_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "FILLED");
    lookupImpl = async () => null;
    await finish(id);
    // A crash between the reservation and ORDER_SUBMITTING: the request was certainly not sent.
    id = await arm();
    await toWatching();
    const before = calls.submit;
    await client.query(
      `UPDATE pending_manual_entries SET status=CASE WHEN direction='long' THEN 'TRIGGERING' ELSE 'CANCELLED' END,
         metadata=metadata||jsonb_build_object('newsState','TRIGGER_RESERVED','reservation',jsonb_build_object('reservedAt',$2::text,'clientRequestId','news-x','attemptId','x'))
       WHERE metadata->>'straddleId'=$1`,
      [id, new Date(clock).toISOString()],
    );
    clock += 20_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "SKIPPED");
    assert.equal(calls.submit, before);
  });

  await test("17. stop hit just before the time exit: no redundant close, CLOSED as stop", async () => {
    const id = await arm();
    await toWatching();
    submitImpl = fill(210.70, "T6");
    await run(210.69, 210.70);
    const trade = trades.get("T6")!;
    trade.closed = true;
    trade.exit = 210.55; // the stop filled at the broker
    const before = calls.close;
    clock += 16 * 60_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(calls.close, before, "no close sent for a trade OANDA already closed");
    const [long] = await rowsOf(id);
    assert.equal(long!.metadata.newsState, "CLOSED");
    assert.equal(long!.metadata.exitReason, "stop");
  });

  await test("17b. stop fills while the time-exit close is in flight: reconciled to CLOSED as stop", async () => {
    const id = await arm();
    await toWatching();
    submitImpl = fill(210.70, "T7");
    await run(210.69, 210.70);
    closeImpl = (tradeId) => { const trade = trades.get(tradeId)!; trade.closed = true; trade.exit = 210.55; };
    clock += 16 * 60_000;
    await news.sweepNewsStraddles(deps);
    closeImpl = null;
    const [long] = await rowsOf(id);
    assert.equal(long!.metadata.newsState, "CLOSED");
    assert.equal(long!.metadata.exitReason, "stop");
  });

  await test("a target hit mirrored from OANDA closes the setup as target", async () => {
    const id = await arm();
    await toWatching();
    submitImpl = fill(210.70, "T8");
    await run(210.69, 210.70);
    const [long] = await rowsOf(id);
    await client.query("UPDATE paper_trades SET status='closed', exit=211.0, paper_pl=300, result_r=2 WHERE id=$1", [long!.paper_trade_id]);
    await news.sweepNewsStraddles(deps);
    const [after] = await rowsOf(id);
    assert.equal(after!.metadata.newsState, "CLOSED");
    assert.equal(after!.metadata.exitReason, "target");
  });

  await test("18. cancel: allowed while watching; refused honestly once an order is reserved", async () => {
    let id = await arm();
    await toWatching();
    await news.cancelNewsStraddle(userId, id, deps);
    assert.equal(await stateOf(id), "CANCELLED");
    const before = calls.submit;
    await run(210.69, 210.70);
    assert.equal(calls.submit, before, "a cancelled setup never fires");
    id = await arm();
    await toWatching();
    submitImpl = async () => { throw new OandaRequestError("OANDA request timed out."); };
    await run(210.69, 210.70);
    await assert.rejects(news.cancelNewsStraddle(userId, id, deps), /already being sent/);
    assert.equal(await stateOf(id), "ORDER_UNKNOWN");
    lookupImpl = async () => ({ state: "CANCELLED", tradeId: null, fillPrice: null, cancelReason: "CANCELLED" });
    clock += 20_000;
    await news.sweepNewsStraddles(deps);
    lookupImpl = async () => null;
  });

  await test("23. kill switch at every pre-entry stage: armed, lock, release, trigger", async () => {
    const setKill = (on: boolean) => client.query("INSERT INTO trade_plan_risk_settings(user_id,kill_switch) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET kill_switch=$2", [userId, on]);
    let id = await arm();
    await setKill(true);
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "SKIPPED", "while armed");
    await assert.rejects(arm(), /kill switch/, "and arming is refused");
    await setKill(false);
    id = await arm();
    await setKill(true);
    clock = releaseAt - 60_000;
    await run(210.59, 210.60);
    assert.equal(await stateOf(id), "SKIPPED", "at the lock");
    await setKill(false);
    id = await arm();
    clock = releaseAt - 60_000;
    await run(210.59, 210.60);
    await setKill(true);
    clock = releaseAt;
    await run(210.59, 210.60);
    assert.equal(await stateOf(id), "SKIPPED", "at the release");
    await setKill(false);
    id = await arm();
    await toWatching();
    await setKill(true);
    const before = calls.submit;
    await run(210.69, 210.70);
    assert.equal(calls.submit, before);
    assert.equal(await stateOf(id), "SKIPPED", "at the trigger");
    await setKill(false);
  });

  await test("expiry: no touch in the watch window → EXPIRED by the sweep", async () => {
    const id = await arm();
    await toWatching();
    clock = releaseAt + 15 * 60_000;
    await news.sweepNewsStraddles(deps);
    assert.equal(await stateOf(id), "EXPIRED");
    assert.ok(eventsFor(id).includes("news_setup_expired"));
  });

  await test("notifications are idempotent: every (setup, event) at most once", () => {
    const keys = notices.map((notice) => `${notice.key}:${notice.event}`);
    assert.equal(new Set(keys).size, keys.length);
  });
} finally {
  await client.query("ROLLBACK");
  client.release();
  await db().end();
}
console.log(`news straddle: ${passed} checks passed (database checks rolled back)`);
