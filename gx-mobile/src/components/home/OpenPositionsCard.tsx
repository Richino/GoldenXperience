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
          const profitable = position.unrealizedPL >= 0;
          const action = position.direction === 'long' ? 'Buy' : 'Sell';
          const resultR = openR(position);
          return (
            <Pressable
              key={position.id}
              accessibilityRole="button"
              accessibilityLabel={`${pairLabel(position.instrument)} ${position.direction}, ${moneyLabel(position.unrealizedPL, currency)}`}
              style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
              onPress={() => router.push({ pathname: '/chart', params: { instrument: position.instrument } })}
            >
              <View style={styles.rowTop}>
                <Text style={styles.pair}>{position.pair || pairLabel(position.instrument)}</Text>
                <Text style={[styles.pl, profitable ? styles.positive : styles.negative]}>{moneyLabel(position.unrealizedPL, currency)}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summary} numberOfLines={1}>{action} opened at <Text style={styles.entryPrice}>{formatPrice(position.entryPrice, position.instrument)}</Text></Text>
                {resultR !== null ? <Text style={[styles.progress, resultR >= 0 ? styles.positive : styles.negative]}>{resultR >= 0 ? '+' : ''}{resultR.toFixed(2)}R</Text> : null}
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
  list: { marginTop: 10, gap: 10 },
  row: { borderRadius: theme.radii.md, padding: 14, backgroundColor: theme.colors.surfaceInset, gap: 8 },
  rowPressed: { opacity: 0.72 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pair: { fontSize: 14, fontFamily: theme.fonts.sansBold, color: theme.colors.textPrimary },
  pl: { flexShrink: 0, fontSize: 13, fontFamily: theme.fonts.monoSemiBold },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summary: { flex: 1, fontSize: 13, lineHeight: 19, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary },
  entryPrice: { fontFamily: theme.fonts.monoSemiBold, color: theme.colors.textPrimary },
  progress: { fontSize: 11, fontFamily: theme.fonts.monoSemiBold },
  positive: { color: theme.colors.primary },
  negative: { color: theme.colors.danger },
});
