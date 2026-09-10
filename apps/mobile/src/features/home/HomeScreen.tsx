import { useMemo } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConnectionBanner } from "@/components/ui/ConnectionBanner";
import { ErrorState } from "@/components/ui/States";
import { spacing } from "@/theme/tokens";
import { useAuth } from "@/auth/AuthProvider";
import { useAllQuotes } from "@/realtime/MarketStreamProvider";
import { recentActivityFromTrades, todayClosedStats, upcomingFromStrategies } from "@/lib/home";
import { tradingDayKey } from "@/lib/format";
import { AccountHero } from "@/features/home/AccountHero";
import { OpenPositions } from "@/features/home/OpenPositions";
import { ActiveSignals, homeSignalRows } from "@/features/home/ActiveSignals";
import { Markets } from "@/features/home/Markets";
import { GxStatus, RecentActivity, Upcoming } from "@/features/home/HomeIdle";
import { markOpenTrade, useHomeData } from "@/features/home/useHomeData";

export function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { data, loading, refreshing, error, refresh } = useHomeData();
  const quotes = useAllQuotes();
  const todayKey = useMemo(() => tradingDayKey(), []);

  const derived = useMemo(() => {
    if (!data) return null;
    const signalRows = homeSignalRows(data.watchlist);
    const openPL = data.openTrades.reduce<{ sum: number; any: boolean }>((acc, trade) => {
      const mid = quotes[trade.instrument]?.mid ?? null;
      const { money } = markOpenTrade(trade, mid);
      return money === null ? acc : { sum: acc.sum + money, any: true };
    }, { sum: 0, any: false });
    const todayList = todayClosedStats(data.journal, todayKey);
    return {
      signalRows,
      openPL: openPL.any ? openPL.sum : null,
      todayNet: data.summary?.today?.realizedPL ?? todayList.netMoney,
      todayR: todayList.netR,
      upcoming: upcomingFromStrategies(data.strategyRows, signalRows.map((row) => row.instrument)),
      recent: recentActivityFromTrades(data.journal, 8),
    };
  }, [data, quotes, todayKey]);

  if (loading && !data) return <HomeSkeleton />;
  if (error && !data) {
    return (
      <Screen scroll refreshing={refreshing} onRefresh={refresh}>
        <ErrorState error={error} onRetry={refresh} />
      </Screen>
    );
  }
  if (!data || !derived) return <HomeSkeleton />;

  const hasOpen = data.openTrades.length > 0;
  const hasSignals = derived.signalRows.length > 0;
  const showIdle = !hasOpen || !hasSignals;

  return (
    <Screen scroll refreshing={refreshing} onRefresh={refresh}>
      <ConnectionBanner />
      <AccountHero
        account={data.account}
        userLabel={user?.email ?? "GX account"}
        openPL={derived.openPL}
        todayNet={derived.todayNet}
        todayR={derived.todayR}
      />

      {hasOpen ? <OpenPositions trades={data.openTrades} currency={data.account.currency} onSeeAll={() => router.push("/trades")} /> : null}
      {hasSignals ? <ActiveSignals rows={derived.signalRows} onSeeAll={() => router.push("/signals")} /> : null}

      {showIdle ? (
        <>
          <GxStatus connection={data.connection} monitoredCount={data.watchlist.length} />
          <Upcoming items={derived.upcoming} />
        </>
      ) : null}

      <Markets />
      <RecentActivity items={derived.recent} currency={data.account.currency} />
    </Screen>
  );
}

function HomeSkeleton() {
  return (
    <Screen scroll>
      <Card elevated>
        <Skeleton width={120} height={12} />
        <Skeleton width={200} height={34} style={{ marginTop: spacing.md }} />
        <View style={{ flexDirection: "row", gap: spacing.xl, marginTop: spacing.lg }}>
          <Skeleton width={70} height={30} />
          <Skeleton width={70} height={30} />
          <Skeleton width={70} height={30} />
        </View>
      </Card>
      <View style={{ gap: spacing.md }}>
        <Skeleton width={140} height={16} />
        <Skeleton height={64} radius={16} />
        <Skeleton height={64} radius={16} />
      </View>
      <View style={{ gap: spacing.md }}>
        <Skeleton width={100} height={16} />
        <Skeleton height={180} radius={16} />
      </View>
    </Screen>
  );
}
