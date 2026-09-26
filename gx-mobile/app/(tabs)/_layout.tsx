import { Tabs } from 'expo-router';

import { CustomTabBar } from '@/components/navigation/CustomTabBar';
import { IOSStatusAreaOverlay } from '@/components/ui/IOSStatusAreaOverlay';
import { GlobalNotificationBell } from '@/components/ui/GlobalNotificationBell';
import { useThemeColors } from '@/lib/theme/useTheme';

export default function TabsLayout() {
  const colors = useThemeColors();
  return <>
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: {
          backgroundColor: colors.background,
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="chart" options={{ title: 'Chart' }} />
      <Tabs.Screen name="journal" options={{ title: 'Journal' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
    <IOSStatusAreaOverlay />
    <GlobalNotificationBell />
  </>;
}
