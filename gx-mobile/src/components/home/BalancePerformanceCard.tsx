import { useEffect, useMemo, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { AccountChart } from '@/components/home/AccountChart';
import { Text } from '@/components/ui/AppText';
import { HomeCard } from '@/components/home/HomeCard';
import { theme, type ThemeColors } from '@/constants/theme';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';
import {
  RANGES,
  RANGE_TABS,
  buildAccountAmountSeries,
  type AccountChartRange,
} from '@/lib/home/account-series';
import { usePreferences } from '@/lib/preferences/PreferencesContext';
import { getMarketCondition, tradingDayKey } from '@/lib/time';
import type { AccountBalanceHistoryPoint, AccountSummary } from '@/types/api';

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

function formatSignedMoney(value: number, currency: string) {
  const absolute = formatMoney(Math.abs(value), currency);
  if (Math.abs(value) < 0.005) return absolute;
  return `${value > 0 ? '+' : '−'}${absolute}`;
}

export function BalancePerformanceCard({
  account,
  history,
  todayKey,
  onNotificationsPress,
}: {
  account: AccountSummary;
  history: AccountBalanceHistoryPoint[];
  todayKey: string;
  onNotificationsPress: () => void;
}) {
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const { themeMode } = usePreferences();
  const isLightTheme = themeMode === 'light';
  const [range, setRange] = useState<AccountChartRange>('1d');
  const [session, setSession] = useState(() => getMarketCondition());

  useEffect(() => {
    const refreshSession = () => setSession(getMarketCondition());
    const timer = setInterval(refreshSession, 30_000);
    // Native timers pause while the app is backgrounded. Refresh immediately
    // on return so a stale "Market closed" state cannot survive into Asia.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshSession();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  const series = useMemo(
    () => buildAccountAmountSeries({ nav: account.nav, unrealizedPL: account.unrealizedPL, history, range }),
    [account.nav, account.unrealizedPL, history, range],
  );

  const realizedPL = useMemo(
    () => history.reduce((sum, point) => (tradingDayKey(point.time) === todayKey ? sum + point.change : sum), 0),
    [history, todayKey],
  );
  const dayPL = realizedPL + account.unrealizedPL;
  const baseline = account.nav - dayPL;
  const changePercent = baseline !== 0 ? (dayPL / baseline) * 100 : 0;
  const positive = dayPL >= 0;
  const changeColor = positive ? colors.primary : colors.danger;

  return (
    <HomeCard style={styles.card} accessibilityLabel="Account overview">
      <View style={styles.topRow}>
        <View
          style={[
            styles.sessionPill,
            isLightTheme ? styles.sessionPillLight : styles.sessionPillDark,
            !session.marketOpen ? (isLightTheme ? styles.sessionPillClosedLight : styles.sessionPillClosedDark) : null,
          ]}
        >
          <View style={[styles.sessionDot, !session.marketOpen ? styles.sessionDotClosed : null]} />
          <Text style={[styles.sessionText, !session.marketOpen ? styles.sessionTextClosed : null]}>
            {session.marketOpen ? `${session.label} session` : 'Market closed'}
          </Text>
        </View>
        <Pressable onPress={onNotificationsPress} accessibilityRole="button" accessibilityLabel="Open notifications" hitSlop={4} style={styles.bellButton}>
          <SymbolView name={{ ios: 'bell', android: 'notifications', web: 'notifications' }} size={18} tintColor={colors.textMutedStrong} />
        </Pressable>
      </View>

      <Text style={styles.balance}>{formatMoney(account.nav, account.currency)}</Text>
      <Text style={[styles.today, { color: changeColor }]}>
        {formatSignedMoney(dayPL, account.currency)}{' '}
        <Text style={[styles.todayMuted, { color: changeColor }]}>
          ({positive ? '+' : '−'}
          {Math.abs(changePercent).toFixed(2)}%) Today
        </Text>
      </Text>

      <View style={styles.rangeRow}>
        {RANGES.map((item) => {
          const selected = item === range;
          return (
            <Pressable
              key={item}
              onPress={() => setRange(item)}
              style={[styles.rangeBtn, selected ? styles.rangeBtnSelected : null]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.rangeText, selected ? styles.rangeTextSelected : null]}>{RANGE_TABS[item]}</Text>
            </Pressable>
          );
        })}
      </View>

      <AccountChart series={series} height={190} />

      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Realized</Text>
          <Text style={[styles.statValue, { color: Math.abs(realizedPL) < 0.005 ? colors.textPrimary : realizedPL > 0 ? colors.primary : colors.danger }]}>
            {formatSignedMoney(realizedPL, account.currency)}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Unrealized</Text>
          <Text
            style={[
              styles.statValue,
              { color: Math.abs(account.unrealizedPL) < 0.005 ? colors.textPrimary : account.unrealizedPL > 0 ? colors.primary : colors.danger },
            ]}
          >
            {formatSignedMoney(account.unrealizedPL, account.currency)}
          </Text>
        </View>
      </View>
    </HomeCard>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    borderRadius: theme.radii.hero,
    paddingTop: 17,
    paddingBottom: 18,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    height: 40,
    marginBottom: 10,
  },
  sessionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sessionPillLight: {
    borderColor: 'rgba(0, 184, 120, 0.28)',
    backgroundColor: 'rgba(0, 184, 120, 0.1)',
  },
  sessionPillDark: {
    borderColor: 'rgba(0, 229, 155, 0.28)',
    backgroundColor: 'rgba(0, 229, 155, 0.14)',
  },
  sessionPillClosedLight: {
    borderColor: 'rgba(16, 24, 32, 0.12)',
    backgroundColor: 'rgba(16, 24, 32, 0.045)',
  },
  sessionPillClosedDark: {
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  sessionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  sessionDotClosed: {
    backgroundColor: colors.textMuted,
  },
  sessionText: {
    fontSize: 10,
    fontFamily: theme.fonts.sansExtraBold,
    letterSpacing: 1,
    color: colors.primary,
    textTransform: 'uppercase',
  },
  sessionTextClosed: {
    color: colors.textSecondary,
  },
  bellButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  label: {
    fontSize: 10,
    fontFamily: theme.fonts.sansMedium,
    letterSpacing: 1.4,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  balance: {
    marginTop: 6,
    fontSize: 40,
    lineHeight: 44,
    fontFamily: theme.fonts.monoBold,
    letterSpacing: -2.2,
    color: colors.textPrimary,
  },
  today: {
    marginTop: 11,
    fontSize: 15,
    fontFamily: theme.fonts.sansMedium,
  },
  todayMuted: {
    fontFamily: theme.fonts.sansMedium,
  },
  rangeRow: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    // Five equal, 40px controls inside a 47px rail: comfortable for a thumb
    // and consistent with the chart timeframe selector.
    alignSelf: 'stretch',
    height: 47,
    padding: 3,
    borderRadius: 12,
    // A dark-mode translucent white rail vanishes on light surfaces. Use the
    // shared raised token so all five time-range targets read as one control.
    backgroundColor: colors.surfaceRaised,
  },
  rangeBtn: {
    flex: 1,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
  },
  rangeBtnSelected: {
    backgroundColor: colors.primarySoft,
  },
  rangeText: {
    fontSize: 12.5,
    fontFamily: theme.fonts.sansSemiBold,
    color: colors.textSecondary,
  },
  rangeTextSelected: {
    color: colors.primary,
  },
  stats: {
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    flexDirection: 'row',
    gap: 24,
  },
  stat: {
    flex: 1,
  },
  statLabel: {
    fontSize: 10,
    fontFamily: theme.fonts.sansMedium,
    letterSpacing: 1.2,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  statValue: {
    marginTop: 4,
    fontSize: 15,
    fontFamily: theme.fonts.monoMedium,
    letterSpacing: -0.3,
  },
});
