"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

function isInternalNavigation(anchor: HTMLAnchorElement) {
  if (
    anchor.target ||
    anchor.hasAttribute("download") ||
    anchor.origin !== window.location.origin
  ) {
    return false;
  }

  return anchor.href !== window.location.href;
}

export function NavigationProgress() {
  const pathname = usePathname();
  const [navigating, setNavigating] = useState(false);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }

      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (anchor && isInternalNavigation(anchor)) {
        setNavigating(true);
      }
    };

    const handlePopState = () => setNavigating(true);

    document.addEventListener("click", handleClick, true);
    window.addEventListener("popstate", handlePopState);

    return () => {
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setNavigating(false), 180);
    return () => window.clearTimeout(timeout);
  }, [pathname]);

  return (
    <div
      className={`navigation-progress${navigating ? " is-loading" : ""}`}
      aria-hidden={!navigating}
    />
  );
}
