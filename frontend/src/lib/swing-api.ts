import { apiUrl } from "./api/url";

export const SWING_CHANGED = "gx:swing-intelligence";
export async function swingRead<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(`/api/swing-intelligence${path}`), { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(20000), ...init });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Swing analysis could not be loaded.");
  return data;
}
export function swingChanged(instrument: string) {
  window.dispatchEvent(new CustomEvent(SWING_CHANGED, { detail: { instrument } }));
}
