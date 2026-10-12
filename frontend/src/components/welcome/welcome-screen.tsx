"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePageScrollLock } from "@/lib/use-page-scroll-lock";
import { OBSERVER_MASCOT_ASSETS } from "@/lib/observer-mascot";
import styles from "./welcome-screen.module.css";

/**
 * Default app launch screen, once per browser/home-screen app session.
 * ?splash=1 previews the transition; ?splash=preview holds it for review.
 */

const SEEN_KEY = "gx-launch-screen-v2";
const SHOW_MS = 2200;

export function WelcomeScreen() {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const heldPreview = useRef(false);
  const isPreview = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const screen = useRef<HTMLDivElement | null>(null);

  // Decided after mount so SSR and hydration agree.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const preview = params.has("splash");
    isPreview.current = preview;
    heldPreview.current = params.get("splash") === "preview";
    let seen = false;
    if (!preview) {
      try {
        seen = window.sessionStorage.getItem(SEEN_KEY) === "1";
      } catch {
        seen = false;
      }
    }
    // The static first-paint copy (layout.tsx, #gx-boot-splash) stays until
    // this animated one has faded in on top of it, then steps aside.
    const releaseBootSplash = () => {
      document.documentElement.classList.remove("gx-boot-splash");
      // The head script painted <html> dark for the gap before the body arrived.
      document.documentElement.style.removeProperty("background-color");
    };
    if (!seen) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Browser launch mode is unavailable during SSR.
      setOpen(true);
      // Hand over only once the animated mascot is decoded (after the 300ms
      // fade-in), so there is never a frame without it; never later than 1.5s.
      let released = false;
      const release = () => { if (!released) { released = true; releaseBootSplash(); } };
      const cap = window.setTimeout(release, 1500);
      const handover = window.setTimeout(() => {
        const mascot = document.querySelector<HTMLImageElement>('[aria-label="Welcome to GoldenXperience"] img');
        if (!mascot) return release();
        mascot.decode().then(release, release);
      }, 350);
      return () => { window.clearTimeout(cap); window.clearTimeout(handover); };
    }
    releaseBootSplash();
  }, []);

  const dismiss = useCallback(() => {
    if (!isPreview.current) {
      try {
        window.sessionStorage.setItem(SEEN_KEY, "1");
      } catch {
        // Private mode: it simply shows again next launch.
      }
    }
    setLeaving(true);
  }, []);

  usePageScrollLock(open);
  useLayoutEffect(() => {
    if (!open) return;
    const background = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== screen.current);
    const priorInert = background.map(node => node.inert);
    background.forEach(node => { node.inert = true; });
    const focus = previousFocus.current;
    return () => {
      background.forEach((node, index) => { node.inert = priorInert[index]; });
      focus?.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    screen.current?.focus({ preventScroll: true });
    const timer = heldPreview.current ? null : window.setTimeout(dismiss, SHOW_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
      if (event.key === "Tab") {
        event.preventDefault();
        screen.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dismiss, open]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setOpen(false);
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (!open) return null;
  const mascot = OBSERVER_MASCOT_ASSETS.neutral;

  return createPortal(
    <div
      ref={screen}
      className={`${styles.screen}${leaving ? ` ${styles.leaving}` : ""}`}
      role="dialog" aria-modal="true" aria-label="Welcome to GoldenXperience"
      aria-describedby="gx-splash-instructions"
      tabIndex={-1}
      onClick={dismiss}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); dismiss(); }
      }}
    >
      <div className={styles.grid} aria-hidden="true" />
      <span id="gx-splash-instructions" className={styles.instructions}>Tap anywhere or press Enter to open your workspace.</span>
      <main className={styles.center}>
        <div className={styles.character}>
          <div className={styles.orbit} aria-hidden="true"><span /><span /></div>
          <picture>
            <source media="(prefers-reduced-motion: reduce)" srcSet={mascot.still} />
            <Image src="/splash/gx-mascot-loop.webp" alt="GX robot mascot" width={256} height={256} unoptimized loading="eager" />
          </picture>
          <span className={styles.spark} aria-hidden="true">✦</span>
        </div>
        <p className={styles.eyebrow}>YOUR TRADING WORKSPACE</p>
        <h1>Golden<span>X</span>perience<span className={styles.period}>.</span></h1>
        <p className={styles.tagline}>See the market clearly.</p>
      </main>
      <footer className={styles.footer}>
        <div className={styles.pulse} aria-hidden="true"><span /><span /><span /><span /><span /></div>
      </footer>
    </div>, document.body,
  );
}
