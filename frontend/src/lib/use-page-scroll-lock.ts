"use client";

import { useEffect } from "react";

/**
 * Freezes the page behind a drawer while `active`. Uses the same approach as
 * MobileSheet (the body is pinned with position: fixed at its scroll offset)
 * because iOS Safari ignores overflow: hidden on the body for touch scrolling.
 * The scroll position is restored on release.
 */
export function usePageScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const body = document.body;
    const scrollY = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
    return () => {
      Object.assign(body.style, previous);
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}
