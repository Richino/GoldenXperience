import { Platform } from 'react-native';

import palette from './palette.json';

type ColorName = keyof typeof palette;
export type ThemeMode = 'light' | 'dark';
export type ThemeColors = Record<ColorName, string>;

function paletteFor(index: 0 | 1): ThemeColors {
  return Object.fromEntries(Object.entries(palette).map(([name, pair]) => [name, pair[index]])) as ThemeColors;
}

/**
 * Plain light and dark palettes. Screens read the active one with
 * useThemeColors() / useThemedStyles() (src/lib/theme), so a theme switch
 * re-renders everything with the new colours on iOS, Android and web alike.
 */
export const palettes: Record<ThemeMode, ThemeColors> = { light: paletteFor(0), dark: paletteFor(1) };

/**
 * Android turns `elevation` into a hard, box-shaped shadow (dark on light
 * cards, a visible square around the rounded dock). On Android use a soft CSS
 * box-shadow instead, which follows border radius; iOS keeps its shadow props.
 */
const android = Platform.OS === 'android';
function androidShadow(boxShadow: string) {
  return { boxShadow, elevation: 0 };
}

/** Card and dock shadows; their colour follows the theme. */
export function shadows(colors: ThemeColors) {
  const dark = colors.shadow === palettes.dark.shadow;
  if (android) {
    return {
      card: androidShadow(dark ? '0px 10px 24px rgba(0, 0, 0, 0.32)' : '0px 8px 22px rgba(39, 49, 58, 0.10)'),
      dock: androidShadow(dark ? '0px 10px 26px rgba(0, 0, 0, 0.4)' : '0px 8px 24px rgba(39, 49, 58, 0.14)'),
    } as const;
  }
  return {
    card: { shadowColor: colors.shadow, shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.22, shadowRadius: 24, elevation: 6 },
    dock: { shadowColor: colors.shadow, shadowOffset: { width: 0, height: 11 }, shadowOpacity: 0.3, shadowRadius: 28, elevation: 12 },
  } as const;
}

/** The lighter lift light-theme cards use on top of their card shadow. */
export const lightCardShadow = android
  ? androidShadow('0px 6px 18px rgba(82, 97, 108, 0.10)')
  : { shadowColor: '#52616c', shadowOffset: { width: 0, height: 9 }, shadowOpacity: 0.075, shadowRadius: 22, elevation: 2 };

/** Small floating controls (the Home bell). */
export function floatingShadow(colors: ThemeColors) {
  return android
    ? androidShadow(colors.shadow === palettes.dark.shadow ? '0px 6px 16px rgba(0, 0, 0, 0.35)' : '0px 6px 16px rgba(39, 49, 58, 0.14)')
    : { shadowColor: colors.shadow, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.16, shadowRadius: 16, elevation: 8 };
}

export const theme = {
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

/** Plain strings for SVG and gradient props (kept for existing callers; same values as palettes). */
export const rawColors = {
  light: { ...palettes.light, chartPage: '#ffffff' },
  dark: { ...palettes.dark, chartPage: '#09090b' },
} as const;
