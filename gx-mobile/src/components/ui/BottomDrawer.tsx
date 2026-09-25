import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { theme } from '@/constants/theme';
import { Text } from '@/components/ui/AppText';

const SHEET_OFFSCREEN = 640;
const DISMISS_DISTANCE = 96;
const SHEET_MAX_HEIGHT_RATIO = 0.72;
const SHEET_HEADER_ESTIMATE = 118;

/**
 * Shared shell for every bottom sheet in the app (notifications inbox,
 * settings pickers): slide-up/spring-down animation, dim backdrop, and a
 * drag-to-dismiss handle. Extracted from the original NotificationDrawer so
 * every sheet gets the same feel instead of each screen rolling its own
 * (settings previously used a plain fade `Modal` with no gesture handling).
 */
export function BottomDrawer({
  visible,
  onClose,
  eyebrow,
  title,
  headerRight,
  scrollable = false,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: string;
  headerRight?: ReactNode;
  /** Long option lists (e.g. chart indicators) need a bounded scroll region inside the capped sheet. */
  scrollable?: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const translateY = useSharedValue(SHEET_OFFSCREEN);
  const { height: windowHeight } = useWindowDimensions();
  const scrollMaxHeight = Math.max(160, windowHeight * SHEET_MAX_HEIGHT_RATIO - SHEET_HEADER_ESTIMATE);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.value = SHEET_OFFSCREEN;
      const frame = requestAnimationFrame(() => {
        translateY.value = withTiming(0, { duration: 300, easing: Easing.bezier(0.22, 1, 0.36, 1) });
      });
      return () => cancelAnimationFrame(frame);
    }
    if (mounted) {
      translateY.value = withTiming(SHEET_OFFSCREEN, { duration: 220, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
  }, [mounted, translateY, visible]);

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(0, translateY.value) }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: interpolate(translateY.value, [0, SHEET_OFFSCREEN], [1, 0], 'clamp') }));

  const requestClose = useCallback(() => {
    translateY.value = withTiming(SHEET_OFFSCREEN, { duration: 220, easing: Easing.out(Easing.cubic) }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
  }, [onClose, translateY]);

  const drag = Gesture.Pan()
    .activeOffsetY(5)
    .onUpdate((event) => {
      translateY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (event.translationY > DISMISS_DISTANCE || event.velocityY > 850) {
        translateY.value = withTiming(SHEET_OFFSCREEN, { duration: 210, easing: Easing.out(Easing.cubic) }, (finished) => {
          if (finished) runOnJS(onClose)();
        });
      } else {
        translateY.value = withTiming(0, { duration: 240, easing: Easing.bezier(0.22, 1, 0.36, 1) });
      }
    });

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={requestClose} statusBarTranslucent>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel={`Close ${title.toLowerCase()}`} />
        </Animated.View>
        <Animated.View style={[styles.sheet, sheetStyle]} accessibilityViewIsModal>
          <GestureDetector gesture={drag}>
            <View style={styles.dragHeader}>
              <View style={styles.handle} />
              <View style={styles.header}>
                <View>
                  {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
                  <Text style={styles.title}>{title}</Text>
                </View>
                <View style={styles.actions}>
                  {headerRight}
                  <Pressable onPress={requestClose} hitSlop={8} style={styles.close} accessibilityRole="button" accessibilityLabel={`Close ${title.toLowerCase()}`}>
                    <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={16} tintColor={theme.colors.textSecondary} />
                  </Pressable>
                </View>
              </View>
            </View>
          </GestureDetector>
          {scrollable ? (
            <ScrollView
              style={{ maxHeight: scrollMaxHeight }}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {children}
            </ScrollView>
          ) : (
            children
          )}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // `flex: 1` alone collapses to 0 height on web: RN Web's Modal portal
  // wrapper is `display: block`, not flex, so there's no flex parent for it
  // to size against. An explicit height fixes that without affecting native.
  root: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0, 0, 0, 0.36)' },
  sheet: { maxHeight: '72%', minHeight: 250, overflow: 'hidden', borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: theme.colors.surface, paddingHorizontal: 20, paddingBottom: 30, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.cardBorder },
  scrollContent: { paddingBottom: 4 },
  dragHeader: { paddingTop: 1 },
  handle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, marginTop: 9, backgroundColor: theme.colors.border },
  header: { marginTop: 16, marginBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 10, fontFamily: theme.fonts.sansMedium, letterSpacing: 1.2, color: theme.colors.textMuted, textTransform: 'uppercase' },
  title: { marginTop: 2, fontSize: 20, fontFamily: theme.fonts.sansBold, color: theme.colors.textPrimary },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceRaised },
});
