import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { HomeCard } from '@/components/home/HomeCard';
import { Text } from '@/components/ui/AppText';
import { theme } from '@/constants/theme';
import { formatPrice, moneyLabel, pairLabel } from '@/lib/format';
import type { OpenPosition } from '@/types/api';

function openR(position: OpenPosition) {
  if (position.stopPrice === null) return null;
  const risk = Math.abs(position.entryPrice - position.stopPrice);
  if (risk === 0) return null;
  const move = position.direction === 'long'
    ? position.currentPrice - position.entryPrice
    : position.entryPrice - position.currentPrice;
  return move / risk;
}

export function OpenPositionsCard({ positions, currency }: { positions: OpenPosition[]; currency: string }) {
  if (!positions.length) return null;

  return (
    <HomeCard style={styles.card} accessibilityLabel="Open positions">
      <View style={styles.header}>
        <Text style={styles.title}>Open positions</Text>
        <Pressable accessibilityRole="link" accessibilityLabel="View all open positions in journal" hitSlop={8} onPress={() => router.push('/journal')}>
          <Text style={styles.viewAll}>View all</Text>
        </Pressable>
      </View>

      <View style={styles.list}>
        {positions.slice(0, 6).map((position) => {
          const resultR = openR(position);
          const profitable = position.unrealizedPL >= 0;
          const lots = Math.abs(position.units) / 100_000;
          return (
            <Pressable
              key={position.id}
              accessibilityRole="button"
              accessibilityLabel={`${pairLabel(position.instrument)} ${position.direction}, ${moneyLabel(position.unrealizedPL, currency)}`}
              style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
              onPress={() => router.push({ pathname: '/chart', params: { instrument: position.instrument } })}
            >
              <View style={styles.rowTop}>
                <View style={styles.symbolGroup}>
                  <Text style={styles.pair}>{position.pair || pairLabel(position.instrument)}</Text>
                  <View style={[styles.sideBadge, position.direction === 'long' ? styles.sideLong : styles.sideShort]}>
                    <Text style={[styles.sideText, position.direction === 'long' ? styles.sideTextLong : styles.sideTextShort]}>{position.direction.toUpperCase()}</Text>
                  </View>
                </View>
                <Text style={[styles.pl, profitable ? styles.positive : styles.negative]}>{moneyLabel(position.unrealizedPL, currency)}</Text>
              </View>
              <View style={styles.rowBottom}>
                <Text style={styles.mark}>MARK {formatPrice(position.currentPrice, position.instrument)} · {lots.toFixed(2)} lot</Text>
                <Text style={[styles.r, resultR === null ? styles.muted : resultR >= 0 ? styles.positive : styles.negative]}>
                  {resultR === null ? '—' : `${resultR >= 0 ? '+' : ''}${resultR.toFixed(2)}R`}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </HomeCard>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 19 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 10, fontFamily: theme.fonts.sansMedium, letterSpacing: 1.4, color: theme.colors.textMuted, textTransform: 'uppercase' },
  viewAll: { fontSize: 12, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.primary },
  list: { marginTop: 12, gap: 1 },
  row: { paddingVertical: 12, paddingHorizontal: 12, marginHorizontal: -12, borderLeftWidth: 2, borderLeftColor: theme.colors.primary, backgroundColor: theme.colors.surfaceInset, gap: 8 },
  rowPressed: { opacity: 0.72 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  symbolGroup: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  pair: { fontSize: 14, fontFamily: theme.fonts.sansBold, color: theme.colors.textPrimary },
  sideBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  sideLong: { backgroundColor: theme.colors.primarySoft },
  sideShort: { backgroundColor: theme.colors.dangerSoft },
  sideText: { fontSize: 9, fontFamily: theme.fonts.sansExtraBold, letterSpacing: 0.4 },
  sideTextLong: { color: theme.colors.primary },
  sideTextShort: { color: theme.colors.danger },
  pl: { flexShrink: 0, fontSize: 13, fontFamily: theme.fonts.monoSemiBold },
  rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  mark: { flex: 1, fontSize: 11, fontFamily: theme.fonts.monoMedium, color: theme.colors.textSecondary },
  r: { flexShrink: 0, fontSize: 12, fontFamily: theme.fonts.monoSemiBold },
  positive: { color: theme.colors.primary },
  negative: { color: theme.colors.danger },
  muted: { color: theme.colors.textMuted },
});
