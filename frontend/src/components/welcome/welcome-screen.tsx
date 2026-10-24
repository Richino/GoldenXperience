"use client";

import { useEffect, useState } from "react";
import { usePageScrollLock } from "@/lib/use-page-scroll-lock";

/** Control the single server-rendered splash; never mount a second overlay. */
export function WelcomeScreen() {
  const [open, setOpen] = useState(false);
  usePageScrollLock(open);

  useEffect(() => {
    const root = document.documentElement;
    const screen = document.getElementById("gx-boot-splash");
    if (!screen || !root.classList.contains("gx-boot-splash")) return;
    const params = new URLSearchParams(window.location.search);
    const preview = params.has("splash") && params.get("splash") !== "launch";
    const held = params.get("splash") === "preview";
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== screen);
    const priorInert = background.map(node => node.inert);
    background.forEach(node => { node.inert = true; });
    screen.setAttribute("data-gx-launch-screen", "");
    screen.setAttribute("aria-hidden", "false");
    screen.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Browser launch mode is unavailable during SSR.
    setOpen(true);
    let leaving = false;
    let closed = false;
    let fadeTimer = 0;
    let cap = 0;

    const release = () => {
      root.classList.remove("gx-boot-splash");
      root.style.removeProperty("background-color");
      screen.removeAttribute("data-gx-launch-screen");
      delete screen.dataset.leaving;
      screen.setAttribute("aria-hidden", "true");
      background.forEach((node, index) => { node.inert = priorInert[index]; });
      previousFocus?.focus({ preventScroll: true });
    };
    const dismiss = () => {
      if (leaving || closed) return;
      leaving = true;
      observer?.disconnect();
      window.clearTimeout(cap);
      screen.dataset.leaving = "true";
      fadeTimer = window.setTimeout(() => {
        closed = true;
        release();
        if (!preview) {
          try { window.sessionStorage.setItem("gx-launch-screen-v2", "1"); } catch { /* Storage is optional. */ }
        }
        setOpen(false);
      }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260);
    };
    const ready = () => {
      if (window.location.pathname === "/login") return dismiss();
      const workspace = document.querySelector('[data-gx-workspace-ready="true"]');
      if (!workspace) return;
      const home = workspace.querySelector<HTMLElement>("[data-home-ready]");
      if (home ? home.dataset.homeReady === "true" : !workspace.querySelector('[aria-busy="true"][aria-label^="Loading "]')) dismiss();
    };
    const observer = preview ? null : new MutationObserver(ready);
    observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-gx-workspace-ready", "data-home-ready", "aria-busy"] });
    if (!held) cap = window.setTimeout(dismiss, preview ? 2200 : 8000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (["Escape", "Enter", " "].includes(event.key)) { event.preventDefault(); dismiss(); }
      if (event.key === "Tab" && !closed) { event.preventDefault(); screen.focus({ preventScroll: true }); }
    };
    screen.addEventListener("click", dismiss);
    screen.addEventListener("keydown", onKeyDown);
    if (!preview) ready();
    return () => {
      closed = true;
      observer?.disconnect();
      window.clearTimeout(cap);
      window.clearTimeout(fadeTimer);
      screen.removeEventListener("click", dismiss);
      screen.removeEventListener("keydown", onKeyDown);
      // Preserve the first-paint flag during React's development effect replay.
      screen.removeAttribute("data-gx-launch-screen");
      background.forEach((node, index) => { node.inert = priorInert[index]; });
    };
  }, []);

  return null;
}
