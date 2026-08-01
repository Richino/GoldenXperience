import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { SignOutButton } from "@/components/ui/sign-out-button";
import { NotificationBell } from "@/components/notifications/notification-bell";

export function MobileTopBar({ showBack = true }: { showBack?: boolean }) {
  const notificationButton = <NotificationBell compact />;

  if (!showBack) {
    return (
      <div className="mb-4 flex justify-end gap-1 lg:hidden">
        {notificationButton}
        <SignOutButton compact />
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center justify-between lg:hidden">
      <Link
        href="/"
        className="mobile-icon-btn pressable text-[color:var(--foreground)]"
        aria-label="Back to home"
      >
        <ChevronLeft className="size-5" strokeWidth={2} />
      </Link>
      <div className="flex gap-1">
        {notificationButton}
        <SignOutButton compact />
      </div>
    </div>
  );
}
