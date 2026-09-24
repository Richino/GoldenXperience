import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold, Geist_800ExtraBold, useFonts as useGeist } from '@expo-google-fonts/geist';
import {
  GeistMono_400Regular,
  GeistMono_500Medium,
  GeistMono_600SemiBold,
  GeistMono_700Bold,
  useFonts as useGeistMono,
} from '@expo-google-fonts/geist-mono';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import { LoginScreen } from '@/components/auth/LoginScreen';
import { SplashView } from '@/components/auth/SplashView';
import { theme } from '@/constants/theme';
import { AuthProvider, useAuth } from '@/lib/auth/AuthContext';
import { PreferencesProvider } from '@/lib/preferences/PreferencesContext';

SplashScreen.preventAutoHideAsync().catch(() => {
  // Dev hot reload can call this twice; ignore.
});

const MIN_SPLASH_MS = 700;

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, checking } = useAuth();
  const [minElapsed, setMinElapsed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMinElapsed(true), MIN_SPLASH_MS);
    return () => clearTimeout(timer);
  }, []);

  const showSplash = checking || !minElapsed;

  if (showSplash) return <SplashView message="Loading workspace" fontsLoaded />;

  if (!user) return <LoginScreen />;

  return <>{children}</>;
}

export default function RootLayout() {
  const [geistLoaded] = useGeist({ Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold, Geist_800ExtraBold });
  const [monoLoaded] = useGeistMono({ GeistMono_400Regular, GeistMono_500Medium, GeistMono_600SemiBold, GeistMono_700Bold });
  const fontsReady = geistLoaded && monoLoaded;
  const nativeHidden = useRef(false);

  const revealJsSplash = useCallback(() => {
    if (nativeHidden.current) return;
    nativeHidden.current = true;
    void SplashScreen.hideAsync();
  }, []);

  return (
    <SafeAreaProvider>
      <PreferencesProvider>
        <StatusBar style="auto" />
        {!fontsReady ? (
          <SplashView message="Starting up" fontsLoaded={false} onLayout={revealJsSplash} />
        ) : (
          <AuthProvider>
            <SplashReveal onReady={revealJsSplash} />
            <AuthGate>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: theme.colors.background },
                }}
              >
                <Stack.Screen name="(tabs)" />
              </Stack>
            </AuthGate>
          </AuthProvider>
        )}
      </PreferencesProvider>
    </SafeAreaProvider>
  );
}

/** Hides the native splash once fonts are ready so the branded JS splash is visible (incl. Expo Go). */
function SplashReveal({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return null;
}
