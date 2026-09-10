import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "@/auth/AuthProvider";
import { ThemeProvider, useTheme } from "@/theme/ThemeProvider";

/**
 * App root. Order matters: SafeAreaProvider → ThemeProvider (so every child can
 * read colours) → AuthProvider (owns the session) → the navigator. The market
 * stream is mounted deeper, inside the authenticated tab group, so it only
 * connects once the user is signed in.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <ThemedNavigator />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function ThemedNavigator() {
  const { colors, name } = useTheme();
  return (
    <>
      <StatusBar style={name === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: "fade",
        }}
      />
    </>
  );
}
