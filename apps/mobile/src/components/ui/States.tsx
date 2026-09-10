import { type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { ApiError } from "@/api/client";
import { useColors } from "@/theme/ThemeProvider";
import { radius, spacing } from "@/theme/tokens";
import { AppText } from "@/components/ui/AppText";

/** A calm, intentional empty state — never a blank void (brief §§9, 14). */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={{ paddingVertical: spacing.xl, alignItems: "center", gap: spacing.xs }}>
      <AppText tone="secondary" size="sm" weight="600">
        {title}
      </AppText>
      {hint ? (
        <AppText tone="muted" size="xs" style={{ textAlign: "center", maxWidth: 260 }}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

/**
 * Error / offline state with a retry. Distinguishes a connectivity problem from
 * a server error so the copy is honest (brief §14).
 */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const colors = useColors();
  const offline = error.isOffline;
  return (
    <View style={{ paddingVertical: spacing.xl, alignItems: "center", gap: spacing.md }}>
      <AppText tone="secondary" size="sm" weight="600">
        {offline ? "You appear to be offline" : "Couldn’t load this"}
      </AppText>
      <AppText tone="muted" size="xs" style={{ textAlign: "center", maxWidth: 280 }}>
        {offline ? "Check your connection — we’ll keep the last data on screen." : error.message}
      </AppText>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={{
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.pill,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.sm,
          }}
        >
          <AppText size="sm" tone="accent" weight="600">
            Try again
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Wraps children with the section chrome so skeletons match real layout. */
export function StateBlock({ children }: { children: ReactNode }) {
  return <View style={{ gap: spacing.sm }}>{children}</View>;
}
