"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type TouchEvent,
} from "react";
import { ArrowDown, Check, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { requestAppRefresh } from "@/lib/use-foreground-refresh";

const MAX_PULL_DISTANCE = 92;
const REFRESH_THRESHOLD = 62;
const MIN_REFRESH_TIME_MS = 550;
const MAX_REFRESH_TIME_MS = 7_000;
const COMPLETE_HOLD_MS = 420;

type RefreshPhase = "idle" | "pulling" | "ready" | "refreshing" | "complete";

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

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
  const router = useRouter();
  const startYRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [pullDistance, setPullDistance] = useState(0);
  const [phase, setPhase] = useState<RefreshPhase>("idle");
  const refreshing = phase === "refreshing" || phase === "complete";

  useEffect(() => () => {
    mountedRef.current = false;
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  function publishPull(nextDistance: number) {
    pullDistanceRef.current = nextDistance;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setPullDistance(pullDistanceRef.current);
      setPhase(pullDistanceRef.current >= REFRESH_THRESHOLD ? "ready" : "pulling");
    });
  }

  function resetPull() {
    startYRef.current = null;
    pullDistanceRef.current = 0;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setPullDistance(0);
    setPhase("idle");
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (
      phase !== "idle" ||
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
    ) {
      resetPull();
      return;
    }

    const downwardDistance = touch.clientY - startY;
    if (downwardDistance <= 0) {
      resetPull();
      return;
    }

    event.preventDefault();
    const nextDistance = Math.min(MAX_PULL_DISTANCE, downwardDistance * 0.52);
    publishPull(nextDistance);
  }

  async function refreshInPlace() {
    const startedAt = performance.now();
    startYRef.current = null;
    pullDistanceRef.current = REFRESH_THRESHOLD;
    setPullDistance(REFRESH_THRESHOLD);
    setPhase("refreshing");

    try {
      router.refresh();
      await Promise.race([requestAppRefresh(), delay(MAX_REFRESH_TIME_MS)]);
      await delay(Math.max(0, MIN_REFRESH_TIME_MS - (performance.now() - startedAt)));
      if (!mountedRef.current) return;

      setPhase("complete");
      await delay(COMPLETE_HOLD_MS);
    } finally {
      if (mountedRef.current) resetPull();
    }
  }

  function handleTouchEnd() {
    if (pullDistanceRef.current < REFRESH_THRESHOLD || refreshing) {
      resetPull();
      return;
    }

    void refreshInPlace();
  }

  function handleTouchCancel() {
    if (!refreshing) resetPull();
  }

  const indicatorVisible = phase !== "idle";
  const progress = Math.min(1, pullDistance / REFRESH_THRESHOLD);
  const label =
    phase === "refreshing" ? "Refreshing"
      : phase === "complete" ? "Updated"
        : phase === "ready" ? "Release to refresh"
          : "Pull to refresh";

  return (
    <div
      className="pwa-pull-refresh"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <div
        role="status"
        aria-live="polite"
        className={`pwa-pull-refresh-indicator${indicatorVisible ? " is-visible" : ""}${
          phase !== "idle" ? ` is-${phase}` : ""
        }`}
        style={{
          "--pull-distance": `${pullDistance}px`,
          "--pull-progress": progress,
          "--pull-rotation": `${progress * 180}deg`,
        } as CSSProperties}
      >
        <span className="pwa-pull-refresh-icon" aria-hidden="true">
          {phase === "refreshing" ? (
            <LoaderCircle className="size-4 pwa-pull-refresh-loader" strokeWidth={2} />
          ) : phase === "complete" ? (
            <Check className="size-4" strokeWidth={2.25} />
          ) : (
            <ArrowDown className="size-4 pwa-pull-refresh-arrow" strokeWidth={2} />
          )}
        </span>
        <span className="pwa-pull-refresh-label">{label}</span>
      </div>
      {children}
    </div>
  );
}
