"use client";

import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

function pageBackground(
  theme: string | undefined,
  isSignalsMobile: boolean,
): string {
  const isLight = theme === "light";

  if (isLight) {
    return isSignalsMobile ? "#ffffff" : "#f2f2f7";
  }

  return "#09090b";
}

export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();
  const pathname = usePathname();
  const [isSignalsMobile, setIsSignalsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1023px)");

    function updateSignalsMobile() {
      setIsSignalsMobile(
        pathname.startsWith("/signals") && mediaQuery.matches,
      );
    }

    updateSignalsMobile();
    mediaQuery.addEventListener("change", updateSignalsMobile);

    return () => {
      mediaQuery.removeEventListener("change", updateSignalsMobile);
    };
  }, [pathname]);

  useEffect(() => {
    const color = pageBackground(resolvedTheme, isSignalsMobile);
    let meta = document.querySelector('meta[name="theme-color"]:not([media])');

    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }

    meta.setAttribute("content", color);

    if (isSignalsMobile) {
      document.documentElement.style.backgroundColor = color;
      document.body.style.backgroundColor = color;
      return;
    }

    document.documentElement.style.backgroundColor = "";
    document.body.style.backgroundColor = "";
  }, [isSignalsMobile, resolvedTheme]);

  return null;
}
