/** Authentication against the existing GX account system. */
import { apiGet, apiSend } from "@/api/client";
import { captureSessionFromJar, clearSession } from "@/api/session";

export interface GxUser {
  id: string;
  email: string;
}

/**
 * Logs in and captures the session token. The POST sets the `gx_session`
 * cookie in the native jar; `captureSessionFromJar` then reads it into secure
 * storage so subsequent requests carry it explicitly.
 */
export async function login(email: string, password: string): Promise<GxUser> {
  const payload = await apiSend<{ user: GxUser }>("/api/auth/login", "POST", {
    email: email.trim(),
    password,
  });
  await captureSessionFromJar();
  return payload.user;
}

/** Verifies the stored session is still valid, returning the current user. */
export async function fetchMe(): Promise<GxUser> {
  const payload = await apiGet<{ user: GxUser }>("/api/auth/me");
  return payload.user;
}

export async function logout(): Promise<void> {
  try {
    await apiSend("/api/auth/logout", "POST");
  } finally {
    // Always drop the local session even if the network call fails.
    await clearSession();
  }
}
