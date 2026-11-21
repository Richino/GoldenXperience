"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useReducer, type ReactNode } from "react";
import { HomeLoadingSkeleton } from "@/components/ui/home-loading-skeleton";
import { HOME_LOADING_CEILING_MS, initialHomeLoadingState, updateHomeLoading } from "@/lib/home/loading";

const HomeReadiness = createContext<((update: { section: string; ready: boolean }) => void) | null>(null);

/** Optional outside Home, so shared cards keep their existing standalone behavior. */
export function useHomeSectionReady(section: string, ready: boolean) {
  const report = useContext(HomeReadiness);
  useEffect(() => { report?.({ section, ready }); }, [report, section, ready]);
}

export function HomeLoadingBoundary({ ready, revealNow = false, children }: {
  ready: Record<string, boolean>;
  /** Home was restored from this device's last load: show it without waiting. */
  revealNow?: boolean;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(updateHomeLoading, undefined, initialHomeLoadingState);
  const report = useCallback((update: { section: string; ready: boolean }) => dispatch(update), []);
  useLayoutEffect(() => { if (revealNow) dispatch({ ceiling: true }); }, [revealNow]);
  // `ready` carries the page's own requests; cards report theirs through
  // context. The reducer latches the reveal so refreshes never re-hide Home.
  const readyKey = Object.entries(ready).map(([section, settled]) => `${section}:${settled}`).join(",");
  useEffect(() => {
    for (const [section, settled] of Object.entries(ready)) dispatch({ section, ready: settled });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readyKey is the stable form of `ready`
  }, [readyKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => dispatch({ ceiling: true }), HOME_LOADING_CEILING_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const visible = state.revealed;
  return <HomeReadiness.Provider value={report}>
    <div data-home-ready={visible} style={{ position: "relative" }}>
      {!visible ? <HomeLoadingSkeleton /> : null}
      {/* Keep cards mounted and measurable while their requests run in parallel. */}
      <div aria-hidden={!visible} inert={!visible} style={visible ? undefined : {
        position: "absolute", insetInline: 0, top: 0, visibility: "hidden", pointerEvents: "none",
      }}>
        {children}
      </div>
    </div>
  </HomeReadiness.Provider>;
}
