"use client";

import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import { HomeLoadingSkeleton } from "@/components/ui/home-loading-skeleton";
import { initialHomeLoadingState, updateHomeLoading } from "@/lib/home/loading";

const HomeReadiness = createContext<((update: { section: string; ready: boolean }) => void) | null>(null);

/** Optional outside Home, so shared cards keep their existing standalone behavior. */
export function useHomeSectionReady(section: string, ready: boolean) {
  const report = useContext(HomeReadiness);
  useEffect(() => { report?.({ section, ready }); }, [report, section, ready]);
}

export function HomeLoadingBoundary({ ready, children }: { ready: boolean; children: ReactNode }) {
  const [state, report] = useReducer(updateHomeLoading, undefined, initialHomeLoadingState);
  const visible = ready && state.revealed;
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
