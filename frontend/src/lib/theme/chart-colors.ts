/**
 * Night Ledger chart palette.
 *
 * lightweight-charts paints to a canvas, so it cannot read the CSS custom
 * properties in night-ledger.css. These values mirror them; change both
 * together. Up and down differ in lightness as well as hue, so the two
 * directions stay distinguishable without relying on colour alone.
 */
export const CHART_COLORS = {
  dark: {
    // Desktop and phone both run the chart full-bleed on the chart ground
    // (night-ledger.css --chart-ground).
    background: "#0e100d",
    embeddedBackground: "#0e100d",
    scaleText: "#9ca195",
    scaleBorder: "rgba(241, 242, 236, 0.1)",
    up: "#c8f560",
    down: "#ff8a5b",
    onUp: "#0b0c0a",
    onDown: "#0b0c0a",
    upLine: "rgba(200, 245, 96, 0.45)",
    downLine: "rgba(255, 138, 91, 0.55)",
    stopLine: "rgba(255, 138, 91, 0.9)",
    horzGrid: "rgba(241, 242, 236, 0.05)",
    vertGrid: "rgba(241, 242, 236, 0.025)",
    // A pending order's entry line (night-ledger.css --pending).
    pending: "#ffc14d",
    // Crosshair lines and their price / time readouts.
    crosshairLine: "rgba(156, 161, 149, 0.6)",
    crosshairTag: "#1b1e19",
    crosshairText: "#f1f2ec",
    // Session bands, their labels and volume (chart-backdrop-primitive).
    backdrop: {
      londonBand: "rgba(241, 242, 236, 0.025)",
      newYorkBand: "rgba(200, 245, 96, 0.045)",
      londonLabel: "#9ca195",
      newYorkLabel: "#c8f560",
      volume: "rgba(241, 242, 236, 0.07)",
    },
  },
  light: {
    background: "#fcfcf9",
    embeddedBackground: "#fcfcf9",
    scaleText: "#61675a",
    scaleBorder: "rgba(20, 22, 18, 0.1)",
    up: "#5b8c00",
    down: "#e0672f",
    onUp: "#ffffff",
    onDown: "#ffffff",
    upLine: "rgba(91, 140, 0, 0.45)",
    downLine: "rgba(224, 103, 47, 0.55)",
    stopLine: "#e0672f",
    horzGrid: "rgba(20, 22, 18, 0.06)",
    vertGrid: "rgba(20, 22, 18, 0.035)",
    pending: "#8a5a12",
    crosshairLine: "rgba(97, 103, 90, 0.55)",
    crosshairTag: "#eeefe8",
    crosshairText: "#141612",
    backdrop: {
      londonBand: "rgba(20, 22, 18, 0.025)",
      newYorkBand: "rgba(110, 160, 0, 0.06)",
      londonLabel: "#61675a",
      newYorkLabel: "#4e7a00",
      volume: "rgba(20, 22, 18, 0.08)",
    },
  },
} as const;

export function chartColors(isDark: boolean) {
  return isDark ? CHART_COLORS.dark : CHART_COLORS.light;
}
