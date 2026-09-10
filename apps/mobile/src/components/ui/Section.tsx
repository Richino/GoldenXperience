import { type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { spacing } from "@/theme/tokens";
import { AppText } from "@/components/ui/AppText";

interface SectionHeaderProps {
  title: string;
  action?: { label: string; onPress: () => void };
}

/** A section title with an optional right-aligned link, e.g. "See all". */
export function SectionHeader({ title, action }: SectionHeaderProps) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: spacing.md,
      }}
    >
      <AppText size="md" weight="700">
        {title}
      </AppText>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8}>
          <AppText size="sm" tone="accent" weight="600">
            {action.label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A small uppercase eyebrow label used above compact lists. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <AppText tone="muted" eyebrow style={{ marginBottom: spacing.sm }}>
      {children}
    </AppText>
  );
}
