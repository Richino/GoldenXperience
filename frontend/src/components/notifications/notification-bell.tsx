"use client";

import Link from "next/link";
import { Bell, CircleAlert, CircleCheck, CircleDot, CircleX, TriangleAlert, type LucideIcon } from "lucide-react";
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

// The row's tone shows as a small icon tile; the text itself stays neutral.
const TONE_ICON: Record<string, LucideIcon> = {
  "is-positive": CircleCheck,
  "is-negative": CircleX,
  "is-issue": TriangleAlert,
  "is-warning": CircleAlert,
  "is-info": Bell,
};

function dayLabel(value: string) {
  const day = new Date(value);
  const today = new Date();
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier";
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
      Read all
    </button>
  ) : null;

  const list = (
    <div className="notification-popover-list nl-notif-list">
      {!notifications.length ? (
        <div className="notification-popover-empty nl-notif-empty">
          <span className="nl-notif-icon" aria-hidden><Bell /></span>
          <p>No notifications yet.</p>
        </div>
      ) : (
        notifications.map((item, index) => {
          const detail = displayDetail(item);
          const tone = detailTone(item);
          const ToneIcon = TONE_ICON[tone] ?? CircleDot;
          const day = dayLabel(item.createdAt);
          const newDay = index === 0 || dayLabel(notifications[index - 1].createdAt) !== day;
          return (
            <div key={item.id} className="nl-notif-entry">
            {newDay ? <p className="nl-notif-day">{day}</p> : null}
            <Link
              href={notificationHref(item)}
              onClick={() => {
                void markRead([item.id]);
                setOpen(false);
              }}
              className={`notification-popover-item pressable ${item.readAt ? "" : "is-unread"} ${tone}`}
            >
              <span className="nl-notif-icon" aria-hidden>
                <ToneIcon />
                {!item.readAt ? <span className="nl-notif-dot" /> : null}
              </span>
              <div className="notification-popover-item-body">
                <div className="notification-popover-item-top">
                  <p className="notification-popover-item-title">{displayTitle(item)}</p>
                  <span className="notification-popover-item-time">{timeLabel(item.createdAt)}</span>
                </div>
                {detail ? <p className="notification-popover-item-message">{detail}</p> : null}
              </div>
            </Link>
            </div>
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
          eyebrow="Inbox"
          title="Notifications"
          headerAction={readAllButton}
        >
          {list}
        </MobileSheet>
      ) : open ? (
        <div className="notification-popover nl-notif absolute right-0 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden">
          <div className="notification-popover-head">
            <p className="notification-popover-title">Notifications</p>
            {unreadCount ? <span className="nl-notif-count">{unreadCount} new</span> : null}
            {readAllButton}
          </div>
          {list}
        </div>
      ) : null}
    </div>
  );
}
