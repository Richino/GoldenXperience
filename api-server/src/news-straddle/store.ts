import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { sameNewsMembers } from "../../../frontend/src/lib/news/news-release-groups.js";
import { db, query, transaction } from "../database.js";
import { PENDING_ENTRY_FIELDS, serializePendingManualEntry, type PendingEntryRow } from "../pending-manual-entries.js";
import { NEWS_TERMINAL, type NewsRun, type NewsLeg } from "../../../frontend/src/lib/news/news-straddle-v3.js";

export type Audit = { event: string; detail?: Record<string, unknown>; transactionId?: string };
export interface NewsSession {
  read(): Promise<NewsRun | null>; save(run: NewsRun, audit: Audit): Promise<void>; seen(id: string): Promise<boolean>;
  halt(reason: string): Promise<void>;
}
export interface NewsRepository { locked<T>(id: string, fn: (s: NewsSession) => Promise<T>): Promise<T | undefined>; active(): Promise<NewsRun[]> }
export const publicRun = (run: NewsRun) => { const { userId: _user, accountKey: _account, ...view } = run; return view; };

async function project(c: Pick<PoolClient, "query">, run: NewsRun) {
  for (const leg of Object.values(run.legs)) {
    const filled = leg.fillPrice !== null;
    if (filled && leg.tradeId && !leg.paperTradeId) {
      // paper_trades.target is NOT NULL; its existing no-target convention is entry.
      // Actual broker/entry target stays null, never a fictitious 2R order.
      const paper = await c.query<{ id: string }>(
        `INSERT INTO paper_trades(user_id,legacy_id,origin,pair,direction,status,result,opened_at,entry,stop,target,reason,notes)
         VALUES($1,$2,'manual',$3,$4,'open','open',$5,$6,$7,$6,$9,$8)
         ON CONFLICT(user_id,legacy_id) DO UPDATE SET updated_at=paper_trades.updated_at RETURNING id`,
        [run.userId, `pending-entry:${leg.entryId}`, run.instrument.replace("_", "/"), leg.side, leg.fillTime, leg.fillPrice, leg.initialStop ?? leg.fillPrice! + (leg.side === "long" ? -1 : 1) * leg.stopDistance!, `${run.mode === "oco" ? "Linked OCO" : "News Straddle v3"} ${run.id}; no fixed target; original -1R stop reference is immutable.`, run.mode === "oco" ? "Linked OCO entry filled" : "News STOP breakout filled"],
      ); leg.paperTradeId = paper.rows[0]!.id;
    }
    if (leg.closedAt && leg.paperTradeId && leg.exitPrice !== null && leg.realizedPL !== null) await c.query(
      `UPDATE paper_trades SET status='closed',result=$2,exit=$3,result_r=$4,closed_at=$5,updated_at=now() WHERE id=$1 AND status='open'`,
      [leg.paperTradeId, leg.realizedPL > 0 ? "win" : leg.realizedPL < 0 ? "loss" : "breakeven", leg.exitPrice, leg.realizedR, leg.closedAt],
    );
    const status = filled ? "TRIGGERED" : leg.state === "CANCELLED" ? "CANCELLED" : leg.state === "REJECTED" ? "FAILED" : NEWS_TERMINAL.includes(run.state) ? run.state === "EXPIRED" ? "EXPIRED" : run.state === "CANCELLED" ? "CANCELLED" : "FAILED" : ["SUBMITTING", "UNKNOWN"].includes(leg.state) ? "TRIGGERING" : "PENDING";
    const zones = run.legs.long.entry && run.legs.short.entry ? { buy: { lower: run.legs.long.entry, upper: run.legs.long.bound }, sell: { lower: run.legs.short.bound, upper: run.legs.short.entry } } : null;
    const meta = {
      mode: "news", configVersion: 3, straddleId: run.id, line: leg.side === "long" ? "upper" : "lower", newsState: run.state,
      createdFrom: "chart", tradeStyle: "day", noTarget: true, release: run.release, linkedOco: run.mode === "oco",
      distancePips: run.settings.distancePips, slippagePips: run.settings.maxSlippagePips, lockAt: run.targetSubmitAt,
      zones, reservation: run.firstFillSide ? { side: run.firstFillSide } : null,
      brokerOrderId: leg.orderId, brokerTradeId: leg.tradeId, execution: filled ? "news_v3_filled" : "news_v3_pending", newsRun: publicRun(run),
    };
    await c.query(`UPDATE pending_manual_entries SET status=$2,entry_price=COALESCE($3,entry_price),stop_price=$4,target_price=NULL,
      trigger_price=$5,triggered_at=$6,paper_trade_id=$7,failure_reason=$8,metadata=metadata||$9::jsonb,updated_at=now() WHERE id=$1`,
    [leg.entryId, status, leg.entry, leg.activeStop ?? leg.initialStop, leg.fillPrice, leg.fillTime, leg.paperTradeId, run.reason, JSON.stringify(meta)]);
  }
}

export class PgNewsRepository implements NewsRepository {
  constructor(private account: string, private pool: Pool = db()) {}
  async active() { return (await this.pool.query<{ snapshot: NewsRun }>("SELECT snapshot FROM news_straddle_runs WHERE account_key=$1 AND ended_at IS NULL ORDER BY created_at", [this.account])).rows.map(r => r.snapshot); }
  async locked<T>(id: string, fn: (s: NewsSession) => Promise<T>) {
    const c = await this.pool.connect(); let locked = false;
    try {
      await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`news-v3:${id}`]); locked = true;
      const session: NewsSession = {
        read: async () => (await c.query<{ snapshot: NewsRun }>("SELECT snapshot FROM news_straddle_runs WHERE id=$1 AND account_key=$2", [id, this.account])).rows[0]?.snapshot ?? null,
        seen: async tx => Boolean((await c.query("SELECT 1 FROM news_straddle_audit WHERE run_id=$1 AND broker_transaction_id=$2", [id, tx])).rowCount),
        save: async (run, audit) => {
          await c.query("BEGIN");
          try {
            await project(c, run);
            const moved = await c.query("UPDATE news_straddle_runs SET snapshot=$3::jsonb,state=$4,revision=revision+1,ended_at=$5,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING revision", [id, run.revision, JSON.stringify({ ...run, revision: run.revision + 1 }), run.state, run.endedAt]);
            if (!moved.rowCount) throw new Error("News setup revision changed; reload before applying another action.");
            await c.query("INSERT INTO news_straddle_audit(run_id,occurred_at,event,detail,broker_transaction_id) VALUES($1,$2,$3,$4::jsonb,$5)", [id, new Date().toISOString(), audit.event, JSON.stringify(audit.detail ?? {}), audit.transactionId ?? null]);
            await c.query("COMMIT"); run.revision++;
          } catch (error) { await c.query("ROLLBACK"); throw error; }
        },
        halt: async reason => { await c.query("INSERT INTO news_straddle_runtime(account_key,halted,halt_reason) VALUES($1,true,$2) ON CONFLICT(account_key) DO UPDATE SET halted=true,halt_reason=$2,updated_at=now()", [this.account, reason]); },
      };
      return await fn(session);
    } finally { if (locked) await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`news-v3:${id}`]).catch(() => undefined); c.release(); }
  }
}

export async function newsRiskPolicy(userId: string) {
  const row = (await query<{ kill_switch: boolean; max_risk_percent: string; max_aggregate_risk_percent: string }>("SELECT kill_switch,max_risk_percent::text,max_aggregate_risk_percent::text FROM trade_plan_risk_settings WHERE user_id=$1", [userId])).rows[0];
  return { killSwitch: row?.kill_switch === true, riskLimit: row ? Number(row.max_risk_percent) : 1, eventRiskLimit: row ? Number(row.max_aggregate_risk_percent) : 3 };
}
export async function newsRuntimeStatus(key: string) {
  return (await query<{ halted: boolean; halt_reason: string | null; transaction_cursor: string | null }>("SELECT halted,halt_reason,transaction_cursor FROM news_straddle_runtime WHERE account_key=$1", [key])).rows[0] ?? { halted: false, halt_reason: null, transaction_cursor: null };
}
export async function createNewsRun(run: NewsRun, transact: typeof transaction = transaction) {
  return transact(async c => {
    // Account-pair serialisation also covers concurrent API workers and requests.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`news-v3-release:${run.accountKey}:${run.release.time}`]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`news-v3-event:${run.accountKey}:${run.eventKey}`]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`news-v3-pair:${run.accountKey}:${run.instrument}`]);
    let existing = (await c.query<{ snapshot: NewsRun }>("SELECT snapshot FROM news_straddle_runs WHERE account_key=$1 AND instrument=$2 AND event_key=$3", [run.accountKey, run.instrument, run.eventKey])).rows[0]?.snapshot;
    if (existing) {
      // Share the engine's lock so cancellation/reconciliation cannot race a restart.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`news-v3:${existing.id}`]);
      existing = (await c.query<{ snapshot: NewsRun }>("SELECT snapshot FROM news_straddle_runs WHERE id=$1", [existing.id])).rows[0]!.snapshot;
    }
    let restarting = false;
    if (existing) {
      if (existing.userId !== run.userId || !isDeepStrictEqual(existing.settings, run.settings)) throw new Error("This pair/event already has an attempt; approved settings cannot be replaced.");
      if (Date.parse(existing.release.time) !== Date.parse(run.release.time) || !sameNewsMembers(existing.release.events ?? [existing.release], run.release.events ?? [run.release])) throw new Error("This news batch already has an attempt; approved releases cannot be replaced.");
      if (!NEWS_TERMINAL.includes(existing.state)) return existing;
      restarting = existing.state === "CANCELLED" && !!existing.endedAt && !existing.firstFillSide && !existing.exception
        && Object.values(existing.legs).every(l => ["UNSENT", "CANCELLED"].includes(l.state)
          && !l.submittedAt && !l.httpDispatchedAt && !l.acknowledgedAt && !l.orderId && !l.tradeId && !l.fillTime && l.fillPrice === null && !l.paperTradeId);
      if (!restarting) throw new Error(`This event's earlier setup is ${existing.state.toLowerCase()}. Monitoring has not restarted. A setup with an execution attempt cannot be restarted.`);
      if (Date.parse(run.targetSubmitAt) <= Date.now() + 12_000) throw new Error("Too late to restart safely before this release.");
    }
    const pair = run.instrument.replace("_", "/");
    const used = (await c.query<{ used: string; cap: string | null }>(`SELECT COALESCE(sum((snapshot->'risk'->>'perLegPercent')::numeric * 2),0)::text AS used,
      min((snapshot->'settings'->>'maxEventRiskPercent')::numeric)::text AS cap FROM news_straddle_runs
      WHERE account_key=$1 AND (event_key=$2 OR snapshot->'release'->>'time'=$3) AND ($4::uuid IS NULL OR id<>$4::uuid)`, [run.accountKey, run.eventKey, run.release.time, restarting ? existing!.id : null])).rows[0]!;
    const limit = (await c.query<{ max_risk_percent: string; max_aggregate_risk_percent: string }>("SELECT max_risk_percent::text,max_aggregate_risk_percent::text FROM trade_plan_risk_settings WHERE user_id=$1", [run.userId])).rows[0];
    if (!run.risk || run.risk.perLegPercent > Number(limit?.max_risk_percent ?? 1)) throw new Error("News per-trade risk exceeds the account risk limit.");
    const eventLimit = Math.min(run.settings.maxEventRiskPercent, Number(used.cap ?? run.settings.maxEventRiskPercent), Number(limit?.max_aggregate_risk_percent ?? 3));
    if (!run.risk || Number(used.used) + run.risk.perLegPercent * 2 > eventLimit + 1e-9) throw new Error("The account's total risk budget for this release is already allocated.");
    const busy = await c.query(`SELECT id FROM pending_manual_entries WHERE instrument=$1 AND status IN ('PENDING','TRIGGERING') UNION ALL SELECT id FROM paper_trades WHERE pair=$2 AND status='open' LIMIT 1`, [run.instrument, pair]);
    if (busy.rowCount) throw new Error("This pair already has an open trade or waiting entry.");
    if ((await c.query("SELECT 1 FROM news_straddle_runtime WHERE account_key=$1 AND halted=true", [run.accountKey])).rowCount) throw new Error("News execution is paused after an exception.");
    if (restarting) {
      const previous = existing!;
      run = { ...run, id: previous.id, revision: previous.revision + 1, createdAt: previous.createdAt,
        timeline: [...previous.timeline, { at: new Date().toISOString(), event: "restarted", detail: "Monitoring restarted after a cancellation before any order submission; broker and risk checks repeated." }] };
      for (const side of ["long", "short"] as const) run.legs[side].entryId = previous.legs[side].entryId;
      await c.query("UPDATE news_straddle_runs SET snapshot=$2::jsonb,state=$3,revision=$4,ended_at=NULL,updated_at=now() WHERE id=$1", [run.id, JSON.stringify(run), run.state, run.revision]);
      await project(c, run);
      await c.query("INSERT INTO news_straddle_audit(run_id,occurred_at,event,detail) VALUES($1,$2,'restarted',$3::jsonb)", [run.id, new Date().toISOString(), JSON.stringify({ previous, targetSubmitAt: run.targetSubmitAt })]);
      return run;
    }
    await c.query("INSERT INTO news_straddle_runs(id,user_id,account_key,instrument,event_key,state,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)", [run.id, run.userId, run.accountKey, run.instrument, run.eventKey, run.state, JSON.stringify(run)]);
    for (const leg of Object.values(run.legs)) await c.query(`INSERT INTO pending_manual_entries(id,user_id,instrument,direction,entry_price,entry_order_type,current_price_at_creation,expiration_type,expires_at,activate_at,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,'time',$8,$9,$10::jsonb)`, [leg.entryId, run.userId, run.instrument, leg.side, leg.entry, leg.side === "long" ? "buy_stop" : "sell_stop", leg.side === "long" ? run.preparedQuote!.ask : run.preparedQuote!.bid,
      (run.mode === "oco" ? run.expiresAt! : new Date(Date.parse(run.release.time) + run.settings.windowSeconds * 1000).toISOString()), run.targetSubmitAt, JSON.stringify({ mode: "news", configVersion: 3, straddleId: run.id })]);
    await project(c, run);
    await c.query("INSERT INTO news_straddle_audit(run_id,occurred_at,event,detail) VALUES($1,$2,'scheduled',$3::jsonb)", [run.id, run.createdAt, JSON.stringify({ targetSubmitAt: run.targetSubmitAt, settings: run.settings, risk: run.risk })]);
    return run;
  });
}
export async function readUserNewsRun(id: string, userId: string) {
  return (await query<{ snapshot: NewsRun }>("SELECT snapshot FROM news_straddle_runs WHERE id=$1 AND user_id=$2", [id, userId])).rows[0]?.snapshot ?? null;
}
export async function newsRows(id: string, userId: string) { return (await query<PendingEntryRow>(`SELECT ${PENDING_ENTRY_FIELDS} FROM pending_manual_entries WHERE user_id=$1 AND metadata->>'straddleId'=$2 ORDER BY direction`, [userId, id])).rows.map(serializePendingManualEntry); }
