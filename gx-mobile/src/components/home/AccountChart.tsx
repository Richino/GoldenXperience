import { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Path, Stop } from 'react-native-svg';

import { rawColors, theme, type ThemeColors } from '@/constants/theme';
import { useThemedStyles } from '@/lib/theme/useTheme';
import { Text } from '@/components/ui/AppText';
import { usePreferences } from '@/lib/preferences/PreferencesContext';
import { accountSeriesTone, type AccountChartPoint } from '@/lib/home/account-series';

function seriesStroke(tone: ReturnType<typeof accountSeriesTone>, palette: (typeof rawColors)['light' | 'dark']) {
  if (tone === 'up') return palette.chartUp;
  if (tone === 'down') return palette.chartDown;
  return palette.textMuted;
}

function chartDomain(points: AccountChartPoint[]) {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const room = Math.max((max - min) * 0.12, 1);
  const domainMin = min - room;
  const domainMax = max + room;
  return { domainMin, domainMax, domainSpan: domainMax - domainMin || 1 };
}

function buildPaths(points: AccountChartPoint[], width: number, height: number, domainMin: number, domainSpan: number) {
  if (points.length < 2 || width <= 0) return { line: '', area: '' };

  const padX = 4;
  const usableW = Math.max(width - padX, 1);
  const step = usableW / (points.length - 1);

  const coords = points.map((point, index) => ({
    x: padX + index * step,
    y: height - ((point.value - domainMin) / domainSpan) * height,
  }));

  let line = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 1; i < coords.length; i += 1) {
    line += ` L ${coords[i].x} ${coords[i].y}`;
  }
  const last = coords[coords.length - 1];
  const first = coords[0];
  const area = `${line} L ${last.x} ${height} L ${first.x} ${height} Z`;

  return { line, area };
}

export function AccountChart({ series, height = 148 }: { series: AccountChartPoint[]; height?: number }) {
  const styles = useThemedStyles(createStyles);
  const [width, setWidth] = useState(0);
  const { themeMode } = usePreferences();
  const palette = rawColors[themeMode];
  const tone = accountSeriesTone(series);
  const stroke = seriesStroke(tone, palette);
  const { domainMin, domainSpan } = useMemo(() => chartDomain(series), [series]);
  const paths = buildPaths(series, width, height, domainMin, domainSpan);
  const labelStep = Math.max(1, Math.ceil(series.length / 6));
  const labels = series.filter((_, index) => index % labelStep === 0 || index === series.length - 1);

  function onLayout(event: LayoutChangeEvent) {
    setWidth(event.nativeEvent.layout.width);
  }

  return (
    <View style={styles.wrap}>
      <View style={[styles.chart, { height }]} onLayout={onLayout}>
        {width > 0 ? (
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient id="accountFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset={0} stopColor={stroke} stopOpacity={0.28} />
                <Stop offset={1} stopColor={stroke} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {[0.25, 0.5, 0.75].map((ratio) => (
              <Line
                key={ratio}
                x1={0}
                x2={width}
                y1={height * ratio}
                y2={height * ratio}
                stroke={palette.border}
                strokeOpacity={0.45}
                strokeWidth={1}
              />
            ))}
            <Path d={paths.area} fill="url(#accountFill)" />
            <Path d={paths.line} stroke={stroke} strokeWidth={2.25} fill="none" strokeLinecap="butt" strokeLinejoin="miter" />
          </Svg>
        ) : null}
      </View>
      <View style={styles.labels}>
        {labels.map((point, index) => (
          <Text
            key={`${point.axisLabel}-${index}`}
            style={[
              styles.label,
              index === 0 ? styles.labelStart : null,
              index === labels.length - 1 ? styles.labelEnd : styles.labelCenter,
            ]}
            numberOfLines={1}
          >
            {point.axisLabel}
          </Text>
        ))}
      </View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  wrap: {
    marginTop: 4,
  },
  chart: {
    width: '100%',
  },
  labels: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  label: {
    flex: 1,
    fontSize: 9,
    fontFamily: theme.fonts.sansMedium,
    color: colors.textMuted,
  },
  labelStart: {
    textAlign: 'left',
  },
  labelCenter: {
    textAlign: 'center',
  },
  labelEnd: {
    textAlign: 'right',
  },
});
