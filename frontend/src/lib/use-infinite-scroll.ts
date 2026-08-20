"use client";

import { useEffect, type RefObject } from "react";

/**
 * Fires `onLoadMore` when a sentinel element scrolls into view, for
 * "load a page, then more as you scroll" lists. It only observes while there is
 * more to load and nothing is already in flight, so a page never double-fires.
 * `onLoadMore` should be stable (wrap it in `useCallback`).
 */
export function useInfiniteScroll({
  sentinelRef,
  hasMore,
  loading,
  onLoadMore,
  rootMargin = "200px",
}: {
  sentinelRef: RefObject<HTMLElement | null>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  rootMargin?: string;
}) {
  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      // A margin so the next page starts loading just before the list runs out.
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [sentinelRef, hasMore, loading, onLoadMore, rootMargin]);
}
