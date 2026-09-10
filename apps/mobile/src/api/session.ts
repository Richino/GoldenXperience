/**
 * Session token lifecycle.
 *
 * The GX backend authenticates with an HttpOnly `gx_session` cookie set by
 * `POST /api/auth/login`. React Native's networking layer consumes `Set-Cookie`
 * natively, so JavaScript never sees it in the response headers. We therefore
 * read the cookie back out of the native jar with `@react-native-cookies/cookies`
 * immediately after login, persist just the token to the encrypted keychain
 * (`expo-secure-store`), and thereafter attach it EXPLICITLY as a `Cookie`
 * header on every HTTP request and on the WebSocket upgrade. The backend's
 * cookie parser reads that header verbatim — so no backend change is needed,
 * and the session survives cold starts because the token lives in secure
 * storage rather than depending on the native jar persisting.
 *
 * Broker credentials are never stored client-side; only this opaque session
 * token is, and only in the keychain.
 */
import CookieManager from "@react-native-cookies/cookies";
import * as SecureStore from "expo-secure-store";
import { API_BASE_URL } from "@/api/config";

const COOKIE_NAME = "gx_session";
const STORE_KEY = "gx.session.token";

let cachedToken: string | null = null;
let loaded = false;

/** Loads the token from the keychain once, caching it in memory thereafter. */
export async function loadToken(): Promise<string | null> {
  if (loaded) return cachedToken;
  try {
    cachedToken = await SecureStore.getItemAsync(STORE_KEY);
  } catch {
    cachedToken = null;
  }
  loaded = true;
  return cachedToken;
}

export function getCachedToken(): string | null {
  return cachedToken;
}

async function persistToken(token: string | null): Promise<void> {
  cachedToken = token;
  loaded = true;
  try {
    if (token) await SecureStore.setItemAsync(STORE_KEY, token);
    else await SecureStore.deleteItemAsync(STORE_KEY);
  } catch {
    // Keychain unavailable — the in-memory cache still carries the session for
    // this launch; the user simply re-authenticates next cold start.
  }
}

/**
 * Called right after a successful login response. Pulls `gx_session` out of the
 * native cookie jar (including HttpOnly) and persists it. Returns true when a
 * token was captured.
 */
export async function captureSessionFromJar(): Promise<boolean> {
  try {
    const cookies = await CookieManager.get(API_BASE_URL);
    const value = cookies?.[COOKIE_NAME]?.value;
    if (value) {
      await persistToken(value);
      return true;
    }
  } catch {
    // Fall through — treated as a capture failure by the caller.
  }
  return false;
}

/** The `Cookie` header value, or null when there is no session. */
export function sessionCookieHeader(): string | null {
  return cachedToken ? `${COOKIE_NAME}=${cachedToken}` : null;
}

export async function clearSession(): Promise<void> {
  await persistToken(null);
  try {
    await CookieManager.clearAll();
  } catch {
    // Best effort; the manual Cookie header is already cleared above.
  }
}
