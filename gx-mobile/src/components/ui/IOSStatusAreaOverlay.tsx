import { Platform, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePreferences } from '@/lib/preferences/PreferencesContext';

/** The iOS notification/notch glass belongs to the tab shell, not one page. */
export function IOSStatusAreaOverlay() {
  const insets = useSafeAreaInsets();
  const { themeMode } = usePreferences();
  if (Platform.OS !== 'ios' || insets.top === 0) return null;

  return (
    <MaskedView
      pointerEvents="none"
      style={[styles.overlay, { height: insets.top }]}
      maskElement={<LinearGradient colors={['#000000', 'transparent']} locations={[0.55, 1]} style={StyleSheet.absoluteFill} />}
    >
      <BlurView intensity={10} tint={themeMode === 'light' ? 'light' : 'dark'} style={StyleSheet.absoluteFill} />
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30 },
});
