import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/auth/AuthProvider";
import { useColors } from "@/theme/ThemeProvider";
import { MarketStreamProvider } from "@/realtime/MarketStreamProvider";

type IoniconName = keyof typeof Ionicons.glyphMap;

/**
 * The five primary destinations (brief §6): Home, Signals, Chart, Trades, More.
 * Everything else is a nested stack route (e.g. /signals/[id]) reached from
 * these, never a sixth tab. The market stream lives here so it connects only
 * inside the authenticated app.
 */
export default function TabsLayout() {
  const { status } = useAuth();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  if (status === "unauthenticated") return <Redirect href="/login" />;

  return (
    <MarketStreamProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.gxAccent,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            height: 52 + insets.bottom,
            paddingBottom: insets.bottom,
            paddingTop: 6,
          },
          tabBarLabelStyle: { fontSize: 10, fontWeight: "600" },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ title: "Home", tabBarIcon: (props) => <TabIcon name="home" {...props} /> }}
        />
        <Tabs.Screen
          name="signals"
          options={{ title: "Signals", tabBarIcon: (props) => <TabIcon name="pulse" {...props} /> }}
        />
        <Tabs.Screen
          name="chart"
          options={{ title: "Chart", tabBarIcon: (props) => <TabIcon name="stats-chart" {...props} /> }}
        />
        <Tabs.Screen
          name="trades"
          options={{ title: "Trades", tabBarIcon: (props) => <TabIcon name="swap-vertical" {...props} /> }}
        />
        <Tabs.Screen
          name="more"
          options={{ title: "More", tabBarIcon: (props) => <TabIcon name="ellipsis-horizontal" {...props} /> }}
        />
      </Tabs>
    </MarketStreamProvider>
  );
}

function TabIcon({ name, color, focused }: { name: IoniconName; color: ColorValue; focused: boolean }) {
  const resolved = (focused ? name : `${String(name)}-outline`) as IoniconName;
  return <Ionicons name={resolved} size={22} color={color} />;
}
