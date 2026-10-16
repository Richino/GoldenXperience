"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { INSTRUMENT_CATALOG, displayNameFor, isKnownInstrument } from "@/lib/instruments/catalog";
import { FILTERS, tradePlansApi, type GenerateResult, type PlanFilter, type TradePlan } from "@/lib/trade-plans/api";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { TradePlanCard } from "./trade-plan-card";
import styles from "./trade-plans.module.css";

const MAJORS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CAD", "USD_CHF", "NZD_USD", "EUR_JPY", "GBP_JPY", "EUR_GBP"];
const SETUP_WORD: Record<string, string> = { BREAKOUT_RETEST: "breakout and retest", SR_REVERSAL: "S/R reversal" };

export function TradePlansView() {
  const [instrument, setInstrument] = useState("EUR_USD");
  const [filter, setFilter] = useState<PlanFilter>("all");
  const [plans, setPlans] = useState<TradePlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [lastRun, setLastRun] = useState<GenerateResult | null>(null);

  // A link can name the pair (the chart's Analyze opens /plans?instrument=EUR_USD).
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("instrument")?.toUpperCase();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requested && isKnownInstrument(requested)) setInstrument(requested);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setPlans(await tradePlansApi.list(filter));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load plans.");
    }
  }, [filter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useForegroundRefresh(refresh);

  const analyze = async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await tradePlansApi.generate(instrument);
      setLastRun(result);
      setFilter("all");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Analysis failed.");
    } finally {
      setGenerating(false);
    }
  };

  const others = INSTRUMENT_CATALOG.filter((item) => !MAJORS.includes(item.name));

  return (
    <div className={styles.view}>
      <PageHeader
        title="Trade plans"
        description="Analyze a pair to get conditional BUY and SELL plans. Nothing is watched or traded until you accept a specific plan."
      />

      <div className={styles.toolbar}>
        <label className="sr-only" htmlFor="plan-pair">Currency pair</label>
        <select id="plan-pair" className={styles.select} value={instrument} onChange={(event) => setInstrument(event.target.value)}>
          <optgroup label="Majors">
            {MAJORS.map((name) => <option key={name} value={name}>{displayNameFor(name)}</option>)}
          </optgroup>
          <optgroup label="Other pairs">
            {others.map((item) => <option key={item.name} value={item.name}>{item.displayName}</option>)}
          </optgroup>
        </select>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={generating} onClick={() => void analyze()}>
          {generating ? "Analyzing…" : "Analyze"}
        </button>
        <p className={styles.toolbarNote}>
          Reads D1, H4, H1 and M15 on completed candles. A new analysis replaces this pair&apos;s plans that are still awaiting approval.
        </p>
      </div>

      {lastRun ? (
        <div className={styles.notice} role="status">
          {lastRun.result === "PLANS"
            ? `${displayNameFor(instrument)}: ${lastRun.planIds.length} plan${lastRun.planIds.length === 1 ? "" : "s"} ready for review.`
            : `${displayNameFor(instrument)}: no valid setup right now.`}
          {lastRun.rejected.length ? (
            <ul>
              {lastRun.rejected.map((item) => (
                <li key={`${item.direction}-${item.setupType}`}>{item.direction} {SETUP_WORD[item.setupType] ?? item.setupType}: {item.reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className={styles.filters} role="toolbar" aria-label="Filter plans">
        {FILTERS.map((item) => (
          <button key={item.id} type="button" className={styles.filter} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {plans === null ? <p className={styles.empty}>Loading plans…</p> : null}
      {plans && !plans.length ? (
        <p className={styles.empty}>
          {filter === "all" ? "No plans yet. Pick a pair and press Analyze." : "No plans in this view."}
        </p>
      ) : null}
      {plans?.length ? (
        <div className={styles.list}>
          {/* Auto execution is enabled per user once risk limits are approved (not built yet). */}
          {plans.map((plan) => <TradePlanCard key={`${plan.id}:${plan.stateVersion}`} plan={plan} autoAvailable={false} onChanged={() => void refresh()} />)}
        </div>
      ) : null}
    </div>
  );
}
