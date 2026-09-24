import { ActivityIndicator, StyleSheet, useColorScheme, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/AppText';
import { rawColors, theme } from '@/constants/theme';

export function SplashView({
  message = 'Loading',
  fontsLoaded = true,
  onLayout,
}: {
  message?: string;
  fontsLoaded?: boolean;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark';
  const palette = rawColors[scheme];
  const insets = useSafeAreaInsets();
  const subtitleFont = fontsLoaded ? theme.fonts.sansSemiBold : undefined;
  const textMuted = scheme === 'light' ? '#7b838c' : '#6d7176';

  return (
    <View
      onLayout={onLayout}
      style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      <View style={styles.center}>
        <ActivityIndicator size="large" color={palette.primary} accessibilityLabel="Loading" />
        {message ? (
          <Text style={[styles.message, { color: textMuted, fontFamily: subtitleFont }]}>{message}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  message: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
});
