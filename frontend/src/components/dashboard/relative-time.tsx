"use client";

import { useEffect, useState } from "react";

function relativeLabel(at: string, now: number) {
  const diff = now - new Date(at).getTime();
  const minutes = Math.round(diff / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * A "12m ago"-style label. Client-only: the value depends on the wall clock, so
 * it renders nothing on the server and on the first client paint (keeping SSR
 * and hydration in agreement), then fills in and ticks once a minute.
 */
export function RelativeTime({ at }: { at: string | null }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Client-only first read; server and first client render both showed
    // nothing, so filling it here is the point rather than a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!at || now === null) return null;
  return <>{relativeLabel(at, now)}</>;
}
