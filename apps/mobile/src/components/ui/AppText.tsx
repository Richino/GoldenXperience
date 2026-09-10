import { Text, type TextProps, type TextStyle } from "react-native";
import { useColors } from "@/theme/ThemeProvider";
import { fontSize, monoFont } from "@/theme/tokens";

type Tone = "primary" | "secondary" | "muted" | "accent" | "positive" | "negative" | "warning";

interface AppTextProps extends TextProps {
  tone?: Tone;
  size?: keyof typeof fontSize;
  weight?: TextStyle["fontWeight"];
  /** Tabular mono figures for prices, P/L and R multiples. */
  mono?: boolean;
  /** Uppercase, letter-spaced eyebrow labels. */
  eyebrow?: boolean;
}

export function AppText({
  tone = "primary",
  size = "base",
  weight = "500",
  mono = false,
  eyebrow = false,
  style,
  ...props
}: AppTextProps) {
  const colors = useColors();
  const color =
    tone === "secondary"
      ? colors.textSecondary
      : tone === "muted"
        ? colors.textMuted
        : tone === "accent"
          ? colors.gxAccent
          : tone === "positive"
            ? colors.positive
            : tone === "negative"
              ? colors.negative
              : tone === "warning"
                ? colors.warning
                : colors.textPrimary;

  return (
    <Text
      {...props}
      style={[
        {
          color,
          fontSize: fontSize[size],
          fontWeight: weight,
          ...(mono ? { fontFamily: monoFont, fontVariant: ["tabular-nums"] } : null),
          ...(eyebrow
            ? { fontSize: fontSize.xs, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" }
            : null),
        },
        style,
      ]}
    />
  );
}
