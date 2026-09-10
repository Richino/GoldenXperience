import { View } from "react-native";
import { AppText } from "@/components/ui/AppText";
import { SideTag } from "@/components/ui/Tags";
import { EmptyState } from "@/components/ui/States";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";
import { formatDayAndTime, formatR } from "@/lib/format";
import { RECENT_OUTCOME_LABEL, type RecentSignal } from "@/lib/signals";

/** Compact rows for closed signals — history uses rows, not the active cards. */
export function HistoryList({ items }: { items: RecentSignal[] }) {
  const colors = useColors();
  if (items.length === 0) {
    return <EmptyState title="No closed signals yet" hint="Resolved strategy signals will be listed here." />;
  }
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
      {items.map((item, index) => {
        const tone = item.outcome === "tp" ? colors.positive : item.outcome === "sl" ? colors.negative : colors.textSecondary;
        return (
          <View
            key={item.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.md,
              borderBottomWidth: index === items.length - 1 ? 0 : 1,
              borderBottomColor: colors.border,
              backgroundColor: colors.surface,
            }}
          >
            <View style={{ flex: 1.3, flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <AppText size="sm" weight="600">
                {item.pair}
              </AppText>
              <SideTag direction={item.direction} />
            </View>
            <View style={{ flex: 1.1 }}>
              <AppText size="xs" style={{ color: tone }} weight="600">
                {RECENT_OUTCOME_LABEL[item.outcome]}
              </AppText>
              <AppText tone="muted" size="xs">
                {item.closedAt ? formatDayAndTime(item.closedAt) : "—"}
              </AppText>
            </View>
            <AppText size="sm" mono weight="600" style={{ color: (item.resultR ?? 0) >= 0 ? colors.positive : colors.negative }}>
              {formatR(item.resultR, 1)}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}
