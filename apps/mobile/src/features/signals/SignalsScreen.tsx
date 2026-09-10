import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Screen } from "@/components/ui/Screen";
import { AppText } from "@/components/ui/AppText";
import { Skeleton } from "@/components/ui/Skeleton";
import { SectionHeader, SectionLabel } from "@/components/ui/Section";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { useColors } from "@/theme/ThemeProvider";
import { radius, spacing } from "@/theme/tokens";
import { buildActiveSignals, buildRecentSignals } from "@/lib/signals";
import { SignalCard } from "@/features/signals/SignalCard";
import { HistoryList } from "@/features/signals/HistoryList";
import { useSignalsData } from "@/features/signals/useSignalsData";

const FILTERS = ["Pair", "Side", "Strategy", "Status"];

export function SignalsScreen() {
  const colors = useColors();
  const [tab, setTab] = useState<"active" | "history">("active");
  const { data, loading, refreshing, error, refresh } = useSignalsData();

  // The base signals carry no live price; each SignalCard overlays its own
  // quote, so the list itself only rebuilds when the setups/plans change.
  const active = useMemo(
    () => (data ? buildActiveSignals(data.setups, data.plans, {}) : []),
    [data],
  );
  const recent = useMemo(() => (data ? buildRecentSignals(data.journal, 30) : []), [data]);
  const activeCount = active.filter((signal) => signal.status === "active").length;
  const watchingCount = active.filter((signal) => signal.status === "watching").length;

  if (loading && !data) return <SignalsSkeleton />;

  return (
    <Screen scroll refreshing={refreshing} onRefresh={refresh}>
      <View style={{ gap: spacing.xs }}>
        <AppText size="xl" weight="800">
          Signals
        </AppText>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.positive }} />
          <AppText tone="secondary" size="sm">
            {activeCount} active · {watchingCount} watching
          </AppText>
        </View>
      </View>

      <View style={{ flexDirection: "row", backgroundColor: colors.surfaceMuted, borderRadius: radius.md, padding: 3 }}>
        {(["active", "history"] as const).map((key) => (
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
              {key === "active" ? "Active" : "History"}
            </AppText>
          </Pressable>
        ))}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
        {FILTERS.map((filter) => (
          <View
            key={filter}
            style={{
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: colors.border,
              paddingHorizontal: spacing.md,
              paddingVertical: 6,
            }}
          >
            <AppText tone="secondary" size="xs" weight="600">
              {filter} ▾
            </AppText>
          </View>
        ))}
      </ScrollView>

      {error && !data ? <ErrorState error={error} onRetry={refresh} /> : null}

      {tab === "active" ? (
        <>
          <View>
            <SectionLabel>Active now</SectionLabel>
            {active.length ? (
              <View style={{ gap: spacing.md }}>
                {active.map((signal) => (
                  <SignalCard key={signal.instrument} signal={signal} />
                ))}
              </View>
            ) : (
              <EmptyState title="No active signals right now" hint="The GX engine posts signals here as setups become valid." />
            )}
          </View>
          <View>
            <SectionHeader title="Recent" action={recent.length ? { label: "See all", onPress: () => setTab("history") } : undefined} />
            <HistoryList items={recent.slice(0, 5)} />
          </View>
        </>
      ) : (
        <View>
          <SectionLabel>History</SectionLabel>
          <HistoryList items={recent} />
        </View>
      )}
    </Screen>
  );
}

function SignalsSkeleton() {
  return (
    <Screen scroll>
      <Skeleton width={120} height={24} />
      <Skeleton height={40} radius={radius.md} />
      <Skeleton height={190} radius={16} />
      <Skeleton height={190} radius={16} />
    </Screen>
  );
}
