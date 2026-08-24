"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChartNoAxesCombined,
  House,
  ListChecks,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "@/components/ui/brand-mark";
import { MobileTopBar } from "@/components/ui/mobile-top-bar";
import { NavigationProgress } from "@/components/ui/navigation-progress";
import { PwaPullToRefresh } from "@/components/ui/pwa-pull-to-refresh";
import { SignOutButton } from "@/components/ui/sign-out-button";
import { NotificationProvider } from "@/components/notifications/notification-provider";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { Toaster } from "@/components/ui/toaster";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon | ((props: { className?: string; strokeWidth?: number }) => React.ReactNode);
}

function replayNavClick(event: React.PointerEvent<HTMLElement>) {
  const target = event.currentTarget;
  target.classList.remove("nav-mobile-link-click");
  void target.offsetWidth;
  target.classList.add("nav-mobile-link-click");
}

function clearNavClick(event: React.AnimationEvent<HTMLElement>) {
  if (event.animationName !== "nav-mobile-click") {
    return;
  }
  event.currentTarget.classList.remove("nav-mobile-link-click");
}

const navItems: NavItem[] = [
  { label: "Home", href: "/", icon: House },
  { label: "Charts", href: "/chart", icon: ChartNoAxesCombined },
  { label: "Watchlist", href: "/watchlist", icon: ListChecks },
  { label: "Journal", href: "/journal", icon: BookOpen },
  { label: "Settings", href: "/settings", icon: Settings },
];

const mobilePrimaryHrefs = ["/", "/chart", "/watchlist", "/journal", "/settings"] as const;

function isActive(pathname: string, href: string) {
  if (href === "/settings") {
    return pathname.startsWith("/settings") || pathname.startsWith("/risk");
  }
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

const primaryNavItems = navItems.filter((item) => item.href !== "/settings");
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
  const dockRef = useRef<HTMLElement>(null);
  const isChart = pathname.startsWith("/chart");
  const isDashboard = pathname === "/";
  const activeMobileIndex = Math.max(
    0,
    mobileNavItems.findIndex((item) => isActive(pathname, item.href)),
  );
  const [previousMobileIndex, setPreviousMobileIndex] = useState(activeMobileIndex);

  // Publish the floating dock's real height so pages can reserve exactly that
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
  }, []);

  return (
    <NotificationProvider>
    <Toaster />
    <PwaPullToRefresh>
      <NavigationProgress />
      <div className="fixed right-8 top-6 z-50 hidden lg:block">
        <NotificationBell />
      </div>
      <div
        className={`min-h-dvh ${
        isChart
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
          isChart ? "lg:min-h-dvh" : ""
        }`}
      >
        <main
          className={`mx-auto w-full min-w-0 max-w-[1320px] ${
            isChart
              ? "pt-0 lg:flex lg:min-h-dvh lg:flex-col lg:justify-center lg:px-8 lg:py-6"
              : "px-4 pb-32 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 md:pt-6 lg:px-8 lg:pb-10"
          }`}
        >
          {!isChart && !isDashboard ? <MobileTopBar showBack /> : null}
          <div key={pathname} className="mobile-page-transition">
            {children}
          </div>
        </main>
      </div>

      <nav
        ref={dockRef}
        className="mobile-dock fixed inset-x-0 bottom-0 z-40 px-4 lg:hidden"
        aria-label="Mobile navigation"
      >
        <svg className="liquid-glass-filter-defs" aria-hidden="true" focusable="false">
          <defs>
            <filter
              id="nav-liquid-glass-lens"
              x="-8%"
              y="-35%"
              width="116%"
              height="170%"
              colorInterpolationFilters="sRGB"
            >
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.009 0.075"
                numOctaves="1"
                seed="8"
                result="lensNoise"
              />
              <feGaussianBlur in="lensNoise" stdDeviation="0.35" result="softLensNoise" />
              <feDisplacementMap
                in="SourceGraphic"
                in2="softLensNoise"
                scale="3.2"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
        <div className="nav-pill mx-auto grid w-full max-w-[24rem] grid-cols-5 items-center p-2">
          <span
            key={`${previousMobileIndex}-${activeMobileIndex}-${pathname}`}
            className="nav-liquid-lens-track"
            data-direction={activeMobileIndex >= previousMobileIndex ? "forward" : "backward"}
            data-moved={activeMobileIndex !== previousMobileIndex}
            style={
              {
                "--nav-active-offset": `${activeMobileIndex * 100}%`,
                "--nav-previous-offset": `${previousMobileIndex * 100}%`,
              } as React.CSSProperties
            }
            aria-hidden="true"
          >
            <span className="nav-liquid-lens" />
          </span>
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
                onClick={() => setPreviousMobileIndex(activeMobileIndex)}
                onPointerDown={replayNavClick}
                onAnimationEnd={clearNavClick}
              >
                <span className="nav-mobile-icon">
                  <Icon className="size-[1.55rem]" strokeWidth={1.7} />
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
      </div>
    </PwaPullToRefresh>
    </NotificationProvider>
  );
}
