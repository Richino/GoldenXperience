"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { TextSizeProvider } from "@/components/providers/text-size-provider";
import { ThemeColorSync } from "@/components/providers/theme-color-sync";
import { ThemeProvider } from "@/components/providers/theme-provider";

const WelcomeScreen = dynamic(() => import("@/components/welcome/welcome-screen").then((module) => module.WelcomeScreen), { ssr: false });

/** Attach the controller to the existing splash; it renders no overlay. */
function LaunchScreen() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (document.documentElement.classList.contains("gx-boot-splash") || new URLSearchParams(window.location.search).has("splash")) {
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
