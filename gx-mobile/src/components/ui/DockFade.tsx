import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { rawColors, type ThemeColors } from '@/constants/theme';
import { useThemedStyles } from '@/lib/theme/useTheme';
import { usePreferences } from '@/lib/preferences/PreferencesContext';

/**
 * A soft page-to-dock transition with a white-only light-mode scrim.
 * Uses `rawColors` (plain strings), not `theme.colors` — expo-linear-gradient
 * renders through react-native-svg, which can't resolve the `DynamicColorIOS`
 * object `colors.*` returns on iOS ("[object Object] is not a valid
 * color").
 */
export function DockFade({ height = 96 }: { height?: number }) {
  const styles = useThemedStyles(createStyles);
  const { themeMode } = usePreferences();
  const isLightTheme = themeMode === 'light';
  return (
    <LinearGradient
      pointerEvents="none"
      colors={isLightTheme
        ? ['transparent', 'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0.82)', '#ffffff']
        : ['transparent', 'rgba(9, 9, 11, 0.46)', rawColors.dark.background, rawColors.dark.background]}
      locations={[0, 0.45, 0.76, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[styles.fade, { height }]}
    />
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  // The navigator renders the dock above each tab scene. This layer only
  // needs to sit above a scene's scroll content, including Journal's cards.
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 5 },
});
