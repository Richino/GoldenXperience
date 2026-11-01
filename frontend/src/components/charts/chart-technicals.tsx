"use client";

/**
 * GX Technical Analyzer, cut down for the Chart page: the indicator votes per
 * timeframe and the 1–5 day outlook. Everything else the analyzer shows
 * (interpretation, evidence, invalidation, zones, data quality) stays out of
 * the panel and travels in "Copy for ChatGPT", the same report the full page
 * copies.
 *
 * Opening the panel issues nothing: it shows this pair's latest report from
 * history when one is still current, and Analyze runs a new one (which, as on
 * the analyzer page, records a forecast).
 */

import { useEffect, useMemo, useState } from "react";
import { Copy, RotateCw, X } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";
import { recordedReadings, technicalSummary } from "@/lib/technical-analyzer/ratings";
import { conciseMarketReport, copyReport } from "@/lib/technical-analyzer/report";
import { continuationRiskLabel, outlookDirection, outlookEvidence } from "@/lib/technical-analyzer/outlook";
import type { Forecast, Frame, History, Snapshot, TechnicalRating } from "@/lib/technical-analyzer/types";
import type { MajorInstrument } from "@/types/forex";

const FRAMES: Array<{ key: Frame; label: string }> = [{ key: "H1", label: "1H" }, { key: "H4", label: "4H" }, { key: "D", label: "1D" }, { key: "W", label: "1W" }];

async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(`/api/technical-analyzer/${path}`), { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(60000), ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Technical analysis unavailable.");
  return data as T;
}

const issuedLabel = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ratingTone = (label: string) => (label.includes("Sell") ? "is-down" : label.includes("Buy") ? "is-up" : "");

function leanLabel(f: Forecast) {
  const direction = outlookDirection(f);
  if (direction === "BEARISH") return { text: "↓ Bearish lean", tone: "is-down" };
  if (direction === "BULLISH") return { text: "↑ Bullish lean", tone: "is-up" };
  if (direction === "UNAVAILABLE") return { text: "Unavailable", tone: "is-muted" };
  return { text: "→ No clear lean", tone: "" };
}

const EVIDENCE_BARS: Record<string, number> = { STRONG: 3, ALIGNED: 3, MODERATE: 2, MIXED: 1, WEAK: 1, LIMITED: 1 };

function riskLabel(f: Forecast) {
  const severity = f.continuationRisk?.severity;
  if (severity === "HIGH") return { text: "High", tone: "is-down" };
  if (severity === "CAUTION") return { text: "Caution", tone: "is-pend" };
  if (severity === "LOW") return { text: "Clear", tone: "is-muted" };
  return { text: continuationRiskLabel(f).replace(/ continuation risk$/, ""), tone: "is-muted" };
}

function IndicatorRow({ name, rating }: { name: string; rating: TechnicalRating }) {
  // score runs -1 (strong sell) to +1 (strong buy).
  const at = Math.max(0, Math.min(100, (rating.score + 1) * 50));
  return (
    <div className="nl-tech-ind">
      <span className="nl-tech-ind-name">{name}</span>
      <span className="nl-tech-meter" aria-hidden="true"><i style={{ left: `${at}%` }} /></span>
      <b className={ratingTone(rating.label)}>{rating.label}</b>
      <span className="nl-tech-ind-counts metric-number">{rating.buy} buy · {rating.neutral} neutral · {rating.sell} sell</span>
    </div>
  );
}

export function ChartTechnicals({ instrument, onClose, className = "" }: {
  instrument: string;
  onClose?: () => void;
  className?: string;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [frame, setFrame] = useState<Frame>("D");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"idle" | "done" | "blocked">("idle");
  const pair = displayNameFor(instrument as MajorInstrument);

  // The latest report for this pair, if its 1-day forecast has not expired.
  // Callers key the panel by pair, so a new pair starts from a fresh state.
  useEffect(() => {
    const controller = new AbortController();
    void read<History>("history", { signal: controller.signal })
      .then((history) => {
        if (controller.signal.aborted) return;
        const now = Date.now();
        const latest = history.rows
          .filter((row) => row.snapshot.instrument === instrument)
          .sort((a, b) => Date.parse(b.snapshot.createdAt) - Date.parse(a.snapshot.createdAt))[0];
        const fresh = latest?.snapshot.forecasts.find((f) => f.horizon === 1);
        setSnapshot(latest && fresh && Date.parse(fresh.expiresAt) > now ? latest.snapshot : null);
      })
      .catch(() => { /* No history is fine: Analyze still works. */ })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [instrument]);

  async function analyze() {
    setBusy(true); setError(""); setCopied("idle");
    try {
      setSnapshot(await read<Snapshot>("analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis unavailable.");
    } finally {
      setBusy(false);
    }
  }

  const current = snapshot?.frames[frame];
  const ratings = useMemo(() => (current ? technicalSummary(recordedReadings(current)) : null), [current]);
  const available = snapshot !== null && snapshot.technicalAvailable !== false;

  async function copy() {
    if (!snapshot) return;
    const ok = await copyReport(conciseMarketReport(snapshot, frame, new Date().toISOString()));
    setCopied(ok ? "done" : "blocked");
  }

  return (
    <section className={`nl-tech ${className}`} aria-labelledby="nl-tech-title">
      <div className="nl-tech-head">
        <div className="nl-tech-title">
          <h2 id="nl-tech-title">Technicals · {pair}</h2>
          <span className="metric-number">
            {snapshot ? `Completed candles · ${issuedLabel(snapshot.createdAt)} ET` : "Completed-candle analysis"}
          </span>
        </div>
        {onClose ? (
          <button type="button" className="nl-tech-close pressable" onClick={onClose} aria-label="Close technicals">
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="nl-tech-body">
        {loading ? (
          <p className="nl-tech-empty">Loading the latest report…</p>
        ) : !snapshot ? (
          <div className="nl-tech-start">
            <p>No current report for {pair}. Analyze reads completed H1, H4, daily and weekly candles.</p>
            <button type="button" className="nl-tech-analyze pressable" onClick={() => void analyze()} disabled={busy}>
              {busy ? "Analyzing…" : `Analyze ${pair}`}
            </button>
            {error ? <p className="nl-tech-error" role="alert">{error}</p> : null}
          </div>
        ) : (
          <>
            <section className="nl-tech-sec" aria-label="Indicator overview">
              <div className="nl-tech-sh">
                <span className="nl-tech-lbl">Indicators</span>
                <div className="nl-tech-seg" role="group" aria-label="Indicator timeframe">
                  {FRAMES.map((f) => (
                    <button key={f.key} type="button" aria-pressed={frame === f.key} className={frame === f.key ? "is-on" : undefined} onClick={() => setFrame(f.key)}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              {ratings && available ? (
                <>
                  <IndicatorRow name="Oscillators" rating={ratings.oscillators} />
                  <IndicatorRow name="Moving averages" rating={ratings.averages} />
                  <IndicatorRow name="Summary" rating={ratings.overall} />
                </>
              ) : (
                <p className="nl-tech-empty">Indicator readings are unavailable for this report.</p>
              )}
            </section>

            <section className="nl-tech-sec" aria-label="1 to 5 day outlook">
              <div className="nl-tech-sh">
                <span className="nl-tech-lbl">1–5 day outlook</span>
                <span className="nl-tech-meta metric-number">trading days</span>
              </div>
              <div className="nl-tech-orow is-head" aria-hidden="true">
                <span /><span>Lean</span><span>Evidence</span><span>Risk</span>
              </div>
              {snapshot.forecasts.map((f) => {
                const lean = leanLabel(f);
                const evidence = outlookEvidence(f);
                const bars = EVIDENCE_BARS[evidence] ?? 0;
                const risk = riskLabel(f);
                return (
                  <div key={f.horizon} className="nl-tech-orow">
                    <span className="metric-number nl-tech-day">{f.horizon}D</span>
                    <b className={lean.tone}>{lean.text}</b>
                    <span className="nl-tech-bars" role="img" aria-label={`${evidence.toLowerCase()} evidence`}>
                      {[1, 2, 3].map((n) => <i key={n} className={n <= bars ? "is-on" : undefined} />)}
                    </span>
                    <span className={`nl-tech-risk ${risk.tone}`}>{risk.text}</span>
                  </div>
                );
              })}
              <p className="nl-tech-note">Lean is direction, evidence is how much the frames agree, risk is what stands in the way.</p>
            </section>
          </>
        )}
      </div>

      {snapshot ? (
        <div className="nl-tech-foot">
          <div className="nl-tech-actions">
            <button type="button" className="nl-tech-copy pressable" onClick={() => void copy()}>
              <Copy aria-hidden="true" />
              {copied === "done" ? "Copied" : "Copy for ChatGPT"}
            </button>
            <button type="button" className="nl-tech-rerun pressable" onClick={() => void analyze()} disabled={busy} title="Run a fresh analysis">
              <RotateCw aria-hidden="true" className={busy ? "is-spinning" : undefined} />
              {busy ? "Running…" : "Run again"}
            </button>
          </div>
          {copied === "blocked" ? <p className="nl-tech-error" role="alert">The browser blocked the clipboard.</p> : null}
          {error ? <p className="nl-tech-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
