import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { theme, shadows, type ThemeColors, lightCardShadow } from '@/constants/theme';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';
import { Text } from '@/components/ui/AppText';
import { usePreferences } from '@/lib/preferences/PreferencesContext';

type TodayPerformanceCardProps = {
  net: number | null;
  resultR: number | null;
  trades: number;
  wins: number;
  losses: number;
  currency: string;
};

function formatSignedMoney(value: number, currency: string) {
  const absolute = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Math.abs(value));
  if (Math.abs(value) < 0.005) return absolute;
  return `${value > 0 ? '+' : '−'}${absolute}`;
}

export function TodayPerformanceCard({ net, resultR, trades, wins, losses, currency }: TodayPerformanceCardProps) {
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const { themeMode } = usePreferences();
  const isLightTheme = themeMode === 'light';
  const resolved = wins + losses;
  const winPercent = resolved > 0 ? Math.round((wins / resolved) * 100) : 0;
  const hasTrades = trades > 0;
  const isLoss = net !== null && net < 0;
  const netPositive = (net ?? 0) >= 0;
  const rPositive = (resultR ?? 0) >= 0;
  const winShare = resolved > 0 ? Math.max(0.04, wins / resolved) : 0;

  return (
    <View style={[styles.shadowWrap, isLightTheme ? styles.lightShadow : null]}>
      <LinearGradient
        colors={isLoss
          ? [isLightTheme ? '#fff3f4' : '#241318', isLightTheme ? '#ffffff' : '#131315']
          : [isLightTheme ? '#f1fbf7' : '#0e241d', isLightTheme ? '#ffffff' : '#131315']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        locations={[0, 0.68]}
        style={styles.card}
      >
      <Text style={styles.title}>Today</Text>
      <View style={styles.totalRow}>
        <Text style={[styles.lead, { color: netPositive ? colors.primary : colors.danger }]}>
          {formatSignedMoney(net ?? 0, currency)}
        </Text>
        <View style={styles.rPill}>
          <Text style={[styles.rText, { color: rPositive ? colors.primary : colors.danger }]}>
            {resultR === null ? '0.0R' : `${resultR > 0 ? '+' : ''}${resultR.toFixed(1)}R`}
          </Text>
        </View>
      </View>
      {!hasTrades ? <Text style={styles.emptyText}>No closed trades today</Text> : null}

      <View style={styles.meta}>
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>Trades</Text>
          <Text style={styles.metaValue}>{trades}</Text>
        </View>
        <View style={[styles.metaItem, styles.metaCenter]}>
          <Text style={styles.metaLabel}>W/L</Text>
          <Text style={styles.metaValue}>
            {wins}/{losses}
          </Text>
        </View>
        <View style={[styles.metaItem, styles.metaEnd]}>
          <Text style={styles.metaLabel}>Win rate</Text>
          <Text style={styles.metaValue}>{winPercent}%</Text>
        </View>
      </View>

      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${winShare * 100}%`, backgroundColor: isLoss ? colors.danger : colors.primary }]} />
      </View>
      </LinearGradient>
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    borderRadius: theme.radii.lg,
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  shadowWrap: {
    borderRadius: theme.radii.lg,
    ...shadows(colors).card,
    shadowOpacity: 0.12,
  },
  lightShadow: lightCardShadow,
  title: {
    fontSize: 10,
    fontFamily: theme.fonts.sansMedium,
    letterSpacing: 1.4,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  totalRow: {
    marginTop: 11,
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  lead: {
    fontSize: 24,
    fontFamily: theme.fonts.monoSemiBold,
    letterSpacing: -1.2,
  },
  rPill: {
    paddingHorizontal: 7,
    paddingVertical: 3.5,
    borderRadius: theme.radii.pill,
    backgroundColor: colors.primaryMuted,
  },
  rText: {
    fontSize: 11,
    fontFamily: theme.fonts.sansSemiBold,
    letterSpacing: -0.3,
  },
  emptyText: {
    marginBottom: 9,
    fontSize: 11.5,
    fontFamily: theme.fonts.sans,
    color: colors.textSecondary,
  },
  meta: {
    marginTop: 14,
    paddingTop: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    flexDirection: 'row',
  },
  metaItem: {
    flex: 1,
  },
  metaCenter: {
    alignItems: 'center',
  },
  metaEnd: {
    alignItems: 'flex-end',
  },
  metaLabel: {
    fontSize: 9,
    fontFamily: theme.fonts.sansMedium,
    letterSpacing: 1.05,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  metaValue: {
    marginTop: 3,
    fontSize: 13,
    fontFamily: theme.fonts.sansMedium,
    color: colors.textSecondary,
  },
  barTrack: {
    marginTop: 14,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceInset,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
  },
});
