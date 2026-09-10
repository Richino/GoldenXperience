import { useEffect, useMemo } from "react";
import { Animated, type DimensionValue } from "react-native";
import { useColors } from "@/theme/ThemeProvider";
import { radius as radiusScale } from "@/theme/tokens";

interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: object;
}

/**
 * A gently pulsing placeholder. Financial screens must not flash fake values
 * while loading (brief §14), so real figures are replaced by these until the
 * true number is known. Uses core `Animated` (native driver) — no extra deps.
 */
export function Skeleton({ width = "100%", height = 14, radius = radiusScale.sm, style }: SkeletonProps) {
  const colors = useColors();
  const pulse = useMemo(() => new Animated.Value(0.4), []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: colors.surfaceMuted, opacity: pulse },
        style,
      ]}
    />
  );
}
