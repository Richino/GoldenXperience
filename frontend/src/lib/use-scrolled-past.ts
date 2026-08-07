"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tracks whether the element the returned ref is attached to has scrolled out
 * of view.
 *
 * A control that is fixed to the viewport still sits in its natural place while
 * the page is at the top, and should look like part of the header there. Only
 * once the page scrolls past does content start passing behind it, which is
 * when it needs to lift off the page to stay readable.
 *
 * The observer watches the element the control was lifted out of, so the
 * threshold is the layout itself rather than a hard-coded scroll offset.
 */
export function useScrolledPast<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [scrolledPast, setScrolledPast] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => setScrolledPast(!entry!.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, scrolledPast };
}
