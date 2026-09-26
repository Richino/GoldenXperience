import { useEffect, useState } from 'react';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs';
import { BookOpen, CandlestickChart, House, Settings, type LucideIcon } from 'lucide-react-native';
import { LayoutChangeEvent, PixelRatio, Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { shadows, type ThemeColors } from '@/constants/theme';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';
import { usePreferences } from '@/lib/preferences/PreferencesContext';

const ICONS: Record<string, LucideIcon> = {
  index: House,
  chart: CandlestickChart,
  journal: BookOpen,
  settings: Settings,
};

/**
 * Full replacement for React Navigation's default bottom tab bar. Ported to
 * match the web dock (AppShell's `.mobile-dock`) 1:1: real lucide icons, an
 * soft mint lens that slides between tabs, and a press-down animation
 * — behaviour the default `tabBarButton`/`tabBarIcon` composition couldn't
 * reliably reproduce (focus state read from React Navigation's own props
 * instead, which is what made the highlight disappear intermittently).
 */
export function CustomTabBar({ state, navigation, descriptors }: BottomTabBarProps) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { themeMode } = usePreferences();
  // The web iOS dock deliberately sits 20px above the screen edge instead of
  // consuming the entire home-indicator inset. Use the same visual offset here
  // so native and mobile-web land in the same place.
  const bottomOffset = Platform.OS === 'ios' ? 20 : Math.max(insets.bottom, 20);
  const [innerWidth, setInnerWidth] = useState(0);
  const activeIndex = useSharedValue(state.index);

  useEffect(() => {
    // Mirrors the web dock's 300ms cubic-bezier movement, but runs on the UI
    // thread so a route render cannot steal frames from the sliding lens.
    activeIndex.value = withTiming(state.index, {
      duration: 300,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
    });
  }, [activeIndex, state.index]);

  // The dock width rarely divides evenly by the tab count. A lens at a
  // fractional width or offset anti-aliases its 1px ring unevenly, so one side
  // looked shaved off; keep both on whole device pixels.
  const columnWidth = PixelRatio.roundToNearestPixel(innerWidth / state.routes.length);
  const pixelRatio = PixelRatio.get();
  const sliderStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: Math.round(activeIndex.value * columnWidth * pixelRatio) / pixelRatio }] }),
    [columnWidth, pixelRatio],
  );

  function onLayout(event: LayoutChangeEvent) {
    setInnerWidth(event.nativeEvent.layout.width);
  }

  // A screen hides the dock with `tabBarStyle: { display: 'none' }` (the chart's
  // fullscreen mode); honour it the way the default tab bar would.
  const focusedStyle = descriptors[state.routes[state.index].key]?.options.tabBarStyle;
  if ((StyleSheet.flatten(focusedStyle as ViewStyle) as ViewStyle | undefined)?.display === 'none') return null;

  return (
    <View style={[styles.dock, { bottom: bottomOffset }]}>
      <View style={[styles.pillShadow, themeMode === 'dark' ? styles.darkTopBorder : null]}>
        <View style={styles.pillOuter}>
          <View style={styles.row} onLayout={onLayout}>
          {innerWidth > 0 ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.slider,
                { width: columnWidth },
                sliderStyle,
              ]}
            >
              <View style={[styles.sliderFill, themeMode === 'dark' ? styles.sliderFillDark : null]} />
            </Animated.View>
          ) : null}

            {state.routes.map((route, index) => {
              const focused = state.index === index;
              const Icon = ICONS[route.name] ?? House;

              return (
                <TabItem
                  key={route.key}
                  focused={focused}
                  Icon={Icon}
                  onPress={() => {
                    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                    if (!focused && !event.defaultPrevented) {
                      navigation.navigate(route.name);
                    }
                  }}
                />
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

function TabItem({ focused, Icon, onPress }: { focused: boolean; Icon: LucideIcon; onPress: () => void }) {
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const pressProgress = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(pressProgress.value, [0, 1], [1, 0.78]) }],
  }));

  function pressIn() {
    pressProgress.value = withTiming(1, {
      duration: 85,
      easing: Easing.out(Easing.quad),
    });
  }

  function pressOut() {
    pressProgress.value = withSpring(0, {
      damping: 16,
      stiffness: 230,
      mass: 0.45,
    });
  }

  return (
    <Pressable style={styles.item} onPress={onPress} onPressIn={pressIn} onPressOut={pressOut}>
      <Animated.View style={pressStyle}>
        <Icon size={24} strokeWidth={1.7} color={focused ? colors.primary : colors.textSecondary} />
      </Animated.View>
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  dock: {
    position: 'absolute',
    // Web iOS: `.mobile-dock { padding-inline: .8rem; }`.
    left: 13,
    right: 13,
  },
  pillShadow: {
    // Web iOS: 4.35rem tall, .46rem inset, 1.8rem radius, no border.
    height: 70,
    padding: 7,
    borderRadius: 29,
    backgroundColor: colors.surface,
    // iOS: a restrained lift (softer than the card preset); Android: the
    // theme's soft box-shadow, which follows the pill's rounded corners.
    ...(Platform.OS === 'android'
      ? shadows(colors).dock
      : { shadowColor: colors.shadow, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 22 }),
  },
  pillOuter: {
    flex: 1,
    // The focus lens is already inset by the shadow shell's padding. Keeping
    // this layer visible prevents iOS from shaving its rounded active edge.
    overflow: 'visible',
    borderRadius: 29,
  },
  darkTopBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.13)',
    borderLeftColor: 'rgba(255, 255, 255, 0.09)',
    borderRightColor: 'rgba(255, 255, 255, 0.09)',
  },
  row: {
    flex: 1,
    flexDirection: 'row',
  },
  slider: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
  },
  sliderFill: {
    flex: 1,
    borderRadius: 22,
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    // A soft mint ring like the web dock's lens; the solid accent line was
    // harsh on the white light-theme pill and made any uneven edge obvious.
    borderColor: 'rgba(0, 184, 120, 0.3)',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 1,
  },
  sliderFillDark: {
    borderColor: 'rgba(0, 229, 155, 0.42)',
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
