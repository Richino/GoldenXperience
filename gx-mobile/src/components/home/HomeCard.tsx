import { StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';

import { theme, shadows, type ThemeColors, lightCardShadow } from '@/constants/theme';
import { useThemedStyles } from '@/lib/theme/useTheme';
import { usePreferences } from '@/lib/preferences/PreferencesContext';

type HomeCardProps = ViewProps & {
  style?: ViewStyle | ViewStyle[];
};

export function HomeCard({ style, children, ...rest }: HomeCardProps) {
  const styles = useThemedStyles(createStyles);
  const { themeMode } = usePreferences();
  return (
    <View style={[styles.card, themeMode === 'light' ? styles.lightShadow : null, style]} {...rest}>
      {children}
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: theme.radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    paddingHorizontal: 22,
    paddingVertical: 19,
    ...shadows(colors).card,
  },
  lightShadow: lightCardShadow,
});
