import { apiUrl } from "@/lib/api/url";

export type PushUiStatus =
  | "checking"
  | "available"
  | "enabled"
  | "blocked"
  | "unsupported"
  | "unavailable"
  | "insecure"
  | "install_required"
  | "error";

function isAppleMobile() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/i.test(ua);
  const iPadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iOS || iPadOs;
}

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function pushApisPresent() {
  return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
}

/** iOS only delivers web push inside a Home Screen web app, not a Safari tab. */
export function applePushNeedsHomeScreen() {
  return isAppleMobile() && !isStandaloneDisplay();
}

export function applicationServerKeyFrom(publicKey: string) {
  const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
  const binary = window.atob((publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function ensurePushServiceWorker() {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function currentPushStatus(): Promise<PushUiStatus> {
  if (!window.isSecureContext) return "insecure";
  if (!pushApisPresent()) return "unsupported";
  if (applePushNeedsHomeScreen()) return "install_required";
  if (Notification.permission === "denied") return "blocked";
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    const response = await fetch(apiUrl("/api/push/vapid-key"), { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return "unavailable";
    if (!subscription || Notification.permission !== "granted") return "available";
    const saved = await fetch(apiUrl("/api/push/status"), {
      method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }), signal: AbortSignal.timeout(10_000),
    });
    if (!saved.ok) return "error";
    const result = await saved.json() as { registered?: boolean };
    return result.registered === true ? "enabled" : "available";
  } catch {
    return "error";
  }
}

export async function subscribeThisDeviceToPush() {
  if (!window.isSecureContext) return { status: "insecure" as const };
  if (!pushApisPresent()) return { status: "unsupported" as const };
  if (applePushNeedsHomeScreen()) return { status: "install_required" as const };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { status: permission === "denied" ? "blocked" as const : "error" as const, permission, message: permission === "denied" ? "Notifications are blocked for this site." : "Notification permission was not granted." };
  }

  const keyResponse = await fetch(apiUrl("/api/push/vapid-key"), { credentials: "include", cache: "no-store" });
  if (!keyResponse.ok) return { status: "unavailable" as const, permission };

  const { publicKey } = await keyResponse.json() as { publicKey: string };
  const registration = await ensurePushServiceWorker();
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKeyFrom(publicKey),
  });
  const response = await fetch(apiUrl("/api/push/subscribe"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
  if (!response.ok) return { status: "error" as const, permission, message: "The server could not save this device." };
  return { status: "enabled" as const, permission };
}

/** Remove only this device's subscription; keep the worker and other devices intact. */
export async function unsubscribeThisDeviceFromPush() {
  if (!pushApisPresent()) return { status: "unsupported" as const };
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    const response = await fetch(apiUrl("/api/push/subscribe"), {
      method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Notifications could not be disabled on the server. Try again.");
    const removed = await subscription.unsubscribe();
    if (!removed && await registration?.pushManager.getSubscription()) throw new Error("The server stopped alerts, but this browser could not remove its subscription. Try again.");
  }
  return { status: "available" as const };
}
