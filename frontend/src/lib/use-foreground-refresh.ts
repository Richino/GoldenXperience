"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `refresh` the moment the app returns to the foreground, so reopening a
 * minimised PWA (or switching back to a backgrounded tab) shows fresh data
 * instead of the snapshot that was on screen when it was hidden.
 *
 * Background tabs have their `setInterval` timers throttled — often to once a
 * minute, and on mobile paused entirely — so a view that only polls on a timer
 * can sit on stale numbers for up to a full cycle after it comes back. Firing
 * the same refresh on the foreground transition closes that gap.
 *
 * Three signals are watched because no single one covers every platform:
 *  - `visibilitychange` → the tab becoming visible again (the common case).
 *  - `focus` → returning to the window on desktop without a visibility change.
 *  - `pageshow` with `persisted` → a page restored from the back/forward cache,
 *    which fires neither of the above.
 *
 * They frequently fire together on a single return, so calls are coalesced
 * within a short window to run `refresh` once per foregrounding.
 */
const COALESCE_WINDOW_MS = 1_000;

export function useForegroundRefresh(refresh: () => void, enabled = true) {
  const refreshRef = useRef(refresh);
  const lastRunRef = useRef(0);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;

    function run() {
      const now = Date.now();
      if (now - lastRunRef.current < COALESCE_WINDOW_MS) return;
      lastRunRef.current = now;
      refreshRef.current();
    }

    function onVisibility() {
      if (document.visibilityState === "visible") run();
    }

    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) run();
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", run);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", run);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [enabled]);
}
