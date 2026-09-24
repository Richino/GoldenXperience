import { StyleSheet, View } from 'react-native';

import { HomeCard } from '@/components/home/HomeCard';
import { Text } from '@/components/ui/AppText';
import { theme } from '@/constants/theme';
import type { ActivityItem } from '@/lib/home/activity';
import { moneyLabel, rLabel } from '@/lib/format';
import { formatShortDay } from '@/lib/time';

function toneColor(kind: ActivityItem['kind']) {
  if (kind === 'tp') return theme.colors.primary;
  if (kind === 'sl') return theme.colors.danger;
  return theme.colors.textSecondary;
}

export function RecentActivityCard({ items, currency }: { items: ActivityItem[]; currency: string }) {
  return (
    <HomeCard style={styles.card} accessibilityLabel="Recent activity">
      <View style={styles.header}>
        <Text style={styles.title}>Recent activity</Text>
        <Text style={styles.previewLabel}>Last {items.length || 0}</Text>
      </View>

      {items.length ? (
        <View>
          {items.map((item, index) => {
            const tone = toneColor(item.kind);
            const hasMoney = item.paperPl !== null;
            const hasR = item.resultR !== null;
            const primaryValue = hasMoney ? moneyLabel(item.paperPl, currency) : hasR ? rLabel(item.resultR) : 'Closed';
            return (
              <View key={item.id} style={[styles.row, index < items.length - 1 ? styles.rowBorder : null]}>
                <View style={styles.left}>
                  <Text style={styles.pair}>{item.pair}</Text>
                  <View style={styles.outcomeRow}>
                    <View style={[styles.outcomeDot, { backgroundColor: tone }]} />
                    <Text style={[styles.result, { color: tone }]}>{item.label}</Text>
                  </View>
                </View>
                <View style={styles.right}>
                  <Text style={[styles.money, { color: hasMoney || hasR ? tone : theme.colors.textSecondary }]}>{primaryValue}</Text>
                  <View style={styles.meta}>
                    {hasMoney && hasR ? <><Text style={[styles.rValue, { color: tone }]}>{rLabel(item.resultR)}</Text><Text style={styles.metaDivider}>·</Text></> : null}
                    <Text style={styles.date}>{formatShortDay(item.at)}</Text>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={styles.empty}>No closed trades yet.</Text>
      )}
    </HomeCard>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: 19,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 10,
    fontFamily: theme.fonts.sansMedium,
    letterSpacing: 1.4,
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
  },
  previewLabel: {
    fontSize: 10,
    fontFamily: theme.fonts.sansMedium,
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  empty: {
    marginTop: 8,
    fontSize: 12,
    fontFamily: theme.fonts.sans,
    color: theme.colors.textSecondary,
  },
  row: {
    minHeight: 62,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  left: {
    flex: 1,
    minWidth: 0,
  },
  right: {
    alignItems: 'flex-end',
    minWidth: 104,
  },
  outcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  pair: {
    fontSize: 12.8,
    fontFamily: theme.fonts.sansBold,
    letterSpacing: -0.1,
    color: theme.colors.textPrimary,
  },
  result: {
    fontSize: 10,
    fontFamily: theme.fonts.sansBold,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  outcomeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  money: {
    fontSize: 13.5,
    lineHeight: 17,
    fontFamily: theme.fonts.monoSemiBold,
  },
  meta: {
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  rValue: {
    fontSize: 10.5,
    fontFamily: theme.fonts.monoMedium,
  },
  metaDivider: {
    fontSize: 10,
    color: theme.colors.textMuted,
  },
  date: {
    fontSize: 10.5,
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.textSecondary,
  },
});
