"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The app-open splash: the GoldenXperience robot art with the app name on
 * top, nothing else over it. Only in the installed iOS / Android app
 * (home-screen PWA), once per launch; it fades out on its own after a moment
 * and a tap skips it. `?splash=1` previews it anywhere.
 */

const SEEN_KEY = "gx-welcome-seen";
const SHOW_MS = 2200;

/** The home-screen app on a phone: standalone display mode on iOS or Android. */
function isInstalledPhoneApp() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone && /iPhone|iPad|iPod|Android/i.test(window.navigator.userAgent);
}

export function WelcomeScreen() {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Decided after mount so SSR and hydration agree.
  useEffect(() => {
    const preview = new URLSearchParams(window.location.search).has("splash");
    if (!preview && !isInstalledPhoneApp()) return;
    let seen = false;
    if (!preview) {
      try {
        seen = window.sessionStorage.getItem(SEEN_KEY) === "1";
      } catch {
        seen = false;
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!seen) setOpen(true);
  }, []);

  const dismiss = useCallback(() => {
    try {
      window.sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Private mode: it simply shows again next launch.
    }
    setLeaving(true);
    window.setTimeout(() => setOpen(false), 260);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(dismiss, SHOW_MS);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previous;
    };
  }, [dismiss, open]);

  if (!open) return null;

  return (
    <div
      className={`gx-welcome${leaving ? " is-leaving" : ""}`}
      role="presentation"
      onClick={dismiss}
    >
      <div className="gx-welcome-art">
        <header className="gx-welcome-title">
          <h1>
            Golden<span>X</span>perience
          </h1>
        </header>
      </div>
    </div>
  );
}
