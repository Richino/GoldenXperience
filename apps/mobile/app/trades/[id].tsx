import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { Card } from "@/components/ui/Card";
import { AppText } from "@/components/ui/AppText";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { spacing } from "@/theme/tokens";

/**
 * Trade detail — a Phase 1 stub. The route and navigation work now; the full
 * marked-up trade view (live P/L, chart overlay, execution timeline) lands with
 * the Phase 2 chart work.
 */
export default function TradeDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Screen scroll>
      <DetailHeader title="Trade" />
      <Card>
        <AppText tone="muted" eyebrow>
          Trade reference
        </AppText>
        <AppText size="sm" weight="600" mono style={{ marginTop: 4 }}>
          {id}
        </AppText>
        <View style={{ marginTop: spacing.md }}>
          <AppText tone="secondary" size="sm">
            The detailed trade view arrives in Phase 2 alongside the GX chart.
          </AppText>
        </View>
      </Card>
    </Screen>
  );
}
