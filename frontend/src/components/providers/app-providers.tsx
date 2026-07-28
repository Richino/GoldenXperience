"use client";

import { TextSizeProvider } from "@/components/providers/text-size-provider";
import { ThemeColorSync } from "@/components/providers/theme-color-sync";
import { ThemeProvider } from "@/components/providers/theme-provider";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ThemeColorSync />
      <TextSizeProvider>{children}</TextSizeProvider>
    </ThemeProvider>
  );
}
