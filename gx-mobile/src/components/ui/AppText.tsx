import { Text as NativeText, StyleSheet, type TextProps } from 'react-native';

import { usePreferences } from '@/lib/preferences/PreferencesContext';

const SCALE = { small: 0.9, standard: 1, large: 1.15 } as const;

/** Applies the user's GX text-size preference while preserving every screen's existing type styles. */
export function Text({ style, ...props }: TextProps) {
  const { textSize } = usePreferences();
  const scale = SCALE[textSize];
  const flattened = StyleSheet.flatten(style);
  const scaledStyle = scale === 1 || !flattened ? style : {
    ...flattened,
    ...(typeof flattened.fontSize === 'number' ? { fontSize: Math.round(flattened.fontSize * scale * 10) / 10 } : null),
    ...(typeof flattened.lineHeight === 'number' ? { lineHeight: Math.round(flattened.lineHeight * scale * 10) / 10 } : null),
  };
  return <NativeText {...props} style={scaledStyle} />;
}
