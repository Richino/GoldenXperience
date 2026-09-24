import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NotificationDrawer } from '@/components/home/NotificationDrawer';
import { theme } from '@/constants/theme';

/** Fixed inbox access for tab pages without Home's own header bell. */
export function GlobalNotificationBell() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  // Home owns its header bell and its scroll-triggered fixed version.
  if (pathname === '/' || pathname === '/index' || pathname === '/journal' || pathname === '/chart') return null;

  return <>
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 8 }]}>
      <Pressable onPress={() => setOpen(true)} style={styles.button} accessibilityRole="button" accessibilityLabel="Open notifications">
        <SymbolView name={{ ios: 'bell', android: 'notifications', web: 'notifications' }} size={20} tintColor={theme.colors.textPrimary} />
      </Pressable>
    </View>
    <NotificationDrawer visible={open} onClose={() => setOpen(false)} />
  </>;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', right: 16, zIndex: 40 },
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.cardBorder, ...theme.shadow.card },
});
