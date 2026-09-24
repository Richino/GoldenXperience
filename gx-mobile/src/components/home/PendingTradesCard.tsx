import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { HomeCard } from '@/components/home/HomeCard';
import { Text } from '@/components/ui/AppText';
import { theme } from '@/constants/theme';
import { apiFetchDelete } from '@/lib/api/client';
import { formatPrice, pairLabel } from '@/lib/format';
import type { PendingEntry } from '@/types/api';

function expirationLabel(expiresAt: string | null) {
  if (!expiresAt) return 'No expiration';
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining <= 0) return 'Expiring';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}

export function PendingTradesCard({ entries, onCancelled }: { entries: PendingEntry[]; onCancelled: () => void }) {
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  function confirmCancel(entry: PendingEntry) {
    Alert.alert(`Cancel ${pairLabel(entry.instrument)}?`, 'This removes the pending entry. It cannot be restored.', [
      { text: 'No, keep it', style: 'cancel' },
      {
        text: 'Yes, cancel trade',
        style: 'destructive',
        onPress: async () => {
          setCancellingId(entry.id);
          try {
            await apiFetchDelete(`/api/pending-entries/${entry.id}`);
            onCancelled();
          } catch {
            Alert.alert('Could not cancel', 'The pending trade could not be cancelled. Try again.');
          } finally {
            setCancellingId(null);
          }
        },
      },
    ]);
  }

  if (!entries.length) {
    return (
      <HomeCard style={styles.card} accessibilityLabel="Pending trades">
        <Text style={styles.title}>Pending trades</Text>
        <Text style={styles.empty}>Nothing pending yet.</Text>
      </HomeCard>
    );
  }

  return (
    <HomeCard style={styles.card} accessibilityLabel="Pending trades">
      <View style={styles.header}>
        <Text style={styles.title}>Pending trades</Text>
        <Text style={styles.count}>
          {entries.length} {entries.length === 1 ? 'trade' : 'trades'}
        </Text>
      </View>
      <View style={styles.list}>
        {entries.map((entry) => {
          const canCancel = entry.status === 'PENDING';
          const cancelling = cancellingId === entry.id;
          return (
            <View key={entry.id} style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.pair}>{pairLabel(entry.instrument)}</Text>
                <View style={[styles.sideBadge, entry.direction === 'long' ? styles.sideLong : styles.sideShort]}>
                  <Text style={[styles.sideText, entry.direction === 'long' ? styles.sideTextLong : styles.sideTextShort]}>
                    {entry.direction.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.orderType}>{entry.entryOrderType.replace('_', ' ')}</Text>
              </View>
              <View style={styles.rowMeta}>
                <View>
                  <Text style={styles.metaLabel}>Entry</Text>
                  <Text style={styles.metaValue}>{formatPrice(entry.entryPrice, entry.instrument)}</Text>
                </View>
                <View>
                  <Text style={styles.metaLabel}>Expires</Text>
                  <Text style={styles.metaValue}>{expirationLabel(entry.expiresAt)}</Text>
                </View>
                <View>
                  <Text style={styles.metaLabel}>Cancel at</Text>
                  <Text style={styles.metaValue}>
                    {entry.invalidationPrice === null ? 'None' : formatPrice(entry.invalidationPrice, entry.instrument)}
                  </Text>
                </View>
              </View>
              <Pressable
                disabled={!canCancel || cancelling}
                onPress={() => confirmCancel(entry)}
                style={[styles.cancelBtn, !canCancel || cancelling ? styles.cancelBtnDisabled : null]}
              >
                <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={12} tintColor={theme.colors.textSecondary} />
                <Text style={styles.cancelText}>{cancelling ? 'Cancelling…' : canCancel ? 'Cancel' : 'Processing'}</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
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
  count: {
    fontSize: 11,
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.textSecondary,
  },
  empty: {
    marginTop: 6,
    fontSize: 12,
    fontFamily: theme.fonts.sans,
    color: theme.colors.textSecondary,
  },
  list: {
    marginTop: 10,
    gap: 10,
  },
  row: {
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surfaceInset,
    padding: 12,
    gap: 10,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pair: {
    fontSize: 14,
    fontFamily: theme.fonts.sansBold,
    color: theme.colors.textPrimary,
  },
  sideBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  sideLong: {
    backgroundColor: theme.colors.primarySoft,
  },
  sideShort: {
    backgroundColor: theme.colors.dangerSoft,
  },
  sideText: {
    fontSize: 9,
    fontFamily: theme.fonts.sansExtraBold,
    letterSpacing: 0.4,
  },
  sideTextLong: {
    color: theme.colors.primary,
  },
  sideTextShort: {
    color: theme.colors.danger,
  },
  orderType: {
    fontSize: 11,
    fontFamily: theme.fonts.sansMedium,
    color: theme.colors.textSecondary,
    textTransform: 'capitalize',
  },
  rowMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metaLabel: {
    fontSize: 9,
    fontFamily: theme.fonts.sansMedium,
    letterSpacing: 0.6,
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
  },
  metaValue: {
    marginTop: 3,
    fontSize: 12.5,
    fontFamily: theme.fonts.monoMedium,
    color: theme.colors.textPrimary,
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radii.pill,
    backgroundColor: theme.colors.surfaceRaised,
  },
  cancelBtnDisabled: {
    opacity: 0.5,
  },
  cancelText: {
    fontSize: 11,
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.textSecondary,
  },
});
