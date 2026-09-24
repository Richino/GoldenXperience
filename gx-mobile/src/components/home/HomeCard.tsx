import { StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';

import { theme } from '@/constants/theme';
import { usePreferences } from '@/lib/preferences/PreferencesContext';

type HomeCardProps = ViewProps & {
  style?: ViewStyle | ViewStyle[];
};

export function HomeCard({ style, children, ...rest }: HomeCardProps) {
  const { themeMode } = usePreferences();
  return (
    <View style={[styles.card, themeMode === 'light' ? styles.lightShadow : null, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.cardBorder,
    paddingHorizontal: 22,
    paddingVertical: 19,
    ...theme.shadow.card,
  },
  lightShadow: {
    shadowColor: '#52616c',
    shadowOffset: { width: 0, height: 9 },
    shadowOpacity: 0.075,
    shadowRadius: 22,
    elevation: 2,
  },
});
