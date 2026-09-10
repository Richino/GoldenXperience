/**
 * GX Design System V1 — semantic design tokens.
 *
 * Ported verbatim from the web app's `frontend/src/app/globals.css` `:root`
 * (light) and `.dark` blocks so the mobile client and the web dashboard share
 * one visual identity: near-black premium dark, soft off-white light, the
 * emerald GX accent, and restrained green/red trading semantics.
 *
 * Components consume these SEMANTIC names (`colors.surfaceElevated`,
 * `colors.positive`) — never a raw hex — so a single theme swap re-skins the
 * whole app and light was designed alongside dark rather than bolted on.
 */

export type ThemeName = "light" | "dark";

export interface ThemeColors {
  /** App canvas behind all surfaces. */
  background: string;
  /** Default card / panel fill. */
  surface: string;
  /** A card raised above another surface (nested rows, sheets). */
  surfaceElevated: string;
  /** Muted inset fill (track backgrounds, pressed states). */
  surfaceMuted: string;
  textPrimary: string;
  /** Labels and secondary figures — still legible, lower emphasis. */
  textSecondary: string;
  /** De-emphasised meta text (timestamps, units). */
  textMuted: string;
  border: string;
  borderStrong: string;
  /** The GX emerald identity colour. */
  gxAccent: string;
  gxAccentBright: string;
  /** Low-alpha accent wash for selected/active fills. */
  gxAccentSoft: string;
  /** Gains, long side, wins. */
  positive: string;
  positiveSoft: string;
  /** Losses, short side, stops. */
  negative: string;
  negativeSoft: string;
  /** A setup part-way to valid — between "nothing" and "ready". */
  warning: string;
  warningSoft: string;
  chartUp: string;
  chartDown: string;
  chartGrid: string;
  /** Low-alpha wash for the active bottom-tab / selected row. */
  navActive: string;
  /** Colour applied to the OS status bar contents ("light"/"dark"). */
  statusBar: ThemeName;
}

const light: ThemeColors = {
  background: "#f2f2f7",
  surface: "#ffffff",
  surfaceElevated: "#f5f5f7",
  surfaceMuted: "#e5e5ea",
  textPrimary: "#1c1c1e",
  textSecondary: "#636366",
  textMuted: "#8e8e93",
  border: "rgba(0, 0, 0, 0.08)",
  borderStrong: "rgba(0, 0, 0, 0.14)",
  gxAccent: "#00b377",
  gxAccentBright: "#00d68f",
  gxAccentSoft: "rgba(0, 179, 119, 0.1)",
  positive: "#00b377",
  positiveSoft: "rgba(0, 179, 119, 0.1)",
  negative: "#e74c3c",
  negativeSoft: "rgba(231, 76, 60, 0.1)",
  warning: "#d98324",
  warningSoft: "rgba(217, 131, 36, 0.12)",
  chartUp: "#00a06a",
  chartDown: "#e74c3c",
  chartGrid: "rgba(28, 28, 30, 0.075)",
  navActive: "rgba(0, 179, 119, 0.1)",
  statusBar: "dark",
};

const dark: ThemeColors = {
  background: "#09090b",
  surface: "#131315",
  surfaceElevated: "#1c1c1f",
  surfaceMuted: "#18181b",
  textPrimary: "#f4f4f5",
  textSecondary: "#d4d4d8",
  textMuted: "#a1a1aa",
  border: "rgba(255, 255, 255, 0.09)",
  borderStrong: "rgba(255, 255, 255, 0.14)",
  gxAccent: "#00e59b",
  gxAccentBright: "#3ef0ad",
  gxAccentSoft: "rgba(0, 229, 155, 0.14)",
  positive: "#00e59b",
  positiveSoft: "rgba(0, 229, 155, 0.14)",
  negative: "#ff6370",
  negativeSoft: "rgba(255, 99, 112, 0.14)",
  warning: "#f5a524",
  warningSoft: "rgba(245, 165, 36, 0.16)",
  chartUp: "#00e59b",
  chartDown: "#ff6370",
  chartGrid: "rgba(244, 244, 245, 0.075)",
  navActive: "rgba(0, 229, 155, 0.13)",
  statusBar: "light",
};

export const palettes: Record<ThemeName, ThemeColors> = { light, dark };

/**
 * Spacing, radii and type scale are theme-independent. The type scale keeps the
 * web's compact financial feel but is nudged up a step for touch legibility.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  card: 20,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 12,
  base: 13,
  md: 14,
  lg: 16,
  xl: 20,
  price: 22,
  hero: 34,
} as const;

/**
 * Platform mono stack for figures. Tabular, so columns of prices and P/L line
 * up. Matches the web's use of a mono face for every `metric-number`.
 */
export const monoFont = "ui-monospace, SFMono-Regular, Menlo, monospace";
