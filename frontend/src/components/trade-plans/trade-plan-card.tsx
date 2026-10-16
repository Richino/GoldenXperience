"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Ban, CheckCircle2, Circle, Pause, Play, XCircle } from "lucide-react";
import { displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import {
  CANCELLABLE,
  EDITABLE,
  SETUP_LABEL,
  STATUS_LABEL,
  tradePlansApi,
  type ConditionStatus,
  type MonitoringMode,
  type PlanDetail,
  type TradePlan,
} from "@/lib/trade-plans/api";
import styles from "./trade-plans.module.css";

const LIVE = new Set(["APPROVED", "MONITORING", "EXECUTION_PENDING", "ORDER_SUBMITTED", "PARTIALLY_FILLED", "FILLED"]);
const READY = new Set(["PENDING_APPROVAL", "CONFIRMED", "NOTIFIED"]);

function statusClass(plan: TradePlan) {
  if (LIVE.has(plan.status)) return `${styles.status} ${styles.statusLive}`;
  if (READY.has(plan.status)) return `${styles.status} ${styles.statusReady}`;
  return `${styles.status} ${styles.statusEnded}`;
}

function timeLeft(expiresAt: string, now: number) {
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function ConditionIcon({ status }: { status: ConditionStatus }) {
  const props = { className: `size-4 ${styles.checkIcon}`, "aria-hidden": true } as const;
  if (status === "PASSED") return <CheckCircle2 {...props} className={`${props.className} ${styles.passed}`} />;
  if (status === "FAILED") return <XCircle {...props} className={`${props.className} ${styles.failed}`} />;
  if (status === "BLOCKED") return <Ban {...props} className={`${props.className} ${styles.blocked}`} />;
  return <Circle {...props} className={`${props.className} ${styles.pending}`} />;
}

const CONDITION_WORD: Record<ConditionStatus, string> = { PASSED: "passed", FAILED: "failed", BLOCKED: "blocked", PENDING: "waiting" };

type Panel = null | "accept" | "edit" | "cancel" | "reject";

export function TradePlanCard({
  plan,
  autoAvailable,
  onChanged,
}: {
  plan: TradePlan;
  /** Auto execution needs approved risk limits; until then only Notify can be chosen. */
  autoAvailable: boolean;
  onChanged: () => void;
}) {
  const digits = precisionFor(plan.instrument);
  const price = (value: number | null) => (value === null ? "—" : value.toFixed(digits));
  const [panel, setPanel] = useState<Panel>(null);
  const [mode, setMode] = useState<MonitoringMode>("NOTIFY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [risk, setRisk] = useState(String(plan.maxRiskPercent));
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      setPanel(null);
      setDetail(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const loadHistory = async () => {
    if (detail) return;
    try {
      setDetail(await tradePlansApi.get(plan.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the history.");
    }
  };

  // Condition rows carry the monitor's progress and reasons; before it has run they are labels only,
  // and the full wording of each rule is under "Why GX made this plan".
  const checklist = plan.conditions;
  const proposal = plan.monitorState?.proposal ?? null;
  const awaiting = plan.status === "PENDING_APPROVAL";
  const monitoring = plan.status === "MONITORING";
  const paused = Boolean(plan.pausedAt);

  return (
    <article className={styles.card} aria-label={`${displayNameFor(plan.instrument)} ${plan.direction} plan`}>
      <header className={styles.cardHead}>
        <div className={styles.ident}>
          <span className={styles.pair}>{displayNameFor(plan.instrument)}</span>
          <span className={`${styles.side} ${plan.direction === "BUY" ? styles.buy : styles.sell}`}>{plan.direction}</span>
        </div>
        <span className={statusClass(plan)}>
          {paused ? "Paused" : STATUS_LABEL[plan.status]}
          {plan.monitoringMode && !awaiting ? ` · ${plan.monitoringMode === "AUTO" ? "Auto" : "Notify"}` : ""}
        </span>
      </header>
      <p className={styles.meta}>
        {SETUP_LABEL[plan.setupType]} · {plan.timeframe} setup, M15 entry · Bias {plan.marketBias.toLowerCase()} · v{plan.planVersion}
        {" · "}
        {LIVE.has(plan.status) || awaiting || READY.has(plan.status) ? timeLeft(plan.expiresAt, now) : `ended ${clock(plan.updatedAt)}`}
      </p>

      <dl className={styles.levels}>
        <div><dt>Entry zone</dt><dd>{price(plan.entryZoneLow)}–{price(plan.entryZoneHigh)}</dd></div>
        <div><dt>Stop loss</dt><dd>{price(plan.stopLoss)}</dd></div>
        <div><dt>Take profit</dt><dd>{price(plan.takeProfit)}</dd></div>
        <div><dt>Reward/risk</dt><dd>{plan.rewardRisk?.toFixed(2) ?? "—"} · {plan.maxRiskPercent}%</dd></div>
      </dl>

      <div>
        <h3 className={styles.sectionTitle}>Confirmation checklist</h3>
        <ul className={styles.checklist}>
          {checklist.map((item) => (
            <li key={item.key} className={styles.check}>
              <ConditionIcon status={item.status} />
              <span>
                <span className="sr-only">{CONDITION_WORD[item.status]}: </span>
                {item.label}
                {item.detail ? <small>{item.detail}</small> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {plan.notTriggeredReason && !proposal ? <p className={styles.waiting}>{plan.notTriggeredReason}</p> : null}
      {proposal && (plan.status === "CONFIRMED" || plan.status === "NOTIFIED") ? (
        <p className={styles.proposal}>
          Confirmed {clock(proposal.confirmedAt)}: {proposal.side} near {price(proposal.entry)}, stop {price(proposal.stopLoss)},
          target {price(proposal.takeProfit)}, reward/risk {proposal.rewardRisk.toFixed(2)}
          {proposal.spread !== null ? `, spread ${price(proposal.spread)}` : ""}.
          {plan.monitoringMode === "NOTIFY" ? " No order has been placed — the trade is your call." : ""}
        </p>
      ) : null}

      {plan.lastEvaluatedAt || plan.lastPrice !== null ? (
        <p className={styles.monitor}>
          {plan.lastPrice !== null ? <span>Price {price(plan.lastPrice)}</span> : null}
          {plan.lastEvaluatedAt ? <span>Last checked {clock(plan.lastEvaluatedAt)}</span> : null}
          {plan.monitorStage ? <span>{plan.monitorStage.replaceAll("_", " ").toLowerCase()}</span> : null}
        </p>
      ) : null}

      <details className={styles.details}>
        <summary>Why GX made this plan</summary>
        <ul>{(plan.plan.explanation ?? []).map((line) => <li key={line}>{line}</li>)}</ul>
        <dl className={styles.rules}>
          {plan.plan.entryTrigger ? <div><dt>Entry trigger</dt><dd>{plan.plan.entryTrigger}</dd></div> : null}
          {plan.plan.confirmation?.length ? (
            <div><dt>Required confirmations</dt><dd><ol style={{ margin: 0, paddingLeft: "1.1rem" }}>{plan.plan.confirmation.map((line) => <li key={line}>{line}</li>)}</ol></dd></div>
          ) : null}
          {plan.plan.stopLossRule ? <div><dt>Stop loss</dt><dd>{plan.plan.stopLossRule}</dd></div> : null}
          {plan.plan.takeProfitRule ? <div><dt>Take profit</dt><dd>{plan.plan.takeProfitRule}</dd></div> : null}
          {plan.plan.positionSizingRule ? <div><dt>Position size</dt><dd>{plan.plan.positionSizingRule}</dd></div> : null}
          {plan.plan.spreadSlippage?.rule ? <div><dt>Spread and slippage</dt><dd>{plan.plan.spreadSlippage.rule}</dd></div> : null}
          {plan.plan.newsRestrictions?.rule ? (
            <div>
              <dt>News</dt>
              <dd>
                {plan.plan.newsRestrictions.rule}
                {plan.plan.newsRestrictions.upcomingHighImpact?.length
                  ? ` Upcoming: ${plan.plan.newsRestrictions.upcomingHighImpact.map((event) => `${event.currency} ${event.title} ${clock(event.at)}`).join("; ")}.`
                  : ""}
              </dd>
            </div>
          ) : null}
          {plan.plan.invalidation?.rules?.length ? <div><dt>Invalidated if</dt><dd>{plan.plan.invalidation.rules.join(" ")}</dd></div> : null}
          {plan.plan.expiryRule ? <div><dt>Expiry</dt><dd>{plan.plan.expiryRule}</dd></div> : null}
        </dl>
      </details>

      <details className={styles.details} onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) void loadHistory(); }}>
        <summary>History</summary>
        {detail ? (
          <ol className={styles.timeline}>
            {detail.events.map((event) => (
              <li key={event.id}>
                <time dateTime={event.createdAt}>{clock(event.createdAt)}</time>
                <span>
                  {event.to && event.from !== event.to ? `${STATUS_LABEL[event.to]} — ` : ""}
                  {event.reason}
                  {event.actor !== "user" ? ` (${event.actor})` : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : <p className={styles.meta}>Loading…</p>}
      </details>

      {panel === "accept" ? (
        <div className={styles.panel}>
          <p>Approve version {plan.planVersion} exactly as shown. GX will only act on this version; any edit needs a new approval.</p>
          <div className={styles.modes} role="radiogroup" aria-label="Monitoring mode">
            <label className={styles.mode}>
              <input type="radio" name={`mode-${plan.id}`} checked={mode === "NOTIFY"} onChange={() => setMode("NOTIFY")} />
              <span>Notify me<small>GX watches the setup and alerts you when every condition is met. No order is sent.</small></span>
            </label>
            <label className={styles.mode} data-disabled={!autoAvailable}>
              <input type="radio" name={`mode-${plan.id}`} checked={mode === "AUTO"} disabled={!autoAvailable} onChange={() => setMode("AUTO")} />
              <span>
                Auto execute (practice account)
                <small>{autoAvailable
                  ? "GX places the trade on your OANDA practice account only after every confirmation and risk check passes."
                  : "Not available yet: automatic execution needs your approved risk limits first."}</small>
              </span>
            </label>
          </div>
          <div className={styles.actions}>
            <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy}
              onClick={() => act(() => tradePlansApi.approve(plan.id, plan.planVersion, mode))}>
              {busy ? "Approving…" : `Approve and start ${mode === "AUTO" ? "auto execution" : "monitoring"}`}
            </button>
            <button type="button" className={styles.button} onClick={() => setPanel(null)}>Back</button>
          </div>
        </div>
      ) : null}

      {panel === "edit" ? (
        <div className={styles.panel}>
          <p>Only risk and expiry can be changed; the levels and rules come from the analysis. Saving makes a new version{awaiting ? "" : " and stops monitoring until you approve it again"}.</p>
          <label className={styles.field}>
            Risk per trade (%)
            <input type="number" inputMode="decimal" min="0.1" max="5" step="0.1" value={risk} onChange={(event) => setRisk(event.target.value)} />
          </label>
          <label className={styles.field}>
            Expire earlier (optional)
            <input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
            <small>Currently {clock(plan.expiresAt)}. A plan can only be shortened.</small>
          </label>
          <div className={styles.actions}>
            <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy}
              onClick={() => act(() => tradePlansApi.edit(plan.id, {
                maxRiskPercent: Number(risk),
                ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}),
              }))}>
              {busy ? "Saving…" : "Save new version"}
            </button>
            <button type="button" className={styles.button} onClick={() => setPanel(null)}>Back</button>
          </div>
        </div>
      ) : null}

      {panel === "cancel" || panel === "reject" ? (
        <div className={styles.panel}>
          <p>
            {panel === "cancel"
              ? "Stop monitoring this plan. Any open position would stay open; this only cancels the plan."
              : "Reject this plan. GX will not monitor or act on it."}
          </p>
          <label className={styles.field}>
            Reason (optional)
            <input value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className={styles.actions}>
            <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy}
              onClick={() => act(() => panel === "cancel" ? tradePlansApi.cancel(plan.id, reason) : tradePlansApi.reject(plan.id, reason))}>
              {busy ? "Saving…" : panel === "cancel" ? "Cancel plan" : "Reject plan"}
            </button>
            <button type="button" className={styles.button} onClick={() => setPanel(null)}>Back</button>
          </div>
        </div>
      ) : null}

      {panel === null ? (
        <div className={styles.actions}>
          {awaiting ? (
            <>
              <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => setPanel("accept")}>Accept</button>
              <button type="button" className={styles.button} onClick={() => setPanel("reject")}>Reject</button>
            </>
          ) : null}
          {EDITABLE.has(plan.status) ? <button type="button" className={styles.button} onClick={() => setPanel("edit")}>Edit</button> : null}
          {monitoring ? (
            <button type="button" className={styles.button} disabled={busy}
              onClick={() => act(() => paused ? tradePlansApi.resume(plan.id) : tradePlansApi.pause(plan.id))}>
              {paused ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </button>
          ) : null}
          {CANCELLABLE.has(plan.status) ? <button type="button" className={`${styles.button} ${styles.danger}`} onClick={() => setPanel("cancel")}>Cancel</button> : null}
          <Link href={`/chart?instrument=${plan.instrument}`} className={styles.button}>Chart</Link>
        </div>
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </article>
  );
}
