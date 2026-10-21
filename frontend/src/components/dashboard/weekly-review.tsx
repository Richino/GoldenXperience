"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { useHomeSectionReady } from "./home-loading-boundary";

/**
 * Home's weekly review: the last completed trading week (Sunday to the Friday
 * close, New York) of the trader's own trades — it changes once a week — measured
 * by the server, with the rule-based findings and an AI coach's summary of
 * where it went wrong and what to change. The summary is written only from
 * the measured facts (the server rejects any number it cannot trace). Each
 * week is saved, so the coach can point out mistakes that keep repeating and
 * check last week's focus; past weeks are listed under the breakdowns.
 */

type Bucket = { key: string; trades: number; wins: number; netR: number; netPl: number };
type HistoryWeek = {
  weekStart: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPl: number;
  focus: string | null;
};
type Review = {
  weekStart: string;
  history: HistoryWeek[];
  from: string;
  to: string;
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    netR: number;
    netPl: number;
    profitFactor: number | null;
    spreadPaid: number;
    avgWinPl: number | null;
    avgLossPl: number | null;
    avgHoldWinMinutes: number | null;
    avgHoldLossMinutes: number | null;
    exits: { stop: number; target: number; manual: number };
    byPair: Bucket[];
    bySession: Bucket[];
  };
  findings: Array<{ id: string; title: string; detail: string; impact: number | null }>;
};
type Summary = {
  summary: string;
  recurring?: Array<{ title: string; detail: string }>;
  lastFocusCheck?: string;
  mistakes: Array<{ title: string; detail: string }>;
  improvements: Array<{ title: string; detail: string }>;
  focus: string;
};

function money(value: number, currency: string) {
  const body = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${body}`;
}
const tone = (value: number | null) => (value === null || Math.abs(value) < 0.005 ? "" : value > 0 ? "is-up" : "is-down");
const weekLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const holdLabel = (minutes: number | null) => (minutes === null ? "—" : minutes >= 120 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes)}m`);

export function WeeklyReview({ currency }: { currency: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryState, setSummaryState] = useState<"idle" | "loading" | "error">("idle");
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // The AI commentary has its own loading state; it must not hide the account.
  useHomeSectionReady("weekly", reviewError !== null || review !== null);

  const loadSummary = useCallback(async () => {
    setSummaryState("loading");
    setSummaryError(null);
    try {
      const response = await fetch(apiUrl("/api/review/weekly/summary"), { method: "POST", credentials: "include", signal: AbortSignal.timeout(20_000) });
      const payload = (await response.json()) as { summary?: Summary; error?: string };
      if (!response.ok || !payload.summary) throw new Error(payload.error ?? "The summary could not be written.");
      setSummary(payload.summary);
      setSummaryState("idle");
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : "The summary could not be written.");
      setSummaryState("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/review/weekly"), { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(12_000) })
      .then(async (response) => {
        const payload = (await response.json()) as Review & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "The weekly review could not be loaded.");
        if (cancelled) return;
        setReview(payload);
        if (payload.stats.trades > 0) void loadSummary();
      })
      .catch((error) => {
        if (!cancelled) setReviewError(error instanceof Error ? error.message : "The weekly review could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadSummary]);

  const stats = review?.stats;
  const best = stats ? [...stats.byPair].sort((a, b) => b.netPl - a.netPl)[0] : null;
  const worst = stats?.byPair[0] ?? null;

  return (
    <section className="nl-sec nl-wr" aria-labelledby="nl-wr-title">
      <div className="nl-sec-head">
        <div className="nl-sec-title">
          <span className="nl-sec-num" aria-hidden="true">04</span>
          <h2 id="nl-wr-title">Last week review</h2>
        </div>
        <span className="nl-wr-window metric-number">{review ? `Week of ${weekLabel(review.weekStart)} · updates after Friday close` : "Last week"}</span>
      </div>

      {reviewError ? (
        <p className="nl-card-empty is-warn">{reviewError}</p>
      ) : !review || !stats ? (
        <div className="nl-wr-card" aria-busy="true">
          <span className="gx-skel nl-wr-skel-line" />
          <span className="gx-skel nl-wr-skel-line is-short" />
        </div>
      ) : stats.trades === 0 ? (
        <p className="nl-empty">No closed trades last week. Your review appears here after a week with some.</p>
      ) : (
        <div className="nl-wr-card">
          <div className="nl-wr-hero">
            <span className="nl-wr-hero-label">Net</span>
            <b className={`nl-wr-net metric-number ${tone(stats.netPl)}`}>{money(stats.netPl, currency)}</b>
            <span className="nl-wr-hero-sub metric-number">
              {stats.trades} trades · {stats.wins}W {stats.losses}L · {stats.winRate === null ? "—" : `${stats.winRate}% win rate`}
            </span>
          </div>
          <dl className="nl-wr-mini">
            <div>
              <dt>Avg win / loss</dt>
              <dd className="metric-number">
                <span className="is-up">{stats.avgWinPl === null ? "—" : money(stats.avgWinPl, currency)}</span>
                <small>/</small>
                <span className="is-down">{stats.avgLossPl === null ? "—" : money(stats.avgLossPl, currency)}</span>
              </dd>
            </div>
            <div>
              <dt>Held win / loss</dt>
              <dd className="metric-number">{holdLabel(stats.avgHoldWinMinutes)} <small>/</small> {holdLabel(stats.avgHoldLossMinutes)}</dd>
            </div>
            <div>
              <dt>Spread paid</dt>
              <dd className="metric-number is-down">{money(-stats.spreadPaid, currency)}</dd>
            </div>
          </dl>

          <div className="nl-wr-ai" aria-live="polite">
            <div className="nl-wr-ai-head">
              <span className="nl-wr-ai-label">
                <Sparkles aria-hidden="true" />
                AI summary
              </span>
              {summaryState === "error" ? (
                <button type="button" className="nl-wr-retry pressable" onClick={() => void loadSummary()}>
                  <RotateCcw aria-hidden="true" />
                  Try again
                </button>
              ) : null}
            </div>
            {summary ? (
              <>
                <p className="nl-wr-summary">{summary.summary}</p>
                <p className="nl-wr-focus">
                  <span>Focus next week</span>
                  {summary.focus}
                </p>
                <details className="nl-wr-more">
                  <summary>What went wrong and what to do</summary>
                {summary.lastFocusCheck ? (
                  <p className="nl-wr-check">
                    <span>Last week&apos;s focus</span>
                    {summary.lastFocusCheck}
                  </p>
                ) : null}
                {summary.recurring?.length ? (
                  <div>
                    <h3>Keeps happening</h3>
                    <ol className="nl-wr-list is-again">
                      {summary.recurring.map((item) => (
                        <li key={item.title}>
                          <b>{item.title}</b>
                          <span>{item.detail}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                <div className="nl-wr-cols">
                  <div>
                    <h3>Where it went wrong</h3>
                    <ol className="nl-wr-list is-wrong">
                      {summary.mistakes.map((item) => (
                        <li key={item.title}>
                          <b>{item.title}</b>
                          <span>{item.detail}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <h3>What to do next</h3>
                    <ol className="nl-wr-list is-do">
                      {summary.improvements.map((item) => (
                        <li key={item.title}>
                          <b>{item.title}</b>
                          <span>{item.detail}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
                </details>
              </>
            ) : summaryState === "loading" ? (
              <div className="nl-wr-ai-loading" role="status">
                <span className="gx-skel nl-wr-skel-line" />
                <span className="gx-skel nl-wr-skel-line" />
                <span className="gx-skel nl-wr-skel-line is-short" />
                <span className="nl-wr-ai-note">Reading your week…</span>
              </div>
            ) : (
              <>
                {summaryError ? <p className="nl-wr-ai-note is-warn">{summaryError} The measured findings are below.</p> : null}
                <ol className="nl-wr-list is-wrong">
                  {review.findings.map((finding) => (
                    <li key={finding.id}>
                      <b>{finding.title}</b>
                      <span>{finding.detail}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>

          <details className="nl-wr-more">
          <summary>By session, pair and past weeks</summary>
          <div className="nl-wr-breakdown">
            <div>
              <h3>By session</h3>
              <ul>
                {stats.bySession.map((row) => (
                  <li key={row.key}>
                    <span>{row.key}</span>
                    <small className="metric-number">{row.trades} · {row.wins}W</small>
                    <b className={`metric-number ${tone(row.netPl)}`}>{money(row.netPl, currency)}</b>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>By pair</h3>
              <ul>
                {stats.byPair.slice(0, 5).map((row) => (
                  <li key={row.key} className={row.key === best?.key ? "is-best" : row.key === worst?.key ? "is-worst" : undefined}>
                    <span>{row.key}</span>
                    <small className="metric-number">{row.trades} · {row.wins}W</small>
                    <b className={`metric-number ${tone(row.netPl)}`}>{money(row.netPl, currency)}</b>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {review.history.length ? (
            <div className="nl-wr-history">
              <h3>Past weeks</h3>
              <ul>
                {review.history.map((week) => (
                  <li key={week.weekStart}>
                    <span>Week of {weekLabel(week.weekStart)}</span>
                    <small className="metric-number">
                      {week.trades} trades · {week.winRate === null ? "—" : `${week.winRate}%`}
                    </small>
                    <b className={`metric-number ${tone(week.netPl)}`}>{money(week.netPl, currency)}</b>
                    {week.focus ? <em>Focus: {week.focus}</em> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          </details>
        </div>
      )}
    </section>
  );
}
