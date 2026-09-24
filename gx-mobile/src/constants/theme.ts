import { DynamicColorIOS, Platform } from 'react-native';

// iOS resolves DynamicColorIOS inside already-created native StyleSheets when
// Appearance.setColorScheme changes. This keeps theme changes live rather than
// requiring a bundle restart. Android falls back to its startup palette.
const adaptive = (light: string, dark: string) => Platform.OS === 'ios' ? DynamicColorIOS({ light, dark }) : dark;

export const theme = {
  colors: {
    background: adaptive('#f5f7f8', '#09090b'), surface: adaptive('#ffffff', '#131315'), surfaceRaised: adaptive('#eef1f2', '#1c1c1f'), surfaceMuted: adaptive('#f7f8f9', '#18181b'),
    surfaceInset: adaptive('rgba(16, 24, 32, 0.045)', 'rgba(255, 255, 255, 0.03)'), cardBorder: adaptive('rgba(16, 24, 32, 0.10)', 'rgba(255, 255, 255, 0.055)'),
    primary: adaptive('#00b878', '#00e59b'), primaryBright: adaptive('#009b66', '#3ef0ad'), primarySoft: adaptive('rgba(0, 184, 120, 0.14)', 'rgba(0, 229, 155, 0.14)'), primaryMuted: adaptive('rgba(0, 184, 120, 0.1)', 'rgba(0, 229, 155, 0.1)'),
    textPrimary: adaptive('#17191c', '#f4f4f5'), textSecondary: adaptive('#5f6770', '#a1a1aa'), textMuted: adaptive('#7b838c', '#6d7176'), textMutedStrong: adaptive('#414850', '#d4d4d8'),
    border: adaptive('rgba(16, 24, 32, 0.12)', 'rgba(255, 255, 255, 0.09)'), danger: adaptive('#df4350', '#ff6370'), dangerSoft: adaptive('rgba(223, 67, 80, 0.1)', 'rgba(255, 99, 112, 0.1)'),
    warning: adaptive('#c27016', '#d98324'), warningSoft: adaptive('rgba(194, 112, 22, 0.12)', 'rgba(217, 131, 36, 0.12)'), currencyBadge: adaptive('rgba(223, 67, 80, 0.1)', 'rgba(255, 99, 112, 0.1)'),
    chartUp: adaptive('#00b878', '#00e59b'), chartDown: adaptive('#e14b57', '#ff5252'),
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  radii: {
    sm: 8,
    md: 12,
    lg: 16,
    xl: 18,
    hero: 22,
    pill: 999,
  },
  shadow: {
    card: {
      shadowColor: adaptive('#27313a', '#000000'),
      shadowOffset: { width: 0, height: 16 },
      shadowOpacity: 0.22,
      shadowRadius: 24,
      elevation: 6,
    },
    dock: {
      shadowColor: adaptive('#27313a', '#000000'),
      shadowOffset: { width: 0, height: 11 },
      shadowOpacity: 0.3,
      shadowRadius: 28,
      elevation: 12,
    },
  },
  fonts: {
    sans: 'Geist_400Regular',
    sansMedium: 'Geist_500Medium',
    sansSemiBold: 'Geist_600SemiBold',
    sansBold: 'Geist_700Bold',
    sansExtraBold: 'Geist_800ExtraBold',
    mono: 'GeistMono_400Regular',
    monoMedium: 'GeistMono_500Medium',
    monoSemiBold: 'GeistMono_600SemiBold',
    monoBold: 'GeistMono_700Bold',
  },
} as const;

export type Theme = typeof theme;

/**
 * Plain-string light/dark pairs for the handful of colors used inside SVG
 * (react-native-svg `Stop`/`Line`/`Path` props, expo-linear-gradient
 * `colors` arrays). Those render outside RN's style system, which is the
 * only thing that knows how to resolve `DynamicColorIOS` — passed one of
 * those objects directly, SVG logs "[object Object] is not a valid color".
 * Pick a variant with `rawColors[themeMode]` (see PreferencesContext).
 */
export const rawColors = {
  light: { chartUp: '#00b878', chartDown: '#e14b57', textMuted: '#7b838c', border: 'rgba(16, 24, 32, 0.12)', background: '#f5f7f8', chartPage: '#ffffff', primary: '#00b878' },
  dark: { chartUp: '#00e59b', chartDown: '#ff5252', textMuted: '#6d7176', border: 'rgba(255, 255, 255, 0.09)', background: '#09090b', chartPage: '#09090b', primary: '#00e59b' },
} as const;
