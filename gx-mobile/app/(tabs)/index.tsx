import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BalancePerformanceCard } from '@/components/home/BalancePerformanceCard';
import { HighImpactNewsCard } from '@/components/home/HighImpactNewsCard';
import { OpenPositionsCard } from '@/components/home/OpenPositionsCard';
import { NotificationDrawer } from '@/components/home/NotificationDrawer';
import { PendingTradesCard } from '@/components/home/PendingTradesCard';
import { RecentActivityCard } from '@/components/home/RecentActivityCard';
import { TodayPerformanceCard } from '@/components/home/TodayPerformanceCard';
import { DockFade } from '@/components/ui/DockFade';
import { Text } from '@/components/ui/AppText';
import { theme } from '@/constants/theme';
import { useHomeData } from '@/hooks/useHomeData';
import { recentActivityFromTrades, todayClosedStats } from '@/lib/home/activity';

const DOCK_CLEARANCE = 98;

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [showFloatingBell, setShowFloatingBell] = useState(false);
  const { account, accountHistory, openPositions, journalTrades, pendingEntries, calendar, calendarLoading, loading, error, todayKey, refresh } = useHomeData();

  // Home is a quick status surface. Keep the full history in Journal instead
  // of letting ten activity rows push the rest of the dashboard below the dock.
  const recentActivity = useMemo(() => recentActivityFromTrades(journalTrades, 5), [journalTrades]);
  const today = useMemo(() => todayClosedStats(journalTrades, todayKey), [journalTrades, todayKey]);
  const highImpactEvents = useMemo(() => (calendar?.events ?? []).filter((event) => event.impact >= 3).slice(0, 3), [calendar]);

  if (loading && !account) {
    return (
      <View style={[styles.root, styles.centered]}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: Math.max(insets.top + 8, 20), paddingBottom: DOCK_CLEARANCE + Math.max(insets.bottom, 8) },
        ]}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(event) => {
          const next = event.nativeEvent.contentOffset.y > 56;
          setShowFloatingBell((current) => current === next ? current : next);
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl tintColor={theme.colors.primary} refreshing={false} onRefresh={() => void refresh()} />}
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {account ? <BalancePerformanceCard account={account} history={accountHistory} todayKey={todayKey} onNotificationsPress={() => setNotificationsOpen(true)} /> : null}
        <OpenPositionsCard positions={openPositions} currency={account?.currency ?? 'USD'} />
        <PendingTradesCard entries={pendingEntries} onCancelled={() => void refresh()} />
        <RecentActivityCard items={recentActivity} currency={account?.currency ?? 'USD'} />
        <TodayPerformanceCard
          net={today.netMoney}
          resultR={today.netR}
          trades={today.trades}
          wins={today.wins}
          losses={today.losses}
          currency={account?.currency ?? 'USD'}
        />
        <HighImpactNewsCard events={highImpactEvents} loading={calendarLoading} connected={calendar?.connected ?? false} />
      </ScrollView>
      <DockFade height={96} />
      {showFloatingBell && !notificationsOpen ? (
        <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOutUp.duration(140)} style={[styles.floatingBellWrap, { top: insets.top + 14 }]}>
          <View style={styles.floatingBellTouchTarget}>
            <Pressable onPress={() => setNotificationsOpen(true)} accessibilityRole="button" accessibilityLabel="Open notifications" style={styles.floatingBell}>
              <SymbolView name={{ ios: 'bell', android: 'notifications', web: 'notifications' }} size={19} tintColor={theme.colors.textPrimary} />
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
      <NotificationDrawer visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    gap: 14,
  },
  error: {
    fontSize: 12,
    fontFamily: theme.fonts.sansMedium,
    color: theme.colors.danger,
  },
  floatingBellWrap: {
    position: 'absolute',
    right: 16,
    zIndex: 30,
  },
  floatingBellTouchTarget: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingBell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    shadowColor: theme.shadow.dock.shadowColor,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 8,
  },
});
