"use client";

import Link from "next/link";
import { Bell, CheckCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { detailTone, displayDetail, displayTitle, notificationHref } from "@/lib/notifications/display";
import { useNotificationContext } from "./notification-provider";

function timeLabel(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function NotificationBell({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  const { notifications, unreadCount, markRead } = useNotificationContext();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonClass = compact
    ? `mobile-icon-btn pressable relative text-[color:var(--muted-strong)] hover:text-[color:var(--foreground)] ${open ? "control-active" : ""} ${className}`
    : `notification-bell-btn pressable relative hidden size-10 place-items-center rounded-full bg-[color:var(--surface)] text-[color:var(--muted-strong)] hover:text-[color:var(--foreground)] lg:grid ${open ? "control-active" : ""} ${className}`;

  // The sheet portals out of this subtree and closes itself on a backdrop tap
  // or Escape, so the popover's dismissal wiring only applies on desktop.
  useEffect(() => {
    if (!open || compact) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [compact, open]);

  const readAllButton = unreadCount ? (
    <button
      type="button"
      onClick={() => void markRead()}
      className="notification-popover-read-all pressable"
      aria-label="Mark all as read"
    >
      <CheckCheck className="size-3.5" />
      <span>Read all</span>
    </button>
  ) : null;

  const list = (
    <div className="notification-popover-list">
      {!notifications.length ? (
        <p className="notification-popover-empty">No notifications yet.</p>
      ) : (
        notifications.map((item) => {
          const detail = displayDetail(item);
          const tone = detailTone(item);
          return (
            <Link
              key={item.id}
              href={notificationHref(item)}
              onClick={() => {
                void markRead([item.id]);
                setOpen(false);
              }}
              className={`notification-popover-item pressable ${item.readAt ? "" : "is-unread"} ${item.kind === "system_issue" ? "is-issue" : ""}`}
            >
              <span className="notification-unread-slot" aria-hidden>
                {!item.readAt ? <span className="notification-unread-dot" /> : null}
              </span>
              <div className="notification-popover-item-body">
                <div className="notification-popover-item-top">
                  <p className="notification-popover-item-title">{displayTitle(item)}</p>
                  <span className="notification-popover-item-time">{timeLabel(item.createdAt)}</span>
                </div>
                {detail ? <p className={`notification-popover-item-message ${tone}`}>{detail}</p> : null}
              </div>
            </Link>
          );
        })
      )}
    </div>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={buttonClass}
        type="button"
      >
        <Bell className="size-[18px]" strokeWidth={compact ? 1.9 : 2} />
        {unreadCount > 0 ? (
          <span className="absolute right-1.5 top-1.5 grid min-w-[1.125rem] place-items-center rounded-full bg-[color:var(--danger)] px-1 text-[0.55rem] font-bold leading-3 text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {compact ? (
        <MobileSheet
          open={open}
          onClose={() => setOpen(false)}
          title="Notifications"
          headerAction={readAllButton}
        >
          {list}
        </MobileSheet>
      ) : open ? (
        <div className="notification-popover menu-popover absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl">
          <div className="notification-popover-head">
            <p className="notification-popover-title">Notifications</p>
            {readAllButton}
          </div>
          {list}
        </div>
      ) : null}
    </div>
  );
}
