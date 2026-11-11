"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import type {
  TradeHealthStatus,
  TradeMonitorDebug,
} from "@/lib/strategy/trade-monitor";

type MonitorResponse =
  | { monitored: false; reason: string }
  | {
      monitored: true;
      tradeId: string | null;
      health: {
        status: TradeHealthStatus;
        score: number;
        reason: string;
        unrealizedR: number;
        factors: Array<{ name: string; contribution: number; note: string }>;
        debug: TradeMonitorDebug;
      };
    };

/** Poll cadence: M15 candles complete every 15m, so a minute is plenty. */
const POLL_MS = 60_000;

function humanize(value: string) {
  const lower = value.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function statusTone(status: TradeHealthStatus) {
  return status === "HOLD" ? "up" : status === "WARNING" ? "warn" : "down";
}

/**
 * Concise live trade-health readout for the active manual trade. Polls the
 * deterministic Stage 5 monitor; it never closes or modifies the position.
 */
export function TradeHealthPanel({ instrument, active }: { instrument: string; active: boolean }) {
  const [data, setData] = useState<MonitorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(apiUrl(`/api/trade-monitor?instrument=${instrument}`), {
          credentials: "include",
          cache: "no-store",
        });
        const payload = (await response.json()) as MonitorResponse & { error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.error ?? "Monitoring unavailable.");
          return;
        }
        setError(null);
        setData(payload);
      } catch {
        if (!cancelled) setError("Monitoring unavailable.");
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [instrument, active]);

  if (!active) return null;
  if (error) return <div className="trade-health is-muted"><span className="trade-health-title">Trade health</span><p>{error}</p></div>;
  if (!data) return <div className="trade-health is-muted"><span className="trade-health-title">Trade health</span><p>Checking…</p></div>;
  if (!data.monitored) {
    return (
      <div className="trade-health is-muted">
        <span className="trade-health-title">Trade health</span>
        <p>{data.reason}</p>
      </div>
    );
  }

  const { status, unrealizedR, reason, debug } = data.health;
  const newSr = debug.newOpposingStructure;
  const momentum = debug.currentImpulse === "NO_IMPULSE" ? "Flat" : humanize(debug.currentImpulse.replace("_IMPULSE", ""));
  const rLabel = `${unrealizedR > 0 ? "+" : ""}${unrealizedR}R`;

  return (
    <div className="trade-health" data-status={status}>
      <header>
        <div>
          <span className="trade-health-title">Trade health</span>
          <strong>{debug.direction.toUpperCase()} {displayNameFor(instrument)}</strong>
        </div>
        <span className={`trade-health-status is-${statusTone(status)}`}>{humanize(status)}</span>
      </header>
      <div className="trade-health-r" data-sign={unrealizedR >= 0 ? "pos" : "neg"}>{rLabel}</div>
      <dl>
        <div><dt>Structure</dt><dd>{debug.structureFailed ? "Failed" : "Intact"}</dd></div>
        <div><dt>Momentum</dt><dd>{momentum}</dd></div>
        <div><dt>New S/R</dt><dd>{newSr === null ? "None" : formatChartPrice(newSr, instrument)}</dd></div>
      </dl>
      <p className="trade-health-reason">{reason}</p>

      <details className="manual-proposal-debug">
        <summary>Monitor detail</summary>
        <dl>
          <div><dt>Health score</dt><dd>{debug.healthScore}</dd></div>
          <div><dt>Current R</dt><dd>{rLabel}</dd></div>
          <div><dt>To TP</dt><dd>{debug.distanceToTpPips.toFixed(1)} pips</dd></div>
          <div><dt>To SL</dt><dd>{debug.distanceToSlPips.toFixed(1)} pips</dd></div>
          <div><dt>Market (entry→now)</dt><dd>{humanize(debug.originalMarketCondition)} → {humanize(debug.currentMarketCondition)}</dd></div>
          <div><dt>S/R migration</dt><dd>{humanize(debug.srMigration)}</dd></div>
          <div><dt>Support (entry→now)</dt><dd>{formatChartPrice(debug.originalSupport, instrument)} → {formatChartPrice(debug.currentSupport, instrument)}</dd></div>
          <div><dt>Resistance (entry→now)</dt><dd>{formatChartPrice(debug.originalResistance, instrument)} → {formatChartPrice(debug.currentResistance, instrument)}</dd></div>
          <div><dt>Interaction</dt><dd>{humanize(debug.currentInteraction)}</dd></div>
          <div><dt>Acceptance</dt><dd>{humanize(debug.currentAcceptance)}</dd></div>
          <div><dt>Setup</dt><dd>{humanize(debug.originalSetup)}</dd></div>
        </dl>
        {debug.factors.length ? (
          <ul className="trade-health-factors">
            {debug.factors.map((factor) => (
              <li key={factor.name} data-sign={factor.contribution >= 0 ? "pos" : "neg"}>
                <span>{factor.contribution >= 0 ? "+" : ""}{factor.contribution}</span> {factor.note}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </div>
  );
}
