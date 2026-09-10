import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/components/ui/Screen";
import { Card } from "@/components/ui/Card";
import { AppText } from "@/components/ui/AppText";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";

/**
 * Chart tab — intentionally a shell for Phase 1. The route exists so bottom
 * navigation is complete, but the trading chart is deliberately deferred to
 * Phase 2 (brief §23): it will be built against the approved GX Chart design
 * with a considered charting integration, not a stand-in library.
 */
export default function ChartRoute() {
  const colors = useColors();
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: spacing.lg, paddingBottom: 80 }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 20,
            backgroundColor: colors.gxAccentSoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="stats-chart" size={30} color={colors.gxAccent} />
        </View>
        <View style={{ alignItems: "center", gap: spacing.xs }}>
          <AppText size="lg" weight="700">
            Chart
          </AppText>
          <AppText tone="secondary" size="sm" style={{ textAlign: "center", maxWidth: 280 }}>
            The GX trading chart arrives in Phase 2, built to the approved chart design with live candles, signal overlays and a full-screen landscape mode.
          </AppText>
        </View>
        <Card style={{ width: "100%" }}>
          <AppText tone="muted" eyebrow>
            Planned for Phase 2
          </AppText>
          <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
            {["Live candles from /api/oanda/candles", "Signal entry / SL / TP overlays", "Landscape full-screen mode", "Pair + timeframe switching"].map((item) => (
              <View key={item} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <Ionicons name="ellipse" size={6} color={colors.gxAccent} />
                <AppText size="sm" tone="secondary">
                  {item}
                </AppText>
              </View>
            ))}
          </View>
        </Card>
      </View>
    </Screen>
  );
}
