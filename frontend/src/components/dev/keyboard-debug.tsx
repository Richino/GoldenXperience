"use client";

import { useEffect, useState } from "react";

/**
 * TEMPORARY diagnostic overlay for the iOS keyboard shift. Shows live viewport
 * metrics so we can see exactly what moves when the keyboard opens on device.
 * Remove once the keyboard issue is resolved.
 *
 * Read on the phone:
 * - vvOffTop  = visualViewport.offsetTop  → how far iOS shifted the visible area
 * - bodyTop   = <body> rect top           → how many px the body actually moved
 * - kbInset   = innerH - vvH - vvOffTop    → keyboard height
 * - scrollY / docTop = document scroll (should stay 0 on the fixed chart page)
 */
export function KeyboardDebug() {
  const [lines, setLines] = useState<string[]>(["(waiting)"]);

  useEffect(() => {
    const vv = window.visualViewport;
    const read = () => {
      const body = document.body.getBoundingClientRect();
      const root = document.documentElement;
      const insetVar = getComputedStyle(root).getPropertyValue("--app-viewport-height").trim() || "-";
      setLines([
        `innerH ${Math.round(window.innerHeight)}`,
        `vvH ${vv ? Math.round(vv.height) : "-"}`,
        `vvOffTop ${vv ? Math.round(vv.offsetTop) : "-"}`,
        `vvPageTop ${vv ? Math.round(vv.pageTop) : "-"}`,
        `scrollY ${Math.round(window.scrollY)}`,
        `docTop ${Math.round(root.scrollTop)}`,
        `bodyTop ${Math.round(body.top)}`,
        `bodyPos ${document.body.style.position || "static"}`,
        `kbInset ${vv ? Math.round(window.innerHeight - vv.height - vv.offsetTop) : "-"}`,
        `--app-vh ${insetVar}`,
      ]);
    };
    read();
    vv?.addEventListener("resize", read);
    vv?.addEventListener("scroll", read);
    window.addEventListener("scroll", read, { passive: true });
    const id = window.setInterval(read, 250);
    return () => {
      vv?.removeEventListener("resize", read);
      vv?.removeEventListener("scroll", read);
      window.removeEventListener("scroll", read);
      window.clearInterval(id);
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        zIndex: 2147483647,
        background: "rgba(0,0,0,0.82)",
        color: "#39ff14",
        font: "11px/1.3 ui-monospace, monospace",
        padding: "6px 8px",
        borderBottomRightRadius: 8,
        pointerEvents: "none",
        whiteSpace: "pre",
      }}
    >
      {lines.join("\n")}
    </div>
  );
}
