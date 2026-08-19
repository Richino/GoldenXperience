"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/api/url";
import { detailTone, displayDetail, displayTitle, notificationHref, sampleToastNotification } from "@/lib/notifications/display";
import { NOTIFICATION_SOUND_KEY, NOTIFICATION_VOLUME_KEY, notificationSoundPath, notificationVolume } from "@/lib/notifications/sounds";
import type { AppNotification, NotificationToast } from "@/lib/notifications/types";

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

function playSelectedSound(audio: HTMLAudioElement | null) {
  if (!audio) return;
  audio.src = notificationSoundPath(window.localStorage.getItem(NOTIFICATION_SOUND_KEY));
  audio.volume = notificationVolume(window.localStorage.getItem(NOTIFICATION_VOLUME_KEY));
  audio.currentTime = 0;
  void audio.play().catch(() => undefined);
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const initialized = useRef(false);
  const seenIds = useRef(new Set<string>());
  const audio = useRef<HTMLAudioElement | null>(null);
  const markReadRef = useRef<(ids?: string[]) => Promise<void>>(async () => undefined);

  const present = useCallback((events: NotificationToast[]) => {
    if (!events.length) return;
    playSelectedSound(audio.current);
    for (const item of [...events].reverse()) {
      const detail = displayDetail(item);
      toast({
        title: displayTitle(item),
        description: detail || undefined,
        href: item.preview ? undefined : notificationHref(item),
        preview: item.preview,
        tone: detailTone(item),
        variant: item.kind === "system_issue" ? "destructive" : "default",
        onNavigate: item.preview
          ? undefined
          : () => {
              void markReadRef.current([item.id]);
            },
      });
    }
    const hidden = document.visibilityState !== "visible";
    const latest = events[0]!;
    if (hidden && !latest.preview && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(latest.title, { body: latest.message, tag: latest.id });
    }
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

  useEffect(() => {
    markReadRef.current = markRead;
  }, [markRead]);

  const value = useMemo(
    () => ({ notifications, unreadCount, markRead, previewToast }),
    [markRead, notifications, previewToast, unreadCount],
  );
  return (
    <NotificationContext.Provider value={value}>
      <audio ref={audio} preload="auto" aria-hidden="true" />
      {children}
    </NotificationContext.Provider>
  );
}

export { useNotificationContext };
