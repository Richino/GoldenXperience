import { StyleSheet, View } from 'react-native';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react-native';

import { Text } from '@/components/ui/AppText';
import { theme, type ThemeColors } from '@/constants/theme';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';
import type { CurrencyStrength, PairStrength } from '@/types/api';

const GRADE_LABEL = { strong: 'Strong', pullback: 'Pullback', turning: 'Turning', weak: 'Weak', range: 'Range' } as const;

/**
 * The pair picker's strength read, under the pair name: one pill combining
 * the 1H trend with what the last 4 hours are doing inside it, then any of its
 * two currencies that stand out as strong or weak across the other pairs.
 * Neutral currencies are left out so the line only speaks when there is
 * something to say.
 */
export function PairStrengthLine({
  strength,
  pillOnly = false,
}: {
  strength: PairStrength;
  /** Just the trend pill, for tight spots like the chart header. */
  pillOnly?: boolean;
}) {
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const { grade, direction } = strength.trend;
  const trendColor = direction === 'down' ? colors.danger : colors.primary;
  // A pullback keeps the trend's colour but drops the fill: same direction,
  // less conviction right now.
  const tone =
    grade === 'weak' || grade === 'turning' ? { color: colors.warning, background: colors.warningSoft, borderColor: 'transparent' }
    : grade === 'range' ? { color: colors.textSecondary, background: colors.surfaceRaised, borderColor: 'transparent' }
    : grade === 'pullback' ? { color: trendColor, background: 'transparent', borderColor: trendColor }
    : { color: trendColor, background: direction === 'down' ? colors.dangerSoft : colors.primarySoft, borderColor: 'transparent' };
  const Arrow = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : null;
  const standouts = pillOnly ? [] : [strength.base, strength.quote].filter(
    (currency): currency is CurrencyStrength => currency !== null && currency.tier !== 'neutral',
  );
  const trendLabel = `${GRADE_LABEL[grade]}${direction ? ` ${direction}` : ''}`;
  const currencyLabel = standouts.map((currency) => `${currency.currency} ${currency.tier}`).join(', ');

  return (
    <View style={[styles.row, pillOnly ? styles.pillOnly : null]} accessibilityLabel={currencyLabel ? `${trendLabel}. ${currencyLabel}` : trendLabel}>
      <View style={[styles.chip, { backgroundColor: tone.background, borderColor: tone.borderColor }]}>
        {Arrow ? <Arrow size={11} strokeWidth={2.4} color={tone.color} /> : null}
        <Text style={[styles.chipText, { color: tone.color }]}>{GRADE_LABEL[grade]}</Text>
      </View>
      {standouts.map((currency) => (
        <Text key={currency.currency} style={styles.currency}>
          {currency.currency}{' '}
          <Text style={{ color: currency.tier === 'strong' ? colors.primary : colors.danger }}>{currency.tier}</Text>
        </Text>
      ))}
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  pillOnly: { marginTop: 0, marginLeft: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  chipText: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold, letterSpacing: 0.2 },
  currency: { fontSize: 11, fontFamily: theme.fonts.sansMedium, color: colors.textSecondary },
});
