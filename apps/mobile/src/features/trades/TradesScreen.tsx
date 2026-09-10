import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { AppText } from "@/components/ui/AppText";
import { Skeleton } from "@/components/ui/Skeleton";
import { SectionLabel } from "@/components/ui/Section";
import { SideTag } from "@/components/ui/Tags";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { useColors } from "@/theme/ThemeProvider";
import { radius, spacing } from "@/theme/tokens";
import { getJournalTrades } from "@/api/endpoints";
import { useResource } from "@/hooks/useResource";
import { displayNameFor, formatPrice } from "@/lib/instruments";
import { formatDayAndTime, formatR, formatSignedMoney } from "@/lib/format";
import type { JournalTrade } from "@/types/forex";

export function TradesScreen() {
  const colors = useColors();
  const router = useRouter();
  const [tab, setTab] = useState<"open" | "closed">("open");
  const loader = useCallback((signal: AbortSignal) => getJournalTrades({ limit: 50, filter: "all" }, signal), []);
  const { data, loading, refreshing, error, refresh } = useResource(loader, { intervalMs: 45_000 });

  const { open, closed } = useMemo(() => {
    const trades = data?.trades ?? [];
    return {
      open: trades.filter((trade) => trade.status === "open"),
      closed: trades.filter((trade) => trade.status === "closed"),
    };
  }, [data]);

  if (loading && !data) return <TradesSkeleton />;

  const rows = tab === "open" ? open : closed;

  return (
    <Screen scroll refreshing={refreshing} onRefresh={refresh}>
      <AppText size="xl" weight="800">
        Trades
      </AppText>

      <View style={{ flexDirection: "row", backgroundColor: colors.surfaceMuted, borderRadius: radius.md, padding: 3 }}>
        {(["open", "closed"] as const).map((key) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            style={{
              flex: 1,
              paddingVertical: spacing.sm,
              borderRadius: radius.sm,
              backgroundColor: tab === key ? colors.surface : "transparent",
              alignItems: "center",
            }}
          >
            <AppText size="sm" weight="600" tone={tab === key ? "primary" : "muted"}>
              {key === "open" ? `Open (${open.length})` : `Closed (${closed.length})`}
            </AppText>
          </Pressable>
        ))}
      </View>

      {error && !data ? <ErrorState error={error} onRetry={refresh} /> : null}

      <View>
        <SectionLabel>{tab === "open" ? "Open positions" : "Closed trades"}</SectionLabel>
        {rows.length === 0 ? (
          <EmptyState
            title={tab === "open" ? "No open trades" : "No closed trades"}
            hint="Trades executed by the GX engine appear here."
          />
        ) : (
          <View style={{ borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
            {rows.map((trade, index) => (
              <TradeRow key={trade.id} trade={trade} isLast={index === rows.length - 1} onPress={() => router.push(`/trades/${trade.id}`)} />
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

function TradeRow({ trade, isLast, onPress }: { trade: JournalTrade; isLast: boolean; onPress: () => void }) {
  const colors = useColors();
  const instrument = trade.instrument ?? trade.pair.replace("/", "_");
  const rTone = (trade.resultR ?? 0) >= 0 ? colors.positive : colors.negative;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        backgroundColor: pressed ? colors.surfaceMuted : colors.surface,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
      })}
    >
      <View style={{ flex: 1.4, flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <AppText size="sm" weight="700">
          {trade.instrument ? displayNameFor(trade.instrument) : trade.pair}
        </AppText>
        <SideTag direction={trade.direction} />
      </View>
      <View style={{ flex: 1.2 }}>
        <AppText size="xs" tone="secondary" mono>
          {formatPrice(trade.entry, instrument)}
        </AppText>
        <AppText tone="muted" size="xs">
          {trade.status === "closed" && trade.closedAt ? formatDayAndTime(trade.closedAt) : "Open"}
        </AppText>
      </View>
      <View style={{ flex: 1, alignItems: "flex-end" }}>
        <AppText size="sm" mono weight="600" style={{ color: trade.status === "closed" ? rTone : colors.textSecondary }}>
          {trade.status === "closed" ? formatR(trade.resultR, 1) : "—"}
        </AppText>
        {trade.paperPl !== null && trade.paperPl !== undefined ? (
          <AppText tone="muted" size="xs" mono>
            {formatSignedMoney(trade.paperPl)}
          </AppText>
        ) : null}
      </View>
    </Pressable>
  );
}

function TradesSkeleton() {
  return (
    <Screen scroll>
      <Skeleton width={110} height={24} />
      <Skeleton height={40} radius={radius.md} />
      <Skeleton height={280} radius={16} />
    </Screen>
  );
}
