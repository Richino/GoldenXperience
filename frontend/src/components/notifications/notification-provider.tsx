"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { currentPushStatus } from "@/lib/notifications/push";
import { sampleToastNotification } from "@/lib/notifications/display";
import { playNotificationSound, unlockNotificationAudio } from "@/lib/notifications/play";
import { NOTIFICATION_SOUND_KEY, NOTIFICATION_VOLUME_KEY, notificationSoundPath, notificationVolume } from "@/lib/notifications/sounds";
import type { AppNotification, NotificationToast } from "@/lib/notifications/types";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";

export type { AppNotification, NotificationToast };

type NotificationContextValue = {
  notifications: AppNotification[];
  unreadCount: number;
  markRead: (ids?: string[]) => Promise<void>;
  previewToast: () => void;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

function useNotificationContext() {
  const value = useContext(NotificationContext);
  if (!value) throw new Error("NotificationProvider is required.");
  return value;
}

/** The chosen sound at the chosen volume, mixed with other audio (lib/notifications/play). */
function playSelectedSound() {
  void playNotificationSound(
    notificationSoundPath(window.localStorage.getItem(NOTIFICATION_SOUND_KEY)),
    notificationVolume(window.localStorage.getItem(NOTIFICATION_VOLUME_KEY)),
  );
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const initialized = useRef(false);
  const seenIds = useRef(new Set<string>());

  // No in-app toast: new notifications play the sound, land in the bell's
  // inbox, and raise a system notification only while the tab is hidden.
  const present = useCallback((events: NotificationToast[]) => {
    if (!events.length) return;
    playSelectedSound();
    const hidden = document.visibilityState !== "visible";
    const latest = events[0]!;
    if (hidden && !latest.preview && typeof Notification !== "undefined" && Notification.permission === "granted") {
      void currentPushStatus().then(status => {
        if (status === "enabled" && document.visibilityState !== "visible") new Notification(latest.title, { body: latest.message, tag: latest.id });
      }).catch(() => { /* A disabled or unverifiable device must not show system alerts. */ });
    }
  }, []);

  // iOS starts web audio only after a gesture; the first tap or key press
  // unlocks it so later notifications can play their sound.
  useEffect(() => {
    const unlock = () => unlockNotificationAudio();
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const previewToast = useCallback(() => {
    present([{ ...sampleToastNotification(), preview: true }]);
  }, [present]);

  const announce = useCallback((events: AppNotification[]) => {
    present(events);
  }, [present]);

  const refresh = useCallback(async () => {
    const url = cursor ? apiUrl(`/api/notifications?after=${encodeURIComponent(cursor)}`) : apiUrl("/api/notifications");
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { notifications: AppNotification[]; unreadCount: number; cursor: string | null };
    const incoming = payload.notifications ?? [];
    const fresh = incoming.filter((item) => !seenIds.current.has(item.id));
    incoming.forEach((item) => seenIds.current.add(item.id));
    if (initialized.current) announce(fresh);
    setNotifications((current) => [...fresh, ...current].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 50));
    setUnreadCount(payload.unreadCount ?? 0);
    setCursor(payload.cursor ?? cursor);
    initialized.current = true;
  }, [announce, cursor]);

  useEffect(() => {
    void refresh();
    // Trade state changes should feel live while the workspace is open. Event
    // IDs and the server dedupe key prevent a polling refresh from replaying a
    // notification that was already presented.
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useForegroundRefresh(refresh);

  const markRead = useCallback(async (ids?: string[]) => {
    const response = await fetch(apiUrl("/api/notifications/read"), {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids?.length ? { ids } : {}),
    });
    if (!response.ok) return;
    const now = new Date().toISOString();
    setNotifications((items) => items.map((item) => !ids || ids.includes(item.id) ? { ...item, readAt: item.readAt ?? now } : item));
    setUnreadCount((count) => ids?.length ? Math.max(0, count - ids.filter((id) => notifications.some((item) => item.id === id && !item.readAt)).length) : 0);
  }, [notifications]);

  const value = useMemo(
    () => ({ notifications, unreadCount, markRead, previewToast }),
    [markRead, notifications, previewToast, unreadCount],
  );
  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export { useNotificationContext };
