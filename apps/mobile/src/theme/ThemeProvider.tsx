import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import { palettes, type ThemeColors, type ThemeName } from "@/theme/tokens";

export type ThemePreference = ThemeName | "system";

const PREF_KEY = "gx.theme.preference";

interface ThemeContextValue {
  /** The resolved theme actually painted right now. */
  name: ThemeName;
  colors: ThemeColors;
  /** "system" follows the OS; "light"/"dark" force a fixed theme. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  // Load the saved override once on mount. SecureStore can reject (no keychain
  // in some contexts), so the read is guarded and simply falls back to system.
  useEffect(() => {
    let active = true;
    SecureStore.getItemAsync(PREF_KEY)
      .then((value) => {
        if (active && (value === "light" || value === "dark" || value === "system")) {
          setPreferenceState(value);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    void SecureStore.setItemAsync(PREF_KEY, next).catch(() => undefined);
  }, []);

  const name: ThemeName = preference === "system" ? (system === "dark" ? "dark" : "light") : preference;

  const value = useMemo<ThemeContextValue>(
    () => ({ name, colors: palettes[name], preference, setPreference }),
    [name, preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider.");
  return context;
}

/** Convenience: the active palette only, for components that just need colours. */
export function useColors(): ThemeColors {
  return useTheme().colors;
}
