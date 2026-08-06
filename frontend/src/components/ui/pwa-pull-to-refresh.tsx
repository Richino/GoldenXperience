"use client";

import {
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type TouchEvent,
} from "react";

const MAX_PULL_DISTANCE = 88;
const REFRESH_THRESHOLD = 66;

function isStandalonePwa() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isPullToRefreshIgnored(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-pull-to-refresh-ignore]"));
}

export function PwaPullToRefresh({ children }: { children: ReactNode }) {
  const startYRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  function resetPull() {
    startYRef.current = null;
    pullDistanceRef.current = 0;
    setPullDistance(0);
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (
      refreshing ||
      !isStandalonePwa() ||
      isPullToRefreshIgnored(event.target) ||
      window.scrollY > 0 ||
      event.touches.length !== 1
    ) {
      return;
    }

    startYRef.current = event.touches[0]?.clientY ?? null;
  }

  function handleTouchMove(event: TouchEvent<HTMLDivElement>) {
    const startY = startYRef.current;
    const touch = event.touches[0];
    if (
      startY === null ||
      !touch ||
      isPullToRefreshIgnored(event.target) ||
      window.scrollY > 0
    ) return;

    const downwardDistance = touch.clientY - startY;
    if (downwardDistance <= 0) {
      resetPull();
      return;
    }

    event.preventDefault();
    const nextDistance = Math.min(MAX_PULL_DISTANCE, downwardDistance * 0.55);
    pullDistanceRef.current = nextDistance;
    setPullDistance(nextDistance);
  }

  function handleTouchEnd() {
    if (pullDistanceRef.current < REFRESH_THRESHOLD || refreshing) {
      resetPull();
      return;
    }

    startYRef.current = null;
    setRefreshing(true);
    window.setTimeout(() => window.location.reload(), 180);
  }

  const indicatorVisible = pullDistance > 0 || refreshing;

  return (
    <div
      className="pwa-pull-refresh"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={resetPull}
    >
      <div
        aria-hidden="true"
        className={`pwa-pull-refresh-indicator${indicatorVisible ? " is-visible" : ""}${
          refreshing ? " is-refreshing" : ""
        }`}
        style={{ "--pull-distance": `${pullDistance}px` } as CSSProperties}
      >
        <span className="pwa-pull-refresh-spinner" />
      </div>
      {children}
    </div>
  );
}
