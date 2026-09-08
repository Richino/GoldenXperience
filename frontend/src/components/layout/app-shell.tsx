"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  BarChart3,
  BookOpen,
  ChartNoAxesCombined,
  Ellipsis,
  House,
  ListChecks,
  Radio,
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
import { apiUrl } from "@/lib/api/url";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

function subscribe() {
  return () => undefined;
}

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
  { label: "Signals", href: "/signals", icon: Radio },
  { label: "Chart", href: "/chart", icon: ChartNoAxesCombined },
  { label: "Trades", href: "/journal", icon: BookOpen },
  { label: "Markets", href: "/watchlist", icon: ListChecks },
  { label: "Performance", href: "/research", icon: BarChart3 },
  { label: "More", href: "/risk", icon: Activity },
  { label: "Settings", href: "/settings", icon: Settings },
];

const mobilePrimaryHrefs = ["/", "/signals", "/chart", "/journal", "/settings"] as const;

function isActive(pathname: string, href: string) {
  if (href === "/settings") {
    return pathname.startsWith("/settings") || pathname.startsWith("/risk");
  }
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

const workspaceNavItems = navItems.filter(
  (item) => item.href !== "/settings" && item.href !== "/risk",
);
const moreNavItem = navItems.find((item) => item.href === "/risk")!;
const settingsNavItem = navItems.find((item) => item.href === "/settings")!;
const mobileNavItems = navItems.filter((item) =>
  (mobilePrimaryHrefs as readonly string[]).includes(item.href),
).map((item) => item.href === "/settings" ? { ...item, label: "More", icon: Ellipsis } : item);

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
      <Icon className="sidebar-nav-glyph shrink-0" strokeWidth={active ? 2.15 : 1.7} />
      {item.label}
    </Link>
  );
}

function initialsFrom(value: string) {
  const local = value.replace(/@.*$/, "");
  const parts = local.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]!.charAt(0)}${parts[1]!.charAt(0)}`.toUpperCase();
  }
  return local.slice(0, 2).toUpperCase() || "GX";
}

function titleFrom(email: string, alias: string | null) {
  const cleaned = alias?.trim() ?? "";
  if (cleaned && !/^\d+$/.test(cleaned)) return cleaned;
  if (!email) return "Practice";
  const local = email.split("@")[0] ?? "Practice";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function SidebarAccount() {
  const [email, setEmail] = useState<string | null>(null);
  const [alias, setAlias] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [meResponse, accountResponse] = await Promise.all([
          fetch(apiUrl("/api/auth/me"), { credentials: "include", cache: "no-store" }),
          fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" }),
        ]);
        if (cancelled) return;

        if (meResponse.ok) {
          const payload = (await meResponse.json()) as { user?: { email?: string } };
          setEmail(payload.user?.email ?? null);
        }

        if (accountResponse.ok) {
          const payload = (await accountResponse.json()) as {
            data?: AccountSummary;
            status?: ConnectionStatus;
          };
          setAlias(payload.data?.alias ?? null);
          setStatus(payload.status ?? null);
        }
      } catch {
        // The compact account chip is secondary chrome; keep the last known
        // values if the snapshot is temporarily unavailable.
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const identity = email ?? alias ?? "Practice";
  const venue = status?.source === "oanda" ? "OANDA" : status?.source ?? null;
  const mode = status?.environment === "live" ? "LIVE" : "Practice";
  const connected = status?.state === "connected";

  return (
    <div className="sidebar-account mt-auto">
      <span className="sidebar-account-avatar" aria-hidden="true">
        {initialsFrom(identity)}
      </span>
      <span className="sidebar-account-copy">
        <span className="sidebar-account-name">{titleFrom(email ?? "", alias)}</span>
        <span className="sidebar-account-status">
          {venue ? `${mode} · ${venue}` : connected ? `${mode} · Connected` : mode}
        </span>
      </span>
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
  const isSignals = pathname === "/signals";
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
  }, [isClient]);

  // Portaled to document.body so no shell ancestor (pull-to-refresh, page
  // motion, overflow) can create a containing block and unpin fixed bottom.
  const mobileDock = (
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
              <span className="nav-mobile-label">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );

  return (
    <NotificationProvider>
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
      <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden w-[224px] flex-col border-r border-[color:var(--border)] px-3.5 py-4 lg:flex">
        <BrandMark variant="sidebar" />
        <nav className="mt-6 space-y-1" aria-label="Primary navigation">
          {workspaceNavItems.map((item) => (
            <SidebarNavLink
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
            />
          ))}
        </nav>

        <div className="mx-1 mt-5 h-px bg-[color:var(--border)]" />

        <nav className="mt-3 space-y-1" aria-label="More">
          <SidebarNavLink
            item={moreNavItem}
            active={isActive(pathname, moreNavItem.href)}
          />
          <SidebarNavLink
            item={settingsNavItem}
            active={isActive(pathname, settingsNavItem.href)}
          />
        </nav>

        <SidebarAccount />
      </aside>

      <div
        className={`min-w-0 w-full lg:pl-[224px] ${isSignals ? "" : "has-topbar"} ${
          isChart ? "lg:min-h-dvh" : ""
        } ${isDashboard ? "has-home-rail" : ""}`}
      >
        {/* Signals carries its own header strip (title + live counts + search),
            so it opts out of the shared market-status top bar. */}
        {isSignals ? null : <AppTopBar />}
        <main
          className={`w-full min-w-0 ${
            isChart
              ? "min-h-dvh p-0"
              : isDashboard
                ? "w-full px-4 pb-32 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 md:pt-5 lg:px-6 lg:pb-8"
                : isSignals
                  ? "w-full max-w-[1320px] mx-auto px-4 pb-32 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 md:pt-6 lg:px-6 lg:pb-8"
                  : "mx-auto max-w-[1320px] px-4 pb-32 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 md:pt-6 lg:px-8 lg:pb-10"
          }`}
        >
          {!isChart && !isDashboard && !isSignals ? <MobileTopBar showBack /> : null}
          <div key={pathname} className="mobile-page-transition">
            {children}
          </div>
        </main>
      </div>
      </div>
    </PwaPullToRefresh>
    {isClient ? createPortal(mobileDock, document.body) : null}
    </NotificationProvider>
  );
}
