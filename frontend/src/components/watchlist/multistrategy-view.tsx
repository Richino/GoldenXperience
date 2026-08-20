"use client";

import { useCallback, useEffect, useState } from "react";
import { displayNameFor } from "@/lib/instruments/catalog";
import { apiUrl } from "@/lib/api/url";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { StrategiesWatchlistSkeleton } from "@/components/ui/page-skeletons";

type SetupStatus = "valid" | "developing" | "invalid" | "no_setup";

type StrategyRow = {
  instrument: string;
  family: "ema" | "breakout" | "momentum" | "meanrev";
  version: string;
  configVersion: string;
  setupStatus: SetupStatus;
  direction: "long" | "short" | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  selected: boolean;
};

type InstrumentRow = {
  instrument: string;
  session: string;
  dataStatus: string;
  regime: string | null;
  trendStrength: number | null;
  volatilityBucket: string | null;
  atrPips: number | null;
  strategies: StrategyRow[];
  adaptive: { adaptiveState: string; reason: string; selected: { family: string; direction: string } | null } | null;
};

type FamilyStat = {
  family: string;
  assigned: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancyR: number | null;
  averageR: number | null;
  candidates: number;
  selectedCandidates: number;
  suppressedCandidates: number;
  shadowResolved: number;
  shadowWinRate: number | null;
  shadowExpectancyR: number | null;
};

const FAMILY_LABEL: Record<string, string> = { ema: "EMA", breakout: "Breakout", momentum: "Momentum", meanrev: "Mean Reversion" };
const FAMILY_ORDER = ["ema", "breakout", "momentum", "meanrev"] as const;

function setupLabel(status: SetupStatus, direction: "long" | "short" | null) {
  switch (status) {
    case "valid":
      return direction === "short" ? "Valid short" : "Valid long";
    case "developing":
      return "Developing";
    case "invalid":
      return "Invalid";
    case "no_setup":
      return "No setup";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function setupTone(status: SetupStatus) {
  switch (status) {
    case "valid":
      return "is-valid";
    case "developing":
      return "is-developing";
    case "invalid":
      return "is-muted";
    case "no_setup":
      return "is-muted";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function signedR(value: number | null) {
  if (value == null) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}R`;
}

function rTone(value: number | null) {
  if (value == null) return "";
  if (value > 0) return "is-win";
  if (value < 0) return "is-loss";
  return "";
}

function rateTone(value: number | null) {
  if (value == null) return "";
  if (value > 0.5) return "is-win";
  if (value < 0.5) return "is-loss";
  return "";
}

function percent(value: number | null) {
  if (value == null) return "—";
  return `${(value * 100).toFixed(0)}%`;
}

function adaptiveStateLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function MultiStrategyView() {
  const [instruments, setInstruments] = useState<InstrumentRow[] | null>(null);
  const [families, setFamilies] = useState<FamilyStat[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [watch, experiment] = await Promise.all([
        fetch(apiUrl("/api/multistrategy/watchlist"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/multistrategy/experiment"), { credentials: "include", cache: "no-store" }),
      ]);
      const watchPayload = await watch.json() as { instruments?: InstrumentRow[]; error?: string };
      if (!watch.ok || !watchPayload.instruments) throw new Error(watchPayload.error ?? "Multi-strategy watchlist is unavailable.");
      setInstruments(watchPayload.instruments);
      const expPayload = await experiment.json() as { experiment?: { label: string } | null; families?: FamilyStat[] };
      setFamilies(expPayload.families ?? []);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Multi-strategy view is unavailable.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useForegroundRefresh(load);

  return (
    <div className="ms-view space-y-8 lg:space-y-10">
      <header>
        <h1 className="text-display">Strategies</h1>
      </header>

      {error ? <p className="research-error">{error}</p> : null}

      {!instruments && !error ? (
        <StrategiesWatchlistSkeleton />
      ) : instruments ? (
        <>
      <section className="dashboard-minimal-section" aria-label="Strategy cohort">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">Cohort</h2>
        <div className="ms-family-list mt-3">
          {FAMILY_ORDER.map((family) => {
            const stat = families.find((item) => item.family === family);
            const winRate = stat?.winRate ?? null;
            const expectancy = stat?.expectancyR ?? null;
            return (
              <article key={family} className="ms-family-card">
                <div className="ms-family-head">
                  <div className="min-w-0">
                    <p className="ms-family-name">{FAMILY_LABEL[family]}</p>
                    <p className="ms-family-record metric-number">
                      {stat?.wins ?? 0}W · {stat?.losses ?? 0}L
                      <span className="ms-family-sep"> · </span>
                      {stat?.assigned ?? 0} executed
                    </p>
                  </div>
                  <div className="ms-family-hero">
                    <p className={`ms-family-rate metric-number ${rateTone(winRate)}`}>{percent(winRate)}</p>
                    <p className={`ms-family-expectancy metric-number ${rTone(expectancy)}`}>{signedR(expectancy)}</p>
                  </div>
                </div>
                <p className="ms-family-shadow metric-number">
                  Shadow {signedR(stat?.shadowExpectancyR ?? null)}
                  {stat?.shadowResolved ? ` · ${stat.shadowResolved}` : ""}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="dashboard-minimal-section" aria-label="Pairs">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Pairs</h2>
          <p className="metric-number text-xs text-[color:var(--muted)]">{instruments.length || "—"}</p>
        </div>
          <div className="ms-pair-list mt-3">
            {instruments.map((row) => (
              <article key={row.instrument} className="ms-pair-card">
                <div className="ms-pair-head">
                  <h3 className="ms-pair-name">{displayNameFor(row.instrument)}</h3>
                  <p className="ms-pair-meta">
                    {row.regime ?? "No regime"}
                    {row.volatilityBucket ? ` · ${row.volatilityBucket} vol` : ""}
                    {row.atrPips != null ? ` · ${row.atrPips.toFixed(1)} ATR` : ""}
                  </p>
                </div>
                <div className="ms-setup-grid">
                  {FAMILY_ORDER.map((family) => {
                    const strat = row.strategies.find((item) => item.family === family);
                    const status = strat?.setupStatus ?? "no_setup";
                    return (
                      <div
                        key={family}
                        className={`ms-setup ${setupTone(status)} ${strat?.selected ? "is-selected" : ""}`}
                      >
                        <div className="ms-setup-top">
                          <span className="ms-setup-family">{FAMILY_LABEL[family]}</span>
                          {strat?.selected ? <span className="ms-setup-pick">Pick</span> : null}
                        </div>
                        <p className="ms-setup-status">{setupLabel(status, strat?.direction ?? null)}</p>
                        {status === "valid" && strat?.riskReward != null ? (
                          <p className="ms-setup-plan metric-number">{strat.riskReward.toFixed(1)}R</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <p className="ms-adaptive">
                  {row.adaptive ? (
                    <>
                      <span className="ms-adaptive-state">{adaptiveStateLabel(row.adaptive.adaptiveState)}</span>
                      {row.adaptive.selected
                        ? ` · ${FAMILY_LABEL[row.adaptive.selected.family] ?? row.adaptive.selected.family} ${row.adaptive.selected.direction}`
                        : " · none"}
                      {row.adaptive.reason ? <span className="ms-adaptive-reason"> · {row.adaptive.reason}</span> : null}
                    </>
                  ) : (
                    "No adaptive decision yet"
                  )}
                </p>
              </article>
            ))}
          </div>
      </section>
        </>
      ) : null}
    </div>
  );
}
