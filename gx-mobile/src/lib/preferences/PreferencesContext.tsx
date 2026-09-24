import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance } from 'react-native';

import { getItem, setItem } from '@/lib/storage';

export const notificationSounds = [
  { value: 'soft-whistle', label: 'Soft Whistle' },
  { value: 'quick-chime', label: 'Quick Chime' },
  { value: 'bright-ping', label: 'Bright Ping' },
  { value: 'classic-ring', label: 'Classic Ring' },
  { value: 'chat-alert', label: 'Chat Alert' },
] as const;

export type NotificationSound = (typeof notificationSounds)[number]['value'];
export type ThemeMode = 'dark' | 'light';
export type TextSize = 'small' | 'standard' | 'large';

type Preferences = {
  themeMode: ThemeMode;
  textSize: TextSize;
  notificationSound: NotificationSound;
  ready: boolean;
  setThemeMode: (value: ThemeMode) => void;
  setTextSize: (value: TextSize) => void;
  setNotificationSound: (value: NotificationSound) => void;
};

const KEYS = {
  themeMode: 'gx-mobile.theme-mode',
  textSize: 'gx-mobile.text-size',
  notificationSound: 'gx-mobile.notification-sound',
} as const;

const DEFAULTS = { themeMode: 'dark' as ThemeMode, textSize: 'standard' as TextSize, notificationSound: 'soft-whistle' as NotificationSound };
const PreferencesContext = createContext<Preferences | null>(null);

function validTheme(value: string | null): value is ThemeMode { return value === 'dark' || value === 'light'; }
function validTextSize(value: string | null): value is TextSize { return value === 'small' || value === 'standard' || value === 'large'; }
function validSound(value: string | null): value is NotificationSound { return notificationSounds.some((sound) => sound.value === value); }

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(DEFAULTS.themeMode);
  const [textSize, setTextSizeState] = useState<TextSize>(DEFAULTS.textSize);
  const [notificationSound, setNotificationSoundState] = useState<NotificationSound>(DEFAULTS.notificationSound);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getItem(KEYS.themeMode), getItem(KEYS.textSize), getItem(KEYS.notificationSound)])
      .then(([storedTheme, storedSize, storedSound]) => {
        if (cancelled) return;
        if (validTheme(storedTheme)) setThemeModeState(storedTheme);
        if (validTheme(storedTheme)) Appearance.setColorScheme(storedTheme);
        if (validTextSize(storedSize)) setTextSizeState(storedSize);
        if (validSound(storedSound)) setNotificationSoundState(storedSound);
      })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  const setThemeMode = useCallback((value: ThemeMode) => { Appearance.setColorScheme(value); setThemeModeState(value); void setItem(KEYS.themeMode, value); }, []);
  const setTextSize = useCallback((value: TextSize) => { setTextSizeState(value); void setItem(KEYS.textSize, value); }, []);
  const setNotificationSound = useCallback((value: NotificationSound) => { setNotificationSoundState(value); void setItem(KEYS.notificationSound, value); }, []);

  const value = useMemo(() => ({ themeMode, textSize, notificationSound, ready, setThemeMode, setTextSize, setNotificationSound }), [themeMode, textSize, notificationSound, ready, setThemeMode, setTextSize, setNotificationSound]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences must be used inside PreferencesProvider.');
  return context;
}
