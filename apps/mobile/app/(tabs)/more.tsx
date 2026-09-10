import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/components/ui/Screen";
import { Card } from "@/components/ui/Card";
import { AppText } from "@/components/ui/AppText";
import { SectionLabel } from "@/components/ui/Section";
import { useColors, useTheme, type ThemePreference } from "@/theme/ThemeProvider";
import { radius, spacing } from "@/theme/tokens";
import { useAuth } from "@/auth/AuthProvider";
import { useStreamStatus } from "@/realtime/MarketStreamProvider";

export default function MoreRoute() {
  const colors = useColors();
  const { user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const status = useStreamStatus();

  const streamLabel =
    status.phase === "connected"
      ? status.source === "mock"
        ? "Simulated data"
        : "Live"
      : status.phase === "offline"
        ? "Offline"
        : "Reconnecting";
  const streamTone = status.phase === "connected" && status.source === "oanda" ? colors.positive : status.phase === "offline" ? colors.negative : colors.warning;

  return (
    <Screen scroll>
      <AppText size="xl" weight="800">
        More
      </AppText>

      <Card>
        <AppText tone="muted" eyebrow>
          Signed in as
        </AppText>
        <AppText size="md" weight="700" style={{ marginTop: 4 }}>
          {user?.email ?? "GX account"}
        </AppText>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: streamTone }} />
          <AppText tone="secondary" size="sm">
            Market stream · {streamLabel}
          </AppText>
        </View>
      </Card>

      <View>
        <SectionLabel>Appearance</SectionLabel>
        <View style={{ flexDirection: "row", backgroundColor: colors.surfaceMuted, borderRadius: radius.md, padding: 3 }}>
          {(["system", "light", "dark"] as ThemePreference[]).map((option) => (
            <Pressable
              key={option}
              onPress={() => setPreference(option)}
              style={{
                flex: 1,
                paddingVertical: spacing.sm,
                borderRadius: radius.sm,
                backgroundColor: preference === option ? colors.surface : "transparent",
                alignItems: "center",
              }}
            >
              <AppText size="sm" weight="600" tone={preference === option ? "primary" : "muted"} style={{ textTransform: "capitalize" }}>
                {option}
              </AppText>
            </Pressable>
          ))}
        </View>
      </View>

      <Pressable
        onPress={() => void signOut()}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.sm,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingVertical: spacing.lg - 2,
        }}
      >
        <Ionicons name="log-out-outline" size={18} color={colors.negative} />
        <AppText size="md" weight="600" style={{ color: colors.negative }}>
          Sign out
        </AppText>
      </Pressable>

      <AppText tone="muted" size="xs" style={{ textAlign: "center" }}>
        GoldenXperience Mobile · Phase 1
      </AppText>
    </Screen>
  );
}
