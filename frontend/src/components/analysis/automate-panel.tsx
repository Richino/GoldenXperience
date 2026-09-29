"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Crosshair } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import type { MajorInstrument } from "@/types/forex";

type AutomationMode = "alert" | "auto";
type WatchState = "NO_PLAN" | "WAITING" | "AT_LEVEL" | "CONFIRMED" | "INVALIDATED";
type AutomateSignal = {
  id: string;
  mode: AutomationMode;
  confirmation: "REJECTION" | "SWEEP";
  direction: "long" | "short";
  candleTime: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  spreadPips: number;
  status: "ALERTED" | "PLACED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "SKIPPED" | "FAILED";
  reason: string;
  expiresAt: string;
  createdAt: string;
};
type AutomateSnapshot = {
  automation: { enabled: boolean; mode: AutomationMode; lastCheckedAt: string | null };
  watch: {
    state: WatchState;
    direction: "long" | "short" | null;
    level: number | null;
    zoneNear: number | null;
    zoneFar: number | null;
    counterTrend: boolean;
    rewardRisk: number | null;
    reason: string;
    trend: string | null;
  } | null;
  signals: AutomateSignal[];
};

const STATE_LABEL: Record<WatchState, string> = {
  NO_PLAN: "No plan",
  WAITING: "Waiting for the level",
  AT_LEVEL: "At the level · waiting for confirmation",
  CONFIRMED: "Confirmed",
  INVALIDATED: "Level broken",
};

/** An alert is actionable while it is ALERTED and not past its expiry. */
function openAlert(snapshot: AutomateSnapshot | null) {
  return snapshot?.signals.find((signal) => signal.status === "ALERTED" && Date.parse(signal.expiresAt) > Date.now()) ?? null;
}

async function readJson<T>(response: Response) {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Request failed.");
  return payload;
}

/**
 * Automate: switch the server watch on for this pair. It keeps the trend and
 * pullback level current and, on a rejection or liquidity-sweep candle, either
 * alerts (Accept / Reject here) or places the practice order itself.
 */
export function AutomateButton({ instrument, className, onPlaced }: { instrument: MajorInstrument; className?: string; onPlaced?: () => void }) {
  const [open, setOpen] = useState(false);
  // Tagged with its pair so switching pairs never shows the previous pair's read.
  const [loaded, setLoaded] = useState<{ instrument: MajorInstrument; data: AutomateSnapshot } | null>(null);
  const snapshot = loaded?.instrument === instrument ? loaded.data : null;
  const setSnapshot = useCallback((data: AutomateSnapshot) => setLoaded({ instrument, data }), [instrument]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(apiUrl(`/api/automate?instrument=${instrument}`), { credentials: "include", cache: "no-store" });
      setSnapshot(await readJson<AutomateSnapshot>(response));
    } catch {
      // Keep the last read; the next poll retries.
    }
  }, [instrument, setSnapshot]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), open ? 15_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const save = async (enabled: boolean, mode: AutomationMode) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(apiUrl("/api/automate"), {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument, enabled, mode }),
      });
      setSnapshot(await readJson<AutomateSnapshot>(response));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save.");
    } finally { setBusy(false); }
  };

  const act = async (signal: AutomateSignal, action: "accept" | "reject") => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(apiUrl(`/api/automate/signals/${signal.id}/${action}`), { method: "POST", credentials: "include" });
      await readJson(response);
      if (action === "accept") onPlaced?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not act on the signal.");
    } finally { setBusy(false); void refresh(); }
  };

  const enabled = snapshot?.automation.enabled ?? false;
  const alert = openAlert(snapshot);
  return <>
    <button
      type="button"
      className={`${className ?? ""} gx-automate-btn${enabled ? " is-on" : ""}${alert ? " has-alert" : ""}`}
      onClick={() => setOpen(true)}
      title={enabled ? "Automate is watching this pair" : "Automate pullback confirmation"}
      aria-label={alert ? "Automate: signal waiting" : enabled ? "Automate is on" : "Automate"}
    >
      <Crosshair className="size-3.5" /><span className="gx-automate-label">Automate</span>
      {alert ? <span className="gx-automate-dot" aria-hidden="true" /> : enabled ? <span className="gx-automate-on" aria-hidden="true" /> : null}
    </button>
    {open ? <AutomateSheet instrument={instrument} snapshot={snapshot} busy={busy} error={error} alert={alert} onClose={() => setOpen(false)} onSave={save} onAct={act} /> : null}
  </>;
}

function AutomateSheet({ instrument, snapshot, busy, error, alert, onClose, onSave, onAct }: {
  instrument: MajorInstrument;
  snapshot: AutomateSnapshot | null;
  busy: boolean;
  error: string | null;
  alert: AutomateSignal | null;
  onClose: () => void;
  onSave: (enabled: boolean, mode: AutomationMode) => void;
  onAct: (signal: AutomateSignal, action: "accept" | "reject") => void;
}) {
  const { setSheet, setBackdrop, handlers, requestClose } = useDragToDismiss({ open: true, onDismiss: onClose, handleSelector: ".tp-grip, .tp-head" });
  const format = (price: number | null) => price === null ? "—" : formatChartPrice(price, instrument);
  const enabled = snapshot?.automation.enabled ?? false;
  const mode = snapshot?.automation.mode ?? "alert";
  const watch = snapshot?.watch ?? null;
  const pair = instrument.replace("_", "/");
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const history = (snapshot?.signals ?? []).filter((signal) => signal.id !== alert?.id).slice(0, 5);

  return createPortal(
    <div ref={setBackdrop} className="tp-backdrop fixed inset-0 z-[10000] flex items-center justify-center p-4" data-pull-to-refresh-ignore="true" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section className="tp-sheet gx-automate-sheet max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-labelledby="automate-title" ref={setSheet} {...handlers}>
        <div className="tp-grip" aria-hidden="true" />
        <header className="tp-head flex items-start justify-between gap-4">
          <div>
            <p className="tp-eyebrow text-xs font-semibold uppercase tracking-wide text-emerald-600">Automate · {pair} · M15</p>
            <h2 id="automate-title" className="tp-title mt-1 text-xl font-semibold">{enabled ? "Watching this pair" : "Automate is off"}</h2>
          </div>
          <button type="button" onClick={requestClose} className="tp-close rounded-lg px-2 py-1 text-xl" aria-label="Close automate">×</button>
        </header>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-zinc-100 p-3 dark:bg-zinc-900">
          <div className="text-sm leading-5">
            <p className="font-semibold">Watch pullback confirmation</p>
            <p className="text-xs text-zinc-500">Rejection or liquidity sweep at the level, checked every completed M15 candle, also while the app is closed.</p>
          </div>
          <button type="button" role="switch" aria-checked={enabled} disabled={busy || !snapshot} onClick={() => onSave(!enabled, mode)} className={`gx-switch${enabled ? " is-on" : ""}`}><span /></button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="When confirmed">
          {(["alert", "auto"] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={busy || !snapshot} onClick={() => onSave(enabled, value)}
              className={`gx-automate-mode rounded-xl border p-3 text-left ${mode === value ? "is-active border-emerald-500" : "border-zinc-200 dark:border-zinc-800"}`}>
              <span className="block text-sm font-semibold">{value === "alert" ? "Alert me" : "Place it"}</span>
              <span className="mt-0.5 block text-xs text-zinc-500">{value === "alert" ? "Notify, I accept or reject" : "Send the practice order"}</span>
            </button>
          ))}
        </div>

        {alert ? (
          <div className="gx-automate-alert mt-4 rounded-2xl border border-emerald-500/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">{alert.confirmation === "SWEEP" ? "Sweep" : "Rejection"} confirmed · expires {time(alert.expiresAt)}</p>
            <p className={`mt-1 text-2xl font-bold ${alert.direction === "long" ? "text-emerald-600" : "text-rose-600"}`}>{alert.direction === "long" ? "LONG" : "SHORT"} at market</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 font-mono text-sm">
              <div><dt className="text-[11px] font-sans font-semibold uppercase text-zinc-500">Entry ≈</dt><dd>{format(alert.entryPrice)}</dd></div>
              <div><dt className="text-[11px] font-sans font-semibold uppercase text-rose-600">Stop</dt><dd>{format(alert.stopPrice)}</dd></div>
              <div><dt className="text-[11px] font-sans font-semibold uppercase text-sky-600">Target</dt><dd>{format(alert.targetPrice)}</dd></div>
            </dl>
            <p className="mt-2 text-xs leading-5 text-zinc-500">{alert.reason} Entry is re-priced at the live quote when you accept.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy} onClick={() => onAct(alert, "reject")} className="tp-reject min-h-11 flex-1 rounded-xl border border-rose-200 px-4 font-medium text-rose-700 dark:border-rose-900 dark:text-rose-300">Reject</button>
              <button type="button" disabled={busy} onClick={() => onAct(alert, "accept")} className="tp-accept min-h-11 flex-1 rounded-xl bg-emerald-600 px-4 font-semibold text-white">Accept</button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 rounded-2xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Now</p>
          {watch ? <>
            <p className="mt-1 font-semibold">{STATE_LABEL[watch.state]}</p>
            {watch.direction && watch.level !== null ? (
              <p className="mt-1 text-zinc-600 dark:text-zinc-300">
                {watch.direction === "long" ? "Long at support" : "Short at resistance"} {format(watch.level)} · zone to {format(watch.zoneFar)} · {watch.rewardRisk}:1{watch.counterTrend ? " · against 1H/4H" : ""}
              </p>
            ) : null}
            <p className="mt-1 text-xs leading-5 text-zinc-500">{watch.reason}</p>
            {snapshot?.automation.lastCheckedAt ? <p className="mt-1 text-xs text-zinc-400">Checked {time(snapshot.automation.lastCheckedAt)}</p> : null}
          </> : <p className="mt-1 text-zinc-500">{enabled ? "First check runs within a minute." : "Turn it on to start watching."}</p>}
        </div>

        {history.length ? (
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Recent signals</p>
            <ul className="mt-2 space-y-2">
              {history.map((signal) => (
                <li key={signal.id} className="rounded-xl bg-zinc-100 p-3 text-xs leading-5 dark:bg-zinc-900">
                  <p className="font-semibold">{time(signal.createdAt)} · {signal.direction === "long" ? "Long" : "Short"} {signal.confirmation.toLowerCase()} · <span className="uppercase">{signal.status.toLowerCase()}</span></p>
                  <p className="text-zinc-500">{signal.reason}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-rose-600" role="alert">{error}</p> : null}
        <p className="mt-4 text-[11px] leading-4 text-zinc-400">Not backtested. Skips when the spread is over 10% of the stop or high-impact news is within 30 min. Auto orders are practice-account only and never replace a trade you already have on this pair.</p>
      </section>
    </div>, document.body,
  );
}
