"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { TextSizeProvider } from "@/components/providers/text-size-provider";
import { ThemeColorSync } from "@/components/providers/theme-color-sync";
import { ThemeProvider } from "@/components/providers/theme-provider";

const WelcomeScreen = dynamic(() => import("@/components/welcome/welcome-screen").then((module) => module.WelcomeScreen), { ssr: false });

/** The native PWA launch screen is enough; this controller is preview-only. */
function LaunchScreen() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const mode = new URLSearchParams(window.location.search).get("splash");
    if (mode === "preview" || mode === "launch") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Launch mode is decided by the first-paint browser script.
      setActive(true);
      return;
    }
    document.documentElement.classList.remove("gx-boot-splash");
    document.documentElement.style.removeProperty("background-color");
  }, []);
  return active ? <WelcomeScreen /> : null;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ThemeColorSync />
      <TextSizeProvider><LaunchScreen />{children}</TextSizeProvider>
    </ThemeProvider>
  );
}
