import { useMemo } from 'react';

import { palettes, type ThemeColors } from '@/constants/theme';
import { usePreferences } from '@/lib/preferences/PreferencesContext';

/** The active palette (light or dark, from Settings). */
export function useThemeColors(): ThemeColors {
  const { themeMode } = usePreferences();
  return palettes[themeMode];
}

/**
 * Styles built from the active palette, rebuilt only when the theme changes.
 * Pass a module-level factory so the memo key stays stable:
 *   const createStyles = (colors: ThemeColors) => StyleSheet.create({ ... });
 *   const styles = useThemedStyles(createStyles);
 */
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T): T {
  const colors = useThemeColors();
  return useMemo(() => factory(colors), [factory, colors]);
}
