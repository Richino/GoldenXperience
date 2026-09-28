import { StyleSheet, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

import { Text } from '@/components/ui/AppText';
import { theme, type ThemeColors } from '@/constants/theme';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';
import type { NewsSurpriseHint, TrendDirection } from '@/lib/news/surprise-hint';

function trendColor(colors: ThemeColors, direction: TrendDirection) {
  return direction === 'up' ? colors.chartUp : colors.chartDown;
}

function MiniTrendLine({ direction }: { direction: TrendDirection }) {
  const colors = useThemeColors();
  const rising = direction === 'up';
  const stroke = trendColor(colors, direction);
  return (
    <Svg width={18} height={8} viewBox="0 0 22 10">
      <Polyline
        points={rising ? '1,9 7,4 12,5 21,1' : '1,1 7,6 12,5 21,9'}
        fill="none"
        stroke={stroke}
        strokeWidth={1.85}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function HintLeg({
  direction,
  label,
  styles,
}: {
  direction: TrendDirection;
  label: string;
  styles: ReturnType<typeof createStyles>;
}) {
  const colors = useThemeColors();
  return (
    <View style={styles.leg}>
      <MiniTrendLine direction={direction} />
      <Text style={[styles.legLabel, { color: trendColor(colors, direction) }]}>{label}</Text>
    </View>
  );
}

export function NewsSurpriseHintView({ hint }: { hint: NewsSurpriseHint }) {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  if (hint.kind === 'unknown') return null;

  if (hint.kind === 'after') {
    if (hint.outcome === 'inline' || hint.direction === 'flat') {
      return <Text style={styles.neutral}>On forecast</Text>;
    }
    const direction = hint.direction;
    return (
      <View style={styles.row}>
        <MiniTrendLine direction={direction} />
        <Text style={[styles.afterLabel, { color: trendColor(colors, direction) }]}>
          {hint.outcome === 'beat' ? 'Beat' : 'Miss'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <HintLeg direction={hint.beatDirection} label="beat" styles={styles} />
      <Text style={styles.sep}>·</Text>
      <HintLeg direction={hint.missDirection} label="miss" styles={styles} />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 5,
      marginTop: 2,
    },
    leg: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
    },
    legLabel: {
      fontSize: 10,
      fontFamily: theme.fonts.sansMedium,
      letterSpacing: 0.3,
      textTransform: 'lowercase',
    },
    sep: {
      fontSize: 10,
      fontFamily: theme.fonts.sans,
      color: colors.textSecondary,
      opacity: 0.55,
    },
    afterLabel: {
      fontSize: 10,
      fontFamily: theme.fonts.sansSemiBold,
    },
    neutral: {
      marginTop: 2,
      fontSize: 10,
      fontFamily: theme.fonts.sans,
      color: colors.textSecondary,
    },
  });
