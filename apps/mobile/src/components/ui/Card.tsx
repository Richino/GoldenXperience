import { View, type ViewProps } from "react-native";
import { useColors } from "@/theme/ThemeProvider";
import { radius, spacing } from "@/theme/tokens";

interface CardProps extends ViewProps {
  /** A slightly raised fill for nested cards / hero panels. */
  elevated?: boolean;
  padded?: boolean;
}

/**
 * The GX surface card: a single hairline border, no drop shadow (the design
 * uses minimal borders and minimal shadows). Cards are used only where a group
 * of figures needs separating — rows elsewhere sit directly on the background.
 */
export function Card({ elevated = false, padded = true, style, ...props }: CardProps) {
  const colors = useColors();
  return (
    <View
      {...props}
      style={[
        {
          backgroundColor: elevated ? colors.surfaceElevated : colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: radius.card,
          padding: padded ? spacing.lg : 0,
        },
        style,
      ]}
    />
  );
}
