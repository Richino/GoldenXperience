import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * expo-secure-store has no web implementation (its native module simply
 * isn't present there — `getValueWithKeyAsync is not a function` on load),
 * so anything using it crashes the whole app on the web target. None of the
 * values stored through this — theme, text size, notification sound — are
 * secret, so plain localStorage is a fine, always-available stand-in.
 */
export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Best-effort: a private window or blocked storage shouldn't crash the app.
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}
