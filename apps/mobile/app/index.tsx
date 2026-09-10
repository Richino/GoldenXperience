import { Redirect } from "expo-router";
import { View } from "react-native";
import { useAuth } from "@/auth/AuthProvider";
import { useColors } from "@/theme/ThemeProvider";
import { Skeleton } from "@/components/ui/Skeleton";
import { Screen } from "@/components/ui/Screen";

/** Entry gate: waits for the session check, then routes to app or login. */
export default function Index() {
  const { status } = useAuth();
  const colors = useColors();

  if (status === "loading") {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: "center", gap: 12 }}>
          <Skeleton width={140} height={22} />
          <Skeleton width={220} height={14} />
          <Skeleton width={180} height={14} />
        </View>
        <View style={{ height: 1, backgroundColor: colors.border }} />
      </Screen>
    );
  }

  return <Redirect href={status === "authenticated" ? "/(tabs)" : "/login"} />;
}
