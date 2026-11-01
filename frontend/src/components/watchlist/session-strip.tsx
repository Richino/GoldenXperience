"use client";

import { useEffect, useState } from "react";
import { getMarketCondition, localMinutes, NEW_YORK_TIME_ZONE } from "@/lib/strategy/session";
import { formatClockTime } from "@/lib/format/datetime";

/**
 * A 24-hour Eastern Time ruler with the three trading sessions as lanes and a
 * marker at the current time. The lanes are fixed ET approximations for
 * orientation; the headline comes from getMarketCondition, the same source the
 * top bar uses, so the two never disagree about which session is live.
 */
const LANES: Array<{ label: string; spans: Array<[number, number]>; tone: string }> = [
  { label: "Asia", spans: [[19, 24], [0, 4]], tone: "is-asia" },
  { label: "London", spans: [[3, 12]], tone: "is-london" },
  { label: "New York", spans: [[8, 17]], tone: "is-new-york" },
];

function readNow() {
  const now = new Date();
  return { minutes: localMinutes(now, NEW_YORK_TIME_ZONE), condition: getMarketCondition(now), clock: `${formatClockTime(now)} ET` };
}

export function SessionStrip() {
  // Client-only: the server cannot know the viewer's current minute.
  const [state, setState] = useState<ReturnType<typeof readNow> | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(readNow());
    const timer = window.setInterval(() => setState(readNow()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const headline = !state
    ? "Sessions"
    : !state.condition.marketOpen
      ? "Market closed"
      : state.condition.label === "London / New York"
        ? "London + New York overlap"
        : `${state.condition.label} session`;
  const clock = state?.clock ?? "— ET";
  const open = state?.condition.marketOpen ?? false;

  return (
    <section className="nl-mx-panel nl-mx-sess" aria-label={`Trading sessions, Eastern Time. ${headline}.`}>
      <div className="nl-mx-ph">
        <h2>Sessions</h2>
        <span className="nl-mx-note metric-number">{clock}</span>
      </div>
      <div className="nl-mx-sess-headline">
        <span className={`nl-mx-sess-dot${open ? "" : " is-closed"}`} aria-hidden="true" />
        <span>{headline}</span>
        {/* Phone: the panel head is hidden, so the clock rides on this line. */}
        <span className="nl-mx-sess-clock metric-number">{clock}</span>
      </div>
      <div className="nl-mx-sess-lanes" aria-hidden="true">
        {LANES.map((lane) => (
          <div key={lane.label} className="nl-mx-sess-lane">
            <span className="nl-mx-sess-label">{lane.label}</span>
            <span className="nl-mx-sess-track">
              {lane.spans.map(([from, to]) => (
                <span
                  key={from}
                  className={`nl-mx-sess-span ${lane.tone}`}
                  style={{ left: `${(from / 24) * 100}%`, width: `${((to - from) / 24) * 100}%` }}
                />
              ))}
            </span>
          </div>
        ))}
        {state ? (
          <span
            className="nl-mx-sess-now"
            style={{ "--now": state.minutes / 1440 } as React.CSSProperties}
          />
        ) : null}
      </div>
      <div className="nl-mx-sess-scale metric-number" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <div className="nl-mx-sess-legend" aria-hidden="true">
        {LANES.map((lane) => (
          <span key={lane.label}>
            <span className={`nl-mx-sess-swatch ${lane.tone}`} />
            {lane.label}
          </span>
        ))}
      </div>
    </section>
  );
}
