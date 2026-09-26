import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { theme, type ThemeColors } from '@/constants/theme';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';
import { Text } from '@/components/ui/AppText';
import { BottomDrawer } from '@/components/ui/BottomDrawer';
import { apiGet, apiPatch } from '@/lib/api/client';
import type { AppNotification } from '@/types/api';

function timeLabel(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return 'Now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function NotificationDrawer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiGet<{ notifications: AppNotification[] }>('/api/notifications');
      setNotifications(payload.notifications ?? []);
      setError(null);
    } catch {
      setError('Notifications are temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Warm the inbox while Home is visible so opening the drawer has content
  // immediately. Later polls refresh quietly without replacing the list.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (visible) void load();
  }, [load, visible]);

  async function markRead(ids?: string[]) {
    try {
      await apiPatch<{ ok: boolean }>('/api/notifications/read', ids?.length ? { ids } : {});
      const now = new Date().toISOString();
      setNotifications((items) => items.map((item) => !ids || ids.includes(item.id) ? { ...item, readAt: item.readAt ?? now } : item));
    } catch {
      setError('Could not update notification status.');
    }
  }

  const unreadCount = notifications.filter((item) => !item.readAt).length;
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      eyebrow="Inbox"
      title="Notifications"
      headerRight={unreadCount ? <Pressable onPress={() => void markRead()} hitSlop={8}><Text style={styles.readAll}>Read all</Text></Pressable> : null}
    >
      {loading && !notifications.length ? <ActivityIndicator style={styles.loader} color={colors.primary} /> : null}
      {!loading && error && !notifications.length ? <Text style={styles.error}>{error}</Text> : null}
      {!loading && !error && !notifications.length ? <Text style={styles.empty}>You’re all caught up.</Text> : null}
      {notifications.length ? (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {notifications.map((item) => (
            <Pressable key={item.id} onPress={() => { if (!item.readAt) void markRead([item.id]); }} style={[styles.item, !item.readAt ? styles.unread : null]} accessibilityRole="button">
              <View style={[styles.dot, { backgroundColor: item.readAt ? colors.textMuted : item.kind === 'system_issue' ? colors.danger : colors.primary }]} />
              <View style={styles.itemBody}>
                <View style={styles.itemTop}><Text style={styles.itemTitle}>{item.title}</Text><Text style={styles.time}>{timeLabel(item.createdAt)}</Text></View>
                {item.message ? <Text style={[styles.message, item.kind === 'system_issue' ? styles.issue : null]}>{item.message}</Text> : null}
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </BottomDrawer>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  readAll: { fontSize: 12, fontFamily: theme.fonts.sansSemiBold, color: colors.primary },
  loader: { marginVertical: 36 }, empty: { paddingVertical: 32, fontSize: 13, fontFamily: theme.fonts.sans, color: colors.textSecondary, textAlign: 'center' }, error: { paddingVertical: 24, fontSize: 13, fontFamily: theme.fonts.sansMedium, color: colors.danger, textAlign: 'center' },
  list: { paddingHorizontal: 4, paddingBottom: 6 }, item: { flexDirection: 'row', gap: 10, paddingHorizontal: 10, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, unread: { backgroundColor: colors.primaryTint }, dot: { width: 7, height: 7, borderRadius: 4, marginTop: 6 }, itemBody: { flex: 1, minWidth: 0 }, itemTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 }, itemTitle: { flex: 1, fontSize: 13, fontFamily: theme.fonts.sansSemiBold, color: colors.textPrimary }, time: { fontSize: 11, fontFamily: theme.fonts.sansMedium, color: colors.textMuted }, message: { marginTop: 3, fontSize: 12, lineHeight: 17, fontFamily: theme.fonts.sans, color: colors.textSecondary }, issue: { color: colors.danger },
});
