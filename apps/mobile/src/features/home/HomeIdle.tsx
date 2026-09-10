import { View } from "react-native";
import { Card } from "@/components/ui/Card";
import { AppText } from "@/components/ui/AppText";
import { SectionHeader, SectionLabel } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/States";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";
import { formatR, formatSignedMoney, relativeTime } from "@/lib/format";
import { useStreamStatus } from "@/realtime/MarketStreamProvider";
import type { HomeActivityItem, HomeUpcomingItem } from "@/lib/home";
import type { ConnectionStatus } from "@/types/api";

/**
 * GX Status — the anchor of the idle hierarchy. Reports the live posture of the
 * system honestly: the stream phase (live/simulated/offline) and which OANDA
 * environment is connected. No invented "next window" countdown.
 */
export function GxStatus({ connection, monitoredCount }: { connection: ConnectionStatus; monitoredCount: number }) {
  const colors = useColors();
  const status = useStreamStatus();

  const live = status.phase === "connected" && status.source === "oanda";
  const simulated = status.phase === "connected" && status.source === "mock";
  const dot = live ? colors.positive : simulated ? colors.warning : status.phase === "offline" ? colors.negative : colors.warning;
  const headline = live
    ? "Monitoring the markets"
    : simulated
      ? "Monitoring simulated data"
      : status.phase === "offline"
        ? "Market stream offline"
        : "Connecting to the markets";

  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
        <AppText size="md" weight="700">
          {headline}
        </AppText>
      </View>
      <AppText tone="secondary" size="sm" style={{ marginTop: spacing.sm }}>
        {monitoredCount} pairs tracked · {connection.environment === "live" ? "Live" : "Practice"} account · {connection.source === "oanda" ? "OANDA" : connection.source}
      </AppText>
    </Card>
  );
}

export function Upcoming({ items }: { items: HomeUpcomingItem[] }) {
  const colors = useColors();
  return (
    <View>
      <SectionLabel>Upcoming</SectionLabel>
      {items.length === 0 ? (
        <EmptyState title="No setups forming" hint="Pairs developing toward a valid setup will show here." />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((item) => (
            <View
              key={item.instrument}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                paddingVertical: spacing.sm,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <AppText size="sm" weight="600">
                {item.pair}
              </AppText>
              <AppText tone="muted" size="xs">
                {item.strategy} · forming
              </AppText>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function RecentActivity({ items, currency }: { items: HomeActivityItem[]; currency: string }) {
  const colors = useColors();
  return (
    <View>
      <SectionHeader title="Recent activity" />
      {items.length === 0 ? (
        <EmptyState title="No recent activity" hint="Closed trades from your GX account will appear here." />
      ) : (
        <View style={{ gap: 2 }}>
          {items.map((item) => {
            const tone = item.kind === "tp" ? colors.positive : item.kind === "sl" ? colors.negative : colors.textSecondary;
            return (
              <View
                key={item.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingVertical: spacing.sm,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                }}
              >
                <View style={{ gap: 2 }}>
                  <AppText size="sm" weight="600">
                    {item.pair}
                  </AppText>
                  <AppText size="xs" style={{ color: tone }}>
                    {item.label} · {relativeTime(item.at)}
                  </AppText>
                </View>
                <View style={{ alignItems: "flex-end", gap: 2 }}>
                  <AppText size="sm" mono weight="600" style={{ color: (item.resultR ?? 0) >= 0 ? colors.positive : colors.negative }}>
                    {formatR(item.resultR)}
                  </AppText>
                  {item.paperPl !== null ? (
                    <AppText tone="muted" size="xs" mono>
                      {formatSignedMoney(item.paperPl, currency)}
                    </AppText>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
