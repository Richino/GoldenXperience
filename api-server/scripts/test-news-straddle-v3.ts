import { manualOcoRun } from "../src/news-straddle/manual-oco.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NEWS_V3_DEFAULTS, type NewsRun, type NewsSide, type NewsLeg } from "../../frontend/src/lib/news/news-straddle-v3.js";
import { NewsStraddleEngine, type EngineDeps } from "../src/news-straddle/engine.js";
import type { NewsRepository, NewsSession, Audit } from "../src/news-straddle/store.js";
import type { NewsBroker, BrokerContext, BrokerTransaction, TradeObservation, OrderObservation } from "../src/news-straddle/broker.js";
import { stopOrderBody, liveNewsBroker } from "../src/news-straddle/broker.js";
import { replayNewsExits } from "../src/news-straddle/replay.js";
import { nextNewsReleaseGroup, newsReleaseStillMatches, type TimedNewsEvent } from "../../frontend/src/lib/news/news-release-groups.js";
import { calculateNewsRisk, entryPrices, parseV3Settings, preSubmitIssue, quoteIssue, schedulingQuoteIssue, trailingDecision, verifyRelease, type NewsQuote } from "../src/news-straddle/policy.js";

const T = Date.parse("2026-10-14T12:30:00Z"), iso = (n: number) => new Date(n).toISOString();
const planningQuote = { bid: 1.12, ask: 1.1201, time: iso(T - 3000), tradeable: true };
assert.equal(schedulingQuoteIssue(planningQuote, T), null);
assert.match(quoteIssue(planningQuote, T)!, /stale/);
assert.match(schedulingQuoteIssue({ ...planningQuote, time: iso(T - 10001) }, T)!, /stale/);
assert.match(schedulingQuoteIssue({ ...planningQuote, time: iso(T + 251) }, T)!, /future/);
assert.ok(schedulingQuoteIssue({ ...planningQuote, tradeable: false }, T));
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) { await fn(); console.log(`ok ${++passed}. ${name}`); }
class MemoryRepo implements NewsRepository {
  run: NewsRun; audit: Audit[] = []; halted = false; seenIds = new Set<string>(); private queue = Promise.resolve();
  constructor(run: NewsRun) { this.run = structuredClone(run); }
  async active() { return this.run.endedAt ? [] : [structuredClone(this.run)]; }
  async locked<U>(_id: string, fn: (s: NewsSession) => Promise<U>) {
    const before = this.queue; let release!: () => void; this.queue = new Promise(resolve => { release = resolve; }); await before;
    try { return await fn({ read: async () => structuredClone(this.run), seen: async id => this.seenIds.has(id), halt: async () => { this.halted = true; },
      save: async (r, audit) => { assert.equal(r.revision, this.run.revision); r.revision++; this.run = structuredClone(r); this.audit.push(structuredClone(audit)); if (audit.transactionId) { assert.equal(this.seenIds.has(audit.transactionId), false); this.seenIds.add(audit.transactionId); } },
    }); } finally { release(); }
  }
}
function fixture() {
  let now = T - 20_000, quote: NewsQuote = { bid: 1.12, ask: 1.1201, time: iso(now), tradeable: true };
  const id = randomUUID();
  const settings = { ...NEWS_V3_DEFAULTS };
  const release = { id: "USD:CPI:2026-10-14", title: "CPI m/m", currency: "USD", time: iso(T), impact: 3, provider: "forex_factory" as const };
  const leg = (side: NewsSide): NewsLeg => ({ side, entryId: randomUUID(), clientId: `${id}-${side}`, tradeClientId: `${id}-trade-${side}`, state: "UNSENT", entry: side === "long" ? 1.1204 : 1.1197, bound: side === "long" ? 1.1206 : 1.1195,
    stopDistance: 0.0016, units: 62500, orderId: null, tradeId: null, paperTradeId: null, submittedAt: null, acknowledgedAt: null, brokerTime: null, cancellationRequestedAt: null, cancellationConfirmedAt: null,
    fillTime: null, fillPrice: null, slippagePips: null, fillSpreadPips: null, initialStop: null, activeStop: null, trailingOrderId: null, trailingRequestedAt: null, trailingActivatedAt: null,
    unrealizedPips: null, maximumFavorablePips: 0, protectedPips: null, realizedPL: null, realizedR: null, exitPrice: null, closedAt: null, lastProtectionAt: null });
  const run: NewsRun = { id, userId: randomUUID(), accountKey: "practice-test", instrument: "EUR_USD", eventKey: release.id, version: 3, revision: 0, state: "SCHEDULED", release, settings, createdAt: iso(now), targetSubmitAt: iso(T - 10000), preparedAt: null, calendarCheckedAt: iso(now), calendarFetchedAt: iso(now), transactionSeed: "10", lastReconciledAt: null, preparedQuote: quote,
    risk: { equity: 10000, currency: "USD", conversion: 1, eventCash: 200, perLegCash: 100, perLegPercent: 1, stopPips: 16, atrPips: 8 },
    constraints: { minimumTrail: 0.0005, maximumTrail: 1, precision: 5, minimumUnits: 1, maximumUnits: 10000000 }, clock: { sampledAt: iso(now), offsetMs: 0, uncertaintyMs: 10 },
    legs: { long: leg("long"), short: leg("short") }, firstFillSide: null, exception: null, reason: null, endedAt: null, timeline: [] };
  const repo = new MemoryRepo(run), orders = new Map<string, OrderObservation>(), trades = new Map<string, TradeObservation>();
  const sent: Array<{ side: NewsSide; at: number; body: ReturnType<typeof stopOrderBody> }> = [], cancels: string[] = [], closes: string[] = [], trailCalls: string[] = [];
  let cancelHeld: Promise<void> | null = null, releaseCancel: (() => void) | null = null;
  let submitFailure: NewsSide | null = null, submitUnknown: NewsSide | null = null, disconnected = false, rescheduled = false, policyKill = false;
  const broker: NewsBroker = {
    environment: () => "practice",
    context: async (): Promise<BrokerContext> => ({ quote: { ...quote, time: iso(now) }, equity: 10000, currency: "USD", conversion: 1, atrPips: 8, lastTransactionId: "10", constraints: run.constraints!, clock: { sampledAt: iso(now), offsetMs: 0, uncertaintyMs: 10 }, openInstruments: [], pendingInstruments: [] }),
    submit: async (r, l) => {
      sent.push({ side: l.side, at: now, body: stopOrderBody(r, l) });
      if (submitFailure === l.side) throw Object.assign(new Error("Rejected"), { status: 400 });
      const order: OrderObservation = { id: `order-${l.side}`, state: "PENDING", time: iso(now) }; orders.set(l.clientId, order);
      if (submitUnknown === l.side) throw new Error("Timeout after broker accepted request");
      return { order: structuredClone(order), transactions: [] };
    },
    order: async id => { if (disconnected) throw new Error("offline"); return orders.has(id) ? structuredClone(orders.get(id)!) : null; },
    cancel: async id => { cancels.push(id); if (cancelHeld) await cancelHeld; if (disconnected) throw new Error("offline"); const o = orders.get(id); if (!o || o.state === "FILLED") throw Object.assign(new Error("Not cancellable"), { status: 404 }); o.state = "CANCELLED"; return "cancel-tx"; },
    trade: async id => { if (disconnected) throw new Error("offline"); return trades.has(id) ? structuredClone(trades.get(id)!) : null; },
    ownedTrades: async () => { if (disconnected) throw new Error("offline"); return [...trades.values()].filter(t => t.state === "OPEN").map(t => structuredClone(t)); },
    addTrailing: async (id, distance) => { if (disconnected) throw new Error("offline"); trailCalls.push(id); const t = trades.get(id)!; t.trailId = `trail-${id}`; t.trailDistance = distance; t.trailValue = t.units > 0 ? quote.bid - distance : quote.ask + distance; return t.trailId; },
    close: async id => { if (disconnected) throw new Error("offline"); closes.push(id); const t = trades.get(id)!; t.state = "CLOSED"; t.closedAt = iso(now); t.exit = t.units > 0 ? quote.bid : quote.ask; t.realizedPL = (t.exit - t.entry) * t.units; return { fillTransactionId: "closed" }; },
    transactions: async () => ({ transactions: [], lastTransactionID: "10" }),
  };
  const deps: EngineDeps = { repo, broker, now: () => now, policy: async () => ({ killSwitch: policyKill, riskLimit: 1 }), halted: async () => repo.halted,
    calendar: async () => ({ fetchedAt: iso(now), events: [{ ...release, timestamp: rescheduled ? iso(T + 60_000) : release.time, timingVerified: true }] }), notify: async () => {}, log: () => {} };
  const engine = new NewsStraddleEngine(deps);
  const at = (time: number, bid = quote.bid, ask = quote.ask) => { now = time; quote = { ...quote, bid, ask, time: iso(time) }; };
  const tick = async (ready = true) => { await engine.tick(id, quote, ready); await engine.drain(); };
  const ready = async () => { at(T - 12_000); await tick(); assert.equal(repo.run.state, "READY"); assert.equal(repo.run.levelsFrozenAt, undefined); };
  const pending = async () => { await ready(); at(T - 10000); await tick(); assert.equal(repo.run.state, "PENDING_ORDERS"); };
  const fill = (side: NewsSide): BrokerTransaction => {
    const l = repo.run.legs[side], price = l.entry!;
    const t: TradeObservation = { id: `trade-${side}`, state: "OPEN", instrument: run.instrument, units: side === "long" ? l.units : -l.units, entry: price, openedAt: iso(now), stop: price + (side === "long" ? -1 : 1) * l.stopDistance!, trailId: null, trailValue: null, trailDistance: null, target: null, realizedPL: 0, closedAt: null, exit: null, clientId: l.tradeClientId };
    trades.set(t.id, t);
    const tx: BrokerTransaction = { id: `fill-${side}`, type: "ORDER_FILL", time: iso(now), instrument: run.instrument, orderID: `order-${side}`, clientOrderID: l.clientId, price: String(price), units: String(t.units), tradeOpened: { tradeID: t.id, units: String(t.units) }, fullPrice: { bids: [{ price: String(quote.bid) }], asks: [{ price: String(quote.ask) }] } };
    orders.set(l.clientId, { id: `order-${side}`, state: "FILLED", fill: tx }); return tx;
  };
  const opened = async (side: NewsSide) => { await pending(); at(T + 100); await engine.observeTransaction(id, fill(side)); await engine.drain(); await engine.observeTrade(id, side, trades.get(`trade-${side}`)!); await engine.drain(); assert.equal(repo.run.state, "OPEN"); };
  return { id, run, repo, engine, deps, broker, orders, trades, sent, cancels, closes, trailCalls, at, tick, ready, pending, fill, opened,
    setFailure(side: NewsSide) { submitFailure = side; }, setUnknown(side: NewsSide) { submitUnknown = side; }, setOffline(value: boolean) { disconnected = value; }, reschedule() { rescheduled = true; }, kill() { policyKill = true; },
    holdCancel() { cancelHeld = new Promise(resolve => { releaseCancel = resolve; }); }, releaseCancel() { releaseCancel?.(); cancelHeld = null; }, quote: () => quote };
}

await test("T−10s target: both native STOP orders, mandatory stops, no take profit, 1% per trade with a 2% double-fill reserve", async () => {
  const f = fixture(); await f.tick(); assert.equal(f.sent.length, 0); await f.ready(); assert.equal(f.sent.length, 0); f.at(T - 10000); await f.tick();
  assert.equal(f.sent.length, 2); assert.ok(f.sent.every(s => s.at === T - 10000)); assert.equal(f.repo.run.state, "PENDING_ORDERS");
  for (const s of f.sent) { assert.equal(s.body.order.type, "STOP"); assert.equal(s.body.order.positionFill, "REDUCE_FIRST"); assert.ok(s.body.order.stopLossOnFill.distance); assert.equal("takeProfitOnFill" in s.body.order, false); }
  assert.ok(f.repo.run.risk!.perLegCash * 2 <= 200); assert.equal(f.repo.run.risk!.perLegPercent, 1);
  assert.equal(f.repo.run.risk!.perLegCash, 100);
  assert.equal(f.repo.run.legs.long.entry, 1.1204); assert.equal(f.repo.run.legs.short.entry, 1.1197);
  await f.tick(); await f.tick(); assert.equal(f.sent.length, 2); assert.ok(f.repo.run.legs.long.httpDispatchedAt); assert.ok(f.repo.audit.some(a => a.event === "http_order_dispatched"));
});
await test("three-pip defaults use executable sides and submit only inside the final ten seconds", async () => {
  assert.equal(parseV3Settings({}).distancePips, 3);
  assert.deepEqual(entryPrices("EUR_GBP", { bid: 0.83941, ask: 0.83955, time: iso(T), tradeable: true }, NEWS_V3_DEFAULTS.distancePips, 2),
    { buy: 0.83985, sell: 0.83911, buyBound: 0.84005, sellBound: 0.83891 });
  const f = fixture(); await f.ready();
  f.at(T - 10001, 1.12002, 1.12012); await f.tick(); assert.equal(f.sent.length, 0);
  f.at(T - 10000, 1.12003, 1.12013); await f.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.repo.run.legs.long.entry, 1.12043);
  assert.equal(f.repo.run.legs.short.entry, 1.11973);
  const entries = [f.repo.run.legs.long.entry, f.repo.run.legs.short.entry];
  f.at(T - 9000, 1.12004, 1.12014); await f.tick();
  assert.deepEqual([f.repo.run.legs.long.entry, f.repo.run.legs.short.entry], entries);
  assert.equal(f.sent.length, 2);
});
await test("old ten-pip monitoring setups adopt three pips once without sending orders early", async () => {
  for (const state of ["SCHEDULED", "PREPARING", "READY"] as const) {
    const f = fixture(); f.repo.run.state = state; f.repo.run.settings.distancePips = 10;
    f.at(T - 60000); await f.tick(); await f.tick();
    assert.equal(f.repo.run.settings.distancePips, 3);
    assert.equal(f.repo.audit.filter(a => a.event === "monitoring_distance_updated").length, 1);
    assert.equal(f.sent.length, 0);
  }
});
await test("distance upgrade never modifies frozen levels or a run with submission evidence", async () => {
  for (const evidence of ["frozen", "submittedAt", "httpDispatchedAt", "acknowledgedAt", "brokerTime", "orderId", "tradeId", "paperTradeId", "fillTime", "fillPrice", "state"] as const) {
    const f = fixture(); f.repo.run.settings.distancePips = 10;
    if (evidence === "frozen") f.repo.run.levelsFrozenAt = iso(T - 60000);
    else if (evidence === "fillPrice") f.repo.run.legs.long.fillPrice = 1.1211;
    else if (evidence === "state") f.repo.run.legs.long.state = "UNKNOWN";
    else f.repo.run.legs.long[evidence] = "prior-attempt";
    f.at(T - 60000); await f.tick();
    assert.equal(f.repo.run.settings.distancePips, 10, evidence);
    assert.equal(f.sent.length, 0);
  }
});
await test("BUY first: verified fill immediately cancels opposite and confirms protection", async () => { const f = fixture(); await f.opened("long"); assert.equal(f.repo.run.legs.short.state, "CANCELLED"); assert.ok(f.repo.run.legs.short.cancellationConfirmedAt); assert.ok(f.repo.run.legs.long.activeStop); assert.equal(f.closes.length, 0); });
await test("SELL first: symmetric OCO and protective initial stop", async () => { const f = fixture(); await f.opened("short"); assert.equal(f.repo.run.legs.long.state, "CANCELLED"); assert.ok(f.repo.run.legs.short.activeStop! > f.repo.run.legs.short.fillPrice!); });
await test("neither fills: GTD window and verified cancellation end the attempt without a position", async () => { const f = fixture(); await f.pending(); f.at(T + 61_000); await f.tick(); await f.engine.reconcile(f.id); await f.engine.drain(); assert.equal(f.repo.run.state, "EXPIRED"); assert.equal(f.trades.size, 0); assert.equal(f.sent.length, 2); });
await test("double fill before cancel: exception, account pause, flatten only owned trades and verify flat", async () => {
  const f = fixture(); await f.pending(); f.holdCancel(); f.at(T + 100); await f.engine.observeTransaction(f.id, f.fill("long"));
  f.at(T + 120); await f.engine.observeTransaction(f.id, f.fill("short")); assert.equal(f.repo.halted, true); assert.equal(f.repo.run.state, "EXCEPTION");
  f.releaseCancel(); await f.engine.drain(); await f.engine.reconcile(f.id); await f.engine.drain();
  assert.equal(f.repo.run.state, "HALTED"); assert.deepEqual([...new Set(f.closes)].sort(), ["trade-long", "trade-short"]); assert.equal(f.sent.length, 2);
});
await test("one rejected submission cancels accepted side; no single-sided strategy or retry", async () => { const f = fixture(); f.setFailure("short"); await f.ready(); f.at(T - 10000); await f.tick(); await f.engine.reconcile(f.id); await f.engine.drain(); assert.equal(f.repo.run.legs.short.state, "REJECTED"); assert.equal(f.repo.run.legs.long.state, "CANCELLED"); assert.equal(f.repo.run.state, "SKIPPED"); assert.equal(f.sent.length, 2); });
await test("submission timeout after acceptance: cancel/reconcile by deterministic ID, restart never re-POSTs", async () => { const f = fixture(); f.setUnknown("long"); await f.ready(); f.at(T - 10000); await f.tick(); const restarted = new NewsStraddleEngine(f.deps); await restarted.reconcile(f.id); await restarted.drain(); f.at(T); await restarted.tick(f.id, f.quote(), true); await restarted.drain(); assert.equal(f.sent.length, 2); assert.equal(f.repo.run.legs.long.state, "CANCELLED"); });
await test("wide or stale price, release deadline, and unsynchronized monitoring block entry", async () => {
  for (const mode of ["spread", "stale", "late", "monitor"] as const) {
    const f = fixture(); await f.ready(); f.at(mode === "late" ? T : T - 10000);
    const q = { ...f.quote() }; if (mode === "spread") q.ask += 0.001; if (mode === "stale") q.time = iso(T - 16000);
    await f.engine.tick(f.id, q, mode !== "monitor"); await f.engine.drain(); assert.equal(f.sent.length, 0, mode);
  }
});
await test("scheduler delay inside the final ten seconds freezes current levels and submits once", async () => {
  const f = fixture(); await f.ready();
  f.repo.run.clock = { sampledAt: iso(T - 12000), offsetMs: 400, uncertaintyMs: 600 };
  f.at(T - 7500, 1.121, 1.1211); await f.tick();
  assert.equal(f.sent.length, 2); assert.ok(f.sent.every(s => s.at === T - 7500));
  assert.equal(f.repo.run.levelsFrozenAt, iso(T - 7500));
  assert.equal(f.repo.run.legs.long.entry, 1.1214); assert.equal(f.repo.run.legs.short.entry, 1.1207);
  f.at(T - 1000); await f.tick(); assert.equal(f.sent.length, 2);
});
await test("preparation finishing after T-10 can still submit before release", async () => {
  const f = fixture(); f.at(T - 8000); await f.tick();
  assert.equal(f.repo.run.state, "READY"); assert.equal(f.sent.length, 0);
  f.at(T - 7900); await f.tick(); assert.equal(f.sent.length, 2);
});
await test("completed preparation never submits at or after release", async () => {
  for (const time of [T, T + 1000]) {
    const f = fixture(); await f.ready(); f.at(time); await f.tick();
    assert.equal(f.sent.length, 0);
    await f.engine.reconcile(f.id); await f.engine.drain();
    assert.equal(f.repo.run.state, "SKIPPED");
  }
});
await test("spread expansion while pending requests cancellation of both native orders", async () => { const f = fixture(); await f.pending(); f.at(T - 1000, 1.1198, 1.1205); await f.tick(); await f.engine.reconcile(f.id); await f.engine.drain(); assert.ok(f.cancels.length >= 2); assert.equal(f.sent.length, 2); });
await test("+10 executable pips activates a 7-pip native trail; original stop remains and no fixed target", async () => {
  const f = fixture(); await f.opened("long"); const entry = f.repo.run.legs.long.fillPrice!, original = f.trades.get("trade-long")!.stop;
  f.at(T + 1000, entry + 0.001, entry + 0.0011); await f.tick(); assert.equal(f.repo.run.state, "TRAILING"); assert.equal(f.trailCalls.length, 1); assert.equal(f.trades.get("trade-long")!.stop, original); assert.ok(Math.abs(f.repo.run.legs.long.protectedPips! - 3) < 1e-7);
  f.at(T + 2000, entry + 0.002, entry + 0.0021); f.trades.get("trade-long")!.trailValue = entry + 0.0013; await f.engine.observeTrade(f.id, "long", f.trades.get("trade-long")!); await f.tick(); assert.ok(Math.abs(f.repo.run.legs.long.protectedPips! - 13) < 1e-7); assert.equal(f.trailCalls.length, 1);
});
await test("SELL trailing uses executable ask and protects profit in the favorable direction", async () => { const f = fixture(); await f.opened("short"); const entry = f.repo.run.legs.short.fillPrice!; f.at(T + 1000, entry - 0.0011, entry - 0.001); await f.tick(); assert.equal(f.repo.run.state, "TRAILING"); assert.ok(Math.abs(f.repo.run.legs.short.protectedPips! - 3) < 1e-7); });
await test("broker disconnect keeps initial protection, then recovery executes the configured emergency exit", async () => { const f = fixture(); await f.opened("long"); const stop = f.trades.get("trade-long")!.stop; f.setOffline(true); f.at(T + 32_000); await f.tick(); assert.equal(f.repo.run.state, "EXCEPTION"); assert.equal(f.trades.get("trade-long")!.stop, stop); assert.equal(f.trades.get("trade-long")!.state, "OPEN"); f.setOffline(false); f.at(T + 33_000); await f.engine.drive(f.id); await f.engine.drain(); await f.engine.reconcile(f.id); await f.engine.drain(); assert.equal(f.trades.get("trade-long")!.state, "CLOSED"); assert.equal(f.repo.run.state, "HALTED"); });
await test("changed/delayed timestamp before submission invalidates the attempt", async () => { const f = fixture(); f.reschedule(); f.at(T - 12000); await f.tick(); await f.engine.reconcile(f.id); await f.engine.drain(); assert.equal(f.sent.length, 0); assert.equal(f.repo.run.state, "SKIPPED"); });
await test("replayed fill transactions are idempotent and do not reopen or duplicate a trade", async () => { const f = fixture(); await f.opened("long"); const tx = f.orders.get(f.repo.run.legs.long.clientId)!.fill!; const count = f.repo.audit.length; await f.engine.observeTransaction(f.id, tx); await f.engine.drain(); assert.equal(f.repo.audit.length, count); assert.equal(f.trades.size, 1); });
await test("missing broker stop triggers emergency reduction instead of inventing protection", async () => { const f = fixture(); await f.pending(); f.at(T + 100); await f.engine.observeTransaction(f.id, f.fill("long")); await f.engine.drain(); f.trades.get("trade-long")!.stop = null; await f.engine.observeTrade(f.id, "long", f.trades.get("trade-long")!); await f.engine.drain(); assert.equal(f.repo.halted, true); assert.ok(f.closes.includes("trade-long")); });
await test("settings and broker minimum/precision constraints reject invalid trails without changing risk", () => {
  assert.throws(() => parseV3Settings({ trailingActivationPips: 5, trailingDistancePips: 7 }), /activation/);
  assert.throws(() => parseV3Settings({ targetPips: 30 }), /Fixed take-profit/);
  const f = fixture(); assert.throws(() => calculateNewsRisk({ instrument: "EUR_USD", settings: f.run.settings, equity: 10000, currency: "USD", conversion: 1, atrPips: 8, minimumTrail: 0.001, maximumTrail: 1, minimumUnits: 1, maximumUnits: 10000000, riskLimit: 1 }), /permitted range/);
  assert.equal(quoteIssue({ ...f.quote(), time: iso(T) }, T - 1000), "The OANDA quote is stale or future-dated.");
});
await test("a protection regression pauses entries and closes only the setup's own position", async () => {
  const f = fixture(); await f.opened("long");
  f.trades.set("unrelated", { ...structuredClone(f.trades.get("trade-long")!), id: "unrelated", clientId: "manual-trade" });
  f.trades.get("trade-long")!.stop! -= 0.001;
  await f.engine.observeTrade(f.id, "long", f.trades.get("trade-long")!); await f.engine.drain();
  assert.ok(f.repo.halted); assert.deepEqual(f.closes, ["trade-long"]); assert.equal(f.trades.get("unrelated")!.state, "OPEN");
});
await test("kill switch cancels pending orders and closes an already open setup", async () => {
  for (const open of [false, true]) {
    const f = fixture(); if (open) await f.opened("long"); else await f.pending(); f.kill(); f.at(T + 500); await f.tick();
    assert.ok(f.cancels.length); if (open) assert.ok(f.closes.includes("trade-long"));
    assert.equal(f.sent.length, 2);
  }
});
await test("calendar rescheduling after broker acceptance cancels both orders", async () => {
  const f = fixture(); await f.pending(); f.reschedule(); await f.engine.verifyCalendar(f.id, await f.deps.calendar()); await f.engine.drain();
  assert.equal(f.repo.run.legs.long.state, "CANCELLED"); assert.equal(f.repo.run.legs.short.state, "CANCELLED"); assert.equal(f.sent.length, 2);
});
await test("partial fill does not become a normal protected open position", async () => {
  const f = fixture(); await f.pending(); f.at(T + 100); const tx = f.fill("long"); tx.tradeOpened!.units = "1";
  await f.engine.observeTransaction(f.id, tx); await f.engine.drain(); assert.ok(f.repo.halted); assert.ok(f.closes.includes("trade-long"));
});
await test("unconfirmed second order at release triggers fail-safe and never submits again", async () => {
  const f = fixture(); await f.pending(); f.repo.run.legs.short.state = "UNKNOWN"; f.repo.run.state = "SUBMITTING";
  f.at(T); await f.tick(); assert.equal(f.repo.run.legs.long.state, "CANCELLED"); assert.equal(f.sent.length, 2);
});
await test("unverified event timestamps, speeches and missing releases cannot be armed", () => {
  const f = fixture(), event = { ...f.run.release, timestamp: f.run.release.time, timingVerified: true };
  for (const changed of [{ ...event, timingVerified: false }, { ...event, title: "Fed Chair Speaks" }]) {
    assert.throws(() => verifyRelease("EUR_USD", { ...changed, time: changed.timestamp }, { fetchedAt: iso(T - 20000), events: [changed] }, T - 20000));
  }
});
await test("disabling new entries retains protection management for an already filled trade", async () => {
  const f = fixture(); await f.opened("long"); f.deps.entriesEnabled = () => false;
  const entry = f.repo.run.legs.long.fillPrice!; f.at(T + 1000, entry + 0.001, entry + 0.0011); await f.tick();
  assert.equal(f.repo.run.state, "TRAILING"); assert.equal(f.sent.length, 2); assert.equal(f.closes.length, 0);
});
await test("matched exit replay demonstrates both the trailing benefit and the fixed-2R benefit", () => {
  const c = { pip: 0.0001, offsetPips: 10, stopPips: 15, maxSpreadPips: 3, boundPips: 2, adverseSlippagePips: 0.5, activationPips: 10, trailPips: 7, activationLatencyMs: 250, windowMs: 60000 };
  const anchor = { at: T - 3000, bid: 1.12, ask: 1.1201 };
  const q = (at: number, bid: number) => ({ at: T + at, bid, ask: bid + 0.0001 });
  const recovery = replayNewsExits(anchor, T, [q(0, 1.121), q(1000, 1.1222), q(1300, 1.1232), q(2000, 1.1224), q(3000, 1.119)], c);
  assert.ok(recovery.entry); assert.ok(recovery.trailing!.r > recovery.fixed!.r); assert.equal(recovery.trailing!.reason, "TRAIL_STOP");
  const extended = replayNewsExits(anchor, T, [q(0, 1.121), q(1000, 1.1222), q(1300, 1.1232), q(2000, 1.1242), q(3000, 1.1234)], c);
  assert.ok(extended.entry); assert.equal(extended.fixed!.reason, "FIXED_2R"); assert.ok(extended.fixed!.r > extended.trailing!.r);
});
await test("real transport body retains original stop, has no TP, and refuses live configuration", async () => {
  const savedFetch = globalThis.fetch, names = ["OANDA_ACCOUNT_ID", "OANDA_API_KEY", "OANDA_API_TOKEN", "OANDA_ENVIRONMENT"];
  const before = names.map(n => process.env[n]); const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  process.env.OANDA_ACCOUNT_ID = "fake-account"; process.env.OANDA_API_KEY = "fake-token"; process.env.OANDA_ENVIRONMENT = "practice";
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ trailingStopLossOrderTransaction: { id: "fake-trail" } }); };
  try {
    await liveNewsBroker.addTrailing("fake-trade", 0.0007, "EUR_USD"); assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.startsWith("https://api-fxpractice.oanda.com/")); assert.deepEqual(calls[0]!.body, { trailingStopLoss: { distance: "0.00070", timeInForce: "GTC" } });
    process.env.OANDA_ENVIRONMENT = "live"; await assert.rejects(() => liveNewsBroker.addTrailing("fake-trade", 0.0007, "EUR_USD"), /practice/); assert.equal(calls.length, 1);
  } finally { globalThis.fetch = savedFetch; names.forEach((n, i) => { if (before[i] === undefined) delete process.env[n]; else process.env[n] = before[i]; }); }
});
function groupedCalendar(): TimedNewsEvent[] {
  return ["CPI m/m", "Core CPI m/m", "Unemployment Claims"].map((title, i) => ({ id: `release-${i}`, title, currency: "USD", timestamp: iso(T), impact: 3, timingVerified: true }));
}
await test("next verified release can be accepted beyond five hours without changing submission timing", () => {
  for (const lead of [5 * 3600000, 5 * 3600000 + 1, 24 * 3600000, 3 * 24 * 3600000]) {
    const now = T - lead, events = groupedCalendar();
    const group = nextNewsReleaseGroup("EUR_USD", events, now)!;
    assert.ok(group); assert.equal(group.timestamp, iso(T));
    const release = verifyRelease("EUR_USD", { ...group, time: group.timestamp }, { events, fetchedAt: iso(now) }, now);
    assert.equal(release.time, iso(T));
  }
  const events = groupedCalendar(), group = { ...events[0]!, time: iso(T) };
  assert.equal(nextNewsReleaseGroup("EUR_USD", events, T - 15000), null);
  assert.throws(() => verifyRelease("EUR_USD", group, { events, fetchedAt: iso(T - 15000) }, T - 15000), /15 seconds/);
  assert.equal(nextNewsReleaseGroup("EUR_USD", events, T + 1), null);
});
await test("same-time releases form one group; later, unrelated, low-impact and unverified releases stay out", () => {
  const events = groupedCalendar();
  const extra = [
    { ...events[0]!, id: "later", timestamp: iso(T + 60000) },
    { ...events[0]!, id: "jpy", currency: "JPY" },
    { ...events[0]!, id: "low", impact: 2 },
    { ...events[0]!, id: "unverified", timingVerified: false },
  ];
  const group = nextNewsReleaseGroup("EUR_USD", [...events, ...extra], T - 20000)!;
  assert.equal(group.events.length, 3); assert.equal(group.timestamp, iso(T));
  assert.deepEqual(nextNewsReleaseGroup("EUR_USD", [...events].reverse(), T - 20000), group);
  assert.equal(nextNewsReleaseGroup("EUR_USD", events, T - 10000), null);
});
await test("both currencies of the pair can share one release group without duplicate feed rows", () => {
  const events = groupedCalendar(), euro = { ...events[0]!, id: "eur", title: "ECB rate decision", currency: "EUR" };
  const group = nextNewsReleaseGroup("EUR_USD", [...events, events[0]!, euro], T - 20000)!;
  assert.equal(group.events.length, 4); assert.deepEqual([...new Set(group.events.map(e => e.currency))], ["EUR", "USD"]);
});
await test("server derives and verifies the whole batch; any member maps to the same canonical setup", () => {
  const events = groupedCalendar(), group = nextNewsReleaseGroup("EUR_USD", events, T - 20000)!;
  const calendar = { events, fetchedAt: iso(T - 20000) };
  const first = verifyRelease("EUR_USD", { ...group, time: group.timestamp }, calendar, T - 20000);
  const another = verifyRelease("EUR_USD", { ...events[1]!, time: iso(T), events: group.events }, calendar, T - 20000);
  assert.deepEqual(first, another); assert.equal(first.events!.length, 3);
  assert.throws(() => verifyRelease("EUR_USD", { ...group, time: group.timestamp, events: [group.events[0]] }, calendar, T - 20000), /changed/);
  assert.equal(newsReleaseStillMatches("EUR_USD", first, events.slice(0, 2)), false);
  assert.equal(newsReleaseStillMatches("EUR_USD", { ...first, events: undefined }, events), true);
});
await test("three approved releases submit exactly one BUY/SELL pair under the same event risk cap", async () => {
  const f = fixture(), events = groupedCalendar();
  const group = nextNewsReleaseGroup("EUR_USD", events, T - 20000)!;
  f.repo.run.release = { ...f.run.release, ...group, time: group.timestamp };
  f.deps.calendar = async () => ({ events, fetchedAt: f.quote().time });
  await f.pending(); assert.equal(f.sent.length, 2); assert.ok(f.repo.run.risk!.perLegCash * 2 <= 200);
  const changed = events.map(e => e.id === "release-1" ? { ...e, timestamp: iso(T + 60000) } : e);
  await f.engine.verifyCalendar(f.id, { events: changed, fetchedAt: f.quote().time }); await f.engine.drain();
  assert.equal(f.repo.run.legs.long.state, "CANCELLED"); assert.equal(f.repo.run.legs.short.state, "CANCELLED"); assert.equal(f.sent.length, 2);
});
await test("orders are submitted inside the final ten seconds; an actual pre-release fill cancels the opposite order", async () => {
  const f = fixture(); f.at(T - 12000); await f.tick();
  for (const at of [T - 11000, T - 10001]) { f.at(at); await f.tick(); assert.equal(f.sent.length, 0); }
  f.at(T - 10000); await f.tick(); assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(o => o.at >= T - 10000 && o.at < T));
  f.at(T - 1500, 1.1210, 1.1211); await f.engine.observeTransaction(f.id, f.fill("long")); await f.engine.drain();
  await f.engine.observeTrade(f.id, "long", f.trades.get("trade-long")!); await f.engine.drain();
  assert.equal(f.repo.run.state, "OPEN"); assert.equal(f.repo.run.legs.long.fillTime, iso(T - 1500)); assert.equal(f.repo.run.legs.short.state, "CANCELLED");
});
await test("the initial broker stop equals one planned R in account currency, with no fixed TP", async () => {
  for (const side of ["long", "short"] as const) {
    const f = fixture(); await f.opened(side); const t = f.trades.get(`trade-${side}`)!, r = f.repo.run.risk!;
    const stoppedPL = (t.stop! - t.entry) * t.units * r.conversion;
    assert.ok(Math.abs(stoppedPL + r.perLegCash) < 1e-7); assert.equal(t.target, null);
    assert.equal(r.perLegPercent, 1); assert.ok(Math.abs(r.perLegCash - r.equity * 0.01) < 1e-7); assert.ok(r.perLegCash * 2 <= r.equity * 0.02);
  }
});
await test("BUY and SELL trails wait for ten executable pips, retain seven-pip distance and never retreat on reversal", async () => {
  for (const side of ["long", "short"] as const) {
    const f = fixture(); await f.opened(side); const l = f.repo.run.legs[side], entry = l.fillPrice!, sign = side === "long" ? 1 : -1;
    const atMove = (time: number, favorablePips: number) => { const exit = entry + sign * favorablePips * 0.0001; f.at(time, side === "long" ? exit : exit - 0.0001, side === "long" ? exit + 0.0001 : exit); };
    atMove(T + 1000, 9.9); await f.tick(); assert.equal(f.trailCalls.length, 0, side);
    atMove(T + 1500, 10); await f.tick(); assert.equal(f.trailCalls.length, 1, side);
    const trade = f.trades.get(`trade-${side}`)!; assert.ok(Math.abs(trade.trailDistance! - 0.0007) < 1e-10);
    const confirmedStop = f.repo.run.legs[side].activeStop!; assert.ok(Math.abs(f.repo.run.legs[side].protectedPips! - 3) < 1e-7);
    atMove(T + 2000, 8); await f.engine.observeTrade(f.id, side, trade); await f.tick();
    assert.equal(f.repo.run.legs[side].activeStop, confirmedStop); assert.equal(f.trailCalls.length, 1); assert.equal(trade.target, null);
  }
});
await test("account per-trade and aggregate limits stay separate; prior smaller approvals are not increased", async () => {
  const f = fixture(); const input = { instrument: "EUR_USD", settings: f.run.settings, equity: 10000, currency: "USD", conversion: 1, atrPips: 8, minimumTrail: 0.0005, maximumTrail: 1, minimumUnits: 1, maximumUnits: 10000000 };
  assert.throws(() => calculateNewsRisk({ ...input, riskLimit: 0.5, eventRiskLimit: 3 }), /account risk limit/);
  assert.throws(() => calculateNewsRisk({ ...input, riskLimit: 1, eventRiskLimit: 1 }), /account risk limit/);
  const full = calculateNewsRisk({ ...input, riskLimit: 1, eventRiskLimit: 3 }); assert.equal(full.risk.perLegCash, 100); assert.equal(full.units, 62500);
  f.repo.run.settings.maxEventRiskPercent = 1; f.repo.run.risk!.perLegCash = 50; f.repo.run.risk!.perLegPercent = 0.5; f.repo.run.risk!.eventCash = 100;
  await f.pending(); assert.equal(f.repo.run.risk!.perLegPercent, 0.5); assert.equal(f.repo.run.risk!.perLegCash, 50);
});

async function manualFixture() {
  const f = fixture(), context = { ...await f.broker.context("EUR_USD"), ocoStopDistance: 0.001 };
  f.repo.run = manualOcoRun(f.run.userId, f.run.accountKey, { requestId: f.id, instrument: "EUR_USD", buyEntry: 1.122, sellEntry: 1.118, riskAmount: 50 }, context, { killSwitch: false, riskLimit: 1, eventRiskLimit: 3 }, T - 20_000);
  return f;
}
await test("manual OCO validates sides, precision, stop, risk and exposure", async () => {
  const f = fixture(), context = { ...await f.broker.context("EUR_USD"), ocoStopDistance: 0.001 };
  const input = { requestId: f.id, instrument: "EUR_USD", buyEntry: 1.122, sellEntry: 1.118, riskAmount: 50 };
  const make = (patch: Record<string, unknown>) => manualOcoRun(f.run.userId, f.run.accountKey, { ...input, ...patch }, context, { killSwitch: false, riskLimit: 1 }, T - 20_000);
  assert.throws(() => make({ buyEntry: 1.12 }), /above the ask/); assert.throws(() => make({ sellEntry: 1.121 }), /below the bid/);
  for (const value of [0, true, NaN]) assert.throws(() => make({ riskAmount: value }), /cash risk amount/);
  assert.throws(() => make({ buyEntry: 1.122001 }), /valid buyEntry/); assert.throws(() => make({ requestId: "bad" }), /request ID/);
  assert.throws(() => make({ riskAmount: 300 }), /risk limit/);
  assert.throws(() => make({ riskAmount: 0.001 }), /cash risk/);
  const run = make({}); assert.equal(run.risk!.perLegPercent, 0.5); assert.ok(run.risk!.perLegCash * 2 <= 100);
  context.openInstruments.push("EUR_USD"); assert.throws(() => make({}), /already has/);
});
for (const side of ["long", "short"] as const) await test(`manual OCO ${side} fill cancels opposite and keeps winner open`, async () => {
  const f = await manualFixture(); await f.tick(); assert.equal(f.sent.length, 2); assert.equal(f.repo.run.state, "PENDING_ORDERS");
  assert.equal(f.repo.run.legs.long.entry, 1.122); assert.equal(f.repo.run.legs.short.entry, 1.118); assert.ok(f.sent.every(s => s.body.order.gtdTime === f.repo.run.expiresAt));
  f.at(T + 100); await f.engine.observeTransaction(f.id, f.fill(side)); await f.engine.drain(); await f.engine.observeTrade(f.id, side, f.trades.get(`trade-${side}`)!); await f.engine.drain();
  assert.equal(f.repo.run.state, "OPEN"); assert.equal(f.cancels.length, 1); assert.ok(f.cancels[0].endsWith(side === "long" ? "short" : "long")); assert.equal(f.closes.length, 0);
  f.at(T + 1000, side === "long" ? 1.124 : 1.115, side === "long" ? 1.1241 : 1.1151); await f.tick(); assert.equal(f.trailCalls.length, 0); assert.equal(f.closes.length, 0);
});
await test("manual OCO ignores calendar outages and preserves levels on restart", async () => {
  const f = await manualFixture(); f.reschedule(); await f.engine.verifyCalendar(f.id, { events: [], fetchedAt: iso(T - 100000000) }); await f.tick(); assert.equal(f.repo.run.state, "PENDING_ORDERS");
  const restarted = new NewsStraddleEngine(f.deps); f.at(T + 1000); await restarted.reconcile(f.id); await restarted.tick(f.id, f.quote(), true); await restarted.drain();
  assert.equal(f.sent.length, 2); assert.equal(f.repo.run.legs.long.entry, 1.122); assert.equal(f.repo.run.legs.short.entry, 1.118);
});
await test("manual OCO waits for monitoring and never dispatches after startup deadline", async () => {
  const f = await manualFixture(); await f.tick(false); assert.equal(f.sent.length, 0); f.at(T + 60_000); await f.tick(false); assert.equal(f.sent.length, 0); assert.notEqual(f.repo.run.state, "READY");
});
await test("manual OCO expiry cancels both waiting orders", async () => {
  const f = await manualFixture(); await f.tick(); f.at(Date.parse(f.repo.run.expiresAt!) + 1); await f.tick(); assert.equal(f.cancels.length, 2); assert.equal(f.closes.length, 0);
});
await test("manual OCO rejection or uncertain submission never creates a second attempt", async () => {
  for (const unknown of [false, true]) { const f = await manualFixture(); if (unknown) f.setUnknown("short"); else f.setFailure("short"); await f.tick(); f.at(T + 1000); await f.tick(); assert.equal(f.sent.length, 2); assert.notEqual(f.repo.run.state, "PENDING_ORDERS"); }
});
await test("manual OCO double fill invokes exception policy", async () => {
  const f = await manualFixture(); await f.tick(); f.holdCancel(); f.at(T + 100); await f.engine.observeTransaction(f.id, f.fill("long")); await f.engine.observeTransaction(f.id, f.fill("short")); f.releaseCancel(); await f.engine.drain();
  assert.ok(f.repo.run.exception?.includes("Both opposing")); assert.equal(f.repo.halted, true); assert.ok(f.closes.includes("trade-long")); assert.ok(f.closes.includes("trade-short"));
});
console.log(`News Straddle v3: ${passed} checks passed; fake broker and clock only, no actual orders.`);
