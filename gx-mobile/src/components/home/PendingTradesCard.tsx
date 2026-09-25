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
          const action = entry.direction === 'long' ? 'Buy' : 'Sell';
          return (
            <View key={entry.id} style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.pair}>{pairLabel(entry.instrument)}</Text>
                <Text style={[styles.status, entry.direction === 'long' ? styles.statusLong : styles.statusShort]}>{canCancel ? 'Waiting' : 'Setting up'}</Text>
              </View>
              <Text style={styles.summary}>{action} when price reaches <Text style={styles.entryPrice}>{formatPrice(entry.entryPrice, entry.instrument)}</Text></Text>
              {entry.expiresAt ? <Text style={styles.expiration}>Expires {expirationLabel(entry.expiresAt)}</Text> : null}
              <Pressable
                disabled={!canCancel || cancelling}
                onPress={() => confirmCancel(entry)}
                style={[styles.cancelBtn, !canCancel || cancelling ? styles.cancelBtnDisabled : null]}
              >
                <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={12} tintColor={theme.colors.warning} />
                <Text style={styles.cancelText}>{cancelling ? 'Cancelling…' : canCancel ? 'Cancel pending trade' : 'Setting up…'}</Text>
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
    padding: 14,
    gap: 8,
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
  status: {
    marginLeft: 'auto',
    fontSize: 11,
    fontFamily: theme.fonts.sansSemiBold,
  },
  statusLong: {
    color: theme.colors.primary,
  },
  statusShort: {
    color: theme.colors.danger,
  },
  summary: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: theme.fonts.sans,
    color: theme.colors.textSecondary,
  },
  entryPrice: {
    fontFamily: theme.fonts.monoSemiBold,
    color: theme.colors.textPrimary,
  },
  expiration: {
    fontSize: 11,
    fontFamily: theme.fonts.sansMedium,
    color: theme.colors.textMuted,
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    minHeight: 42,
    marginTop: 2,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.warning,
    backgroundColor: theme.colors.warningSoft,
  },
  cancelBtnDisabled: {
    opacity: 0.5,
  },
  cancelText: {
    fontSize: 11,
    fontFamily: theme.fonts.sansSemiBold,
    color: theme.colors.warning,
  },
});
