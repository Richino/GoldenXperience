import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * Same API service the web app talks to (api-server, default port 8787).
 *
 * On web this runs in the same browser as the dev machine, so `localhost`
 * resolves correctly. On a native device (phone/tablet over Expo Go),
 * `localhost` would resolve to the device itself, not this machine — so
 * native defaults to the dev machine's LAN IP instead.
 *
 * Standalone iPhone/Android builds (EAS) must set EXPO_PUBLIC_API_URL and
 * EXPO_PUBLIC_WEB_APP_URL to your **public HTTPS** frontend URL (same value
 * for both) so the app works with your PC off. See gx-mobile/.env.example.
 */
const PRODUCTION_APP_URL = 'https://goldenxperience.com';
const LAN_API_URL = 'http://10.0.0.111:8787';
const LOCALHOST_API_URL = 'http://localhost:8787';
/** Release builds (EAS / TestFlight) with no env override use production. */
const isReleaseBuild = !__DEV__ && !Constants.expoConfig?.hostUri && !Constants.expoGoConfig?.debuggerHost;

const DEFAULT_API_URL = Platform.OS === 'web'
  ? LOCALHOST_API_URL
  : isReleaseBuild
    ? PRODUCTION_APP_URL
    : LAN_API_URL;
const LAN_WEB_APP_URL = 'http://10.0.0.111:3000';
const LOCALHOST_WEB_APP_URL = 'http://localhost:3000';
const expoHost = (Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost ?? '').replace(/^https?:\/\//, '').split(':')[0];
const DEFAULT_WEB_APP_URL = Platform.OS === 'web'
  ? LOCALHOST_WEB_APP_URL
  : isReleaseBuild
    ? PRODUCTION_APP_URL
    : expoHost
      ? `http://${expoHost}:3000`
      : LAN_WEB_APP_URL;

export function apiUrl(path: string) {
  const base = (process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
}

/** The dedicated GX chart-canvas endpoint used only by the native Chart tab. */
export function webAppUrl(path = '') {
  const base = (process.env.EXPO_PUBLIC_WEB_APP_URL || DEFAULT_WEB_APP_URL).replace(/\/$/, '');
  const normalized = path && !path.startsWith('/') ? `/${path}` : path;
  return `${base}${normalized}`;
}
