"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { requestAppRefresh } from "@/lib/use-foreground-refresh";

const MAX_PULL_DISTANCE = 92;
const REFRESH_THRESHOLD = 62;
/** Gap held open above the page while refreshing, with the spinner centred in it. */
const REFRESH_HOLD = 76;
const MIN_REFRESH_TIME_MS = 550;
const MAX_REFRESH_TIME_MS = 7_000;
const COMPLETE_HOLD_MS = 220;
/** Instagram-style spinner: bars fill in clockwise as you pull, then step round while refreshing. */
const SPINNER_BARS = 8;

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

/**
 * Rubber-band resistance: follows the finger closely at first, then stiffens
 * smoothly towards the max instead of hitting a hard clamp.
 */
function resist(rawDistance: number) {
  return MAX_PULL_DISTANCE * (1 - Math.exp(-rawDistance / (MAX_PULL_DISTANCE * 1.6)));
}

export function PwaPullToRefresh({ children }: { children: ReactNode }) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const gapRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number | null>(null);
  const startXRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const phaseRef = useRef<RefreshPhase>("idle");
  const [phase, setPhaseState] = useState<RefreshPhase>("idle");
  // Latest refresh callback for the native listeners registered once below.
  const refreshRef = useRef<() => void>(() => {});

  function setPhase(next: RefreshPhase) {
    if (phaseRef.current === next) return;
    phaseRef.current = next;
    setPhaseState(next);
  }

  /**
   * Pull distance is written straight to the DOM once per frame. Routing it
   * through React state re-rendered the whole tree on every touchmove, which is
   * what made the drag stutter on a busy page.
   */
  function paint(distance: number) {
    const indicator = indicatorRef.current;
    const gap = gapRef.current;
    if (indicator) {
      indicator.style.setProperty("--pull-distance", `${distance}px`);
      indicator.style.setProperty(
        "--pull-bars",
        String(Math.min(1, distance / REFRESH_THRESHOLD) * SPINNER_BARS),
      );
    }
    if (gap) {
      const hidden = phaseRef.current === "idle" || phaseRef.current === "complete";
      gap.style.height = `${hidden ? 0 : distance}px`;
    }
  }

  function publishPull(nextDistance: number) {
    pullDistanceRef.current = nextDistance;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setPhase(pullDistanceRef.current >= REFRESH_THRESHOLD ? "ready" : "pulling");
      paint(pullDistanceRef.current);
    });
  }

  function resetPull() {
    startYRef.current = null;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (phaseRef.current === "idle" && pullDistanceRef.current === 0) return;
    pullDistanceRef.current = 0;
    setPhase("idle");
    paint(0);
  }

  async function refreshInPlace() {
    const startedAt = performance.now();
    startYRef.current = null;
    // A frame queued by the last touchmove would otherwise land after this and
    // flip the phase back to "ready", so the spinner never starts turning.
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pullDistanceRef.current = REFRESH_HOLD;
    setPhase("refreshing");
    paint(REFRESH_HOLD);

    try {
      router.refresh();
      await Promise.race([requestAppRefresh(), delay(MAX_REFRESH_TIME_MS)]);
      await delay(Math.max(0, MIN_REFRESH_TIME_MS - (performance.now() - startedAt)));
      if (!mountedRef.current) return;

      setPhase("complete");
      paint(pullDistanceRef.current);
      await delay(COMPLETE_HOLD_MS);
    } finally {
      if (mountedRef.current) resetPull();
    }
  }
  refreshRef.current = () => void refreshInPlace();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    mountedRef.current = true;

    function onStart(event: TouchEvent) {
      if (
        phaseRef.current !== "idle" ||
        !isStandalonePwa() ||
        isPullToRefreshIgnored(event.target) ||
        window.scrollY > 0 ||
        event.touches.length !== 1
      ) {
        startYRef.current = null;
        return;
      }
      startYRef.current = event.touches[0]?.clientY ?? null;
      startXRef.current = event.touches[0]?.clientX ?? null;
    }

    function onMove(event: TouchEvent) {
      const startY = startYRef.current;
      // Not a pull gesture: return immediately so ordinary scrolling is untouched.
      if (startY === null) return;
      const touch = event.touches[0];
      if (!touch || window.scrollY > 0) {
        resetPull();
        return;
      }

      const downwardDistance = touch.clientY - startY;
      // A sideways swipe (the movers strip, filter chips) is not a pull. Drop
      // it before any preventDefault, or the horizontal scroll is cancelled
      // the moment the finger drifts a few pixels down. Past 24px of real pull
      // the gesture is committed and sideways drift no longer cancels it.
      const sideways = Math.abs(touch.clientX - (startXRef.current ?? touch.clientX));
      if (sideways > Math.abs(downwardDistance) && downwardDistance < 24) {
        startYRef.current = null;
        return;
      }
      if (downwardDistance <= 0) {
        // Finger went back up past the start: collapse, but keep tracking so
        // pulling down again in the same gesture still works.
        if (pullDistanceRef.current > 0) publishPull(0);
        return;
      }

      // Non-passive listener, so this actually stops the native bounce from
      // fighting the custom pull (React's touchmove is passive and ignores it).
      if (event.cancelable) event.preventDefault();
      publishPull(resist(downwardDistance));
    }

    function onEnd() {
      if (phaseRef.current === "refreshing" || phaseRef.current === "complete") return;
      if (pullDistanceRef.current < REFRESH_THRESHOLD) {
        resetPull();
        return;
      }
      refreshRef.current();
    }

    function onCancel() {
      if (phaseRef.current === "refreshing" || phaseRef.current === "complete") return;
      resetPull();
    }

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd, { passive: true });
    root.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      mountedRef.current = false;
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onCancel);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
    // Handlers read refs only; register once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const indicatorVisible = phase !== "idle";
  // Screen readers only; the spinner itself carries no text.
  const label =
    phase === "refreshing" ? "Refreshing"
      : phase === "complete" ? "Updated"
        : phase === "ready" ? "Release to refresh"
          : "Pull to refresh";

  return (
    <div ref={rootRef} className="pwa-pull-refresh">
      <div
        ref={indicatorRef}
        role="status"
        aria-live="polite"
        className={`pwa-pull-refresh-indicator${indicatorVisible ? " is-visible" : ""}${
          phase !== "idle" ? ` is-${phase}` : ""
        }`}
        style={{ "--pull-distance": "0px", "--pull-bars": 0 } as CSSProperties}
      >
        <span className="pwa-pull-refresh-spinner" aria-hidden="true">
          {Array.from({ length: SPINNER_BARS }, (_, index) => (
            <span key={index} className="pwa-pull-refresh-bar" style={{ "--bar": index } as CSSProperties} />
          ))}
        </span>
        <span className="sr-only">{label}</span>
      </div>
      {/* The page follows the finger, stays pushed down while refreshing, and
          eases back once done. Height, not transform, so fixed bars are unaffected. */}
      <div
        ref={gapRef}
        aria-hidden="true"
        className={`pwa-pull-refresh-gap${phase === "pulling" || phase === "ready" ? " is-tracking" : ""}`}
        style={{ height: 0 }}
      />
      {children}
    </div>
  );
}
