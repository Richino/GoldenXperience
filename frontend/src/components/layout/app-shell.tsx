"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BarChart3,
  BookOpen,
  LayoutDashboard,
  Settings,
  FlaskConical,
  ShieldCheck,
  Radar,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "@/components/ui/brand-mark";
import { MobileTopBar } from "@/components/ui/mobile-top-bar";
import { NavigationProgress } from "@/components/ui/navigation-progress";
import { PwaPullToRefresh } from "@/components/ui/pwa-pull-to-refresh";
import { SignOutButton } from "@/components/ui/sign-out-button";
import { NotificationProvider } from "@/components/notifications/notification-provider";
import { NotificationBell } from "@/components/notifications/notification-bell";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { label: "Home", href: "/", icon: LayoutDashboard },
  { label: "Signals", href: "/signals", icon: BarChart3 },
  { label: "Watchlist", href: "/watchlist", icon: Radar },
  { label: "Journal", href: "/journal", icon: BookOpen },
  { label: "Research", href: "/research", icon: FlaskConical },
  { label: "Risk", href: "/risk", icon: ShieldCheck },
  { label: "Settings", href: "/settings", icon: Settings },
];

const mobilePrimaryHrefs = ["/", "/signals", "/watchlist", "/journal"] as const;
const mobileMoreHrefs = ["/research", "/risk", "/settings"] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

const primaryNavItems = navItems.filter((item) => item.href !== "/settings");
const settingsNavItem = navItems.find((item) => item.href === "/settings")!;
const mobileNavItems = navItems.filter((item) =>
  (mobilePrimaryHrefs as readonly string[]).includes(item.href),
);
const mobileMoreItems = navItems.filter((item) =>
  (mobileMoreHrefs as readonly string[]).includes(item.href),
);

function SidebarNavLink({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      className={`sidebar-nav-link pressable ${active ? "sidebar-nav-link-active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <span
        className={`sidebar-nav-icon ${active ? "sidebar-nav-icon-active" : ""}`}
      >
        <Icon className="size-4" strokeWidth={active ? 2.25 : 1.85} />
      </span>
      {item.label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const isSignals = pathname.startsWith("/signals");
  const isDashboard = pathname === "/";
  const moreActive = mobileMoreHrefs.some((href) => isActive(pathname, href));

  useEffect(() => {
    setMobileMoreOpen(false);
  }, [pathname]);

  return (
    <NotificationProvider>
    <PwaPullToRefresh>
      <NavigationProgress />
      <div className="fixed right-8 top-6 z-50 hidden lg:block">
        <NotificationBell />
      </div>
      <div
        className={`min-h-dvh ${
        isSignals
          ? "signals-route"
          : "bg-[color:var(--background)]"
      }`}
    >
      <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col border-r border-[color:var(--border)] px-5 py-6 lg:flex">
        <BrandMark />
        <div className="mt-8">
          <p className="sidebar-section-label px-3">Workspace</p>
          <nav className="mt-2 space-y-1" aria-label="Primary navigation">
            {primaryNavItems.map((item) => (
              <SidebarNavLink
                key={item.href}
                item={item}
                active={isActive(pathname, item.href)}
              />
            ))}
          </nav>
        </div>

        <div className="mt-5 px-3">
          <div className="h-px bg-[color:var(--border)]" />
        </div>

        <nav className="mt-4 space-y-1" aria-label="Settings">
          <SidebarNavLink
            item={settingsNavItem}
            active={isActive(pathname, settingsNavItem.href)}
          />
        </nav>

        <div className="sidebar-status-card mt-auto rounded-2xl p-3.5">
          <div className="flex items-center gap-2 text-xs font-medium tracking-[-0.01em]">
            <span className="relative grid size-2.5 place-items-center">
              <span className="sidebar-status-dot-halo absolute size-2.5 rounded-full bg-[color:var(--success)] opacity-35" />
              <span className="relative size-1.5 rounded-full bg-[color:var(--success)]" />
            </span>
            Practice workspace
          </div>
          <p className="text-caption mt-2 leading-5 text-[color:var(--muted)]">
            Broker credentials stay on the server.
          </p>
          <SignOutButton />
        </div>
      </aside>

      <div
        className={`min-w-0 w-full lg:pl-[260px] ${
          isSignals ? "lg:min-h-dvh" : ""
        }`}
      >
        <main
          className={`mx-auto w-full min-w-0 max-w-[1320px] ${
            isSignals
              ? "pt-0 lg:flex lg:min-h-dvh lg:flex-col lg:justify-center lg:px-8 lg:py-6"
              : "px-4 pb-32 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 md:pt-6 lg:px-8 lg:pb-10"
          }`}
        >
          {!isSignals && !isDashboard ? <MobileTopBar showBack /> : null}
          {children}
        </main>
      </div>

      <nav
        className="mobile-dock fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
        aria-label="Mobile navigation"
      >
        {mobileMoreOpen ? (
          <div className="nav-more-sheet mx-auto mb-2 w-full max-w-[22rem]">
            {mobileMoreItems.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMoreOpen(false)}
                  className={`nav-more-link pressable ${active ? "is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="nav-more-icon">
                    <Icon className="size-4" strokeWidth={active ? 2.25 : 1.9} />
                  </span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
            <SignOutButton menu />
          </div>
        ) : null}

        <div className="nav-pill mx-auto flex w-full max-w-[22rem] items-center justify-between gap-1 px-2 py-1.5">
          {mobileNavItems.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-mobile-link pressable ${
                  active ? "nav-mobile-link-active" : ""
                }`}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
              >
                <Icon className="size-[1.2rem]" strokeWidth={active ? 2.3 : 1.85} />
              </Link>
            );
          })}
          <button
            type="button"
            className={`nav-mobile-link pressable ${
              mobileMoreOpen || moreActive ? "nav-mobile-link-active" : ""
            }`}
            aria-label="More"
            aria-expanded={mobileMoreOpen}
            onClick={() => setMobileMoreOpen((open) => !open)}
          >
            <MoreHorizontal
              className="size-[1.2rem]"
              strokeWidth={mobileMoreOpen || moreActive ? 2.3 : 1.85}
            />
          </button>
        </div>
      </nav>
      </div>
    </PwaPullToRefresh>
    </NotificationProvider>
  );
}
