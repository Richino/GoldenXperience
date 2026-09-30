import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, RefreshControl, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { useThemeColors } from '@/lib/theme/useTheme';

const BARS = 8;
const SIZE = 28;
const BAR_WIDTH = 2.6;
const BAR_HEIGHT = 7.5;
const BAR_RADIUS = 7;
/** Pull distance at which every bar is showing, about where iOS fires the refresh. */
const FULL_PULL = 72;
/** Keep the spin on screen long enough to read, even when the reload is instant. */
const MIN_SPIN_MS = 600;

/**
 * Instagram-style pull to refresh: the stock RefreshControl still owns the
 * gesture and the trigger, but on iOS its spinner is hidden and PullRefreshSpinner
 * draws eight bars that fill in clockwise as you pull, then spin while
 * refreshing. Android does not report overscroll, so it keeps the native spinner.
 */
export function usePullRefresh(onRefresh: () => Promise<unknown> | void, onScrollY?: (y: number) => void) {
  const colors = useThemeColors();
  const pull = useSharedValue(0);
  const [refreshing, setRefreshing] = useState(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const start = useCallback(() => {
    setRefreshing(true);
    const started = Date.now();
    void Promise.resolve()
      .then(() => onRefreshRef.current())
      .catch(() => {
        // The screen shows its own error state.
      })
      .finally(() => {
        setTimeout(() => setRefreshing(false), Math.max(0, MIN_SPIN_MS - (Date.now() - started)));
      });
  }, []);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      pull.value = Math.max(0, -event.contentOffset.y);
      if (onScrollY) runOnJS(onScrollY)(event.contentOffset.y);
    },
  }, [onScrollY]);

  const custom = Platform.OS === 'ios';
  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={start}
      tintColor={custom ? 'transparent' : colors.primary}
      colors={[colors.primary]}
    />
  );

  return { pull, refreshing, onScroll, refreshControl, custom };
}

/**
 * `safeTop` is the bottom of the status bar; `contentTop` is where the
 * scroll content starts (its top padding) before any pull.
 */
export function PullRefreshSpinner({ pull, refreshing, safeTop, contentTop }: { pull: SharedValue<number>; refreshing: boolean; safeTop: number; contentTop: number }) {
  const colors = useThemeColors();
  const spin = useSharedValue(0);
  const active = useSharedValue(0);

  useEffect(() => {
    active.value = refreshing ? 1 : 0;
    if (refreshing) {
      spin.value = 0;
      spin.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(spin);
    }
  }, [active, refreshing, spin]);

  // Rides just above the content as it slides down, then sits centred in the
  // gap between the status bar and the content once there is room.
  const wrapStyle = useAnimatedStyle(() => {
    const visible = pull.value > 2 || active.value === 1;
    const top = contentTop + pull.value;
    const centred = (safeTop + top) / 2 - SIZE / 2;
    return {
      opacity: visible ? 1 : 0,
      transform: [{ translateY: Math.min(centred, top - SIZE - 6) }],
    };
  });

  return (
    <Animated.View pointerEvents="none" style={[styles.wrap, wrapStyle]}>
      <View style={styles.spinner}>
        {Array.from({ length: BARS }, (_, index) => (
          <Bar key={index} index={index} pull={pull} spin={spin} active={active} color={colors.textSecondary} />
        ))}
      </View>
    </Animated.View>
  );
}

function Bar({ index, pull, spin, active, color }: { index: number; pull: SharedValue<number>; spin: SharedValue<number>; active: SharedValue<number>; color: string }) {
  const style = useAnimatedStyle(() => {
    if (active.value === 1) {
      // Spinning: the lit bar steps clockwise and the ones behind it fade.
      const step = Math.floor(spin.value * BARS) % BARS;
      const behind = (step - index + BARS) % BARS;
      return { opacity: 1 - 0.8 * (behind / (BARS - 1)) };
    }
    // Pulling: bars fill in clockwise from the top, one per eighth of the pull.
    const filled = (pull.value / FULL_PULL) * BARS;
    return { opacity: Math.min(1, Math.max(0, filled - index)) };
  });
  return (
    <Animated.View
      style={[
        styles.bar,
        { backgroundColor: color, transform: [{ rotate: `${index * (360 / BARS)}deg` }, { translateY: -BAR_RADIUS }] },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5, alignItems: 'center' },
  spinner: { width: SIZE, height: SIZE },
  bar: {
    position: 'absolute',
    left: (SIZE - BAR_WIDTH) / 2,
    top: (SIZE - BAR_HEIGHT) / 2,
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    borderRadius: BAR_WIDTH / 2,
  },
});
