import { View } from "react-native";
import { useColors } from "@/theme/ThemeProvider";
import { radius, spacing } from "@/theme/tokens";
import { AppText } from "@/components/ui/AppText";
import type { SignalStatus } from "@/lib/signals";

/** LONG / SHORT chip — restrained green/red, the GX trading semantics. */
export function SideTag({ direction }: { direction: "long" | "short" }) {
  const colors = useColors();
  const long = direction === "long";
  return (
    <View
      style={{
        backgroundColor: long ? colors.positiveSoft : colors.negativeSoft,
        borderRadius: radius.sm,
        paddingHorizontal: 6,
        paddingVertical: 2,
      }}
    >
      <AppText size="xs" weight="700" style={{ color: long ? colors.positive : colors.negative, letterSpacing: 0.4 }}>
        {long ? "LONG" : "SHORT"}
      </AppText>
    </View>
  );
}

const STATUS_LABEL: Record<SignalStatus, string> = {
  active: "Active",
  watching: "Watching",
  triggered: "Triggered",
};

export function StatusPill({ status }: { status: SignalStatus }) {
  const colors = useColors();
  const color =
    status === "active" ? colors.positive : status === "watching" ? colors.warning : colors.gxAccent;
  const bg =
    status === "active" ? colors.positiveSoft : status === "watching" ? colors.warningSoft : colors.gxAccentSoft;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs,
        backgroundColor: bg,
        borderRadius: radius.pill,
        paddingHorizontal: spacing.sm,
        paddingVertical: 3,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <AppText size="xs" weight="600" style={{ color }}>
        {STATUS_LABEL[status]}
      </AppText>
    </View>
  );
}
