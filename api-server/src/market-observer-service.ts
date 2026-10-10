import type { MarketAnalysis } from "../../frontend/src/lib/strategy/market-analysis.js";
import type { ObserverPlan, ObserverRead, ObserverSnapshot } from "../../frontend/src/lib/market-observer-types.js";
import { analyzeV2 } from "../../frontend/src/lib/strategy/analyze-v2/decide.js";
import { toMarketAnalysis } from "../../frontend/src/lib/strategy/analyze-v2/adapter.js";
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { databaseConfigured, query, transaction } from "./database.js";
import { MarketPatternEngine } from "./market-patterns.js";
import { MarketStateEngine } from "./market-state.js";
import { ObserverAiGate } from "./market-observer-ai.js";
import { createObserverPlan, evaluateObserverPlan, TERMINAL_PLAN_STATES } from "./market-observer-plan.js";

interface CachedPlan { userId: string; plan: ObserverPlan; persisted: ObserverPlan; events: ObserverPlan[] }
export class ObserverServiceError extends Error {}
/** All writes are serialized and versioned. This service has no order/execution imports. */
export class MarketObserverService {
  readonly state: MarketStateEngine;
  private ai = new ObserverAiGate();
  private interested = new Map<string, number>();
  private plans = new Map<string, CachedPlan>();
  private writes = new Map<string, CachedPlan>();
  private busy = false;
  private flushing: Promise<void> | null = null;
  private storageReady = false;
  private stopped = false;
  private lastRefresh = 0;
  private retryAfter = 0;
  private snapshots = new Map<string, { at: number; value: Pick<ObserverSnapshot, "plan" | "history"> }>();
  private retired = new Set<string>();
  private retire(id: string) {
    this.retired.add(id); this.plans.delete(id); this.writes.delete(id);
    if (this.retired.size > 2000) this.retired.delete(this.retired.values().next().value!);
  }
  private timer: ReturnType<typeof setInterval>;
  private storageTimer: ReturnType<typeof setInterval>;
  private lastTickAt: string | null = null;
  private livePairs = 0;
  constructor(readonly patterns: MarketPatternEngine, private readonly aiEnabled: boolean) {
    this.state = new MarketStateEngine(patterns);
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref();
    this.storageTimer = setInterval(() => void this.flush(), 1000); this.storageTimer.unref();
    void this.flush();
  }
  context(kind: string, data: Record<string, unknown>, receivedAt: string) {
    if (kind === "calendar") this.state.calendarContext(data, receivedAt);
    if (kind === "context-error") this.state.contextError(data);
  }
  private tick() {
    if (this.stopped) return;
    const asOf = new Date().toISOString(), reads = new Map<string, ObserverRead>();
    for (const instrument of this.patterns.instruments) {
      try { reads.set(instrument, this.state.update(instrument, asOf)); }
      catch (error) { console.error(`[observer] ${instrument} calculation failed`, error); }
    }
    this.lastTickAt = asOf; this.livePairs = [...reads.values()].filter(r => r.state === "live").length;
    for (const [id, cached] of this.plans) {
      if (TERMINAL_PLAN_STATES.has(cached.plan.status)) continue;
      if (cached.events.length >= 256) {
        if (cached.plan.reason !== "Journal backlog reached its limit. Monitoring is paused until storage recovers.") {
          cached.plan = { ...cached.plan, status: "PAUSED", resumeStatus: cached.plan.status === "PAUSED" ? cached.plan.resumeStatus : cached.plan.status as ObserverPlan["resumeStatus"], updatedAt: asOf, reason: "Journal backlog reached its limit. Monitoring is paused until storage recovers." };
          cached.events.push(structuredClone(cached.plan)); this.writes.set(id, cached);
        }
        continue;
      }
      const read = reads.get(cached.plan.instrument); if (!read) continue;
      const planRead = this.storageReady ? read : { ...read, blockers: ["Plan journal is unavailable.", ...read.blockers] };
      const next = evaluateObserverPlan(cached.plan, planRead, this.patterns.history(cached.plan.instrument, cached.plan.trigger?.timeframe ?? "M5"));
      if (JSON.stringify(next) !== JSON.stringify(cached.plan)) {
        if (next.status !== cached.plan.status || next.reason !== cached.plan.reason) cached.events.push(structuredClone(next));
        cached.plan = next; this.writes.set(id, cached);
      }
      this.interested.set(next.instrument, Date.now());
    }
    if (this.aiEnabled) for (const [instrument, at] of this.interested) {
      if (Date.now() - at > 600_000) { this.interested.delete(instrument); continue; }
      const read = reads.get(instrument);
      if (read) void this.ai.request(read).then(ai => { if (ai && !this.stopped) this.state.attachExplanation(instrument, read.revision, ai); });
    }
  }
  private flush() {
    this.flushing ??= this.flushWork().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async flushWork() {
    if (this.busy || this.stopped || !databaseConfigured() || Date.now() < this.retryAfter) return;
    this.busy = true;
    try {
      for (const [id, cached] of this.writes) {
        const frozen = structuredClone(cached.plan), events = cached.events.slice();
        const updated = await transaction(async client => {
          const result = await client.query("UPDATE market_observer_plans SET status=$2,plan=$3::jsonb,updated_at=$4 WHERE id=$1 AND status NOT IN ('INVALIDATED','EXPIRED','CLOSED') RETURNING id", [id, frozen.status, JSON.stringify(frozen), frozen.updatedAt]);
          if (result.rowCount) for (const event of events) await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)", [id, event.updatedAt, event.status, event.reason, JSON.stringify(event)]);
          return Boolean(result.rowCount);
        });
        if (!updated) { this.retire(id); this.snapshots.delete(`${cached.userId}:${frozen.instrument}`); continue; }
        cached.persisted = frozen;
        cached.events.splice(0, events.length);
        this.snapshots.delete(`${cached.userId}:${frozen.instrument}`);
        if (JSON.stringify(cached.plan) === JSON.stringify(frozen)) this.writes.delete(id);
        if (TERMINAL_PLAN_STATES.has(frozen.status) && !this.writes.has(id)) this.plans.delete(id);
      }
      if (Date.now() - this.lastRefresh > 30_000) {
        const rows = await query<{ user_id: string; plan: ObserverPlan }>("SELECT user_id,plan FROM market_observer_plans WHERE status IN ('WATCHING','READY','TRIGGERED','PAUSED') ORDER BY created_at LIMIT 500");
        for (const row of rows.rows) if (!this.plans.has(row.plan.id) && !this.retired.has(row.plan.id)) {
          const plan = structuredClone(row.plan);
          // No tick path is recoverable through a server restart.
          if (plan.status === "TRIGGERED" || plan.status === "PAUSED" && plan.resumeStatus === "TRIGGERED") {
            plan.status = "CLOSED"; plan.updatedAt = new Date().toISOString(); plan.reason = "Server restarted after the signal triggered; intervening price path is unknown.";
            plan.outcome = { kind: "unknown_after_gap", at: plan.updatedAt, price: null };
          }
          const cached = { userId: row.user_id, plan, persisted: structuredClone(row.plan), events: plan.status === "CLOSED" ? [structuredClone(plan)] : [] };
          this.plans.set(plan.id, cached);
          if (plan.status === "CLOSED") this.writes.set(plan.id, cached);
        }
        this.lastRefresh = Date.now();
      }
      this.storageReady = true;
    } catch (error) { this.storageReady = false; this.retryAfter = Date.now() + 10_000; console.error("[observer] journal unavailable", error instanceof Error ? error.message : error); }
    finally { this.busy = false; }
  }
  async snapshot(userId: string, instrument: string): Promise<ObserverSnapshot> {
    this.interested.set(instrument, Date.now());
    const read = this.state.update(instrument);
    try {
      const key = `${userId}:${instrument}`, cachedSnapshot = this.snapshots.get(key);
      if (cachedSnapshot && Date.now() - cachedSnapshot.at < 5000) {
        const saved = cachedSnapshot.value.plan;
        return { enabled: true, read, ...cachedSnapshot.value, plan: saved ? structuredClone(this.plans.get(saved.id)?.plan ?? saved) : null, storage: this.storageReady ? "ready" : "unavailable" };
      }
      const result = await query<{ plan: ObserverPlan }>("SELECT plan FROM market_observer_plans WHERE user_id=$1 AND instrument=$2 ORDER BY version DESC LIMIT 1", [userId, instrument]);
      const saved = result.rows[0]?.plan ?? null;
      const plan = saved ? TERMINAL_PLAN_STATES.has(saved.status) ? saved : this.plans.get(saved.id)?.plan ?? saved : null;
      const history = saved ? (await query<{ id: string; at: Date; status: ObserverPlan["status"]; reason: string }>("SELECT id::text,at,status,reason FROM market_observer_events WHERE plan_id=$1 ORDER BY id DESC LIMIT 30", [saved.id])).rows.map(e => ({ ...e, at: e.at.toISOString() })) : [];
      const value = { plan: plan ? structuredClone(plan) : null, history };
      this.snapshots.set(key, { at: Date.now(), value });
      if (this.snapshots.size > 500) this.snapshots.delete(this.snapshots.keys().next().value!);
      return { enabled: true, read, ...value, storage: this.storageReady ? "ready" : "unavailable" };
    } catch { return { enabled: true, read, plan: null, history: [], storage: "unavailable" }; }
  }
  async analyze(userId: string, instrument: string, mode: "NORMAL" | "SWING") {
    if (!this.storageReady) throw new ObserverServiceError("The plan journal is temporarily unavailable. Monitoring cannot be saved yet.");
    // Recompute on the server rather than trusting client levels or historical snapshots.
    const [m15, h1, h4, daily, execution, pricing, calendar, exposure] = await Promise.all([
      getCandles(instrument, "M15", 300), getCandles(instrument, "H1", 300), getCandles(instrument, "H4", 300), getCandles(instrument, "D", 300),
      getCandles(instrument, mode === "NORMAL" ? "M5" : "H1", 50), getPricing([instrument]), getEconomicCalendar(),
      query<{ instrument: string; direction: "long" | "short" }>("SELECT instrument,direction FROM pending_manual_entries WHERE user_id=$1 AND (status IN ('PENDING','TRIGGERING') OR status='TRIGGERED' AND EXISTS (SELECT 1 FROM paper_trades t WHERE t.id=pending_manual_entries.paper_trade_id AND t.status='open'))", [userId]),
    ]);
    const genuine = (r: typeof m15) => r.status.state === "connected" && r.data.source === "oanda" ? r.data.candles : undefined;
    const now = new Date().toISOString(), quote = pricing.status.state === "connected" && pricing.status.source === "oanda" ? pricing.data.find(q => q.instrument === instrument && q.source === "oanda" && q.status.toLowerCase() === "tradeable") ?? null : null;
    const news = calendar.status.state === "connected" && calendar.data.connected && calendar.data.source !== "mock"
      && calendar.data.coverageUntil && Date.parse(calendar.data.coverageUntil) >= Date.parse(now) + 30 * 60_000 ? [...calendar.data.events, ...(calendar.data.recentEvents ?? [])] : null;
    const input = { instrument, candles: { M15: genuine(m15), H1: genuine(h1), H4: genuine(h4), D1: genuine(daily) }, quote, now: Date.parse(now), news, exposure: exposure.rows };
    const normal = toMarketAnalysis(analyzeV2({ ...input, mode: "NORMAL" }));
    const swing = toMarketAnalysis(analyzeV2({ ...input, mode: "SWING" }));
    let plan!: ObserverPlan;
    const retiredIds: string[] = [];
    await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`observer:${userId}:${instrument}`]);
      const versions = await client.query<{ version: number }>("SELECT coalesce(max(version),0)::integer+1 AS version FROM market_observer_plans WHERE user_id=$1 AND instrument=$2", [userId, instrument]);
      plan = createObserverPlan(mode === "NORMAL" ? normal : swing, genuine(execution) ?? [], now, versions.rows[0]!.version);
      const retired = await client.query<{ id: string }>("UPDATE market_observer_plans SET status='EXPIRED',plan=plan || jsonb_build_object('status','EXPIRED','reason','Replaced by a new version.','updatedAt',$3::text),updated_at=$3::timestamptz WHERE user_id=$1 AND instrument=$2 AND status IN ('WATCHING','READY','TRIGGERED','PAUSED') RETURNING id", [userId, instrument, now]);
      retiredIds.push(...retired.rows.map(row => row.id));
      for (const row of retired.rows) await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,'EXPIRED','Replaced by a new version.','{}')", [row.id, now]);
      await client.query("INSERT INTO market_observer_plans(id,user_id,instrument,version,status,plan,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7)", [plan.id, userId, instrument, plan.version, plan.status, JSON.stringify(plan), now]);
      await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)", [plan.id, now, plan.status, plan.reason, JSON.stringify(plan)]);
    });
    for (const id of retiredIds) this.retire(id);
    for (const [id, cached] of this.plans) if (cached.userId === userId && cached.plan.instrument === instrument) this.retire(id);
    this.plans.set(plan.id, { userId, plan, persisted: structuredClone(plan), events: [] });
    this.snapshots.delete(`${userId}:${instrument}`);
    this.interested.set(instrument, Date.now());
    return { normal, swing, plan };
  }
  async cancel(userId: string, instrument: string) {
    const now = new Date().toISOString();
    const retiredIds: string[] = [];
    await transaction(async client => {
      const rows = await client.query<{ id: string }>("UPDATE market_observer_plans SET status='EXPIRED',plan=plan || jsonb_build_object('status','EXPIRED','reason','Monitoring stopped by you.','updatedAt',$3::text),updated_at=$3::timestamptz WHERE user_id=$1 AND instrument=$2 AND status IN ('WATCHING','READY','TRIGGERED','PAUSED') RETURNING id", [userId, instrument, now]);
      retiredIds.push(...rows.rows.map(row => row.id));
      for (const row of rows.rows) await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,'EXPIRED','Monitoring stopped by you.','{}')", [row.id, now]);
    });
    for (const id of retiredIds) this.retire(id);
    for (const [id, cached] of this.plans) if (cached.userId === userId && cached.plan.instrument === instrument) this.retire(id);
    this.snapshots.delete(`${userId}:${instrument}`);
  }
  async stop() { clearInterval(this.timer); clearInterval(this.storageTimer); await this.flush(); this.stopped = true; }
  health() { return { enabled: true, version: "market-observer@1", storageReady: this.storageReady, aiEnabled: this.aiEnabled, subscribedPairs: this.patterns.instruments.length, livePairs: this.livePairs, lastTickAt: this.lastTickAt }; }
}
