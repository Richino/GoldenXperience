"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { TextSizeProvider } from "@/components/providers/text-size-provider";
import { ThemeColorSync } from "@/components/providers/theme-color-sync";
import { ThemeProvider } from "@/components/providers/theme-provider";

const WelcomeScreen = dynamic(() => import("@/components/welcome/welcome-screen").then((module) => module.WelcomeScreen), { ssr: false });

/** Keep launch artwork until hydration, with no minimum wait before use. */
function LaunchScreen() {
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("splash")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Explicit browser-only design preview.
      setPreview(true);
      return;
    }
    document.documentElement.classList.remove("gx-boot-splash");
    document.documentElement.style.removeProperty("background-color");
    try {
      window.sessionStorage.setItem("gx-launch-screen-v2", "1");
    } catch {
      // Storage is optional; it must never delay opening the workspace.
    }
  }, []);
  return preview ? <WelcomeScreen /> : null;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ThemeColorSync />
      <TextSizeProvider><LaunchScreen />{children}</TextSizeProvider>
    </ThemeProvider>
  );
}
