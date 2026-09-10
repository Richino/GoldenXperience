import { View } from "react-native";
import { useColors } from "@/theme/ThemeProvider";
import { radius, spacing } from "@/theme/tokens";
import { AppText } from "@/components/ui/AppText";
import { useStreamStatus } from "@/realtime/MarketStreamProvider";

/**
 * A slim strip reflecting the market-stream phase. It shows only when there is
 * something worth saying — a healthy live connection stays silent so the screen
 * isn't cluttered. Handles connecting / reconnecting / offline / mock (§11).
 */
export function ConnectionBanner() {
  const colors = useColors();
  const status = useStreamStatus();

  // A live OANDA connection needs no banner.
  if (status.phase === "connected" && status.source === "oanda") return null;

  const tone =
    status.phase === "offline"
      ? { fg: colors.negative, bg: colors.negativeSoft, dot: colors.negative }
      : status.phase === "connected" && status.source === "mock"
        ? { fg: colors.warning, bg: colors.warningSoft, dot: colors.warning }
        : { fg: colors.textSecondary, bg: colors.surfaceMuted, dot: colors.warning };

  const label =
    status.phase === "connecting"
      ? "Connecting to market stream…"
      : status.phase === "reconnecting"
        ? "Reconnecting…"
        : status.phase === "offline"
          ? "Market stream offline"
          : status.source === "mock"
            ? "Simulated market data"
            : status.message;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        backgroundColor: tone.bg,
        borderRadius: radius.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone.dot }} />
      <AppText size="xs" weight="600" style={{ color: tone.fg }}>
        {label}
      </AppText>
    </View>
  );
}
