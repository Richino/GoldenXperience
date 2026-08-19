"use client";

import { useCallback, useEffect, useState } from "react";
import { displayNameFor } from "@/lib/instruments/catalog";
import { apiUrl } from "@/lib/api/url";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";

type StrategyRow = {
  instrument: string;
  family: "ema" | "breakout" | "momentum" | "meanrev";
  version: string;
  configVersion: string;
  setupStatus: "valid" | "developing" | "invalid" | "no_setup";
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

function statusTone(status: string) {
  if (status === "valid") return "#16a34a";
  if (status === "developing") return "#2563eb";
  return "var(--muted-foreground, #71717a)";
}

export function MultiStrategyView() {
  const [instruments, setInstruments] = useState<InstrumentRow[] | null>(null);
  const [families, setFamilies] = useState<FamilyStat[]>([]);
  const [experimentLabel, setExperimentLabel] = useState<string | null>(null);
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
      setExperimentLabel(expPayload.experiment?.label ?? null);
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

  if (error) return <p className="text-sm" style={{ color: "#dc2626" }}>{error}</p>;
  if (!instruments) return <p className="text-sm opacity-70">Loading strategies…</p>;

  return (
    <div className="space-y-6">
      {/* Per-family experiment cohort statistics. */}
      <section className="rounded-xl border p-4" style={{ borderColor: "var(--border, #e4e4e7)" }}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Experiment{experimentLabel ? ` · ${experimentLabel}` : ""}</h2>
          <span className="text-xs opacity-60">resolved counts are per strategy</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {FAMILY_ORDER.map((family) => {
            const stat = families.find((item) => item.family === family);
            return (
              <div key={family} className="rounded-lg border p-3" style={{ borderColor: "var(--border, #e4e4e7)" }}>
                <div className="text-sm font-medium">{FAMILY_LABEL[family]}</div>
                <dl className="mt-1 space-y-0.5 text-xs opacity-80">
                  <div className="flex justify-between"><dt>Candidates</dt><dd>{stat?.candidates ?? 0}</dd></div>
                  <div className="flex justify-between"><dt>Executed</dt><dd>{stat?.assigned ?? 0}</dd></div>
                  <div className="flex justify-between"><dt>Suppressed</dt><dd>{stat?.suppressedCandidates ?? 0}</dd></div>
                  <div className="flex justify-between"><dt>Resolved</dt><dd>{stat?.resolved ?? 0}</dd></div>
                  <div className="flex justify-between"><dt>Win rate</dt><dd>{stat?.winRate != null ? `${(stat.winRate * 100).toFixed(0)}%` : "—"}</dd></div>
                  <div className="flex justify-between"><dt>Expectancy</dt><dd>{stat?.expectancyR != null ? `${stat.expectancyR.toFixed(2)}R` : "—"}</dd></div>
                  <div className="flex justify-between opacity-70" style={{ borderTop: "1px dashed var(--border, #e4e4e7)", marginTop: 2, paddingTop: 2 }}><dt>Shadow ({stat?.shadowResolved ?? 0})</dt><dd>{stat?.shadowExpectancyR != null ? `${stat.shadowExpectancyR.toFixed(2)}R` : "—"}</dd></div>
                </dl>
              </div>
            );
          })}
        </div>
      </section>

      {/* Per-instrument: which strategies see a setup, and the adaptive pick. */}
      <div className="space-y-3">
        {instruments.map((row) => (
          <section key={row.instrument} className="rounded-xl border p-4" style={{ borderColor: "var(--border, #e4e4e7)" }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold">{displayNameFor(row.instrument)}</h3>
              <span className="text-xs opacity-70">
                {row.regime ? `${row.regime}` : "regime —"}
                {row.trendStrength != null ? ` · R² ${row.trendStrength.toFixed(2)}` : ""}
                {row.volatilityBucket ? ` · ${row.volatilityBucket} vol` : ""}
                {row.atrPips != null ? ` · ${row.atrPips.toFixed(1)} ATR pips` : ""}
              </span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {FAMILY_ORDER.map((family) => {
                const strat = row.strategies.find((item) => item.family === family);
                const status = strat?.setupStatus ?? "no_setup";
                return (
                  <div key={family} className="rounded-lg border p-2.5 text-sm" style={{ borderColor: strat?.selected ? "#16a34a" : "var(--border, #e4e4e7)", borderWidth: strat?.selected ? 2 : 1 }}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{FAMILY_LABEL[family]}</span>
                      {strat?.selected ? <span className="text-xs font-semibold" style={{ color: "#16a34a" }}>SELECTED</span> : null}
                    </div>
                    <div className="mt-1 text-xs" style={{ color: statusTone(status) }}>
                      {status === "valid" ? `VALID ${strat?.direction === "long" ? "LONG" : "SHORT"}` : status === "no_setup" ? "No setup" : status.toUpperCase()}
                    </div>
                    {strat?.setupStatus === "valid" && strat.riskReward != null ? (
                      <div className="mt-0.5 text-xs opacity-60">{strat.riskReward.toFixed(1)}R · {strat.version}</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 text-xs">
              <span className="font-medium">Adaptive Engine: </span>
              {row.adaptive ? (
                <span className="opacity-80">
                  <span style={{ textTransform: "uppercase" }}>{row.adaptive.adaptiveState.replace("_", " ")}</span>
                  {" — "}
                  {row.adaptive.selected ? `SELECTED → ${FAMILY_LABEL[row.adaptive.selected.family] ?? row.adaptive.selected.family} ${row.adaptive.selected.direction}` : "NONE"}
                  <span className="block opacity-60">{row.adaptive.reason}</span>
                </span>
              ) : <span className="opacity-60">No decision yet.</span>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
