import type { MarketAnalysis } from "../../frontend/src/lib/strategy/market-analysis.js";
import type { ObserverPlan, ObserverRead, ObserverSnapshot, ObserverJournal, ObserverEvaluation } from "../../frontend/src/lib/market-observer-types.js";
import type { PoolClient } from "pg";
import { analyzeV2 } from "../../frontend/src/lib/strategy/analyze-v2/decide.js";
import { toMarketAnalysis } from "../../frontend/src/lib/strategy/analyze-v2/adapter.js";
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { databaseConfigured, query, transaction } from "./database.js";
import { MarketPatternEngine } from "./market-patterns.js";
import { MARKET_STATE_VERSION, MarketStateEngine } from "./market-state.js";
import { ObserverAiGate } from "./market-observer-ai.js";
import { createObserverPlan, evaluateObserverPlan, observerPlanChecks, resumeObserverPlan, stopObserverPlan, TERMINAL_PLAN_STATES } from "./market-observer-plan.js";
import { evaluateMeasuredPlan, summarizeObserverPlans } from "./market-observer-evaluation.js";
import { reviewObserverPlan, proposalCanNotify } from "./observer-review.js";
import { queueNotification, displayPair } from "./notifications.js";

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
  private mutating = new Set<string>();
  private retire(id: string) {
    this.retired.add(id); this.plans.delete(id); this.writes.delete(id);
    if (this.retired.size > 2000) this.retired.delete(this.retired.values().next().value!);
  }
  private timer: ReturnType<typeof setInterval>;
  private storageTimer: ReturnType<typeof setInterval>;
  private lastTickAt: string | null = null;
  private livePairs = 0;
  private scanning = false;
  private scanTimer: ReturnType<typeof setInterval>;
  constructor(readonly patterns: MarketPatternEngine, private readonly aiEnabled: boolean) {
    this.state = new MarketStateEngine(patterns);
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref();
    this.storageTimer = setInterval(() => void this.flush(), 1000); this.storageTimer.unref();
    this.scanTimer = setInterval(() => void this.scanBackground(), 60_000); this.scanTimer.unref();
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
    this.evaluatePlans(reads, asOf);
    if (this.aiEnabled) for (const [instrument, at] of this.interested) {
      if (Date.now() - at > 600_000) { this.interested.delete(instrument); continue; }
      const read = reads.get(instrument);
      if (read) void this.ai.request(read, pending => this.state.attachExplanation(instrument, read.revision, pending))
        .then(ai => { if (ai && !this.stopped) this.state.attachExplanation(instrument, read.revision, ai); });
    }
  }
  /** Preserve brief quote crossings even if price recovers before the next timer pass. */
  observe(instrument: string, receivedAt: string) {
    if (this.stopped || ![...this.plans.values()].some(c => c.plan.instrument === instrument && !TERMINAL_PLAN_STATES.has(c.plan.status))) return;
    try { this.evaluatePlans(new Map([[instrument, this.state.update(instrument, receivedAt)]]), receivedAt); }
    catch (error) { console.error(`[observer] ${instrument} quote evaluation failed`, error); }
  }
  private evaluatePlans(reads: Map<string, ObserverRead>, asOf: string) {
    for (const [id, cached] of this.plans) {
      if (this.mutating.has(`${cached.userId}:${cached.plan.instrument}`)) continue;
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
      const next = evaluateMeasuredPlan(cached.plan, planRead, this.patterns.history(cached.plan.instrument, cached.plan.trigger?.timeframe ?? "M5"));
      if (JSON.stringify(next) !== JSON.stringify(cached.plan)) {
        if (next.status !== cached.plan.status || next.reason !== cached.plan.reason || next.confirmationCandle !== cached.plan.confirmationCandle || next.pullback?.touchedAt && !cached.plan.pullback?.touchedAt) cached.events.push(structuredClone(next));
        cached.plan = next; this.writes.set(id, cached);
      }
      this.interested.set(next.instrument, Date.now());
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
          const plan = resumeObserverPlan(row.plan, new Date().toISOString());
          const cached = { userId: row.user_id, plan, persisted: structuredClone(row.plan), events: [structuredClone(plan)] };
          this.plans.set(plan.id, cached);
          this.writes.set(plan.id, cached);
        }
        this.lastRefresh = Date.now();
      }
      this.storageReady = true;
    } catch (error) { this.storageReady = false; this.retryAfter = Date.now() + 10_000; console.error("[observer] journal unavailable", error instanceof Error ? error.message : error); }
    finally { this.busy = false; }
  }
  async activeInstruments(userId: string): Promise<string[]> {
    if (!this.storageReady) throw new ObserverServiceError("The plan journal is temporarily unavailable.");
    const result = await query<{ instrument: string }>(
      "SELECT instrument FROM market_observer_plans WHERE user_id=$1 AND status IN ('WATCHING','READY','TRIGGERED','PAUSED') UNION SELECT instrument FROM market_observer_watches WHERE user_id=$1 AND enabled ORDER BY instrument",
      [userId],
    );
    return result.rows.map(row => row.instrument);
  }
  async snapshot(userId: string, instrument: string): Promise<ObserverSnapshot> {
    this.interested.set(instrument, Date.now());
    const read = this.state.update(instrument);
    try {
      const watches = await query<{ enabled: boolean; mode: "NORMAL" | "SWING" }>("SELECT enabled,mode FROM market_observer_watches WHERE user_id=$1 AND instrument=$2", [userId, instrument]);
      const background = watches.rows[0] ?? { enabled: false, mode: "NORMAL" as const };
      const key = `${userId}:${instrument}`, cachedSnapshot = this.snapshots.get(key);
      if (cachedSnapshot && Date.now() - cachedSnapshot.at < 5000) {
        const saved = cachedSnapshot.value.plan;
        const plan = saved ? structuredClone(this.plans.get(saved.id)?.plan ?? saved) : null;
        return { enabled: true, background, read, ...cachedSnapshot.value, plan, checks: observerPlanChecks(plan, this.storageReady ? read : { ...read, blockers: ["Plan journal is unavailable.", ...read.blockers] }), storage: this.storageReady ? "ready" : "unavailable" };
      }
      const result = await query<{ plan: ObserverPlan }>("SELECT plan FROM market_observer_plans WHERE user_id=$1 AND instrument=$2 ORDER BY version DESC LIMIT 1", [userId, instrument]);
      const saved = result.rows[0]?.plan ?? null;
      const plan = saved ? TERMINAL_PLAN_STATES.has(saved.status) ? saved : this.plans.get(saved.id)?.plan ?? saved : null;
      const history = saved ? (await query<{ id: string; at: Date; status: ObserverPlan["status"]; reason: string }>("SELECT id::text,at,status,reason FROM market_observer_events WHERE plan_id=$1 ORDER BY id DESC LIMIT 30", [saved.id])).rows.map(e => ({ ...e, at: e.at.toISOString() })) : [];
      const value = { plan: plan ? structuredClone(plan) : null, history };
      this.snapshots.set(key, { at: Date.now(), value });
      if (this.snapshots.size > 500) this.snapshots.delete(this.snapshots.keys().next().value!);
      return { enabled: true, background, read, ...value, checks: observerPlanChecks(plan, this.storageReady ? read : { ...read, blockers: ["Plan journal is unavailable.", ...read.blockers] }), storage: this.storageReady ? "ready" : "unavailable" };
    } catch { return { enabled: true, read, plan: null, history: [], storage: "unavailable" }; }
  }
  /** Bounded archive fetched on demand, scoped to the authenticated owner and selected pair. */
  async journal(userId: string, instrument: string): Promise<ObserverJournal> {
    const rows = await query<{ plan: ObserverPlan }>("SELECT plan FROM market_observer_plans WHERE user_id=$1 AND instrument=$2 ORDER BY version DESC LIMIT 10", [userId, instrument]);
    const events = await query<{ id: string; at: Date; status: ObserverPlan["status"]; reason: string; planId: string; version: number; snapshot: ObserverPlan | null }>(
      `SELECT e.id::text,e.at,e.status,e.reason,e.plan_id AS "planId",p.version,
        CASE WHEN e.snapshot ? 'id' THEN e.snapshot ELSE NULL END AS snapshot
       FROM market_observer_events e JOIN market_observer_plans p ON p.id=e.plan_id
       WHERE p.user_id=$1 AND p.instrument=$2 ORDER BY e.id DESC LIMIT 60`, [userId, instrument]);
    return { plans: rows.rows.map(r => r.plan), events: events.rows.map(e => ({ ...e, at: e.at.toISOString() })) };
  }
  async evaluation(userId: string, instrument: string): Promise<ObserverEvaluation> {
    const rows = await query<{ plan: ObserverPlan }>("SELECT plan FROM market_observer_plans WHERE user_id=$1 AND instrument=$2 ORDER BY version DESC LIMIT 1001", [userId, instrument]);
    const plans = rows.rows.slice(0, 1000).map(r => TERMINAL_PLAN_STATES.has(r.plan.status) ? r.plan : this.plans.get(r.plan.id)?.plan ?? r.plan);
    return summarizeObserverPlans(plans, instrument, new Date().toISOString(), rows.rows.length > 1000);
  }
  private async endActive(client: PoolClient, userId: string, instrument: string, now: string, reason: string) {
    const rows = await client.query<{ plan: ObserverPlan }>("SELECT plan FROM market_observer_plans WHERE user_id=$1 AND instrument=$2 AND status IN ('WATCHING','READY','TRIGGERED','PAUSED') FOR UPDATE", [userId, instrument]);
    for (const row of rows.rows) {
      const ended = stopObserverPlan(row.plan, now, reason);
      await client.query("UPDATE market_observer_plans SET status=$2,plan=$3::jsonb,updated_at=$4 WHERE id=$1", [ended.id, ended.status, JSON.stringify(ended), now]);
      await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)", [ended.id, now, ended.status, ended.reason, JSON.stringify(ended)]);
    }
    return rows.rows.map(r => r.plan.id);
  }
  private async flushBeforeMutation(userId: string, instrument: string) {
    const pending = () => [...this.writes.values()].some(c => c.userId === userId && c.plan.instrument === instrument);
    await this.flush();
    // The first flush may load restart events, or finish a write already in flight.
    if (pending()) await this.flush();
    if (!this.storageReady || pending()) throw new ObserverServiceError("The plan journal is temporarily unavailable. Existing monitoring was preserved.");
  }
  private pauseAfterFailedMutation(userId: string, instrument: string) {
    // Evaluation is suspended while the final journal snapshot is committed. If that
    // change fails, its missing path must not become a fabricated signal outcome.
    for (const [id, cached] of this.plans) {
      if (cached.userId !== userId || cached.plan.instrument !== instrument || TERMINAL_PLAN_STATES.has(cached.plan.status)) continue;
      cached.plan = resumeObserverPlan(cached.plan, new Date().toISOString());
      cached.plan.reason = cached.plan.status === "CLOSED" ? "A failed plan change interrupted observation; intervening price path is unknown." : "Plan change could not be saved. Fresh checks and a new full execution candle are required.";
      cached.events.push(structuredClone(cached.plan)); this.writes.set(id, cached);
    }
    this.snapshots.delete(`${userId}:${instrument}`);
  }
  async analyze(userId: string, instrument: string, mode: "NORMAL" | "SWING", background = false) {
    if (!this.storageReady) throw new ObserverServiceError("The plan journal is temporarily unavailable. Monitoring cannot be saved yet.");
    // Recompute on the server rather than trusting client levels or historical snapshots.
    const [m15, h1, h4, daily, execution, pricing, calendar, exposure] = await Promise.all([
      getCandles(instrument, "M15", 300), getCandles(instrument, "H1", 300), getCandles(instrument, "H4", 300), getCandles(instrument, "D", 300),
      getCandles(instrument, mode === "NORMAL" ? "M5" : "H1", 50), getPricing([instrument]), getEconomicCalendar(),
      query<{ instrument: string; direction: "long" | "short" }>("SELECT instrument,direction FROM pending_manual_entries WHERE user_id=$1 AND (status IN ('PENDING','TRIGGERING') OR status='TRIGGERED' AND EXISTS (SELECT 1 FROM paper_trades t WHERE t.id=pending_manual_entries.paper_trade_id AND t.status='open'))", [userId]),
    ]);
    const genuine = (r: typeof m15) => r.status.state === "connected" && r.data.source === "oanda" ? r.data.candles : undefined;
    const now = new Date().toISOString(), quote = pricing.status.state === "connected" && pricing.status.source === "oanda" ? pricing.data.find(q => q.instrument === instrument && q.source === "oanda" && q.status.toLowerCase() === "tradeable") ?? null : null;
    for (const [granularity, result] of [["M15", m15], ["H1", h1], ["H4", h4]] as const) {
      if (genuine(result)) this.patterns.context({ instrument, granularity, source: "oanda", snapshot: result.data }, now);
      else this.patterns.contextError({ instrument, granularity, context: "candles" });
    }
    if (mode === "NORMAL") {
      if (genuine(execution)) this.patterns.context({ instrument, granularity: "M5", source: "oanda", snapshot: execution.data }, now);
      else this.patterns.contextError({ instrument, granularity: "M5", context: "candles" });
    }
    this.state.calendarContext({ snapshot: calendar.data }, now);
    const news = calendar.status.state === "connected" && calendar.data.connected && calendar.data.source !== "mock"
      && calendar.data.coverageUntil && Date.parse(calendar.data.coverageUntil) >= Date.parse(now) + 30 * 60_000 ? [...calendar.data.events, ...(calendar.data.recentEvents ?? [])] : null;
    const input = { instrument, candles: { M15: genuine(m15), H1: genuine(h1), H4: genuine(h4), D1: genuine(daily) }, quote, now: Date.parse(now), news, exposure: exposure.rows };
    const normal = toMarketAnalysis(analyzeV2({ ...input, mode: "NORMAL" }));
    const swing = toMarketAnalysis(analyzeV2({ ...input, mode: "SWING" }));
    let plan!: ObserverPlan;
    const retiredIds: string[] = [];
    const mutationKey = `${userId}:${instrument}`;
    if (this.mutating.has(mutationKey)) throw new ObserverServiceError("A plan change is already being saved. Try again shortly.");
    this.mutating.add(mutationKey);
    let completed = false;
    try {
      await this.flushBeforeMutation(userId, instrument);
      await transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`observer:${userId}:${instrument}`]);
        if (background) {
          const watch = await client.query("SELECT 1 FROM market_observer_watches WHERE user_id=$1 AND instrument=$2 AND enabled AND mode=$3 FOR UPDATE", [userId, instrument, mode]);
          const active = await client.query("SELECT 1 FROM market_observer_plans WHERE user_id=$1 AND instrument=$2 AND status IN ('WATCHING','READY','TRIGGERED','PAUSED')", [userId, instrument]);
          if (!watch.rowCount || active.rowCount) throw new ObserverServiceError("Background scan superseded by a newer pair change.");
        }
        const versions = await client.query<{ version: number }>("SELECT coalesce(max(version),0)::integer+1 AS version FROM market_observer_plans WHERE user_id=$1 AND instrument=$2", [userId, instrument]);
        plan = createObserverPlan(mode === "NORMAL" ? normal : swing, genuine(execution) ?? [], now, versions.rows[0]!.version);
        if (background) {
          plan.review = { decision: "pending", decidedAt: null };
          if (!proposalCanNotify(plan, now)) throw new ObserverServiceError("No actionable proposal found.");
          plan.reason = "New plan awaiting your review. Accept to start monitoring; no order will be placed.";
        }
        retiredIds.push(...await this.endActive(client, userId, instrument, new Date().toISOString(), "Replaced by a new version."));
        await client.query("INSERT INTO market_observer_plans(id,user_id,instrument,version,status,plan,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7)", [plan.id, userId, instrument, plan.version, plan.status, JSON.stringify(plan), now]);
        await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)", [plan.id, now, plan.status, plan.reason, JSON.stringify(plan)]);
      });
      for (const id of retiredIds) this.retire(id);
      for (const [id, cached] of this.plans) if (cached.userId === userId && cached.plan.instrument === instrument) this.retire(id);
      this.plans.set(plan.id, { userId, plan, persisted: structuredClone(plan), events: [] });
      this.snapshots.delete(`${userId}:${instrument}`);
      this.interested.set(instrument, Date.now());
      completed = true;
      return { normal, swing, plan };
    } finally { if (!completed) this.pauseAfterFailedMutation(userId, instrument); this.mutating.delete(mutationKey); }
  }
  async cancel(userId: string, instrument: string) {
    await this.setBackground(userId, instrument, "NORMAL", false);
    const retiredIds: string[] = [];
    const mutationKey = `${userId}:${instrument}`;
    if (this.mutating.has(mutationKey)) throw new ObserverServiceError("A plan change is already being saved. Try again shortly.");
    this.mutating.add(mutationKey);
    let completed = false;
    try {
      await this.flushBeforeMutation(userId, instrument);
      await transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`observer:${userId}:${instrument}`]);
        retiredIds.push(...await this.endActive(client, userId, instrument, new Date().toISOString(), "Monitoring stopped by you."));
      });
      for (const id of retiredIds) this.retire(id);
      for (const [id, cached] of this.plans) if (cached.userId === userId && cached.plan.instrument === instrument) this.retire(id);
      this.snapshots.delete(`${userId}:${instrument}`);
      completed = true;
    } finally { if (!completed) this.pauseAfterFailedMutation(userId, instrument); this.mutating.delete(mutationKey); }
  }
  async setBackground(userId: string, instrument: string, mode: "NORMAL" | "SWING", enabled: boolean) {
    await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`observer-watches:${userId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`observer:${userId}:${instrument}`]);
      if (enabled) {
        const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM market_observer_watches WHERE user_id=$1 AND enabled AND instrument<>$2", [userId, instrument]);
        if (Number(count.rows[0]?.count) >= 12) throw new ObserverServiceError("Background monitoring supports up to 12 pairs.");
      }
      await client.query(`INSERT INTO market_observer_watches(user_id,instrument,mode,enabled) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,instrument) DO UPDATE SET mode=EXCLUDED.mode,enabled=EXCLUDED.enabled,next_scan_at=now(),updated_at=now()`, [userId, instrument, mode, enabled]);
    });
    this.snapshots.delete(`${userId}:${instrument}`);
  }
  async review(userId: string, instrument: string, planId: string, decision: "accepted" | "rejected") {
    const key = `${userId}:${instrument}`;
    if (this.mutating.has(key)) throw new ObserverServiceError("A plan change is already being saved.");
    this.mutating.add(key);
    let completed = false;
    try {
      await this.flushBeforeMutation(userId, instrument);
      const plan = await transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`observer:${userId}:${instrument}`]);
        const rows = await client.query<{ plan: ObserverPlan }>("SELECT plan FROM market_observer_plans WHERE id=$1 AND user_id=$2 AND instrument=$3 FOR UPDATE", [planId, userId, instrument]);
        if (!rows.rows[0]) throw new ObserverServiceError("This plan is no longer available.");
        let next: ObserverPlan;
        try {
          const read = this.state.update(instrument);
          const current = evaluateObserverPlan(rows.rows[0].plan, read, []);
          next = reviewObserverPlan(current, decision, new Date().toISOString());
        }
        catch (error) { throw new ObserverServiceError((error as Error).message); }
        await client.query("UPDATE market_observer_plans SET status=$2,plan=$3::jsonb,updated_at=$4 WHERE id=$1", [next.id, next.status, JSON.stringify(next), next.updatedAt]);
        await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)", [next.id, next.updatedAt, next.status, next.reason, JSON.stringify(next)]);
        await client.query("UPDATE market_observer_watches SET next_scan_at=now()+interval '15 minutes' WHERE user_id=$1 AND instrument=$2", [userId, instrument]);
        return next;
      });
      if (decision === "rejected") this.retire(plan.id);
      else this.plans.set(plan.id, { userId, plan, persisted: structuredClone(plan), events: [] });
      this.snapshots.delete(key); completed = true;
      return plan;
    } finally { if (!completed) this.pauseAfterFailedMutation(userId, instrument); this.mutating.delete(key); }
  }
  private async scanBackground() {
    if (this.scanning || this.stopped || !this.storageReady) return;
    this.scanning = true;
    try {
      // Retry notification creation after restart/failure; the unique key suppresses duplicates.
      const proposals = await query<{ user_id: string; plan: ObserverPlan }>("SELECT user_id,plan FROM market_observer_plans WHERE plan->'review'->>'decision'='pending' AND status IN ('WATCHING','READY','PAUSED') LIMIT 500");
      for (const row of proposals.rows) {
        const plan = this.plans.get(row.plan.id)?.plan ?? row.plan;
        if (!proposalCanNotify(plan, new Date().toISOString())) continue;
        await queueNotification({ userId: row.user_id, kind: "setup_ready", title: `${displayPair(plan.instrument)} plan to review`,
          message: `${plan.direction === "short" ? "Sell" : "Buy"} plan: entry ${plan.entry}, stop ${plan.stop}, target ${plan.target}. Accept to monitor or reject. No trade placed.`,
          instrument: plan.instrument, paperTradeId: null, dedupeKey: `observer-proposal:${plan.id}`,
          url: `/chart?instrument=${encodeURIComponent(plan.instrument)}&observer=review&plan=${plan.id}` });
      }
      const confirmed = await query<{ user_id: string; plan: ObserverPlan }>("SELECT user_id,plan FROM market_observer_plans WHERE status='TRIGGERED' AND plan->'review'->>'decision'='accepted' LIMIT 500");
      for (const row of confirmed.rows) {
        await queueNotification({ userId: row.user_id, kind: "setup_ready", title: `${displayPair(row.plan.instrument)} entry conditions met`,
          message: "Your accepted plan met its entry checks. Open the app to review current price before placing any trade.",
          instrument: row.plan.instrument, paperTradeId: null, dedupeKey: `observer-confirmed:${row.plan.id}`,
          url: `/chart?instrument=${encodeURIComponent(row.plan.instrument)}&observer=review&plan=${row.plan.id}` });
      }
      const due = await query<{ user_id: string; instrument: string; mode: "NORMAL" | "SWING" }>(`UPDATE market_observer_watches w
        SET next_scan_at=now()+CASE WHEN mode='SWING' THEN interval '15 minutes' ELSE interval '5 minutes' END
        WHERE (user_id,instrument)=(SELECT user_id,instrument FROM market_observer_watches w2
          WHERE enabled AND next_scan_at<=now() AND NOT EXISTS (SELECT 1 FROM market_observer_plans p WHERE p.user_id=w2.user_id AND p.instrument=w2.instrument AND p.status IN ('WATCHING','READY','TRIGGERED','PAUSED'))
          ORDER BY next_scan_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING user_id,instrument,mode`);
      const row = due.rows[0];
      if (row && this.state.update(row.instrument).state === "live") {
        try { await this.analyze(row.user_id, row.instrument, row.mode, true); }
        catch (error) { if (!(error instanceof ObserverServiceError)) throw error; }
      }
    } catch (error) { console.error("[observer] background scan unavailable", error instanceof Error ? error.message : error); }
    finally { this.scanning = false; }
  }
  async stop() { clearInterval(this.scanTimer); clearInterval(this.timer); clearInterval(this.storageTimer); await this.flush(); this.stopped = true; }
  health() { return { enabled: true, version: MARKET_STATE_VERSION, storageReady: this.storageReady, aiEnabled: this.aiEnabled, subscribedPairs: this.patterns.instruments.length, livePairs: this.livePairs, lastTickAt: this.lastTickAt }; }
}
