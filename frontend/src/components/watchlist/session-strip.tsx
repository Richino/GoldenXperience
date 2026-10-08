"use client";

import { useEffect, useState } from "react";
import { getMarketCondition, localMinutes, NEW_YORK_TIME_ZONE } from "@/lib/strategy/session";

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
  return { minutes: localMinutes(now, NEW_YORK_TIME_ZONE), condition: getMarketCondition(now) };
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
  const clock = state
    ? `${String(Math.floor(state.minutes / 60)).padStart(2, "0")}:${String(state.minutes % 60).padStart(2, "0")} ET`
    : "— ET";

  return (
    <section className="nl-session-strip" aria-label={`Trading sessions, Eastern Time. ${headline}.`}>
      <div className="nl-session-strip-head">
        {/* Phone: the lanes collapse to three swatches beside the headline. */}
        <span className="nl-session-swatches" aria-hidden="true">
          <span className="is-asia" />
          <span className="is-london" />
          <span className="is-new-york" />
        </span>
        <span className="nl-session-strip-title">{headline}</span>
        <span className="nl-session-strip-clock metric-number">{clock}</span>
      </div>
      <div className="nl-session-strip-lanes" aria-hidden="true">
        {LANES.map((lane) => (
          <div key={lane.label} className="nl-session-lane">
            <span className="nl-session-lane-label">{lane.label}</span>
            <span className="nl-session-lane-track">
              {lane.spans.map(([from, to]) => (
                <span
                  key={from}
                  className={`nl-session-lane-span ${lane.tone}`}
                  style={{ left: `${(from / 24) * 100}%`, width: `${((to - from) / 24) * 100}%` }}
                />
              ))}
            </span>
          </div>
        ))}
        {state ? (
          <span
            className="nl-session-now"
            style={{ "--now": state.minutes / 1440 } as React.CSSProperties}
          />
        ) : null}
      </div>
      <div className="nl-session-strip-scale" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </section>
  );
}
