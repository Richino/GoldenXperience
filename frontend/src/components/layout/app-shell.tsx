"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  BookOpen,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "@/components/ui/brand-mark";
import { MobileTopBar } from "@/components/ui/mobile-top-bar";
import { NavigationProgress } from "@/components/ui/navigation-progress";
import { PwaPullToRefresh } from "@/components/ui/pwa-pull-to-refresh";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { label: "Home", href: "/", icon: LayoutDashboard },
  { label: "Signals", href: "/signals", icon: BarChart3 },
  { label: "Journal", href: "/journal", icon: BookOpen },
  { label: "Risk", href: "/risk", icon: ShieldCheck },
  { label: "Settings", href: "/settings", icon: Settings },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

const primaryNavItems = navItems.slice(0, 4);
const settingsNavItem = navItems[4]!;

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
  const isSignals = pathname.startsWith("/signals");
  const isDashboard = pathname === "/";

  return (
    <PwaPullToRefresh>
      <NavigationProgress />
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
              ? "pb-32 pt-0 lg:flex lg:min-h-dvh lg:flex-col lg:justify-center lg:px-8 lg:py-6"
              : "px-4 pb-32 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 md:pt-6 lg:px-8 lg:pb-10"
          }`}
        >
          {!isSignals ? <MobileTopBar showBack={!isDashboard} /> : null}
          {children}
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
        aria-label="Mobile navigation"
      >
        <div className="nav-pill mx-auto flex max-w-md items-center justify-around px-2 py-2">
          {navItems.map((item) => {
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
                <Icon className="size-5" strokeWidth={active ? 2.25 : 1.8} />
              </Link>
            );
          })}
        </div>
      </nav>
      </div>
    </PwaPullToRefresh>
  );
}
