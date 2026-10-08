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
    // Desktop draws the chart inside a #141612 card; the phone (embedded) runs
    // edge to edge on the page ground.
    background: "#141612",
    embeddedBackground: "#0b0c0a",
    scaleText: "#9ca195",
    up: "#c8f560",
    down: "#ff8a5b",
    onUp: "#0b0c0a",
    onDown: "#0b0c0a",
    upLine: "rgba(200, 245, 96, 0.45)",
    downLine: "rgba(255, 138, 91, 0.55)",
    stopLine: "rgba(255, 138, 91, 0.9)",
    horzGrid: "rgba(241, 242, 236, 0.05)",
    vertGrid: "rgba(241, 242, 236, 0.025)",
  },
  light: {
    background: "#ffffff",
    embeddedBackground: "#ffffff",
    scaleText: "#61675a",
    up: "#5b8c00",
    down: "#e0672f",
    onUp: "#ffffff",
    onDown: "#ffffff",
    upLine: "rgba(91, 140, 0, 0.45)",
    downLine: "rgba(224, 103, 47, 0.55)",
    stopLine: "#e0672f",
    horzGrid: "rgba(20, 22, 18, 0.06)",
    vertGrid: "rgba(20, 22, 18, 0.035)",
  },
} as const;

export function chartColors(isDark: boolean) {
  return isDark ? CHART_COLORS.dark : CHART_COLORS.light;
}
