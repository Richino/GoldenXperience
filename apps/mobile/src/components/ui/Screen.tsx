import { type ReactNode } from "react";
import { RefreshControl, ScrollView, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";

interface ScreenProps {
  children: ReactNode;
  /** Enables a vertical scroll view with optional pull-to-refresh. */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: ViewStyle;
}

/**
 * The themed page frame. Paints the app background, respects the status-bar
 * safe area at the top, and leaves room at the bottom for the tab bar. Wraps a
 * pull-to-refresh scroll view when asked (brief §16).
 */
export function Screen({ children, scroll = false, refreshing = false, onRefresh, contentStyle }: ScreenProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = insets.top + spacing.sm;

  if (scroll) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={[
          { paddingTop: topPad, paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
          contentStyle,
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.textMuted}
              colors={[colors.gxAccent]}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <View
      style={[
        { flex: 1, backgroundColor: colors.background, paddingTop: topPad, paddingHorizontal: spacing.lg },
        contentStyle,
      ]}
    >
      {children}
    </View>
  );
}
