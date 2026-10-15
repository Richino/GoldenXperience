"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";

/**
 * Journal: the swing plan's checklist, scored. Every closed trade tagged on the
 * ticket (trend / news view / entry level, plus day or swing) is grouped by
 * each tag, so you can see which parts of the plan actually pay. Below the
 * target count the numbers are shown but marked as an early read.
 */

type Bucket = { value: string; label: string; trades: number; wins: number; winRate: number; avgR: number | null; netPl: number };
type PlanReviewData = { tagged: number; target: number; groups: { key: string; label: string; buckets: Bucket[] }[] };

const money = (value: number) =>
  `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const signedR = (value: number | null) => (value === null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}R`);

export function PlanReview() {
  const [data, setData] = useState<PlanReviewData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/review/plan"), { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("unavailable"))))
      .then((payload: PlanReviewData) => { if (!cancelled) setData(payload); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  if (failed) return null;
  if (!data) return <section className="plan-review" aria-busy="true"><span className="gx-skel plan-review-skel" /></section>;

  const progress = Math.min(1, data.tagged / data.target);
  const early = data.tagged < data.target;
  return (
    <section className="plan-review" aria-labelledby="plan-review-title">
      <div className="plan-review-head">
        <div>
          <h2 id="plan-review-title">Plan review</h2>
          <p>Closed trades you tagged on the ticket, grouped by each part of your plan.</p>
        </div>
        <span className="metric-number">{data.tagged}/{data.target} tagged</span>
      </div>
      <div className="plan-review-bar" aria-hidden="true"><i style={{ width: `${progress * 100}%` }} /></div>
      {data.tagged === 0 ? (
        <p className="plan-review-empty">
          No tagged trades yet. Fill in the Plan check (trend, news view, entry) on the new-trade form and closed trades
          will show up here.
        </p>
      ) : (
        <>
          {early ? (
            <p className="plan-review-note">
              Early read: {data.tagged} of {data.target} trades. Small samples swing a lot, so treat these as a direction
              to watch, not a result.
            </p>
          ) : null}
          <div className="plan-review-groups">
            {data.groups.filter((group) => group.buckets.length).map((group) => (
              <div key={group.key} className="plan-review-group">
                <h3>{group.label}</h3>
                <table>
                  <thead>
                    <tr><th scope="col">Tag</th><th scope="col">Trades</th><th scope="col">Win</th><th scope="col">Avg R</th><th scope="col">Net</th></tr>
                  </thead>
                  <tbody>
                    {group.buckets.map((bucket) => (
                      <tr key={bucket.value}>
                        <th scope="row">{bucket.label}</th>
                        <td className="metric-number">{bucket.trades}</td>
                        <td className="metric-number">{bucket.winRate}%</td>
                        <td className={`metric-number ${bucket.avgR === null ? "" : bucket.avgR >= 0 ? "is-up" : "is-down"}`}>{signedR(bucket.avgR)}</td>
                        <td className={`metric-number ${bucket.netPl >= 0 ? "is-up" : "is-down"}`}>{money(bucket.netPl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
