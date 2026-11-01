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

// The row's tone shows as a small colored icon; the text itself stays neutral.
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

type Filter = "all" | "unread";

export function NotificationBell({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  const { notifications, unreadCount, markRead } = useNotificationContext();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
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

  const shown = filter === "unread" ? notifications.filter((item) => !item.readAt) : notifications;

  const readAllButton = unreadCount ? (
    <button type="button" onClick={() => void markRead()} className="nl-nt-readall pressable" aria-label="Mark all as read">
      Mark all read
    </button>
  ) : null;

  const filters = (
    <div className="nl-nt-filter" role="group" aria-label="Notifications shown">
      <button type="button" aria-pressed={filter === "all"} className={filter === "all" ? "is-on" : undefined} onClick={() => setFilter("all")}>
        All <span className="metric-number">{notifications.length}</span>
      </button>
      <button type="button" aria-pressed={filter === "unread"} className={filter === "unread" ? "is-on" : undefined} onClick={() => setFilter("unread")}>
        Unread <span className="metric-number">{unreadCount}</span>
      </button>
    </div>
  );

  const list = (
    <div className="nl-nt-list">
      {!shown.length ? (
        <div className="nl-nt-empty">
          <Bell aria-hidden />
          <p>{filter === "unread" && notifications.length ? "You're all caught up." : "No notifications yet."}</p>
        </div>
      ) : (
        shown.map((item, index) => {
          const detail = displayDetail(item);
          const tone = detailTone(item);
          const ToneIcon = TONE_ICON[tone] ?? CircleDot;
          const day = dayLabel(item.createdAt);
          const newDay = index === 0 || dayLabel(shown[index - 1].createdAt) !== day;
          return (
            <div key={item.id}>
              {newDay ? <p className="nl-nt-day">{day}</p> : null}
              <Link
                href={notificationHref(item)}
                onClick={() => {
                  void markRead([item.id]);
                  setOpen(false);
                }}
                className={`nl-nt-row ${item.readAt ? "" : "is-unread"} ${tone}`}
              >
                <span className="nl-nt-icon" aria-hidden>
                  <ToneIcon />
                </span>
                <span className="nl-nt-body">
                  <span className="nl-nt-top">
                    <b>{displayTitle(item)}</b>
                    <span className="nl-nt-time metric-number">{timeLabel(item.createdAt)}</span>
                  </span>
                  {detail ? <span className="nl-nt-msg">{detail}</span> : null}
                </span>
                {!item.readAt ? <span className="nl-nt-unread" aria-label="Unread" /> : null}
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
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={buttonClass}
        type="button"
      >
        <Bell className="size-[18px]" strokeWidth={compact ? 1.9 : 2} />
        {unreadCount > 0 ? <span className="nl-bell-badge metric-number" aria-hidden>{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
      </button>

      {compact ? (
        <MobileSheet
          open={open}
          onClose={() => setOpen(false)}
          eyebrow="Inbox"
          title="Notifications"
          headerAction={readAllButton}
        >
          <div className="nl-nt is-sheet">
            {filters}
            {list}
          </div>
        </MobileSheet>
      ) : open ? (
        <div className="nl-nt is-popover absolute right-0 z-50" role="dialog" aria-label="Notifications">
          <div className="nl-nt-head">
            <h2>Notifications</h2>
            {unreadCount ? <span className="nl-nt-count metric-number">{unreadCount} new</span> : null}
            {readAllButton}
          </div>
          {filters}
          {list}
        </div>
      ) : null}
    </div>
  );
}
