"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  CandlestickChart,
  BookOpen,
  ChartNoAxesCombined,
  House,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "@/components/ui/brand-mark";
import { AppTopBar } from "@/components/layout/app-topbar";
import { MobileTopBar } from "@/components/ui/mobile-top-bar";
import { NavigationProgress } from "@/components/ui/navigation-progress";
import { PwaPullToRefresh } from "@/components/ui/pwa-pull-to-refresh";
import { SignOutButton } from "@/components/ui/sign-out-button";
import { NotificationProvider } from "@/components/notifications/notification-provider";
import { Toaster } from "@/components/ui/toaster";
import { MarketObserverProvider } from "@/components/analysis/market-observer-provider";
import { syncAppViewportHeight } from "@/lib/pwa/viewport-height";

function subscribe() {
  return () => undefined;
}

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon | ((props: { className?: string; strokeWidth?: number }) => React.ReactNode);
}

const navItems: NavItem[] = [
  { label: "Home", href: "/", icon: House },
  { label: "Chart", href: "/chart", icon: CandlestickChart },
  { label: "Trades", href: "/journal", icon: BookOpen },
  { label: "Markets", href: "/watchlist", icon: ChartNoAxesCombined },
  { label: "Settings", href: "/settings", icon: Settings },
];

const mobilePrimaryHrefs = ["/", "/chart", "/journal", "/watchlist", "/settings"] as const;

function isActive(pathname: string, href: string) {
  if (href === "/settings") {
    return pathname.startsWith("/settings") || pathname.startsWith("/risk");
  }
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

const workspaceNavItems = navItems.filter((item) => item.href !== "/settings");
const settingsNavItem = navItems.find((item) => item.href === "/settings")!;
const mobileNavItems = navItems.filter((item) =>
  (mobilePrimaryHrefs as readonly string[]).includes(item.href),
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
      <Icon className="sidebar-nav-glyph shrink-0" strokeWidth={active ? 1.9 : 1.55} />
      {item.label}
    </Link>
  );
}

function SidebarAccount() {
  return (
    <div className="sidebar-account">
      <SignOutButton quiet />
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const dockRef = useRef<HTMLElement>(null);
  const isClient = useSyncExternalStore(subscribe, () => true, () => false);
  const isChart = pathname.startsWith("/chart");
  const isDashboard = pathname === "/";
  // Trades (the /journal route) carries its own header + connection strip and a
  // two-pane workspace, so it opts out of the shared market-status top bar.
  const isTrades = pathname === "/journal";
  const isMarkets = pathname === "/watchlist";
  const isSettings = pathname === "/settings";
  // Pages that draw their own header row (title, status, tools) as designed.
  const ownsHeader = isDashboard || isChart || isTrades || isMarkets || isSettings;
  // Bottom-dock tabs have no "back"; their bell shares the title row.
  const isTabPage = isTrades || pathname === "/settings" || pathname === "/watchlist";
  // Publish the dock's real height so pages can reserve exactly that
  // much space beneath their content. The measured value already includes the
  // pill and its home-indicator safe-area padding, so consumers add nothing
  // extra — no double-counted inset, no hardcoded guess drifting per device.
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;

    const root = document.documentElement;
    const apply = () =>
      root.style.setProperty("--app-dock-height", `${dock.offsetHeight}px`);
    apply();

    const observer = new ResizeObserver(apply);
    observer.observe(dock);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--app-dock-height");
    };
  }, [isClient]);

  // Restore fixed-height chart pages on resume and retain iOS keyboard cleanup.
  useEffect(() => syncAppViewportHeight(window, document), []);

  // Portaled to document.body so no shell ancestor (pull-to-refresh, page
  // motion, overflow) can create a containing block and unpin fixed bottom.
  const mobileDock = (
    <nav
      ref={dockRef}
      className="mobile-dock ink-dock fixed inset-x-0 bottom-0 z-40 lg:hidden"
      aria-label="Mobile navigation"
    >
      {/* Ink sheet: a dark sheet pinned to the screen edge in both themes; the
          active tab grows into a lime tile that reveals its label. */}
      <div className="ink-dock-sheet">
        {mobileNavItems.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`ink-dock-tab${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
            >
              <Icon className="ink-dock-icon" strokeWidth={1.9} />
              <span className="ink-dock-label">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );

  return (
    <NotificationProvider>
    <MarketObserverProvider>
    <Toaster />
    <PwaPullToRefresh>
      <NavigationProgress />
      <div
        className={`min-h-dvh ${
        isChart
          ? "signals-route"
          : "bg-[color:var(--background)]"
      }`}
    >
      <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden w-24 flex-col lg:flex">
        <div className="sidebar-header">
          <BrandMark variant="sidebar" />
        </div>

        <nav className="sidebar-nav sidebar-nav-primary" aria-label="Primary navigation">
          {workspaceNavItems.map((item) => (
            <SidebarNavLink
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
            />
          ))}
        </nav>

        <nav className="sidebar-nav sidebar-nav-utility" aria-label="Settings">
          <SidebarNavLink
            item={settingsNavItem}
            active={isActive(pathname, settingsNavItem.href)}
          />
        </nav>

        <SidebarAccount />
      </aside>

      <div
        className={`min-w-0 w-full lg:pl-24 ${ownsHeader ? "" : "has-topbar"} ${
          isChart ? "lg:min-h-dvh" : ""
        }`}
      >
        {ownsHeader ? null : <AppTopBar />}
        <main
          data-gx-workspace-ready={isClient ? "true" : undefined}
          className={`w-full min-w-0 ${
            isChart
              ? "min-h-dvh p-0"
              : ownsHeader
                ? "w-full pb-32 pt-[var(--gx-safe-area-top)] lg:pb-0 lg:pt-0"
                : "mx-auto max-w-[1320px] px-4 pb-32 pt-[max(1rem,var(--gx-safe-area-top))] sm:px-6 md:pt-6 lg:px-8 lg:pb-10"
          }`}
        >
          {!ownsHeader ? <MobileTopBar showBack={!isTabPage} inline={isTabPage} /> : null}
          <div key={pathname} className="mobile-page-transition">
            {children}
          </div>
        </main>
      </div>
      </div>
    </PwaPullToRefresh>
    {isClient ? createPortal(mobileDock, document.body) : null}
    </MarketObserverProvider>
    </NotificationProvider>
  );
}
