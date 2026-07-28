import Link from "next/link";
import { Bell, ChevronLeft } from "lucide-react";

export function MobileTopBar({ showBack = true }: { showBack?: boolean }) {
  const notificationButton = (
    <button
      type="button"
      aria-label="Notifications"
      className="mobile-icon-btn pressable relative text-[color:var(--muted-strong)] hover:text-[color:var(--foreground)]"
    >
      <Bell className="size-[18px]" strokeWidth={1.9} />
      <span className="absolute right-2 top-2 size-2 rounded-full bg-[color:var(--danger)]" />
    </button>
  );

  if (!showBack) {
    return (
      <div className="mb-4 flex justify-end lg:hidden">{notificationButton}</div>
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
      {notificationButton}
    </div>
  );
}
