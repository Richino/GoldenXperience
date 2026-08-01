"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { NOTIFICATION_SOUND_KEY, NOTIFICATION_VOLUME_KEY, notificationSoundPath, notificationVolume } from "@/lib/notifications/sounds";

export type AppNotification = {
  id: string;
  kind: "setup_ready" | "paper_opened" | "paper_closed" | "system_issue";
  title: string;
  message: string;
  instrument: string | null;
  paperTradeId: string | null;
  readAt: string | null;
  createdAt: string;
};

type NotificationContextValue = {
  notifications: AppNotification[];
  unreadCount: number;
  markRead: (ids?: string[]) => Promise<void>;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

function useNotificationContext() {
  const value = useContext(NotificationContext);
  if (!value) throw new Error("NotificationProvider is required.");
  return value;
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const initialized = useRef(false);
  const seenIds = useRef(new Set<string>());
  const audio = useRef<HTMLAudioElement | null>(null);

  const announce = useCallback((events: AppNotification[]) => {
    if (!events.length) return;
    const selectedSound = window.localStorage.getItem(NOTIFICATION_SOUND_KEY);
    if (audio.current) {
      audio.current.src = notificationSoundPath(selectedSound);
      audio.current.volume = notificationVolume(window.localStorage.getItem(NOTIFICATION_VOLUME_KEY));
      audio.current.currentTime = 0;
      void audio.current.play().catch(() => undefined);
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const latest = events[0]!;
      new Notification(latest.title, { body: latest.message, tag: latest.id });
    }
  }, []);

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
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

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

  const value = useMemo(() => ({ notifications, unreadCount, markRead }), [markRead, notifications, unreadCount]);
  return <NotificationContext.Provider value={value}><audio ref={audio} preload="auto" aria-hidden="true" />{children}</NotificationContext.Provider>;
}

export { useNotificationContext };
