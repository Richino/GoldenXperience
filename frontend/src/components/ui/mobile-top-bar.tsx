"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { useScrolledPast } from "@/lib/use-scrolled-past";

/**
 * The back link and the bell stay put while the page scrolls; the row itself
 * does not travel with them. The bottom dock is already fixed, so leaving these
 * in flow meant forward navigation persisted while the way back — and the
 * bell's unread badge — scrolled off. The journal runs past 2000px on a phone.
 *
 * The icons are taken out of flow by `.mobile-floating-icon`, so this element
 * stays behind to reserve their height and to act as the threshold: once it
 * scrolls away the icons lift off the page, and until then they read as part of
 * the header they came from.
 */
export function MobileTopBar({ showBack = true }: { showBack?: boolean }) {
  const { ref, scrolledPast } = useScrolledPast<HTMLDivElement>();
  const lift = scrolledPast ? " is-lifted" : "";

  return (
    <div ref={ref} className="mb-4 h-10 lg:hidden">
      {showBack ? (
        <Link
          href="/"
          className={`mobile-icon-btn mobile-floating-icon mobile-floating-icon-start pressable text-[color:var(--foreground)]${lift}`}
          aria-label="Back to home"
        >
          <ChevronLeft className="size-5" strokeWidth={2} />
        </Link>
      ) : null}
      <NotificationBell
        compact
        className={`mobile-floating-icon mobile-floating-icon-end${lift}`}
      />
    </div>
  );
}
