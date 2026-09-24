import { useEffect, useState } from 'react';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs';
import { BookOpen, CandlestickChart, House, Settings, type LucideIcon } from 'lucide-react-native';
import { LayoutChangeEvent, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/constants/theme';
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
export function CustomTabBar({ state, navigation }: BottomTabBarProps) {
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

  const columnWidth = innerWidth / state.routes.length;
  const sliderStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: activeIndex.value * columnWidth }] }),
    [columnWidth],
  );

  function onLayout(event: LayoutChangeEvent) {
    setInnerWidth(event.nativeEvent.layout.width);
  }

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
              <View style={styles.sliderFill} />
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
        <Icon size={24} strokeWidth={1.7} color={focused ? theme.colors.primary : theme.colors.textSecondary} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: theme.colors.surface,
    shadowColor: theme.shadow.dock.shadowColor,
    shadowOffset: { width: 0, height: 8 },
    // The light dock uses a restrained cool-gray lift; dark retains the
    // deeper web-style elevation.
    shadowOpacity: 0.18,
    shadowRadius: 22,
    ...Platform.select({
      ios: {},
      android: { elevation: 6 },
      default: {},
    }),
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
    backgroundColor: theme.colors.primarySoft,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 1,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
