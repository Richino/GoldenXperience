import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { theme, shadows, type ThemeColors, lightCardShadow } from '@/constants/theme';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';
import { Text } from '@/components/ui/AppText';
import { usePreferences } from '@/lib/preferences/PreferencesContext';
import { eventDay, eventTime } from '@/lib/time';
import type { CalendarEvent } from '@/types/api';

export function HighImpactNewsCard({
  events,
  loading,
  connected,
}: {
  events: CalendarEvent[];
  loading: boolean;
  connected: boolean;
}) {
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const { themeMode } = usePreferences();
  return (
    <View style={[styles.card, themeMode === 'light' ? styles.lightShadow : null]}>
      <View style={styles.header}>
        <Text style={styles.title}>High-impact news</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open Forex Factory calendar"
          hitSlop={8}
          style={styles.external}
          onPress={() => Linking.openURL('https://www.forexfactory.com/calendar')}
        >
          <SymbolView name={{ ios: 'arrow.up.right', android: 'open_in_new', web: 'open_in_new' }} size={12} tintColor={colors.textSecondary} />
        </Pressable>
      </View>

      {loading ? (
        <Text style={styles.empty}>Loading calendar…</Text>
      ) : !connected ? (
        <Text style={[styles.empty, styles.emptyDanger]}>Calendar unavailable — verify news manually.</Text>
      ) : events.length ? (
        <View style={styles.list}>
          {events.map((event) => (
            <View key={event.id} style={styles.row}>
              <View style={styles.timeCol}>
                <Text style={styles.time}>{eventTime(event.timestamp)}</Text>
                <Text style={styles.day}>{eventDay(event.timestamp)}</Text>
              </View>
              <View style={styles.body}>
                <View style={styles.currencyBadge}>
                  <Text style={styles.currency}>{event.currency}</Text>
                </View>
                <Text style={styles.eventTitle} numberOfLines={2}>
                  {event.title}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.empty}>No high-impact events in this week’s feed.</Text>
      )}
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: theme.radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    padding: 16,
    ...shadows(colors).card,
    shadowOpacity: 0.12,
  },
  lightShadow: lightCardShadow,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 10,
    fontFamily: theme.fonts.sansMedium,
    letterSpacing: 1.4,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  external: {
    width: 23,
    height: 23,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryMuted,
  },
  empty: {
    marginTop: 8,
    fontSize: 12,
    fontFamily: theme.fonts.sans,
    color: colors.textSecondary,
  },
  emptyDanger: {
    color: colors.danger,
  },
  list: {
    marginTop: 8,
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    gap: 9,
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: 10,
    backgroundColor: colors.surfaceInset,
  },
  timeCol: {
    width: 72,
  },
  time: {
    fontSize: 12,
    fontFamily: theme.fonts.monoBold,
    color: colors.textMutedStrong,
    letterSpacing: -0.5,
  },
  day: {
    marginTop: 2,
    fontSize: 9.5,
    fontFamily: theme.fonts.mono,
    color: colors.textSecondary,
    letterSpacing: -0.5,
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  currencyBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2.5,
    borderRadius: 3,
    backgroundColor: colors.currencyBadge,
  },
  currency: {
    fontSize: 9,
    fontFamily: theme.fonts.sansBold,
    color: colors.danger,
    letterSpacing: 0.45,
  },
  eventTitle: {
    flex: 1,
    fontSize: 12,
    fontFamily: theme.fonts.sansSemiBold,
    color: colors.textMutedStrong,
  },
});
